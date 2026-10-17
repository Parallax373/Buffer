//! Import of a FanControl configuration (`userConfig.json`, https://getfancontrol.com). The schema is not documented;
//! the field names and enum values below were read from FanControl.Library.dll's metadata (never executed):
//! `SerializableGraphFanCurve`, `...LinearFanCurve`, `...FlatFanCurve`, `...MixFanCurve`, `...SyncFanCurve`, `...TriggerFanCurve`,
//! `...AutoFanCurve`, `SerializableControlConfig`; `MixFunction { Max=0, Sum=1, Average=2, Min=3, Subtract=4 }` (curves) and
//! `SensorMixFunction { Average=0, Max=1, Min=2, Sum=3, Subtract=4 }` (custom Mix sensors).
//!
//! FanControl's identifiers are not LibreHardwareMonitor's: board chips lose the chip index (`/lpc/nct6797d/control/1` is
//! `/lpc/nct6797d/0/control/1` here) and an NVIDIA card is `NVApiWrapper/0-GA102-A/control/0` there but `/gpu-nvidia/0/control/1`
//! here (fan and control numbers start at 1). Everything is mapped against the sensors the helper really reports; what
//! cannot be mapped is skipped and listed in `notes`. Calibration tables are not imported.

use crate::client::SensorInfo;
use crate::model::*;
use serde_json::Value;

#[derive(Debug, Default)]
pub struct Imported {
    pub setup: Setup,
    pub controls: usize,
    pub curves: usize,
    pub mixes: usize,
    pub hidden: usize,
    /// things that were skipped or changed, one short sentence each (English: shown as detail)
    pub notes: Vec<String>,
}

/// Where FanControl keeps its configuration on common installs.
pub fn candidates() -> Vec<std::path::PathBuf> {
    let mut v = Vec::new();
    for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA", "APPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let base = std::path::PathBuf::from(base);
            v.push(base.join("FanControl").join("Configurations").join("userConfig.json"));
        }
    }
    v.retain(|p| p.is_file());
    v.dedup();
    v
}

fn slug(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect::<String>().trim_matches('-').to_string()
}

/// FanControl sensor/control identifier -> the helper's identifier, if the helper has it.
pub fn map_id(fc: &str, sensors: &[SensorInfo]) -> Option<String> {
    let has = |id: &str| sensors.iter().any(|s| s.id == id);
    if let Some(rest) = fc.strip_prefix("Mix/") {
        return Some(format!("mix:{}", slug(rest)));
    }
    // board chips: /lpc/<chip>/<kind>/<n>  ->  /lpc/<chip>/<index>/<kind>/<n>
    if let Some(rest) = fc.strip_prefix("/lpc/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if let [chip, kind, n] = parts[..] {
            return sensors.iter().map(|s| s.id.as_str()).find(|id| {
                let p: Vec<&str> = id.trim_start_matches('/').split('/').collect();
                p.len() == 5 && p[0] == "lpc" && p[1] == chip && p[3] == kind && p[4] == n && p[2].chars().all(|c| c.is_ascii_digit())
            }).map(String::from);
        }
    }
    // NVIDIA through FanControl's own wrapper: NVApiWrapper/<card>-<name>/<kind>/<n>
    if let Some(rest) = fc.strip_prefix("NVApiWrapper/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if let [card, kind, n] = parts[..] {
            let idx = card.split('-').next().unwrap_or("0");
            let n: u32 = n.parse().ok()?;
            let id = match kind {
                "control" => format!("/gpu-nvidia/{idx}/control/{}", n + 1),
                "fan" => format!("/gpu-nvidia/{idx}/fan/{}", n + 1),
                "sensor" if n == 0 => format!("/gpu-nvidia/{idx}/temperature/0"), // the GPU core temperature
                _ => return None,
            };
            return has(&id).then_some(id);
        }
    }
    has(fc).then(|| fc.to_string())
}

fn f(v: &Value, k: &str) -> Option<f32> {
    v.get(k).and_then(|x| x.as_f64()).map(|x| x as f32)
}

fn id_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.get("Identifier")).and_then(|x| x.as_str()).map(String::from)
}

