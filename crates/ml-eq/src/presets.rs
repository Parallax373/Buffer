//! Built-in presets. Like FL Studio's parametric EQ every dot starts as a bell and every band has a gain, so all seven
//! dots drag the same way (up and down = louder and quieter). A preset may use a shelf where it needs one: "cut the
//! rumble" is a low shelf with negative gain, which stays draggable. Cuts, notch and band pass are one right click away.

use crate::{Band, Kind, BANDS};

const fn pk(f: f64, g: f64, q: f64) -> Band {
    Band::new(Kind::Peak, f, g, q)
}

/// Default layout: seven bells spread over the range, all at 0 dB.
pub const FLAT: [Band; BANDS] = [
    pk(50.0, 0.0, 1.0),
    pk(130.0, 0.0, 1.0),
    pk(330.0, 0.0, 1.0),
    pk(800.0, 0.0, 1.0),
    pk(2000.0, 0.0, 1.0),
    pk(5000.0, 0.0, 1.0),
    pk(12000.0, 0.0, 1.0),
];

/// Footsteps and reloads forward, boom pushed back.
pub const GAMING: [Band; BANDS] = [
    Band::new(Kind::LowShelf, 70.0, -5.0, 0.707),
    pk(150.0, 0.0, 1.0),
    pk(300.0, -2.0, 1.0),
    pk(1000.0, 0.0, 1.0),
    pk(3000.0, 4.5, 1.2),
    pk(6000.0, 2.5, 1.5),
    Band::new(Kind::HighShelf, 10000.0, 1.5, 0.707),
];

/// Clear speech: rumble down, mud down, presence up, harsh sibilance tamed.
pub const VOICE: [Band; BANDS] = [
    Band::new(Kind::LowShelf, 90.0, -8.0, 0.707),
    pk(180.0, -1.5, 1.0),
    pk(350.0, -3.0, 1.2),
    pk(1000.0, 0.0, 1.0),
    pk(3200.0, 3.5, 1.0),
    pk(7000.0, -2.0, 3.0),
    Band::new(Kind::HighShelf, 10000.0, 1.0, 0.707),
];

/// V-shape: more bass and air.
pub const MUSIC: [Band; BANDS] = [
    Band::new(Kind::LowShelf, 90.0, 5.0, 0.707),
    pk(250.0, -1.0, 1.0),
    pk(900.0, -1.5, 0.8),
    pk(2500.0, 0.0, 1.0),
    pk(5000.0, 1.0, 1.0),
    pk(8000.0, 0.0, 1.0),
    Band::new(Kind::HighShelf, 12000.0, 3.5, 0.707),
];

pub const IDS: [&str; 4] = ["flat", "gaming", "voice", "music"];

pub fn builtin(id: &str) -> Option<[Band; BANDS]> {
    Some(match id {
        "flat" => FLAT,
        "gaming" => GAMING,
        "voice" => VOICE,
        "music" => MUSIC,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_band_has_a_gain_so_all_dots_drag_alike() {
        for id in IDS {
            for (i, b) in builtin(id).unwrap().iter().enumerate() {
                assert!(matches!(b.kind, Kind::Peak | Kind::LowShelf | Kind::HighShelf), "{id} band {}", i + 1);
                assert!(b.on, "{id} band {} starts on", i + 1);
            }
        }
        assert!(FLAT.iter().all(|b| b.kind == Kind::Peak && b.gain == 0.0));
    }
}
