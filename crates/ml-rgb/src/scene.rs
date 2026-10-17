//! The persisted RGB scene: the JSON the Advanced page keeps, plus what the recorder needs to render it (RGB-SCENE.md).
//! Unknown keys are carried along untouched, so UI-only state (camera, saved effects, ...) can live in the same object.

use crate::engine::{scan_extent, Layer, TAU32};
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
    /// own brightness of this device, 0..100 (on top of the scene's)
    #[serde(default = "full")]
    pub trim: f32,
    /// this device shows the effect `delay` ms later than the rest
    #[serde(default)]
    pub delay: f32,
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
    /// second colour (hue, saturation) for breathing and wave, and for the device's own effects that take colours
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c2: Option<[f32; 2]>,
    /// the effect travels the other way (wave, rainbow, a device effect with a direction)
    #[serde(default)]
    pub rev: bool,
    /// name of one of the device's own OpenRGB modes (it runs the effect itself); then `fx` is "native"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<String>,
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
    /// devices (key "name#n") placed in the scene that Buffer leaves alone: they show their own lighting ("Give back")
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub free: Vec<String>,
    /// the scene is in the merged form (one scene, Simple and Advanced are two views of it); see `migrate`
    #[serde(default)]
    pub merged: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The key of the `nth` OpenRGB device called `name` (as in `hidden`, `calib`, `free`).
pub fn dev_key(name: &str, nth: u32) -> String {
    format!("{name}#{nth}")
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
    /// Advanced: the layers that act on this device, when some skip it (None = all the scene's layers)
    pub layers: Option<Vec<Layer>>,
    /// Advanced: multiplier after the effect (the device's own brightness), 1.0 = unchanged
    pub gain: f32,
    /// Advanced: seconds this device runs behind the scene
    pub delay: f64,
}

impl DevPlan {
    /// A device that shows one colour (or a Simple look).
    pub fn fixed(index: usize, color: [u8; 3], look: Option<Look>) -> Self {
        DevPlan { index, fixed: Some(color), look, pos: Vec::new(), layers: None, gain: 1.0, delay: 0.0 }
    }
}

impl Look {
    /// HSV with full value (saturation 0 is white, like the page's colour wheel), scaled by `f` (0..1).
    fn hsv(hue: f32, sat: f32, f: f32) -> [u8; 3] {
        let c = (sat / 100.0).clamp(0.0, 1.0);
        let h = hue.rem_euclid(360.0) / 60.0;
        let x = c * (1.0 - ((h % 2.0) - 1.0).abs());
        let (r, g, b) = match h as u32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = 1.0 - c;
        let q = |v: f32| ((v + m) * 255.0 * f.clamp(0.0, 1.0)).round().clamp(0.0, 255.0) as u8;
        [q(r), q(g), q(b)]
    }

    /// The colour with the brightness applied (the same HSL formula the Simple page paints with).
    pub fn rgb(&self) -> [u8; 3] {
        Self::hsv(self.hue, self.sat, if self.on { self.br / 100.0 } else { 0.0 })
    }

    /// True for the effects that change over time (they need the render loop).
    pub fn animated(&self) -> bool {
        self.on && matches!(self.fx.as_str(), "breathing" | "rainbow" | "wave")
    }

    /// The device runs its own mode (see `native`).
    pub fn is_native(&self) -> bool {
        self.on && self.native.is_some()
    }

    /// Colour 1 and colour 2 at full brightness (colour 2 falls back to colour 1).
    pub fn colors(&self) -> ([u8; 3], [u8; 3]) {
        let a = Self::hsv(self.hue, self.sat, 1.0);
        let b = self.c2.map(|c| Self::hsv(c[0], c[1], 1.0)).unwrap_or(a);
        (a, b)
    }

