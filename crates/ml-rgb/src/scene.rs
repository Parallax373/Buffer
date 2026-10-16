//! The persisted RGB scene: the JSON the Advanced page keeps, plus what the recorder needs to render it (RGB-SCENE.md).
//! Unknown keys are carried along untouched, so UI-only state (camera, saved effects, ...) can live in the same object.

use crate::engine::{Layer, TAU32};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Mode {
    #[default]
    #[serde(rename = "simple")]
    Simple,
    /// the design artifact calls it "adv"
    #[serde(rename = "advanced", alias = "adv")]
    Advanced,
}

/// Names the OpenRGB device that shows a scene device: its name, and which of several with that name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub name: String,
    #[serde(default)]
    pub nth: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Device {
    #[serde(default)]
    pub id: u32,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ex: bool,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub z: f32,
    #[serde(default)]
    pub rot: f32,
    #[serde(default = "one")]
    pub sc: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<Link>,
    /// LED positions in cm in the device's own space; the built-in layout of `type` when absent
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pts: Option<Vec<[f32; 3]>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One static colour for an OpenRGB device (Simple mode).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Look {
    pub name: String,
    #[serde(default)]
    pub nth: u32,
    #[serde(default = "hue")]
    pub hue: f32,
    #[serde(default = "sat")]
    pub sat: f32,
    #[serde(default = "full")]
    pub br: f32,
    #[serde(default = "yes")]
    pub on: bool,
    /// "static", or an effect that needs no positions: "breathing", "rainbow", "wave"
    #[serde(default = "fx_static")]
    pub fx: String,
    #[serde(default = "one")]
    pub speed: f32,
}

fn fx_static() -> String {
    "static".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    #[serde(default)]
    pub mode: Mode,
    #[serde(default = "yes")]
    pub playing: bool,
    #[serde(default = "one")]
    pub speed: f32,
    #[serde(default = "full")]
    pub bright: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<u32>,
    #[serde(default = "origin")]
    pub origin: [f32; 3],
    #[serde(default)]
    pub devices: Vec<Device>,
    #[serde(default)]
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub simple: Vec<Look>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn yes() -> bool {
    true
}
fn one() -> f32 {
    1.0
}
fn full() -> f32 {
    100.0
}
fn hue() -> f32 {
    75.0
}
fn sat() -> f32 {
    90.0
}
fn origin() -> [f32; 3] {
    [0.0, 18.0, 0.0]
}

impl Default for Scene {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

/// What to show on one OpenRGB device: a fixed colour, or one position (cm, world space) per LED.
#[derive(Debug, Clone, PartialEq)]
pub struct DevPlan {
    /// index in OpenRGB's device list
    pub index: usize,
    pub fixed: Option<[u8; 3]>,
    /// Simple mode: the look, for the effects that move over time
    pub look: Option<Look>,
    pub pos: Vec<[f32; 3]>,
}

impl Look {
    /// HSL at lightness 0.55 (the page paints the same), scaled by `f` (0..1).
    fn hsl(hue: f32, sat: f32, f: f32) -> [u8; 3] {
        let l = 0.55f32;
        let a = sat / 100.0 * l.min(1.0 - l);
        let ch = |n: f32| {
            let k = (n + hue / 30.0).rem_euclid(12.0);
            l - a * (k - 3.0).min(9.0 - k).min(1.0).max(-1.0)
        };
        let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 * f.clamp(0.0, 1.0)).round().clamp(0.0, 255.0) as u8;
        [q(ch(0.0)), q(ch(8.0)), q(ch(4.0))]
    }

    /// The colour with the brightness applied (the same HSL formula the Simple page paints with).
    pub fn rgb(&self) -> [u8; 3] {
        Self::hsl(self.hue, self.sat, if self.on { self.br / 100.0 } else { 0.0 })
    }

    /// True for the effects that change over time (they need the render loop).
    pub fn animated(&self) -> bool {
        self.on && matches!(self.fx.as_str(), "breathing" | "rainbow" | "wave")
    }

    /// The colour of the LED at relative position `u` (0..1 along the device) at time `t` seconds.
    pub fn at(&self, t: f64, u: f32) -> [u8; 3] {
        if !self.on {
            return [0, 0, 0];
        }
        let s = self.speed.clamp(0.1, 5.0) as f64;
        let br = self.br / 100.0;
        let wave = |x: f64| (0.5 + 0.5 * (x * std::f64::consts::TAU).sin()) as f32;
        match self.fx.as_str() {
            "breathing" => Self::hsl(self.hue, self.sat, br * (0.1 + 0.9 * wave(t * 0.25 * s - 0.25))),
            "rainbow" => Self::hsl(((t * 45.0 * s) as f32 + u * 160.0).rem_euclid(360.0), self.sat.max(80.0), br),
            "wave" => Self::hsl(self.hue, self.sat, br * (0.08 + 0.92 * wave(u as f64 - t * 0.35 * s))),
            _ => self.rgb(),
        }
    }
}

/// The built-in LED layouts of the page's device types (cm; x right, y up, z to the front).
pub fn builtin_layout(kind: &str) -> Vec<[f32; 3]> {
    let line = |n: usize, len: f32, vertical: bool| -> Vec<[f32; 3]> {
        (0..n)
            .map(|i| {
                let u = (i as f32 / (n - 1) as f32 - 0.5) * len;
                if vertical { [0.0, u, 0.0] } else { [u, 0.0, 0.0] }
            })
            .collect()
    };
    match kind {
        "header" => line(12, 18.0, false),
        "gpu" => line(8, 28.0, false),
        "ram" => line(8, 13.0, true),
        "strip" => line(16, 24.0, false),
        "fan" => (0..8).map(|i| [(i as f32 / 8.0 * TAU32).cos() * 5.5, (i as f32 / 8.0 * TAU32).sin() * 5.5, 0.0]).collect(),
        "keyboard" => (0..120).map(|k| [((k % 20) as f32 - 9.5) * 1.8, 0.0, ((k / 20) as f32 - 2.5) * 1.8]).collect(),
        "headset" => vec![[-8.0, 3.0, -1.0], [-8.0, 3.0, 1.0], [8.0, 3.0, -1.0], [8.0, 3.0, 1.0]],
        _ => vec![[0.0; 3]],
    }
}

impl Device {
    /// World positions of `leds` LEDs. A layout with another LED count is resampled by index.
    pub fn world(&self, leds: usize) -> Vec<[f32; 3]> {
        let local = match &self.pts {
            Some(p) if !p.is_empty() => p.clone(),
            _ => builtin_layout(&self.kind),
        };
        let a = self.rot.to_radians();
        let (c, s) = (a.cos(), a.sin());
        (0..leds)
            .map(|i| {
                let p = local[(i * local.len() / leds.max(1)).min(local.len() - 1)];
                [self.x + (p[0] * c + p[2] * s) * self.sc, self.y + p[1] * self.sc, self.z + (-p[0] * s + p[2] * c) * self.sc]
            })
            .collect()
    }
}

/// Index of the `nth` device called `name` in `devs` (name, LED count).
pub fn resolve(devs: &[(&str, usize)], name: &str, nth: u32) -> Option<usize> {
    devs.iter().enumerate().filter(|(_, d)| d.0 == name).nth(nth as usize).map(|(i, _)| i)
}

impl Scene {
    pub fn fps(&self) -> u32 {
        self.fps.unwrap_or(30).clamp(5, 60)
    }

    /// Drops the look of one device: it is given back (the recorder restores its own lighting).
    pub fn remove_look(&mut self, name: &str, nth: u32) {
        self.simple.retain(|l| !(l.name == name && l.nth == nth));
    }

    /// Replaces (or adds) the look of one device and switches to Simple mode.
    pub fn set_look(&mut self, look: Look) {
        match self.simple.iter_mut().find(|l| l.name == look.name && l.nth == look.nth) {
            Some(l) => *l = look,
            None => self.simple.push(look),
        }
        self.mode = Mode::Simple;
    }

    /// What each driven device shows, given the OpenRGB device list as (name, LED count). Simple mode drives the
    /// devices that have a look, Advanced the ones with a link; a device is never planned twice.
    pub fn plan(&self, devs: &[(&str, usize)]) -> Vec<DevPlan> {
        let mut out: Vec<DevPlan> = Vec::new();
        let mut add = |p: DevPlan| {
            if !out.iter().any(|o| o.index == p.index) {
                out.push(p);
            }
        };
        match self.mode {
            Mode::Simple => {
                for l in &self.simple {
                    if let Some(index) = resolve(devs, &l.name, l.nth) {
                        add(DevPlan { index, fixed: Some(l.rgb()), look: Some(l.clone()), pos: Vec::new() });
                    }
                }
            }
            Mode::Advanced => {
                for d in &self.devices {
                    if let Some(link) = &d.link {
                        if let Some(index) = resolve(devs, &link.name, link.nth) {
                            add(DevPlan { index, fixed: None, look: None, pos: d.world(devs[index].1) });
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_object_is_a_scene_and_the_artifacts_shape_loads() {
        let s: Scene = serde_json::from_str("{}").unwrap();
        assert_eq!((s.mode, s.playing, s.speed, s.bright, s.fps()), (Mode::Simple, true, 1.0, 100.0, 30));
        // what the artifact keeps in localStorage: "adv", `bright`, UI-only keys, devices without link/pts
        let art = r##"{"mode":"adv","view":"3d","snap":2,"sel":1,"origin":[0,18,0],"speed":1,"bright":80,"fxName":"Scan",
          "devices":[{"id":1,"type":"gpu","name":"GPU","ex":true,"x":-30,"y":16,"z":0,"rot":90,"sc":1}],
          "layers":[{"on":true,"gen":"scan","p":{"speed":1,"scale":1,"rot":0,"axis":0,"mirror":false,"ease":0,"trail":0.55,"width":4},
                     "stops":[{"p":0,"c":"#38b6ff"},{"p":1,"c":"#e8f6ff"}],"blend":"add","opacity":1}]}"##;
        let s: Scene = serde_json::from_str(art).unwrap();
        assert_eq!((s.mode, s.bright, s.layers.len(), s.devices.len()), (Mode::Advanced, 80.0, 1, 1));
        let back = serde_json::to_value(&s).unwrap();
        assert_eq!(back["mode"], "advanced");
        assert_eq!(back["fxName"], "Scan", "unknown keys survive");
        assert_eq!(back["layers"][0]["stops"][0]["c"], "#38b6ff");
        assert_eq!(serde_json::from_value::<Scene>(back).unwrap(), s);
    }

    #[test]
    fn simple_colours_follow_the_pages_formula() {
        let look = |hue, sat, br, on| Look { name: "x".into(), nth: 0, hue, sat, br, on, fx: "static".into(), speed: 1.0 };
        assert_eq!(look(0.0, 90.0, 100.0, true).rgb(), [244, 37, 37]);
        assert_eq!(look(75.0, 90.0, 100.0, false).rgb(), [0, 0, 0]);
        assert_eq!(look(200.0, 0.0, 100.0, true).rgb(), [140, 140, 140]);
        let half = look(200.0, 0.0, 50.0, true).rgb();
        assert_eq!(half, [70, 70, 70]);
    }

    #[test]
    fn simple_effects_move_over_time_and_stay_in_range() {
        let mut l = Look { name: "x".into(), nth: 0, hue: 200.0, sat: 90.0, br: 100.0, on: true, fx: "static".into(), speed: 1.0 };
        assert!(!l.animated());
        assert_eq!(l.at(3.0, 0.5), l.rgb(), "static ignores time");
        for fx in ["breathing", "rainbow", "wave"] {
            l.fx = fx.into();
            assert!(l.animated());
            let a = l.at(0.0, 0.2);
            let b = l.at(1.7, 0.2);
            assert_ne!(a, b, "{fx} changes with time");
        }
        l.fx = "wave".into();
        assert_ne!(l.at(0.0, 0.0), l.at(0.0, 0.25), "a wave differs along the device");
        l.on = false;
        assert_eq!(l.at(1.0, 0.3), [0, 0, 0]);
        assert!(!l.animated(), "off needs no loop");
        let mut s = Scene::default();
        s.set_look(Look { name: "A".into(), nth: 0, hue: 1.0, sat: 1.0, br: 1.0, on: true, fx: "static".into(), speed: 1.0 });
        s.remove_look("A", 0);
        assert!(s.simple.is_empty());
        let old: Look = serde_json::from_str(r#"{"name":"A","hue":10}"#).unwrap();
        assert_eq!((old.fx.as_str(), old.speed), ("static", 1.0), "looks saved before effects still load");
    }

    #[test]
    fn plan_resolves_links_and_lays_out_leds() {
        let devs = [("Board", 12), ("Headset", 2), ("Headset", 2)];
        let mut s = Scene::default();
        s.mode = Mode::Advanced;
        let dev = |kind: &str, name: &str, nth, x| Device {
            id: 1, kind: kind.into(), name: name.into(), ex: false, x, y: 0.0, z: 0.0, rot: 0.0, sc: 1.0,
            link: Some(Link { name: name.into(), nth }), pts: None, extra: Map::new(),
        };
        s.devices = vec![dev("header", "Board", 0, 10.0), dev("headset", "Headset", 1, 0.0), dev("gpu", "Nope", 0, 0.0)];
        let p = s.plan(&devs);
        assert_eq!(p.iter().map(|d| (d.index, d.pos.len())).collect::<Vec<_>>(), [(0, 12), (2, 2)]);
        assert!((p[0].pos[0][0] - (10.0 - 9.0)).abs() < 1e-4 && (p[0].pos[11][0] - 19.0).abs() < 1e-4);
        // a 2 LED headset on a 4 point layout takes points 0 and 2
        assert_eq!(p[1].pos.iter().map(|q| q[0]).collect::<Vec<_>>(), [-8.0, 8.0]);
        // rotating by 90 degrees about y turns +x into -z
        let mut r = dev("header", "Board", 0, 0.0);
        r.rot = 90.0;
        let w = r.world(12);
        assert!(w[11][0].abs() < 1e-4 && (w[11][2] + 9.0).abs() < 1e-4);
        s.mode = Mode::Simple;
        s.set_look(Look { name: "Headset".into(), nth: 1, hue: 75.0, sat: 90.0, br: 100.0, on: true, fx: "static".into(), speed: 1.0 });
        assert_eq!(s.plan(&devs).iter().map(|d| d.index).collect::<Vec<_>>(), [2]);
        assert!(s.plan(&devs)[0].fixed.is_some());
    }
}
