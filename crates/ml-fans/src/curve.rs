//! The curve engine: pure, no I/O, driven by `Engine::step(setup, now, readings)` about once a second.
//!
//! Rules (from https://getfancontrol.com/docs):
//! * Hysteresis and response time only act while the temperature FALLS; a rising temperature is followed at once.
//!   At the first and last point of a curve they are skipped (`skip_edges`).
//! * Per control: offset, then stop (below it 0 %), then minimum (hard floor), a kick (`start`) when leaving 0 %,
//!   step up / step down per second, and avoid ranges.
//! * Auto: finds the lowest speed that holds the load temperature; the step is halved and the response time doubled
//!   while the temperature is falling.
//! * A control whose sensor is missing gets the fail-safe speed, never its last value.

use crate::model::*;
use std::collections::HashMap;

pub type Readings = HashMap<String, f32>;

/// What to do with one control this cycle.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Out {
    /// set this percent
    Set(f32),
    /// leave the control to the BIOS / card
    Release,
}

#[derive(Default)]
struct CurveState {
    /// temperature the curve currently acts on (lags behind a falling temperature)
    t_eff: Option<f32>,
    /// since when the temperature has been lower than `t_eff - hyst`
    fall_since: Option<f64>,
    /// Trigger: true = load speed
    load: bool,
    /// Auto: current speed and when it was last adjusted
    speed: Option<f32>,
    adjusted: f64,
    last_t: Option<f32>,
}

#[derive(Default)]
struct CtlState {
    out: f32,
    kick_until: f64,
    init: bool,
}

#[derive(Default)]
pub struct Engine {
    curves: HashMap<String, CurveState>,
    ctls: HashMap<String, CtlState>,
    last_now: Option<f64>,
    /// the percent each control was given last cycle (Sync reads it)
    pub outputs: HashMap<String, f32>,
}

/// Linear interpolation over points sorted by temperature; flat outside them.
pub fn interp(points: &[[f32; 2]], t: f32) -> f32 {
    let Some(first) = points.first() else { return 0.0 };
    if t <= first[0] {
        return first[1];
    }
    for w in points.windows(2) {
        if t <= w[1][0] {
            let span = w[1][0] - w[0][0];
            return if span <= 0.0 { w[1][1] } else { w[0][1] + (w[1][1] - w[0][1]) * (t - w[0][0]) / span };
        }
    }
    points[points.len() - 1][1]
}

pub fn mix(f: MixFn, v: &[f32]) -> Option<f32> {
    let first = *v.first()?;
    Some(match f {
        MixFn::Max => v.iter().copied().fold(f32::MIN, f32::max),
        MixFn::Min => v.iter().copied().fold(f32::MAX, f32::min),
        MixFn::Avg => v.iter().sum::<f32>() / v.len() as f32,
        MixFn::Sum => v.iter().sum(),
        MixFn::Sub => first - v[1..].iter().sum::<f32>(),
    })
}

/// A sensor value: a raw reading, or a `mix:<id>` custom sensor built from others (mixes of mixes are followed to depth 4).
pub fn sensor(setup: &Setup, r: &Readings, id: &str, depth: u8) -> Option<f32> {
    if let Some(m) = id.strip_prefix("mix:") {
        if depth > 4 {
            return None;
        }
        let m = setup.mixes.iter().find(|x| x.id == m)?;
        let v: Option<Vec<f32>> = m.inputs.iter().map(|i| sensor(setup, r, i, depth + 1)).collect();
        return mix(m.func, &v?);
    }
    r.get(id).copied().filter(|v| v.is_finite())
}

impl Engine {
    pub fn new() -> Engine {
        Engine::default()
    }

    /// Forget everything (the setup changed a lot, or control was handed back).
    pub fn reset(&mut self) {
        *self = Engine::default();
    }

