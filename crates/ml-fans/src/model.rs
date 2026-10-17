//! The saved setup (`fans.json`): custom sensors, curves and controls. See FANS-SPEC.md for the curve types, which follow
//! the FanControl documentation (https://getfancontrol.com/docs).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How several inputs are combined (Mix sensors and Mix curves).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum MixFn {
    #[default]
    Max,
    Min,
    Avg,
    Sum,
    /// first input minus the others
    Sub,
}

/// A sensor made of other sensors; its id is `mix:<id>` wherever a sensor id is expected.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct MixSensor {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub func: MixFn,
    pub inputs: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Kind {
    /// points `[temperature, percent]`, interpolated
    Graph { src: String, points: Vec<[f32; 2]> },
    Linear { src: String, tmin: f32, tmax: f32, pmin: f32, pmax: f32 },
    Flat { pct: f32 },
    /// combines other curves
    Mix { func: MixFn, curves: Vec<String> },
    /// the same percent as another control, plus an offset (absolute, or a share of it)
    Sync { control: String, offset: f32, #[serde(default)] proportional: bool },
    /// below `idle_t` idle speed until the temperature reaches `load_t`, then load speed until it is back at `idle_t`
    Trigger { src: String, idle_t: f32, load_t: f32, idle_pct: f32, load_pct: f32 },
    /// finds the lowest speed that holds `load_t`; below the load zone it acts like a linear curve
    Auto { src: String, idle_t: f32, load_t: f32, min: f32, max: f32, step: f32, deadband: f32 },
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Curve {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub kind: Kind,
    /// degrees the temperature must fall before the speed may drop (rising is never delayed)
    #[serde(default)]
    pub hyst: f32,
    /// seconds a fall has to hold before it counts
    #[serde(default)]
    pub resp: f32,
    /// skip hysteresis and response time at the first and last point of the curve
    #[serde(default = "yes")]
    pub skip_edges: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// follows its curve
    #[default]
    Curve,
    /// a fixed percent
    Manual,
    /// Buffer does not touch it (BIOS / the card)
    Auto,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Tuning {
    /// largest change per second, up and down (100 = no limit)
    pub step_up: f32,
    pub step_down: f32,
    /// a stopped fan is kicked with at least this much for 2 s
    pub start: f32,
    /// below this the fan is switched off (0 %)
    pub stop: f32,
    /// hard floor, also in manual
    pub minimum: f32,
    pub offset: f32,
    /// percent ranges the fan skips (it moves to the nearest edge)
    #[serde(default)]
    pub avoid: Vec<[f32; 2]>,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning { step_up: 100.0, step_down: 100.0, start: 0.0, stop: 0.0, minimum: 0.0, offset: 0.0, avoid: vec![] }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Control {
    /// LibreHardwareMonitor control id, e.g. `/lpc/nct6797d/0/control/1`
    pub id: String,
    /// the speed sensor that belongs to it (paired), e.g. `/lpc/nct6797d/0/fan/1`
    #[serde(default)]
    pub fan: Option<String>,
    pub name: String,
    #[serde(default)]
    pub curve: Option<String>,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub manual: f32,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub tuning: Tuning,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Setup {
    #[serde(default)]
    pub mixes: Vec<MixSensor>,
    #[serde(default)]
    pub curves: Vec<Curve>,
    #[serde(default)]
    pub controls: Vec<Control>,
    /// what a control does when its sensor is lost or the recorder dies (percent)
    #[serde(default = "hundred")]
    pub failsafe: f32,
    /// display names the user gave to sensors (id -> name)
    #[serde(default)]
    pub names: BTreeMap<String, String>,
    /// where each control sits in the case schematic (control id -> slot); controls without an entry are placed automatically
    #[serde(default)]
    pub layout: BTreeMap<String, String>,
}

fn hundred() -> f32 {
    100.0
}

impl Default for Setup {
    fn default() -> Self {
        Setup { mixes: vec![], curves: vec![], controls: vec![], failsafe: 100.0, names: BTreeMap::new(), layout: BTreeMap::new() }
    }
}

impl Curve {
    pub fn graph(id: &str, name: &str, src: &str, points: &[[f32; 2]]) -> Curve {
        Curve { id: id.into(), name: name.into(), kind: Kind::Graph { src: src.into(), points: points.to_vec() }, hyst: 2.0, resp: 2.0, skip_edges: true }
    }
    pub fn flat(id: &str, name: &str, pct: f32) -> Curve {
        Curve { id: id.into(), name: name.into(), kind: Kind::Flat { pct }, hyst: 0.0, resp: 0.0, skip_edges: true }
    }
}