fn mix_fn(curve: bool, n: i64) -> MixFn {
    let order: [MixFn; 5] = if curve { [MixFn::Max, MixFn::Sum, MixFn::Avg, MixFn::Min, MixFn::Sub] } else { [MixFn::Avg, MixFn::Max, MixFn::Min, MixFn::Sum, MixFn::Sub] };
    order.get(n as usize).copied().unwrap_or(MixFn::Max)
}

/// Converts a FanControl configuration into a setup. `current` supplies what the helper already found (controls the
/// user has not configured stay as they are); nothing is applied here.
pub fn from_fancontrol(json: &str, sensors: &[SensorInfo], current: &Setup) -> Result<Imported, String> {
    let root: Value = serde_json::from_str(json).map_err(|e| format!("not a FanControl configuration: {e}"))?;
    let fc = root.get("FanControl").ok_or("not a FanControl configuration (no FanControl section)")?;
    let mut out = Imported { setup: current.clone(), ..Imported::default() };
    let setup = &mut out.setup;
    let mut notes = Vec::new();

    // custom sensors: only Mix is supported (Time average, File and Offset have no counterpart yet)
    for s in fc["CustomSensors"].as_array().unwrap_or(&vec![]) {
        let name = s["NickName"].as_str().unwrap_or("Mix").to_string();
        if let Some(sel) = s["SelectedSensors"].as_array() {
            let inputs: Vec<String> = sel.iter().filter_map(|x| x["Identifier"].as_str()).filter_map(|i| map_id(i, sensors)).collect();
            if inputs.len() != sel.len() {
                notes.push(format!("Mix sensor \"{name}\": a sensor was not found on this PC"));
            }
            if inputs.is_empty() {
                continue;
            }
            let id = slug(s["Identifier"].as_str().unwrap_or(&name).trim_start_matches("Mix/"));
            setup.mixes.retain(|m| m.id != id);
            setup.mixes.push(MixSensor { id, name, func: mix_fn(false, s["SelectedMixFunction"].as_i64().unwrap_or(1)), inputs });
            out.mixes += 1;
        } else {
            notes.push(format!("Custom sensor \"{name}\" (time average, file or offset) is not supported yet"));
        }
    }

    // curves, told apart by the fields they carry
    let mut curve_ids = std::collections::HashMap::new();
    for c in fc["FanCurves"].as_array().unwrap_or(&vec![]) {
        let name = c["Name"].as_str().unwrap_or("Curve").to_string();
        let id = format!("fc:{}", slug(&name));
        curve_ids.insert(name.clone(), id.clone());
        let src = id_of(c, "SelectedTempSource").and_then(|i| map_id(&i, sensors));
        let hy = &c["HysteresisConfig"];
        let (hyst, resp, edges) = (f(hy, "HysteresisValueDown").unwrap_or(0.0), f(hy, "ResponseTimeDown").unwrap_or(0.0), hy["IgnoreHysteresisAtLimits"].as_bool().unwrap_or(true));
        let need_src = |src: &Option<String>, notes: &mut Vec<String>| {
            if src.is_none() {
                notes.push(format!("Curve \"{name}\": its temperature sensor was not found on this PC"));
            }
            src.clone().unwrap_or_default()
        };
        let kind = if let Some(p) = c["Points"].as_array() {
            let mut points: Vec<[f32; 2]> = p.iter().filter_map(|s| s.as_str()).filter_map(|s| s.split_once(',')).filter_map(|(a, b)| Some([a.trim().parse().ok()?, b.trim().parse().ok()?])).collect();
            points.sort_by(|a, b| a[0].total_cmp(&b[0]));
            if points.len() < 2 {
                notes.push(format!("Curve \"{name}\" has no usable points and was skipped"));
                continue;
            }
            Kind::Graph { src: need_src(&src, &mut notes), points }
        } else if c.get("MinimumFanSpeed").is_some() || c.get("MaximumFanSpeed").is_some() {
            Kind::Linear { src: need_src(&src, &mut notes), tmin: f(c, "MinimumTemperature").unwrap_or(40.0), tmax: f(c, "MaximumTemperature").unwrap_or(80.0), pmin: f(c, "MinimumFanSpeed").unwrap_or(30.0), pmax: f(c, "MaximumFanSpeed").unwrap_or(100.0) }
        } else if c.get("LoadFanSpeed").is_some() {
            Kind::Trigger { src: need_src(&src, &mut notes), idle_t: f(c, "IdleTemperature").unwrap_or(40.0), load_t: f(c, "LoadTemperature").unwrap_or(70.0), idle_pct: f(c, "IdleFanSpeed").unwrap_or(30.0), load_pct: f(c, "LoadFanSpeed").unwrap_or(80.0) }
        } else if c.get("Deadband").is_some() {
            Kind::Auto { src: need_src(&src, &mut notes), idle_t: f(c, "IdleTemperature").unwrap_or(40.0), load_t: f(c, "LoadTemperature").unwrap_or(70.0), min: f(c, "MinFanSpeed").unwrap_or(20.0), max: f(c, "MaxFanSpeed").unwrap_or(100.0), step: f(c, "Step").unwrap_or(5.0), deadband: f(c, "Deadband").unwrap_or(6.0) }
        } else if c.get("SelectedFanCurves").is_some() {
            let curves = c["SelectedFanCurves"].as_array().map(|a| a.iter().filter_map(|x| x["Name"].as_str()).map(|n| format!("fc:{}", slug(n))).collect()).unwrap_or_default();
            Kind::Mix { func: mix_fn(true, c["SelectedMixFunction"].as_i64().unwrap_or(0)), curves }
        } else if c.get("Proportional").is_some() {
            let control = id_of(c, "SelectedControl").and_then(|i| map_id(&i, sensors));
            if control.is_none() {
                notes.push(format!("Sync curve \"{name}\" follows a control that was not found; it follows nothing yet"));
            }
            Kind::Sync { control: control.unwrap_or_default(), offset: f(c, "SelectedOffset").unwrap_or(0.0), proportional: c["Proportional"].as_bool().unwrap_or(false) }
        } else if c.get("Percent").is_some() {
            Kind::Flat { pct: f(c, "Percent").unwrap_or(40.0) }
        } else {
            notes.push(format!("Curve \"{name}\" has a type that is not supported and was skipped"));
            continue;
        };
        setup.curves.retain(|x| x.id != id);
        setup.curves.push(Curve { id, name, kind, hyst, resp, skip_edges: edges });
        out.curves += 1;
    }

    // controls; `named`: speed sensor -> the control FanControl pairs it with
    let mut named: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for c in fc["Controls"].as_array().unwrap_or(&vec![]) {
        let nick = c["NickName"].as_str().unwrap_or("").to_string();
        let Some(id) = c["Identifier"].as_str().and_then(|i| map_id(i, sensors)) else {
            notes.push(format!("Control \"{nick}\" was not found on this PC"));
            continue;
        };
        let curve = c["SelectedFanCurve"]["Name"].as_str().and_then(|n| curve_ids.get(n).cloned());
        let enabled = c["Enable"].as_bool().unwrap_or(false);
        let mode = if !enabled { Mode::Auto } else if c["ManualControl"].as_bool().unwrap_or(false) { Mode::Manual } else if curve.is_some() { Mode::Curve } else { Mode::Auto };
        let tuning = Tuning {
            step_up: f(c, "SelectedCommandStepUp").unwrap_or(100.0).clamp(1.0, 100.0),
            step_down: f(c, "SelectedCommandStepDown").unwrap_or(100.0).clamp(1.0, 100.0),
            start: f(c, "SelectedStart").unwrap_or(0.0),
            stop: f(c, "SelectedStop").unwrap_or(0.0),
            minimum: f(c, "MinimumPercent").unwrap_or(0.0),
            offset: f(c, "SelectedOffset").unwrap_or(0.0),
            avoid: vec![],
        };
        let fan = id_of(c, "PairedFanSensor").and_then(|i| map_id(&i, sensors));
        if let Some(f) = &fan {
            named.insert(f.clone(), id.clone());
        }
        let hidden = c["IsHidden"].as_bool().unwrap_or(false);
        let entry = Control { id: id.clone(), fan, name: if nick.is_empty() { id.clone() } else { nick }, curve, mode, manual: f(c, "ManualControlValue").unwrap_or(40.0), hidden, tuning };
        if let Some(old) = setup.controls.iter_mut().find(|x| x.id == id) {
            let fan = entry.fan.clone().or_else(|| old.fan.clone());
            *old = Control { fan, ..entry };
        } else {
            setup.controls.push(entry);
        }
        out.controls += 1;
        if hidden {
            out.hidden += 1;
        }
    }
    // a speed sensor FanControl gives to one control is not also kept on another by Buffer's guess
    for c in out.setup.controls.iter_mut() {
        if let Some(f) = &c.fan {
            if named.get(f).is_some_and(|owner| owner != &c.id) {
                c.fan = None;
            }
        }
    }
    out.notes = notes;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, kind: &str) -> SensorInfo {
        SensorInfo { id: id.into(), name: id.into(), hw: "x".into(), hw_type: if id.contains("gpu") { "GpuNvidia" } else { "SuperIO" }.into(), kind: kind.into(), value: Some(1.0), control: kind == "control" }
    }

    fn pc() -> Vec<SensorInfo> {
        vec![
            s("/lpc/nct6797d/0/control/1", "control"), s("/lpc/nct6797d/0/fan/1", "fan"),
            s("/lpc/nct6797d/0/control/2", "control"), s("/lpc/nct6797d/0/fan/2", "fan"),
            s("/gpu-nvidia/0/control/1", "control"), s("/gpu-nvidia/0/fan/1", "fan"), s("/gpu-nvidia/0/temperature/0", "temperature"),
            s("/amdcpu/0/temperature/2", "temperature"),
        ]
    }

    const CFG: &str = r#"{ "__VERSION__": "267", "FanControl": {
      "Controls": [
        {"NickName":"GPU left","Identifier":"NVApiWrapper/0-GA102-A/control/0","IsHidden":false,"Enable":true,"SelectedFanCurve":{"Name":"Graph GPU"},"SelectedOffset":0,"PairedFanSensor":{"Identifier":"NVApiWrapper/0-GA102-A/fan/0"},"SelectedStart":0,"SelectedStop":0,"MinimumPercent":0,"SelectedCommandStepUp":8,"SelectedCommandStepDown":6,"ManualControlValue":100,"ManualControl":false},
        {"NickName":"CPU #1","Identifier":"/lpc/nct6797d/control/1","IsHidden":false,"Enable":true,"SelectedFanCurve":{"Name":"Case mix"},"SelectedOffset":5,"PairedFanSensor":{"Identifier":"/lpc/nct6797d/fan/1"},"SelectedStart":25,"SelectedStop":16,"MinimumPercent":10,"SelectedCommandStepUp":8,"SelectedCommandStepDown":8,"ManualControlValue":100,"ManualControl":false},
        {"NickName":"Pump","Identifier":"/lpc/nct6797d/control/2","IsHidden":true,"Enable":true,"SelectedFanCurve":null,"PairedFanSensor":null,"ManualControl":true,"ManualControlValue":70},
        {"NickName":"Gone","Identifier":"/lpc/nct6797d/control/9","IsHidden":false,"Enable":true}
      ],
      "FanCurves": [
        {"Name":"Graph GPU","CommandMode":0,"SelectedTempSource":{"Identifier":"NVApiWrapper/0-GA102-A/sensor/0"},"Points":["50,30","55,50","75,70","65,60","80,100"],"MaximumTemperature":80,"MinimumTemperature":50,"MaximumCommand":100,"HysteresisConfig":{"ResponseTimeUp":1,"ResponseTimeDown":3,"HysteresisValueUp":2,"HysteresisValueDown":4,"IgnoreHysteresisAtLimits":false}},
        {"Name":"Flat 100","Percent":100},
        {"Name":"Linear","SelectedTempSource":{"Identifier":"/amdcpu/0/temperature/2"},"MinimumTemperature":40,"MaximumTemperature":80,"MinimumFanSpeed":20,"MaximumFanSpeed":90,"HysteresisConfig":{"ResponseTimeDown":1,"HysteresisValueDown":2,"IgnoreHysteresisAtLimits":true}},
        {"Name":"Trig","SelectedTempSource":{"Identifier":"Mix/Mix"},"IdleTemperature":45,"LoadTemperature":70,"IdleFanSpeed":25,"LoadFanSpeed":75},
        {"Name":"Auto one","SelectedTempSource":{"Identifier":"/amdcpu/0/temperature/2"},"IdleTemperature":40,"LoadTemperature":65,"MinFanSpeed":20,"MaxFanSpeed":100,"Step":4,"Deadband":5},
        {"Name":"Case mix","SelectedFanCurves":[{"Name":"Graph GPU"},{"Name":"Flat 100"}],"SelectedMixFunction":3},
        {"Name":"Follow","SelectedControl":{"Identifier":"/lpc/nct6797d/control/1"},"SelectedOffset":10,"Proportional":true}
      ],
      "CustomSensors": [
        {"NickName":"Mix","Identifier":"Mix/Mix","SelectedMixFunction":1,"SelectedSensors":[{"Identifier":"/amdcpu/0/temperature/2"},{"Identifier":"NVApiWrapper/0-GA102-A/sensor/0"}]},
        {"NickName":"Avg over time","Identifier":"Avg/1","SelectedPeriod":10}
      ] } }"#;

    #[test]
    fn maps_fancontrol_identifiers_onto_the_helpers() {
        let p = pc();
        assert_eq!(map_id("/lpc/nct6797d/control/1", &p).as_deref(), Some("/lpc/nct6797d/0/control/1"));
        assert_eq!(map_id("NVApiWrapper/0-GA102-A/control/0", &p).as_deref(), Some("/gpu-nvidia/0/control/1"));
        assert_eq!(map_id("NVApiWrapper/0-GA102-A/fan/0", &p).as_deref(), Some("/gpu-nvidia/0/fan/1"));
        assert_eq!(map_id("NVApiWrapper/0-GA102-A/sensor/0", &p).as_deref(), Some("/gpu-nvidia/0/temperature/0"));
        assert_eq!(map_id("/amdcpu/0/temperature/2", &p).as_deref(), Some("/amdcpu/0/temperature/2"));
        assert_eq!(map_id("Mix/My Mix", &p).as_deref(), Some("mix:my-mix"));
        assert_eq!(map_id("/lpc/nct6797d/control/9", &p), None);
        assert_eq!(map_id("NVApiWrapper/0-GA102-A/control/5", &p), None);
    }

    #[test]
    fn imports_every_curve_type_with_the_right_numbers() {
        let r = from_fancontrol(CFG, &pc(), &Setup::default()).unwrap();
        let c = |id: &str| r.setup.curves.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("no curve {id}"));
        match &c("fc:graph-gpu").kind {
            Kind::Graph { src, points } => {
                assert_eq!(src, "/gpu-nvidia/0/temperature/0");
                assert_eq!(points[2], [65.0, 60.0], "points are sorted by temperature");
            }
            k => panic!("{k:?}"),
        }
        let g = c("fc:graph-gpu");
        assert_eq!((g.hyst, g.resp, g.skip_edges), (4.0, 3.0, false), "the falling-side values are the ones that apply");
        assert_eq!(c("fc:flat-100").kind, Kind::Flat { pct: 100.0 });
        assert_eq!(c("fc:linear").kind, Kind::Linear { src: "/amdcpu/0/temperature/2".into(), tmin: 40.0, tmax: 80.0, pmin: 20.0, pmax: 90.0 });
        assert_eq!(c("fc:trig").kind, Kind::Trigger { src: "mix:mix".into(), idle_t: 45.0, load_t: 70.0, idle_pct: 25.0, load_pct: 75.0 });
        assert!(matches!(c("fc:auto-one").kind, Kind::Auto { step, deadband, .. } if step == 4.0 && deadband == 5.0));
        assert_eq!(c("fc:case-mix").kind, Kind::Mix { func: MixFn::Min, curves: vec!["fc:graph-gpu".into(), "fc:flat-100".into()] }, "curve mix 3 = Min");
        assert_eq!(c("fc:follow").kind, Kind::Sync { control: "/lpc/nct6797d/0/control/1".into(), offset: 10.0, proportional: true });
        assert_eq!(r.curves, 7);
    }

    #[test]
    fn the_sensor_mix_function_enum_is_not_the_curve_one() {
        let r = from_fancontrol(CFG, &pc(), &Setup::default()).unwrap();
        assert_eq!(r.setup.mixes.len(), 1);
        assert_eq!(r.setup.mixes[0].func, MixFn::Max, "SelectedMixFunction 1 on a sensor mix is Max");
        assert_eq!(r.setup.mixes[0].inputs, ["/amdcpu/0/temperature/2", "/gpu-nvidia/0/temperature/0"]);
        assert_eq!(mix_fn(true, 1), MixFn::Sum);
        assert_eq!(mix_fn(false, 1), MixFn::Max);
    }

    #[test]
    fn imports_controls_with_tuning_modes_and_notes() {
        let r = from_fancontrol(CFG, &pc(), &Setup::default()).unwrap();
        let c = |id: &str| r.setup.controls.iter().find(|c| c.id == id).unwrap();
        let gpu = c("/gpu-nvidia/0/control/1");
        assert_eq!((gpu.name.as_str(), gpu.mode, gpu.curve.as_deref()), ("GPU left", Mode::Curve, Some("fc:graph-gpu")));
        assert_eq!(gpu.fan.as_deref(), Some("/gpu-nvidia/0/fan/1"));
        assert_eq!((gpu.tuning.step_up, gpu.tuning.step_down), (8.0, 6.0));
        let cpu = c("/lpc/nct6797d/0/control/1");
        assert_eq!((cpu.tuning.start, cpu.tuning.stop, cpu.tuning.minimum, cpu.tuning.offset), (25.0, 16.0, 10.0, 5.0));
        let pump = c("/lpc/nct6797d/0/control/2");
        assert_eq!((pump.mode, pump.manual, pump.hidden), (Mode::Manual, 70.0, true));
        assert_eq!((r.controls, r.hidden), (3, 1));
        assert!(r.notes.iter().any(|n| n.contains("Gone")), "{:?}", r.notes);
        assert!(r.notes.iter().any(|n| n.contains("Avg over time")), "{:?}", r.notes);
    }

    #[test]
    fn a_sensor_fancontrol_pairs_elsewhere_is_not_kept_twice() {
        let p = vec![s("/lpc/nct6797d/0/control/0", "control"), s("/lpc/nct6797d/0/control/5", "control"), s("/lpc/nct6797d/0/fan/5", "fan")];
        let mut cur = Setup::default();
        cur.controls.push(Control { id: "/lpc/nct6797d/0/control/5".into(), fan: Some("/lpc/nct6797d/0/fan/5".into()), name: "x".into(), curve: None, mode: Mode::Auto, manual: 40.0, hidden: false, tuning: Tuning::default() });
        let fc = r#"{"FanControl":{"Controls":[{"NickName":"A","Identifier":"/lpc/nct6797d/control/0","Enable":true,"PairedFanSensor":{"Identifier":"/lpc/nct6797d/fan/5"}},{"NickName":"B","Identifier":"/lpc/nct6797d/control/5","Enable":true,"PairedFanSensor":null}],"FanCurves":[]}}"#;
        let r = from_fancontrol(fc, &p, &cur).unwrap();
        let get = |id: &str| r.setup.controls.iter().find(|c| c.id == id).unwrap().fan.clone();
        assert_eq!(get("/lpc/nct6797d/0/control/0").as_deref(), Some("/lpc/nct6797d/0/fan/5"));
        assert_eq!(get("/lpc/nct6797d/0/control/5"), None, "fan/5 belongs to A in FanControl");
    }

    #[test]
    fn existing_controls_keep_their_pairing_when_the_import_has_none() {
        let mut cur = Setup::default();
        cur.controls.push(Control { id: "/lpc/nct6797d/0/control/2".into(), fan: Some("/lpc/nct6797d/0/fan/2".into()), name: "old".into(), curve: None, mode: Mode::Auto, manual: 40.0, hidden: false, tuning: Tuning::default() });
        let r = from_fancontrol(CFG, &pc(), &cur).unwrap();
        let pump = r.setup.controls.iter().find(|c| c.id == "/lpc/nct6797d/0/control/2").unwrap();
        assert_eq!((pump.name.as_str(), pump.fan.as_deref()), ("Pump", Some("/lpc/nct6797d/0/fan/2")));
    }

    #[test]
    fn rejects_files_that_are_not_fancontrol_configs() {
        assert!(from_fancontrol("{}", &pc(), &Setup::default()).is_err());
        assert!(from_fancontrol("nope", &pc(), &Setup::default()).is_err());
    }
}