    /// The colour of the LED at relative position `u` (0..1 along the device) at time `t` seconds.
    pub fn at(&self, t: f64, u: f32) -> [u8; 3] {
        if !self.on {
            return [0, 0, 0];
        }
        let s = self.speed.clamp(0.1, 5.0) as f64;
        let br = self.br / 100.0;
        let wave = |x: f64| (0.5 + 0.5 * (x * std::f64::consts::TAU).sin()) as f32;
        let u = if self.rev { 1.0 - u } else { u };
        // two colours: the effect blends between them at full brightness instead of dimming
        let mix = |w: f32| {
            let (a, b) = self.colors();
            let m = |i: usize| ((a[i] as f32 + (b[i] as f32 - a[i] as f32) * w) * br).round().clamp(0.0, 255.0) as u8;
            [m(0), m(1), m(2)]
        };
        match self.fx.as_str() {
            "breathing" if self.c2.is_some() => mix(wave(t * 0.25 * s - 0.25)),
            "breathing" => Self::hsv(self.hue, self.sat, br * (0.1 + 0.9 * wave(t * 0.25 * s - 0.25))),
            "rainbow" => Self::hsv(((t * 45.0 * s) as f32 + u * 160.0).rem_euclid(360.0), self.sat.max(80.0), br),
            "wave" if self.c2.is_some() => mix(wave(u as f64 - t * 0.35 * s)),
            "wave" => Self::hsv(self.hue, self.sat, br * (0.08 + 0.92 * wave(u as f64 - t * 0.35 * s))),
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
    /// World positions of `leds` LEDs. A layout with more points than LEDs gives each LED the middle of its group of
    /// points (a board OpenRGB sees as one LED, laid over three fans, takes its colour at their middle; the page's
    /// preview uses the same rule); one with fewer points is resampled by index.
    pub fn world(&self, leds: usize) -> Vec<[f32; 3]> {
        let local = match &self.pts {
            Some(p) if !p.is_empty() => p.clone(),
            _ => builtin_layout(&self.kind),
        };
        let a = self.rot.to_radians();
        let (c, s) = (a.cos(), a.sin());
        let n = local.len();
        (0..leds)
            .map(|i| {
                let p = if leds < n {
                    let (a, b) = (i * n / leds, ((i + 1) * n / leds).max(i * n / leds + 1));
                    let k = (b - a) as f32;
                    local[a..b].iter().fold([0.0f32; 3], |m, q| [m[0] + q[0] / k, m[1] + q[1] / k, m[2] + q[2] / k])
                } else {
                    local[(i * n / leds.max(1)).min(n - 1)]
                };
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
    /// There is an effect to follow: at least one layer is on (all off = placed devices show their own lighting, not black).
    pub fn has_effect(&self) -> bool {
        self.layers.iter().any(|l| l.on)
    }

    /// Tells every Scan layer where the driven devices are along its direction (its own layers and the copies in the
    /// plans), so a sweep covers the whole layout and not a fixed 160 cm around the origin. Run after `plan`.
    pub fn fit(&mut self, plans: &mut [DevPlan]) {
        let positions: Vec<[f32; 3]> = plans.iter().filter(|p| p.fixed.is_none()).flat_map(|p| p.pos.iter().copied()).collect();
        let origin = self.origin;
        for l in self.layers.iter_mut() {
            l.ext = scan_extent(l, origin, &positions);
        }
        for p in plans.iter_mut() {
            for l in p.layers.iter_mut().flatten() {
                l.ext = scan_extent(l, origin, &positions);
            }
        }
    }

    fn has_look(&self, key: &str) -> bool {
        self.simple.iter().any(|l| dev_key(&l.name, l.nth) == key)
    }

    /// The placed devices that follow the effect (linked, not given back, no look of their own), by key.
    fn scene_keys(&self) -> Vec<String> {
        if !self.has_effect() {
            return Vec::new();
        }
        self.devices
            .iter()
            .filter_map(|d| d.link.as_ref().map(|l| dev_key(&l.name, l.nth)))
            .filter(|k| !self.free.contains(k) && !self.has_look(k))
            .collect()
    }

    /// How many devices this scene drives: the ones with a look of their own, and the ones that follow the effect.
    pub fn driven_count(&self) -> usize {
        self.simple.len() + self.scene_keys().len()
    }

    /// Simple and Advanced used to be two scenes in one, and only `mode`'s one was shown. Now both are one scene: a
    /// device's own look wins, a placed device without one follows the effect, `free` ones are left alone, and `mode`
    /// is only the view that is open. The old form is turned into the new one so that exactly what was lit stays lit:
    /// a Simple scene gives back every placed device without a look; an Advanced scene's looks were not shown, so they
    /// are put aside (`simple_before_merge`), not lost. Runs once (`merged`).
    pub fn migrate(&mut self) {
        if self.merged {
            return;
        }
        match self.mode {
            Mode::Simple => {
                let keys: Vec<String> = self.devices.iter().filter_map(|d| d.link.as_ref().map(|l| dev_key(&l.name, l.nth))).collect();
                for k in keys {
                    if !self.has_look(&k) && !self.free.contains(&k) {
                        self.free.push(k);
                    }
                }
            }
            Mode::Advanced => {
                if !self.simple.is_empty() {
                    self.extra.insert("simple_before_merge".into(), serde_json::to_value(&self.simple).unwrap_or_default());
                    self.simple.clear();
                }
            }
        }
        self.merged = true;
    }

    pub fn fps(&self) -> u32 {
        self.fps.unwrap_or(30).clamp(5, 60)
    }

    /// Gives one device back: its look goes, and if it is placed it does not follow the effect either; it shows its
    /// own lighting (the recorder restores it).
    pub fn remove_look(&mut self, name: &str, nth: u32) {
        self.simple.retain(|l| !(l.name == name && l.nth == nth));
        let k = dev_key(name, nth);
        let placed = self.devices.iter().any(|d| d.link.as_ref().is_some_and(|l| l.name == name && l.nth == nth));
        if placed && !self.free.contains(&k) {
            self.free.push(k);
        }
    }

    /// One device follows the scene's effect again: no look of its own, not given back.
    pub fn follow_scene(&mut self, name: &str, nth: u32) {
        self.simple.retain(|l| !(l.name == name && l.nth == nth));
        let k = dev_key(name, nth);
        self.free.retain(|f| f != &k);
    }

    /// Replaces (or adds) the look of one device: its own colour, over the effect. The open view (`mode`) stays.
    pub fn set_look(&mut self, look: Look) {
        let k = dev_key(&look.name, look.nth);
        self.free.retain(|f| f != &k);
        match self.simple.iter_mut().find(|l| l.name == look.name && l.nth == look.nth) {
            Some(l) => *l = look,
            None => self.simple.push(look),
        }
    }

    /// What each driven device shows, given the OpenRGB device list as (name, LED count), whatever view is open: a
    /// device's own look first, then the effect for placed devices that are not given back; a device is never planned
    /// twice.
    pub fn plan(&self, devs: &[(&str, usize)]) -> Vec<DevPlan> {
        let mut out: Vec<DevPlan> = Vec::new();
        let mut add = |p: DevPlan| {
            if !out.iter().any(|o| o.index == p.index) {
                out.push(p);
            }
        };
        for l in &self.simple {
            if let Some(index) = resolve(devs, &l.name, l.nth) {
                add(DevPlan::fixed(index, l.rgb(), Some(l.clone())));
            }
        }
        if self.has_effect() {
            for d in &self.devices {
                if let Some(link) = d.link.as_ref().filter(|l| !self.free.contains(&dev_key(&l.name, l.nth))) {
                    if let Some(index) = resolve(devs, &link.name, link.nth) {
                        let layers = self.layers.iter().any(|l| l.skip.contains(&d.id)).then(|| self.layers.iter().filter(|l| !l.skip.contains(&d.id)).cloned().collect());
                        let gain = (d.trim / 100.0).clamp(0.0, 1.0);
                        add(DevPlan { index, fixed: None, look: None, pos: d.world(devs[index].1), layers, gain, delay: (d.delay.clamp(-1000.0, 5000.0) / 1000.0) as f64 });
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
        let look = |hue, sat, br, on| Look { name: "x".into(), nth: 0, hue, sat, br, on, fx: "static".into(), speed: 1.0, c2: None, rev: false, native: None };
        assert_eq!(look(0.0, 90.0, 100.0, true).rgb(), [255, 26, 26]);
        assert_eq!(look(120.0, 100.0, 100.0, true).rgb(), [0, 255, 0]);
        assert_eq!(look(75.0, 90.0, 100.0, false).rgb(), [0, 0, 0]);
        assert_eq!(look(200.0, 0.0, 100.0, true).rgb(), [255, 255, 255], "no saturation is white");
        assert_eq!(look(200.0, 0.0, 50.0, true).rgb(), [128, 128, 128]);
    }

    #[test]
    fn simple_effects_move_over_time_and_stay_in_range() {
        let mut l = Look { name: "x".into(), nth: 0, hue: 200.0, sat: 90.0, br: 100.0, on: true, fx: "static".into(), speed: 1.0, c2: None, rev: false, native: None };
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
        // a second colour blends between the two instead of dimming; reversing flips the wave along the device
        l.fx = "wave".into();
        l.c2 = Some([0.0, 100.0]);
        let (a, b) = l.colors();
        let end = l.at(0.0, 0.25);
        assert!(end.iter().zip(a.iter().zip(&b)).all(|(x, (p, q))| *x >= *p.min(q) && *x <= *p.max(q)), "stays between the two colours");
        let fwd = l.at(0.7, 0.2);
        l.rev = true;
        assert_eq!(l.at(0.7, 0.8), fwd, "reversed is the mirror image");
        l.rev = false;
        l.on = false;
        assert_eq!(l.at(1.0, 0.3), [0, 0, 0]);
        assert!(!l.animated(), "off needs no loop");
        let mut s = Scene::default();
        s.set_look(Look { name: "A".into(), nth: 0, hue: 1.0, sat: 1.0, br: 1.0, on: true, fx: "static".into(), speed: 1.0, c2: None, rev: false, native: None });
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
            link: Some(Link { name: name.into(), nth }), pts: None, trim: 100.0, delay: 0.0, extra: Map::new(),
        };
        s.devices = vec![dev("header", "Board", 0, 10.0), dev("headset", "Headset", 1, 0.0), dev("gpu", "Nope", 0, 0.0)];
        assert!(s.plan(&devs).is_empty(), "no effect (no layers): placed devices are not driven");
        s.layers = serde_json::from_str(r##"[{"gen":"solid","stops":[{"p":0,"c":"#ffffff"},{"p":1,"c":"#ffffff"}]}]"##).unwrap();
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
        // one scene, whatever view is open: a look of its own wins over the effect; the view (mode) changes nothing
        s.set_look(Look { name: "Headset".into(), nth: 1, hue: 75.0, sat: 90.0, br: 100.0, on: true, fx: "static".into(), speed: 1.0, c2: None, rev: false, native: None });
        assert_eq!(s.mode, Mode::Advanced, "setting a look does not switch the view");
        let p = s.plan(&devs);
        assert_eq!(p.iter().map(|d| (d.index, d.fixed.is_some())).collect::<Vec<_>>(), [(2, true), (0, false)]);
        s.mode = Mode::Simple;
        assert_eq!(s.plan(&devs).len(), 2, "the Simple view drives the same");
        // give back: no look and not the effect either; follow the scene again: the effect
        s.remove_look("Headset", 1);
        assert_eq!(s.plan(&devs).iter().map(|d| d.index).collect::<Vec<_>>(), [0]);
        assert_eq!(s.free, ["Headset#1"]);
        s.follow_scene("Headset", 1);
        assert_eq!(s.plan(&devs).iter().map(|d| (d.index, d.fixed.is_some())).collect::<Vec<_>>(), [(0, false), (2, false)]);
        assert_eq!(s.driven_count(), 3, "counts what the scene drives, also a placed device OpenRGB does not see now");
        // every layer off: no effect, the placed devices are given back (not driven black)
        s.layers.iter_mut().for_each(|l| l.on = false);
        assert!(s.plan(&devs).is_empty() && s.driven_count() == 0);
    }

    #[test]
    fn migration_keeps_what_was_lit() {
        let base = r##"{"devices":[{"id":1,"type":"gpu","link":{"name":"G"}},{"id":2,"type":"ram","link":{"name":"R"}}],
            "layers":[{"gen":"solid","stops":[{"p":0,"c":"#ffffff"},{"p":1,"c":"#ffffff"}]}],
            "simple":[{"name":"R","hue":10}]"##;
        let devs = [("G", 8), ("R", 10)];
        let drive = |s: &Scene| s.plan(&devs).iter().map(|p| (p.index, p.fixed.is_some())).collect::<Vec<_>>();
        // a Simple scene showed only its looks: the placed device without one is given back
        let mut s: Scene = serde_json::from_str(&format!("{base},\"mode\":\"simple\"}}")).unwrap();
        s.migrate();
        assert_eq!((drive(&s), s.free.clone(), s.merged), (vec![(1, true)], vec!["G#0".to_string()], true));
        // an Advanced scene showed only its effect: its looks are put aside, not lost
        let mut a: Scene = serde_json::from_str(&format!("{base},\"mode\":\"advanced\"}}")).unwrap();
        a.migrate();
        assert_eq!(drive(&a), [(0, false), (1, false)]);
        assert!(a.simple.is_empty() && a.extra["simple_before_merge"][0]["name"] == "R");
        // once only, and it survives a round trip
        let again = { let mut x = a.clone(); x.migrate(); x };
        assert_eq!(again, a);
        let back: Scene = serde_json::from_value(serde_json::to_value(&a).unwrap()).unwrap();
        assert_eq!(back, a);
    }

    #[test]
    fn per_device_layers_brightness_and_delay() {
        let j = r##"{"mode":"advanced","devices":[
            {"id":1,"type":"gpu","name":"G","x":0,"y":0,"z":0,"link":{"name":"GPU"}},
            {"id":2,"type":"ram","name":"R","x":0,"y":0,"z":0,"link":{"name":"RAM"},"trim":50,"delay":250}],
          "layers":[{"gen":"solid","stops":[{"p":0,"c":"#ffffff"},{"p":1,"c":"#ffffff"}]},
                    {"gen":"wave","skip":[2],"stops":[{"p":0,"c":"#000000"},{"p":1,"c":"#ff0000"}]}]}"##;
        let s: Scene = serde_json::from_str(j).unwrap();
        let p = s.plan(&[("GPU", 8), ("RAM", 10)]);
        assert!(p[0].layers.is_none(), "a device no layer skips uses the scene's layers");
        assert_eq!((p[0].gain, p[0].delay), (1.0, 0.0));
        let only = p[1].layers.as_ref().expect("the RAM is skipped by the wave");
        assert_eq!(only.len(), 1);
        assert_eq!(p[1].gain, 0.5);
        assert!((p[1].delay - 0.25).abs() < 1e-9);
        // the new fields round-trip, and a scene saved before them still loads with neutral values
        let back: Scene = serde_json::from_value(serde_json::to_value(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        let old: Device = serde_json::from_str(r#"{"id":3,"type":"fan"}"#).unwrap();
        assert_eq!((old.trim, old.delay), (100.0, 0.0));
        assert!(!serde_json::to_string(&s.layers[0]).unwrap().contains("skip"), "an empty skip list is not written");
    }

    #[test]
    fn fewer_leds_than_points_take_the_middle_of_their_group() {
        // a board OpenRGB sees as one LED, laid over two fan rings (points at x = 0 and x = 10): its LED sits in between
        let d: Device = serde_json::from_str(r#"{"id":1,"type":"header","x":0,"y":0,"z":0,"pts":[[0,1,0],[0,-1,0],[10,1,0],[10,-1,0]]}"#).unwrap();
        let one = d.world(1);
        assert_eq!(one.len(), 1);
        assert!((one[0][0] - 5.0).abs() < 1e-5 && one[0][1].abs() < 1e-5);
        // two LEDs: one per ring
        let two = d.world(2);
        assert!((two[0][0] - 0.0).abs() < 1e-5 && (two[1][0] - 10.0).abs() < 1e-5);
        // more LEDs than points: resampled by index as before
        assert_eq!(d.world(8).len(), 8);
    }
}
