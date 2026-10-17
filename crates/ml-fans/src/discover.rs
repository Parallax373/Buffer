//! First-run detection: turn the helper's sensor list into controls. Pairing a control with its speed sensor follows the
//! way LibreHardwareMonitor numbers them (`.../control/N` goes with `.../fan/N` on the same chip or card). Nothing is hidden
//! here: one tach reading of 0 does not prove an empty header (Fan #6 on the dev PC read 0 once while it was spinning), so
//! the page only dims rows that show no signal. Nothing is driven yet: every new control is in Auto mode.

use crate::client::SensorInfo;
use crate::model::{Control, Mode, Setup, Tuning};

/// Adds a control for every writable control that the setup does not know yet and pairs known ones that lack their speed
/// sensor. Returns how many things changed.
pub fn discover(setup: &mut Setup, sensors: &[SensorInfo]) -> usize {
    let mut added = 0;
    for s in sensors.iter().filter(|s| s.kind == "control" && s.control) {
        let fan_id = s.id.replace("/control/", "/fan/");
        let fan = sensors.iter().find(|f| f.kind == "fan" && f.id == fan_id);
        if let Some(known) = setup.controls.iter_mut().find(|c| c.id == s.id) {
            // a control saved before its speed sensor was known gets paired now
            if known.fan.is_none() && fan.is_some() {
                known.fan = fan.map(|f| f.id.clone());
                added += 1;
            }
            continue;
        }
        let name = if s.hw_type.starts_with("Gpu") { s.name.clone() } else { format!("{} · {}", short_board(&s.hw), s.name) };
        setup.controls.push(Control {
            id: s.id.clone(),
            fan: fan.map(|f| f.id.clone()),
            name,
            curve: None,
            mode: Mode::Auto,
            manual: s.value.unwrap_or(40.0).round(),
            hidden: false,
            tuning: Tuning::default(),
        });
        added += 1;
    }
    added
}

/// "Nuvoton NCT6797D" -> "NCT6797D": the chip name is what a person recognises.
fn short_board(hw: &str) -> &str {
    hw.rsplit(' ').next().unwrap_or(hw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, name: &str, hw: &str, hw_type: &str, kind: &str, value: f32) -> SensorInfo {
        SensorInfo { id: id.into(), name: name.into(), hw: hw.into(), hw_type: hw_type.into(), kind: kind.into(), value: Some(value), control: kind == "control" }
    }

    #[test]
    fn pairs_controls_with_fans_and_hides_nothing() {
        let sensors = vec![
            s("/lpc/nct/0/control/1", "Fan #2", "Nuvoton NCT6797D", "SuperIO", "control", 44.0),
            s("/lpc/nct/0/fan/1", "Fan #2", "Nuvoton NCT6797D", "SuperIO", "fan", 880.0),
            s("/lpc/nct/0/control/3", "Fan #4", "Nuvoton NCT6797D", "SuperIO", "control", 57.0),
            s("/lpc/nct/0/fan/3", "Fan #4", "Nuvoton NCT6797D", "SuperIO", "fan", 0.0),
            s("/gpu-nvidia/0/control/1", "GPU Fan 1", "NVIDIA GeForce RTX 3090", "GpuNvidia", "control", 30.0),
            s("/gpu-nvidia/0/fan/1", "GPU Fan 1", "NVIDIA GeForce RTX 3090", "GpuNvidia", "fan", 0.0),
        ];
        let mut setup = Setup::default();
        assert_eq!(discover(&mut setup, &sensors), 3);
        let c = &setup.controls;
        assert_eq!(c[0].name, "NCT6797D · Fan #2");
        assert_eq!(c[0].fan.as_deref(), Some("/lpc/nct/0/fan/1"));
        assert!(c.iter().all(|x| !x.hidden), "one reading of 0 rpm is not proof of an empty header");
        assert_eq!(c[2].name, "GPU Fan 1");
        assert!(c.iter().all(|x| x.mode == Mode::Auto));
        assert_eq!(discover(&mut setup, &sensors), 0, "a second run adds nothing");
    }
}