    /// One cycle: the output for every control that Buffer drives. `Out::Release` for controls in Auto mode.
    pub fn step(&mut self, setup: &Setup, now: f64, r: &Readings) -> Vec<(String, Out)> {
        let dt = self.last_now.map_or(1.0, |l| (now - l).clamp(0.05, 5.0)) as f32;
        self.last_now = Some(now);
        // pass 1: every curve that does not look at another control
        let mut value: HashMap<String, Option<f32>> = HashMap::new();
        for c in &setup.curves {
            if !matches!(c.kind, Kind::Mix { .. } | Kind::Sync { .. }) {
                let v = self.eval(setup, c, now, r);
                value.insert(c.id.clone(), v);
            }
        }
        // pass 2: Mix of curves, then Sync (which follows what the other control was given)
        for c in &setup.curves {
            if let Kind::Mix { func, curves } = &c.kind {
                let v: Option<Vec<f32>> = curves.iter().map(|i| value.get(i).copied().flatten()).collect();
                value.insert(c.id.clone(), v.and_then(|v| mix(*func, &v)));
            }
        }
        for c in &setup.curves {
            if let Kind::Sync { control, offset, proportional } = &c.kind {
                let v = self.outputs.get(control).map(|o| if *proportional { o * (1.0 + offset / 100.0) } else { o + offset });
                value.insert(c.id.clone(), v.map(|v| v.clamp(0.0, 100.0)));
            }
        }
        let mut out = Vec::new();
        for ctl in &setup.controls {
            let o = match ctl.mode {
                Mode::Auto => Out::Release,
                Mode::Manual => Out::Set(self.shape(ctl, now, dt, ctl.manual)),
                Mode::Curve => {
                    let target = ctl.curve.as_ref().and_then(|c| value.get(c).copied().flatten());
                    match target {
                        Some(t) => Out::Set(self.shape(ctl, now, dt, t)),
                        None => {
                            // sensor lost or no curve: the fail-safe, immediately and without any step limit
                            let s = self.ctls.entry(ctl.id.clone()).or_default();
                            s.out = setup.failsafe;
                            s.init = true;
                            Out::Set(setup.failsafe)
                        }
                    }
                }
            };
            if let Out::Set(p) = o {
                self.outputs.insert(ctl.id.clone(), p);
            } else {
                self.outputs.remove(&ctl.id);
            }
            out.push((ctl.id.clone(), o));
        }
        out
    }

    /// offset, stop, minimum, kick, steps, avoid ranges
    fn shape(&mut self, ctl: &Control, now: f64, dt: f32, target: f32) -> f32 {
        let tu = &ctl.tuning;
        let s = self.ctls.entry(ctl.id.clone()).or_default();
        let mut want = (target + tu.offset).clamp(0.0, 100.0);
        if want < tu.stop {
            want = 0.0;
        }
        want = want.max(tu.minimum);
        for a in &tu.avoid {
            let (lo, hi) = (a[0].min(a[1]), a[0].max(a[1]));
            if want > lo && want < hi {
                // to the nearest edge, towards where it came from when it is in the middle
                want = if (want - lo) < (hi - want) || ((want - lo) == (hi - want) && s.out <= lo) { lo } else { hi };
            }
        }
        if !s.init {
            // the first value is taken as it is: a control must not creep up from 0 after the recorder starts
            s.init = true;
            s.out = want;
            return want;
        }
        if s.out <= 0.0 && want > 0.0 && want < tu.start {
            s.kick_until = now + 2.0;
        }
        if now < s.kick_until {
            want = want.max(tu.start);
        }
        let next = if want > s.out { (s.out + tu.step_up.max(0.1) * dt).min(want) } else { (s.out - tu.step_down.max(0.1) * dt).max(want) };
        s.out = next;
        next
    }

    fn eval(&mut self, setup: &Setup, c: &Curve, now: f64, r: &Readings) -> Option<f32> {
        match &c.kind {
            Kind::Flat { pct } => Some(*pct),
            Kind::Graph { src, points } => {
                let t = self.delayed(c, now, sensor(setup, r, src, 0)?, points.first().map(|p| p[0]), points.last().map(|p| p[0]));
                Some(interp(points, t))
            }
            Kind::Linear { src, tmin, tmax, pmin, pmax } => {
                let t = self.delayed(c, now, sensor(setup, r, src, 0)?, Some(*tmin), Some(*tmax));
                let pts = [[*tmin, *pmin], [*tmax, *pmax]];
                Some(interp(&pts, t))
            }
            Kind::Trigger { src, idle_t, load_t, idle_pct, load_pct } => {
                let t = sensor(setup, r, src, 0)?;
                let st = self.curves.entry(c.id.clone()).or_default();
                if t >= *load_t {
                    st.load = true;
                } else if t <= *idle_t {
                    st.load = false;
                }
                Some(if st.load { *load_pct } else { *idle_pct })
            }
            Kind::Auto { src, idle_t, load_t, min, max, step, deadband } => {
                let t = sensor(setup, r, src, 0)?;
                let st = self.curves.entry(c.id.clone()).or_default();
                let falling = st.last_t.is_some_and(|l| t < l - 0.05);
                st.last_t = Some(t);
                let linear = interp(&[[*idle_t, *min], [(*load_t - *deadband).max(*idle_t + 0.1), (*min + (*max - *min) * 0.5)]], t);
                let speed = st.speed.unwrap_or(linear);
                let next = if t < *load_t - *deadband {
                    // below the load zone: linear
                    linear
                } else {
                    let wait = (c.resp.max(1.0) * if t < *load_t { 2.0 } else { 1.0 }) as f64;
                    if now - st.adjusted >= wait {
                        st.adjusted = now;
                        if t > *load_t {
                            speed + step
                        } else if t < *load_t - *deadband / 2.0 || falling {
                            speed - step / 2.0
                        } else {
                            speed
                        }
                    } else {
                        speed
                    }
                };
                let next = next.clamp(*min, *max);
                st.speed = Some(next);
                Some(next)
            }
            Kind::Mix { .. } | Kind::Sync { .. } => None,
        }
    }

