//! The effect engine: `color_at(layers, position, t, env)` is a pure function of a point in space and a time, with no
//! allocation and no randomness. It is a port of the JS engine in the Advanced RGB page (same maths, same constants,
//! computed in f64 like JS), so the page's preview and the lights show the same thing. See RGB-SCENE.md for the data.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

const TAU: f64 = std::f64::consts::PI * 2.0;
pub const TAU32: f32 = std::f32::consts::PI * 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Gen {
    Wave,
    Radial,
    Rainbow,
    Noise,
    Scan,
    Solid,
    Sparkle,
    Audio,
}

impl Gen {
    /// These use their value as coverage as well (a dark gap stays dark instead of being tinted by the gradient's start).
    fn is_mask(self) -> bool {
        matches!(self, Gen::Radial | Gen::Scan | Gen::Sparkle | Gen::Audio)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Blend {
    Add,
    Mix,
    Multiply,
    Max,
}

/// `#rrggbb` in JSON, bytes in memory (parsed once, not per frame).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Color(pub [u8; 3]);

impl Serialize for Color {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("#{:02x}{:02x}{:02x}", self.0[0], self.0[1], self.0[2]))
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        let h = s.strip_prefix('#').unwrap_or(&s);
        let v = |i: usize, w: usize| u8::from_str_radix(&h[i..i + w], 16).map_err(de::Error::custom);
        match h.len() {
            6 if h.is_ascii() => Ok(Color([v(0, 2)?, v(2, 2)?, v(4, 2)?])),
            3 if h.is_ascii() => Ok(Color([v(0, 1)? * 17, v(1, 1)? * 17, v(2, 1)? * 17])),
            _ => Err(de::Error::custom(format!("bad colour '{s}'"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Stop {
    pub p: f32,
    pub c: Color,
}

/// Per-layer parameters; the defaults are the page's `dflt()`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Params {
    pub speed: f32,
    pub scale: f32,
    pub rot: f32,
    pub axis: u8,
    pub mirror: bool,
    pub ease: f32,
    pub trail: f32,
    pub width: f32,
}

impl Default for Params {
    fn default() -> Self {
        Params { speed: 1.0, scale: 1.0, rot: 0.0, axis: 0, mirror: false, ease: 0.0, trail: 0.5, width: 6.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    #[serde(default = "yes")]
    pub on: bool,
    #[serde(rename = "gen")]
    pub kind: Gen,
    #[serde(default)]
    pub p: Params,
    pub stops: Vec<Stop>,
    #[serde(default = "add")]
    pub blend: Blend,
    #[serde(default = "one")]
    pub opacity: f32,
    /// scene device ids this layer does not act on (the Advanced page's "Applies to"); kept on the layer so it
    /// follows the layer when layers are reordered, copied or deleted
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skip: Vec<u32>,
}

fn yes() -> bool {
    true
}
fn add() -> Blend {
    Blend::Add
}
fn one() -> f32 {
    1.0
}

/// What the engine needs besides the layers: origin of Radial/Scan (cm), audio level 0..1, brightness 0..1.
#[derive(Debug, Clone, Copy)]
pub struct Env {
    pub origin: [f32; 3],
    pub level: f32,
    pub bright: f32,
}

fn clamp(v: f64, a: f64, b: f64) -> f64 {
    v.max(a).min(b)
}

fn fract(x: f64) -> f64 {
    x - x.floor()
}

/// Gradient at `v` (0..1), channels 0..255.
fn grad_at(st: &[Stop], v: f64) -> [f64; 3] {
    let ch = |c: &Color| [c.0[0] as f64, c.0[1] as f64, c.0[2] as f64];
    let n = st.len();
    if n == 0 {
        return [0.0; 3];
    }
    if v <= st[0].p as f64 {
        return ch(&st[0].c);
    }
    if v >= st[n - 1].p as f64 {
        return ch(&st[n - 1].c);
    }
    for i in 1..n {
        if v <= st[i].p as f64 {
            let (a, b) = (&st[i - 1], &st[i]);
            let u = (v - a.p as f64) / (b.p as f64 - a.p as f64).max(1e-6);
            let (ca, cb) = (ch(&a.c), ch(&b.c));
            return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u];
        }
    }
    [0.0; 3]
}

/// JS `x | 0`: truncate, wrap into 32 bits, NaN is 0.
fn to_i32(x: f64) -> i32 {
    if x.is_finite() {
        (x as i64) as i32
    } else {
        0
    }
}

/// Integer hash of a lattice point to [0, 1).
fn h3(x: f64, y: f64, z: f64) -> f64 {
    let mut h = (to_i32(x).wrapping_mul(73856093) ^ to_i32(y).wrapping_mul(19349663) ^ to_i32(z).wrapping_mul(83492791)) as u32;
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    h ^= h >> 16;
    h as f64 / 4294967296.0
}

fn vnoise(x: f64, y: f64, z: f64) -> f64 {
    let (ix, iy, iz) = (x.floor(), y.floor(), z.floor());
    let s = |f: f64| f * f * (3.0 - 2.0 * f);
    let (fx, fy, fz) = (s(x - ix), s(y - iy), s(z - iz));
    let l = |a: f64, b: f64, u: f64| a + (b - a) * u;
    l(
        l(l(h3(ix, iy, iz), h3(ix + 1.0, iy, iz), fx), l(h3(ix, iy + 1.0, iz), h3(ix + 1.0, iy + 1.0, iz), fx), fy),
        l(l(h3(ix, iy, iz + 1.0), h3(ix + 1.0, iy, iz + 1.0), fx), l(h3(ix, iy + 1.0, iz + 1.0), h3(ix + 1.0, iy + 1.0, iz + 1.0), fx), fy),
        fz,
    )
}

/// One layer's generator: position (cm) and time (s) to 0..1.
fn gen_value(l: &Layer, pos: [f64; 3], t: f64, env: &Env) -> f64 {
    let p = &l.p;
    let (speed, sc) = (p.speed as f64, p.scale as f64);
    let tl = t * speed;
    let o = env.origin;
    let (dx, dy, dz) = (pos[0] - o[0] as f64, pos[1] - o[1] as f64, pos[2] - o[2] as f64);
    let an = p.rot as f64 * std::f64::consts::PI / 180.0;
    let (ca, sa) = (an.cos(), an.sin());
    let (ux, uy, uz) = match p.axis {
        0 => (ca, 0.0, sa),
        1 => (sa, ca, 0.0),
        _ => (sa, 0.0, ca),
    };
    let s0 = dx * ux + dy * uy + dz * uz;
    let s = if p.mirror { s0.abs() } else { s0 };
    let mut v = match l.kind {
        Gen::Wave => 0.5 + 0.5 * (TAU * (s / (30.0 / sc) - tl * 0.5)).sin(),
        Gen::Rainbow => fract(s / (80.0 / sc) - tl * 0.2),
        Gen::Solid => 1.0 - (2.0 * fract(tl * 0.15) - 1.0).abs(),
        Gen::Radial => {
            let d = (dx * dx + dy * dy + dz * dz).sqrt();
            let r = 90.0 / sc;
            let x = d - ((tl * 22.0) % r + r) % r;
            if x >= 0.0 {
                (-(x * x) / (p.width as f64 * 0.5 + 0.5).powi(2)).exp()
            } else {
                (x / (p.trail as f64 * 40.0 + 0.5)).exp()
            }
        }
        Gen::Noise => {
            let lam = 24.0 / sc;
            let al = s0 / lam;
            let k = -0.6 * al - tl * 1.5;
            let n = vnoise(dx / lam + ux * k, dy / lam + uy * k, dz / lam + uz * k);
            clamp((n - 0.25) * 1.8, 0.0, 1.0)
        }
        // quantised into 3 cm bars: head plus a faded trail behind it, like the logo
        Gen::Scan => {
            let sg = if speed >= 0.0 { 1.0 } else { -1.0 };
            let (span, lo) = if p.mirror { (80.0, 0.0) } else { (160.0, -80.0) };
            let head = lo + span * fract(tl * 0.3);
            let back = ((head - s) * sg / 3.0).floor() * 3.0;
            let w = p.width as f64;
            if back < 0.0 {
                0.0
            } else if back <= w {
                1.0
            } else {
                (-(back - w) / (p.trail as f64 * 45.0 + 1.0)).exp() * 0.85
            }
        }
        Gen::Sparkle => {
            let cs = 2.0 / sc;
            let (cx, cy, cz) = ((pos[0] / cs).floor(), (pos[1] / cs).floor(), (pos[2] / cs).floor());
            let a = h3(cx, cy, cz);
            let b = h3(cz + 91.0, cx + 17.0, cy + 5.0);
            let ph = fract(tl * 0.6 + a);
            if b > p.width as f64 / 10.0 {
                0.0
            } else if ph < 0.1 {
                ph / 0.1
            } else {
                (-(ph - 0.1) / (0.04 + p.trail as f64 * 0.4)).exp()
            }
        }
        // bars along the axis up to the input level
        Gen::Audio => {
            let u = if p.mirror { s / 80.0 } else { (s + 80.0) / 160.0 };
            let uq = (clamp(u, 0.0, 1.0) * 24.0).floor() / 24.0;
            let lv = env.level as f64;
            if uq < lv {
                0.35 + 0.65 * uq / lv.max(0.05)
            } else {
                0.0
            }
        }
    };
    if p.ease > 0.0 {
        v = clamp(v, 0.0, 1.0).powf(1.0 + p.ease as f64 * 3.0);
    }
    v
}

/// Colour (r, g, b, 0..255) of the stacked layers at a point. `t` is seconds. Non-finite input gives black, never NaN.
pub fn color_at(layers: &[Layer], pos: [f32; 3], t: f64, env: &Env) -> [f32; 3] {
    let pos = [pos[0] as f64, pos[1] as f64, pos[2] as f64];
    let (mut r, mut g, mut b) = (0.0f64, 0.0f64, 0.0f64);
    for l in layers {
        if !l.on {
            continue;
        }
        let v = clamp(gen_value(l, pos, t, env), 0.0, 1.0);
        let c = grad_at(&l.stops, v);
        let a = if l.kind.is_mask() { v } else { 1.0 } * l.opacity as f64;
        match l.blend {
            Blend::Add => {
                r += c[0] * a;
                g += c[1] * a;
                b += c[2] * a;
            }
            Blend::Mix => {
                r = r * (1.0 - a) + c[0] * a;
                g = g * (1.0 - a) + c[1] * a;
                b = b * (1.0 - a) + c[2] * a;
            }
            Blend::Multiply => {
                r = r * (1.0 - a) + r * c[0] / 255.0 * a;
                g = g * (1.0 - a) + g * c[1] / 255.0 * a;
                b = b * (1.0 - a) + b * c[2] / 255.0 * a;
            }
            Blend::Max => {
                r = r.max(c[0] * a);
                g = g.max(c[1] * a);
                b = b.max(c[2] * a);
            }
        }
    }
    let k = env.bright as f64;
    let out = |x: f64| {
        let v = (x * k).min(255.0);
        if v.is_finite() {
            v.max(0.0) as f32
        } else {
            0.0
        }
    };
    [out(r), out(g), out(b)]
}

/// 0..255 float colour to the bytes OpenRGB takes.
pub fn to_bytes(c: [f32; 3]) -> [u8; 3] {
    [c[0].round() as u8, c[1].round() as u8, c[2].round() as u8]
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENV: Env = Env { origin: [0.0, 18.0, 0.0], level: 0.6, bright: 1.0 };

    fn layer(kind: Gen, p: Params, a: &str, b: &str, blend: Blend, opacity: f32) -> Layer {
        let col = |s: &str| serde_json::from_value::<Color>(serde_json::json!(s)).unwrap();
        Layer { on: true, kind, p, stops: vec![Stop { p: 0.0, c: col(a) }, Stop { p: 1.0, c: col(b) }], blend, opacity, skip: Vec::new() }
    }

    fn all() -> Vec<Layer> {
        let q = Params::default();
        vec![
            layer(Gen::Wave, Params { rot: 25.0, axis: 1, ..q }, "#06241c", "#38b6ff", Blend::Mix, 1.0),
            layer(Gen::Radial, Params { width: 8.0, trail: 0.6, ..q }, "#8a6bff", "#ff5fd2", Blend::Add, 1.0),
            layer(Gen::Rainbow, Params { mirror: true, ..q }, "#ff4d4d", "#38b6ff", Blend::Max, 0.5),
            layer(Gen::Noise, Params { ease: 0.6, axis: 2, ..q }, "#000000", "#8a6bff", Blend::Multiply, 0.8),
            layer(Gen::Scan, Params { speed: -0.8, width: 3.0, trail: 0.8, ..q }, "#c6f432", "#ffffff", Blend::Add, 1.0),
            layer(Gen::Solid, q, "#120a1e", "#38b6ff", Blend::Add, 0.3),
            layer(Gen::Sparkle, Params { width: 6.0, ..q }, "#ffffff", "#ffffff", Blend::Add, 1.0),
            layer(Gen::Audio, q, "#2ee6a8", "#ff4d4d", Blend::Add, 1.0),
        ]
    }

    #[test]
    fn every_generator_is_finite_and_in_range() {
        let ls = all();
        for i in 0..400 {
            let f = i as f32;
            let pos = [(f * 0.7).sin() * 70.0, (f * 0.3).cos() * 30.0 + 20.0, (f * 1.3).sin() * 40.0];
            for l in &ls {
                for t in [0.0, 0.37, 12.5, 1e5] {
                    let c = color_at(std::slice::from_ref(l), pos, t, &ENV);
                    assert!(c.iter().all(|v| v.is_finite() && (0.0..=255.0).contains(v)), "{:?} {c:?}", l.kind);
                }
            }
            let c = color_at(&ls, pos, i as f64 * 0.11, &ENV);
            assert!(c.iter().all(|v| v.is_finite() && (0.0..=255.0).contains(v)));
        }
        assert_eq!(color_at(&ls, [f32::NAN, 0.0, f32::INFINITY], 1.0, &ENV).iter().filter(|v| v.is_nan()).count(), 0);
    }

    #[test]
    fn it_is_deterministic_and_off_layers_do_nothing() {
        let mut ls = all();
        let a = color_at(&ls, [3.0, 4.0, 5.0], 2.5, &ENV);
        assert_eq!(a, color_at(&ls, [3.0, 4.0, 5.0], 2.5, &ENV));
        ls.iter_mut().for_each(|l| l.on = false);
        assert_eq!(color_at(&ls, [3.0, 4.0, 5.0], 2.5, &ENV), [0.0; 3]);
        assert_eq!(color_at(&[], [0.0; 3], 0.0, &ENV), [0.0; 3]);
    }

    #[test]
    fn brightness_scales_and_clips() {
        let ls = [layer(Gen::Solid, Params { speed: 0.0, ..Params::default() }, "#ff8000", "#ff8000", Blend::Add, 1.0)];
        let half = color_at(&ls, [0.0; 3], 0.0, &Env { bright: 0.5, ..ENV });
        assert_eq!(to_bytes(half), [128, 64, 0]);
        let over = color_at(&ls, [0.0; 3], 0.0, &Env { bright: 3.0, ..ENV });
        assert_eq!(over[0], 255.0);
    }

    #[test]
    fn blends_match_the_page() {
        let sol = |a: &str, blend, op| layer(Gen::Solid, Params { speed: 0.0, ..Params::default() }, a, a, blend, op);
        // base (100, 50, 0) from "add", then each blend with (200, 100, 100) at 0.5
        let base = sol("#643200", Blend::Add, 1.0);
        let top = |b| [base.clone(), sol("#c86464", b, 0.5)];
        let at = |b| color_at(&top(b), [0.0; 3], 0.0, &ENV);
        let near = |a: [f32; 3], e: [f32; 3]| a.iter().zip(e).all(|(x, y)| (x - y).abs() < 0.01);
        assert!(near(at(Blend::Add), [200.0, 100.0, 50.0]));
        assert!(near(at(Blend::Mix), [150.0, 75.0, 50.0]));
        assert!(near(at(Blend::Max), [100.0, 50.0, 50.0]));
        assert!(near(at(Blend::Multiply), [100.0 * 0.5 + 100.0 * 200.0 / 255.0 * 0.5, 50.0 * 0.5 + 50.0 * 100.0 / 255.0 * 0.5, 0.0], ));
    }

    /// Samples computed by running the page's JS engine (colorAt, lines 224-312 of the published design) in node.
    #[test]
    fn golden_samples_from_the_js_engine() {
        let ls = all();
        let env = Env { origin: [0.0, 18.0, 0.0], level: 0.6, bright: 0.85 };
        for (i, (pos, t, js)) in GOLDEN.iter().enumerate() {
            let got = color_at(&ls, *pos, *t, &env);
            let ok = got.iter().zip(js).all(|(a, b)| (a - b).abs() < 0.05);
            assert!(ok, "sample {i}: rust {got:?} js {js:?}");
        }
        // one layer at a time too (catches compensating errors)
        for (k, rows) in GOLDEN_EACH.iter().enumerate() {
            for (pos, t, js) in rows.iter() {
                let got = color_at(&ls[k..=k], *pos, *t, &env);
                assert!(got.iter().zip(js).all(|(a, b)| (a - b).abs() < 0.05), "layer {k} at {pos:?} t={t}: rust {got:?} js {js:?}");
            }
        }
    }

    type Sample = ([f32; 3], f64, [f32; 3]);
    const GOLDEN: &[Sample] = &[
    ([0.0000, 18.0000, 0.0000], 0.00, [255.0000, 169.4553, 178.1435]),
    ([-30.0000, 16.0000, 5.0000], 1.50, [154.8448, 116.8719, 136.8532]),
    ([12.5000, 3.2500, -7.7500], 7.25, [255.0000, 164.6795, 160.9092]),
    ([34.0000, 0.0000, -10.0000], 33.10, [24.3058, 48.0212, 65.8797]),
    ([-44.5000, 40.0000, -2.0000], 0.00, [172.6146, 178.3801, 150.3994]),
    ([7.0000, 22.0000, 19.5000], 1.50, [255.0000, 175.1806, 255.0000]),
    ];
    const GOLDEN_EACH: &[&[Sample]] = &[
        &[
        ([0.0000, 18.0000, 0.0000], 0.00, [26.3500, 92.6500, 120.2750]),
        ([12.5000, 3.2500, -7.7500], 1.50, [23.7515, 85.0625, 108.4780]),
        ([-44.5000, 40.0000, -2.0000], 7.25, [37.4255, 124.9906, 170.5579]),
        ],
        &[
        ([0.0000, 18.0000, 0.0000], 1.50, [37.2267, 22.9605, 53.7762]),
        ([12.5000, 3.2500, -7.7500], 7.25, [17.9611, 12.2836, 29.0116]),
        ([-44.5000, 40.0000, -2.0000], 33.10, [0.0000, 0.0000, 0.0000]),
        ],
        &[
        ([0.0000, 18.0000, 0.0000], 7.25, [61.8588, 57.2687, 74.3325]),
        ([12.5000, 3.2500, -7.7500], 33.10, [63.0217, 56.6552, 73.2923]),
        ([-44.5000, 40.0000, -2.0000], 0.00, [61.3302, 57.5477, 74.8053]),
        ],
        &[
        ([0.0000, 18.0000, 0.0000], 33.10, [0.0000, 0.0000, 0.0000]),
        ([12.5000, 3.2500, -7.7500], 0.00, [0.0000, 0.0000, 0.0000]),
        ([-44.5000, 40.0000, -2.0000], 1.50, [0.0000, 0.0000, 0.0000]),
        ],
        &[
        ([0.0000, 18.0000, 0.0000], 0.00, [19.4515, 23.3393, 6.9431]),
        ([12.5000, 3.2500, -7.7500], 1.50, [0.0000, 0.0000, 0.0000]),
        ([-44.5000, 40.0000, -2.0000], 7.25, [0.0000, 0.0000, 0.0000]),
        ],
        &[
        ([0.0000, 18.0000, 0.0000], 1.50, [8.9505, 22.2870, 33.4688]),
        ([12.5000, 3.2500, -7.7500], 7.25, [6.2857, 10.2255, 17.6906]),
        ([-44.5000, 40.0000, -2.0000], 33.10, [5.2683, 5.6202, 11.6663]),
        ],
        &[
        ([0.0000, 18.0000, 0.0000], 7.25, [8.8313, 8.8313, 8.8313]),
        ([12.5000, 3.2500, -7.7500], 33.10, [0.0000, 0.0000, 0.0000]),
        ([-44.5000, 40.0000, -2.0000], 0.00, [0.0000, 0.0000, 0.0000]),
        ],
        &[
        ([0.0000, 18.0000, 0.0000], 33.10, [176.1083, 70.9221, 65.8314]),
        ([12.5000, 3.2500, -7.7500], 0.00, [192.5356, 69.0130, 65.8931]),
        ([-44.5000, 40.0000, -2.0000], 1.50, [81.3871, 69.4466, 56.5735]),
        ],
    ];
}