    /// The temperature a curve acts on: rises at once, falls only after `hyst` degrees held for `resp` seconds.
    fn delayed(&mut self, c: &Curve, now: f64, t: f32, first_t: Option<f32>, last_t: Option<f32>) -> f32 {
        let st = self.curves.entry(c.id.clone()).or_default();
        let Some(eff) = st.t_eff else {
            st.t_eff = Some(t);
            return t;
        };
        let at_edge = c.skip_edges && (first_t.is_some_and(|f| t <= f) || last_t.is_some_and(|l| t >= l));
        if t >= eff || at_edge {
            st.t_eff = Some(t);
            st.fall_since = None;
            return t;
        }
        if eff - t >= c.hyst {
            let since = *st.fall_since.get_or_insert(now);
            if now - since >= c.resp as f64 {
                st.t_eff = Some(t);
                st.fall_since = None;
                return t;
            }
        } else {
            st.fall_since = None;
        }
        eff
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(pairs: &[(&str, f32)]) -> Readings {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn setup_with(curve: Curve) -> Setup {
        let mut ctl = Control { id: "c0".into(), fan: None, name: "Fan".into(), curve: Some(curve.id.clone()), mode: Mode::Curve, manual: 0.0, hidden: false, tuning: Tuning::default() };
        ctl.tuning.step_up = 100.0;
        Setup { curves: vec![curve], controls: vec![ctl], ..Setup::default() }
    }

    fn run(e: &mut Engine, s: &Setup, now: f64, t: f32) -> f32 {
        match e.step(s, now, &r(&[("t", t)]))[0].1 {
            Out::Set(p) => p,
            Out::Release => -1.0,
        }
    }

    const PTS: [[f32; 2]; 3] = [[30.0, 20.0], [60.0, 50.0], [90.0, 100.0]];

    #[test]
    fn interpolates_and_is_flat_outside_the_points() {
        assert_eq!(interp(&PTS, 20.0), 20.0);
        assert_eq!(interp(&PTS, 45.0), 35.0);
        assert_eq!(interp(&PTS, 99.0), 100.0);
        assert_eq!(interp(&[], 50.0), 0.0);
    }

    #[test]
    fn rising_is_followed_at_once_falling_waits_for_hysteresis_and_response_time() {
        let mut c = Curve::graph("g", "G", "t", &PTS);
        c.hyst = 3.0;
        c.resp = 5.0;
        let s = setup_with(c);
        let mut e = Engine::new();
        assert_eq!(run(&mut e, &s, 0.0, 50.0), interp(&PTS, 50.0));
        assert_eq!(run(&mut e, &s, 1.0, 55.0), interp(&PTS, 55.0), "rising: no delay");
        // falls by 2 (< hyst): ignored
        assert_eq!(run(&mut e, &s, 2.0, 53.0), interp(&PTS, 55.0));
        // falls by 5 (>= hyst) but not for long enough yet
        assert_eq!(run(&mut e, &s, 3.0, 50.0), interp(&PTS, 55.0));
        assert_eq!(run(&mut e, &s, 7.0, 50.0), interp(&PTS, 55.0));
        // held for resp seconds: accepted
        assert_eq!(run(&mut e, &s, 8.5, 50.0), interp(&PTS, 50.0));
    }

    #[test]
    fn a_fall_that_does_not_hold_restarts_the_response_timer() {
        let mut c = Curve::graph("g", "G", "t", &PTS);
        c.hyst = 3.0;
        c.resp = 5.0;
        let s = setup_with(c);
        let mut e = Engine::new();
        run(&mut e, &s, 0.0, 60.0);
        run(&mut e, &s, 1.0, 55.0); // starts the timer
        run(&mut e, &s, 4.0, 59.0); // back within hyst: timer cleared
        assert_eq!(run(&mut e, &s, 8.0, 55.0), interp(&PTS, 60.0), "the timer started again at 8");
        assert_eq!(run(&mut e, &s, 13.5, 55.0), interp(&PTS, 55.0));
    }

    #[test]
    fn hysteresis_is_skipped_at_the_edges_of_the_curve() {
        let mut c = Curve::graph("g", "G", "t", &PTS);
        c.hyst = 10.0;
        c.resp = 60.0;
        let s = setup_with(c);
        let mut e = Engine::new();
        run(&mut e, &s, 0.0, 80.0);
        // falling to the first point's temperature: followed at once
        assert_eq!(run(&mut e, &s, 1.0, 30.0), 20.0);
    }

    #[test]
    fn stop_minimum_offset_and_steps() {
        let mut s = setup_with(Curve::flat("f", "F", 10.0));
        s.controls[0].tuning.stop = 15.0;
        let mut e = Engine::new();
        assert_eq!(run(&mut e, &s, 0.0, 0.0), 0.0, "below stop = off");
        s.controls[0].tuning.minimum = 25.0;
        assert_eq!(run(&mut e, &s, 1.0, 0.0), 25.0, "minimum is a hard floor");
        s.controls[0].tuning.minimum = 0.0;
        s.controls[0].tuning.offset = 30.0;
        s.controls[0].tuning.step_down = 5.0;
        s.controls[0].tuning.stop = 0.0;
        // target 40, from 25: rises at once
        assert_eq!(run(&mut e, &s, 2.0, 0.0), 40.0);
        s.curves[0].kind = Kind::Flat { pct: 0.0 };
        // target 30 from 40, down at most 5 per second
        assert_eq!(run(&mut e, &s, 3.0, 0.0), 35.0);
        assert_eq!(run(&mut e, &s, 4.0, 0.0), 30.0);
    }

    #[test]
    fn a_stopped_fan_is_kicked_with_start_for_two_seconds() {
        let mut s = setup_with(Curve::flat("f", "F", 0.0));
        s.controls[0].tuning.start = 40.0;
        let mut e = Engine::new();
        assert_eq!(run(&mut e, &s, 0.0, 0.0), 0.0);
        s.curves[0].kind = Kind::Flat { pct: 20.0 };
        assert_eq!(run(&mut e, &s, 1.0, 0.0), 40.0, "kick");
        assert_eq!(run(&mut e, &s, 2.5, 0.0), 40.0, "still kicking");
        assert_eq!(run(&mut e, &s, 3.5, 0.0), 20.0, "then its own speed");
    }

    #[test]
    fn avoid_ranges_move_to_the_nearest_edge() {
        let mut s = setup_with(Curve::flat("f", "F", 44.0));
        s.controls[0].tuning.avoid = vec![[40.0, 50.0]];
        let mut e = Engine::new();
        assert_eq!(run(&mut e, &s, 0.0, 0.0), 40.0);
        s.curves[0].kind = Kind::Flat { pct: 47.0 };
        assert_eq!(run(&mut e, &s, 1.0, 0.0), 50.0);
    }

    #[test]
    fn a_lost_sensor_means_the_failsafe_not_the_last_value() {
        let s = setup_with(Curve::graph("g", "G", "t", &PTS));
        let mut e = Engine::new();
        assert_eq!(run(&mut e, &s, 0.0, 30.0), 20.0);
        let out = e.step(&s, 1.0, &r(&[]));
        assert_eq!(out[0].1, Out::Set(100.0));
    }

    #[test]
    fn mix_sensors_and_mix_curves() {
        let mut s = setup_with(Curve::flat("a", "A", 30.0));
        s.mixes.push(MixSensor { id: "m".into(), name: "M".into(), func: MixFn::Max, inputs: vec!["x".into(), "y".into()] });
        s.curves = vec![
            Curve::graph("g", "G", "mix:m", &PTS),
            Curve::flat("a", "A", 30.0),
            Curve { id: "mx".into(), name: "Mx".into(), kind: Kind::Mix { func: MixFn::Max, curves: vec!["g".into(), "a".into()] }, hyst: 0.0, resp: 0.0, skip_edges: true },
        ];
        s.controls[0].curve = Some("mx".into());
        let mut e = Engine::new();
        let out = e.step(&s, 0.0, &r(&[("x", 40.0), ("y", 60.0)]));
        assert_eq!(out[0].1, Out::Set(50.0), "max(40,60) = 60 -> 50 %, versus flat 30 %");
        assert_eq!(mix(MixFn::Sub, &[10.0, 3.0, 2.0]), Some(5.0));
        assert_eq!(mix(MixFn::Avg, &[10.0, 20.0]), Some(15.0));
    }

    #[test]
    fn sync_follows_another_control_with_an_offset() {
        let mut s = setup_with(Curve::flat("f", "F", 40.0));
        let mut second = s.controls[0].clone();
        second.id = "c1".into();
        second.curve = Some("sy".into());
        s.controls.push(second);
        s.curves.push(Curve { id: "sy".into(), name: "Sy".into(), kind: Kind::Sync { control: "c0".into(), offset: 10.0, proportional: false }, hyst: 0.0, resp: 0.0, skip_edges: true });
        let mut e = Engine::new();
        let first = e.step(&s, 0.0, &r(&[]));
        assert_eq!(first[0].1, Out::Set(40.0));
        let second = e.step(&s, 1.0, &r(&[]));
        assert_eq!(second[1].1, Out::Set(50.0));
    }

    #[test]
    fn trigger_holds_until_the_other_threshold() {
        let c = Curve { id: "tr".into(), name: "T".into(), kind: Kind::Trigger { src: "t".into(), idle_t: 40.0, load_t: 70.0, idle_pct: 30.0, load_pct: 80.0 }, hyst: 0.0, resp: 0.0, skip_edges: true };
        let s = setup_with(c);
        let mut e = Engine::new();
        assert_eq!(run(&mut e, &s, 0.0, 35.0), 30.0);
        assert_eq!(run(&mut e, &s, 1.0, 60.0), 30.0, "between: holds idle");
        assert_eq!(run(&mut e, &s, 2.0, 72.0), 80.0);
        assert_eq!(run(&mut e, &s, 3.0, 55.0), 80.0, "between: holds load");
        assert_eq!(run(&mut e, &s, 4.0, 38.0), 30.0);
    }

    #[test]
    fn auto_raises_while_hot_and_backs_off_slower_when_cooler() {
        let c = Curve { id: "au".into(), name: "A".into(), kind: Kind::Auto { src: "t".into(), idle_t: 40.0, load_t: 70.0, min: 20.0, max: 100.0, step: 10.0, deadband: 6.0 }, hyst: 0.0, resp: 1.0, skip_edges: true };
        let s = setup_with(c);
        let mut e = Engine::new();
        let a = run(&mut e, &s, 0.0, 72.0);
        let b = run(&mut e, &s, 2.0, 72.0);
        let c2 = run(&mut e, &s, 4.0, 72.0);
        assert!(b > a && c2 > b, "above the load temperature it keeps climbing: {a} {b} {c2}");
        assert!(c2 <= 100.0);
        let d = run(&mut e, &s, 6.0, 66.0);
        assert!(d < c2 && d >= c2 - 5.0 - 0.01, "backs off by half a step: {c2} -> {d}");
        // well below the load zone: linear again
        assert!(run(&mut e, &s, 8.0, 41.0) < 40.0);
    }

    #[test]
    fn auto_mode_releases_and_manual_is_shaped() {
        let mut s = setup_with(Curve::flat("f", "F", 50.0));
        s.controls[0].mode = Mode::Auto;
        let mut e = Engine::new();
        assert_eq!(e.step(&s, 0.0, &r(&[]))[0].1, Out::Release);
        s.controls[0].mode = Mode::Manual;
        s.controls[0].manual = 35.0;
        assert_eq!(e.step(&s, 1.0, &r(&[]))[0].1, Out::Set(35.0));
    }

    #[test]
    fn the_setup_round_trips_through_json() {
        let mut s = setup_with(Curve::graph("g", "G", "t", &PTS));
        s.curves.push(Curve { id: "tr".into(), name: "T".into(), kind: Kind::Trigger { src: "t".into(), idle_t: 40.0, load_t: 70.0, idle_pct: 30.0, load_pct: 80.0 }, hyst: 1.0, resp: 2.0, skip_edges: false });
        let j = serde_json::to_string(&s).unwrap();
        assert!(j.contains(r#""type":"graph""#), "{j}");
        assert_eq!(serde_json::from_str::<Setup>(&j).unwrap(), s);
        let minimal: Setup = serde_json::from_str("{}").unwrap();
        assert_eq!(minimal.failsafe, 100.0);
    }
}
