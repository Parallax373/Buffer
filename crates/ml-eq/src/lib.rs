//! Live EQ model shared by the recorder (the only writer) and the app. Equalizer APO does the DSP; this crate
//! turns `EqState` into an APO config file (`buffer.txt` in APO's config folder, included once from `config.txt`).
//!
//! Every output device keeps its own System EQ and gets its own `Device:` section, so the EQ follows whichever
//! output Windows plays to without Buffer doing anything when the default device changes.

pub mod apo;
pub mod autoeq;
pub mod curve;
pub mod presets;

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub const BANDS: usize = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Peak,
    LowShelf,
    HighShelf,
    LowCut,
    HighCut,
    Notch,
    BandPass,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Band {
    pub kind: Kind,
    /// centre / corner frequency, Hz
    pub f: f64,
    /// dB; ignored by cut, notch and band-pass
    pub gain: f64,
    pub q: f64,
    pub on: bool,
}

impl Band {
    pub const fn new(kind: Kind, f: f64, gain: f64, q: f64) -> Self {
        Band { kind, f, gain, q, on: true }
    }
}

/// A headphone profile (AutoEQ); applied before the 7 user bands and not shown as dots.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub preamp: f64,
    pub filters: Vec<Band>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    pub enabled: bool,
    #[serde(default)]
    pub preset: String,
    pub bands: [Band; BANDS],
    #[serde(default)]
    pub autoeq: Option<Profile>,
}

impl Default for Channel {
    fn default() -> Self {
        Channel { enabled: true, preset: "flat".into(), bands: presets::FLAT, autoeq: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserPreset {
    pub name: String,
    pub bands: [Band; BANDS],
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EqState {
    /// master switch; off = APO gets no filters from us
    pub enabled: bool,
    /// System EQ per output endpoint id (`{0.0.0.00000000}.{guid}`)
    #[serde(default)]
    pub outputs: BTreeMap<String, Channel>,
    /// microphone endpoint id; empty = none chosen
    #[serde(default)]
    pub mic_device: String,
    #[serde(default)]
    pub mic: Channel,
    #[serde(default)]
    pub user_presets: Vec<UserPreset>,
    /// game executable stem (lower case) -> preset id, applied to the output in use while that game is in front
    #[serde(default)]
    pub game_presets: BTreeMap<String, String>,
    /// games the recorder has seen in front (exe stem -> display name); the EQ page lists them, so a game
    /// needs no "add" step
    #[serde(default)]
    pub seen_games: BTreeMap<String, String>,
    /// the same games, most recently in front first (the EQ page lists the last few of them)
    #[serde(default)]
    pub recent_games: Vec<String>,
}

impl EqState {
    pub fn path() -> PathBuf {
        app_dir().join("eq.json")
    }

    pub fn load() -> Self {
        migrate_legacy_eq(&appdata());
        std::fs::read_to_string(Self::path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        write_atomic(&Self::path(), serde_json::to_string_pretty(self).unwrap().as_bytes())
    }

    /// Bands of a preset id. The user's own come first: editing a built-in preset saves an override under the
    /// same id, which wins over the shipped one until it is reset.
    pub fn preset_bands(&self, id: &str) -> Option<[Band; BANDS]> {
        self.user_presets.iter().find(|p| p.name == id).map(|p| p.bands).or_else(|| presets::builtin(id))
    }

    /// Drops the override of a built-in preset and puts the shipped bands back on every channel that uses it.
    /// False for an id that is not built-in.
    pub fn reset_preset(&mut self, id: &str) -> bool {
        let Some(shipped) = presets::builtin(id) else { return false };
        self.user_presets.retain(|p| p.name != id);
        for ch in self.outputs.values_mut().chain(std::iter::once(&mut self.mic)) {
            if ch.preset == id {
                ch.bands = shipped;
            }
        }
        true
    }

    /// Remembers a game that came to the front: its name, and it moves to the head of the recent list.
    /// True when anything changed (so the caller knows whether to save).
    pub fn note_game(&mut self, stem: &str, name: &str) -> bool {
        let mut changed = self.seen_games.get(stem).map(String::as_str) != Some(name);
        self.seen_games.insert(stem.to_string(), name.to_string());
        if self.recent_games.first().map(String::as_str) != Some(stem) {
            self.recent_games.retain(|g| g != stem);
            self.recent_games.insert(0, stem.to_string());
            self.recent_games.truncate(30);
            changed = true;
        }
        changed
    }

    /// Switches a channel to a preset (keeps its headphone profile). False for an unknown id.
    pub fn set_preset(&mut self, device: &str, id: &str) -> bool {
        let Some(bands) = self.preset_bands(id) else { return false };
        let ch = if device == self.mic_device { &mut self.mic } else { self.outputs.entry(device.to_string()).or_default() };
        ch.bands = bands;
        ch.preset = id.to_string();
        true
    }
}

fn appdata() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// `%APPDATA%\Buffer`: the same folder as recorder.json and app-state.json (see `ml_core::paths`).
pub fn app_dir() -> PathBuf {
    appdata().join("Buffer")
}

/// Early builds wrote eq.json into `%APPDATA%\moments-lite`, a stray folder (the data folder is `Buffer`). Moves the
/// file over once so nobody loses their EQ, then removes what that folder had left if it is empty.
pub fn migrate_legacy_eq(base: &Path) {
    let (old, new) = (base.join("moments-lite"), base.join("Buffer"));
    let (old_file, new_file) = (old.join("eq.json"), new.join("eq.json"));
    if old_file.is_file() && !new_file.exists() && std::fs::create_dir_all(&new).is_ok() && std::fs::copy(&old_file, &new_file).is_ok() {
        let _ = std::fs::remove_file(&old_file);
    }
    // an empty `eq` folder an abandoned approach left; remove_dir refuses a folder that still holds something
    let _ = std::fs::remove_dir(old.join("eq"));
    let _ = std::fs::remove_dir(&old);
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// `{0.0.0.00000000}.{guid}` -> `{guid}`, the form APO's `Device:` matches on (measured).
pub fn device_guid(id: &str) -> &str {
    id.rsplit_once("}.").map(|(_, g)| g).unwrap_or(id)
}

/// A number from the outside world (the control port takes JSON from any local process): finite and inside the range
/// APO and the maths can take, else the default.
fn num(v: f64, lo: f64, hi: f64, default: f64) -> f64 {
    if v.is_finite() { v.clamp(lo, hi) } else { default }
}

/// Only what a Windows endpoint id is made of may reach buffer.txt: a newline in an id would start a new directive.
fn safe_device(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.chars().all(|c| c.is_ascii_hexdigit() || matches!(c, '{' | '}' | '-' | '.' | '_'))
}

fn filter_line(b: &Band) -> String {
    let (f, g, q) = (num(b.f, 10.0, 24_000.0, 1000.0), num(b.gain, -40.0, 40.0, 0.0), num(b.q, 0.05, 50.0, 1.0));
    match b.kind {
        Kind::Peak => format!("Filter: ON PK Fc {f:.1} Hz Gain {g:.1} dB Q {q:.3}"),
        Kind::LowShelf => format!("Filter: ON LSC Fc {f:.1} Hz Gain {g:.1} dB Q {q:.3}"),
        Kind::HighShelf => format!("Filter: ON HSC Fc {f:.1} Hz Gain {g:.1} dB Q {q:.3}"),
        Kind::LowCut => format!("Filter: ON HPQ Fc {f:.1} Hz Q {q:.3}"),
        Kind::HighCut => format!("Filter: ON LPQ Fc {f:.1} Hz Q {q:.3}"),
        Kind::Notch => format!("Filter: ON NO Fc {f:.1} Hz Q {q:.3}"),
        Kind::BandPass => format!("Filter: ON BP Fc {f:.1} Hz Q {q:.3}"),
    }
}

/// Temporary override while a band is held in solo (Alt+drag): only that range of that device is heard.
#[derive(Debug, Clone, PartialEq)]
pub struct Solo {
    pub device: String,
    pub f: f64,
    pub q: f64,
}

/// What is applied on top of the saved state and never saved itself: a band in solo, and a game preset on the
/// output in use. Keeping them out of eq.json means a restart mid-game, or an edit made during it, can't lose
/// the user's own EQ.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Live {
    pub solo: Option<Solo>,
    /// (output endpoint id, the game preset's bands)
    pub game: Option<(String, [Band; BANDS])>,
}

fn channel_section(out: &mut String, device: &str, ch: &Channel, live: &Live) {
    if !safe_device(device) {
        return;
    }
    out.push_str(&format!("Device: {}\n", device_guid(device)));
    if let Some(s) = live.solo.as_ref().filter(|s| s.device == device) {
        out.push_str(&filter_line(&Band::new(Kind::BandPass, s.f, 0.0, s.q.max(0.3))));
        out.push('\n');
        return;
    }
    if !ch.enabled {
        return;
    }
    let bands = match &live.game {
        Some((dev, b)) if dev == device => b,
        _ => &ch.bands,
    };
    let mut stages: Vec<Band> = Vec::new();
    let mut preamp = 0.0;
    if let Some(p) = &ch.autoeq {
        preamp += num(p.preamp, -40.0, 12.0, 0.0);
        stages.extend(p.filters.iter().filter(|b| b.on));
    }
    let user: Vec<Band> = bands.iter().copied().filter(|b| b.on).collect();
    // headroom for the user's boosts so a +6 dB bell never clips
    preamp -= curve::peak_db(&user).max(0.0);
    stages.extend(user);
    if preamp.abs() >= 0.05 {
        out.push_str(&format!("Preamp: {preamp:.1} dB\n"));
    }
    for b in &stages {
        out.push_str(&filter_line(b));
        out.push('\n');
    }
}

/// Full text of `buffer.txt`. A disabled state still writes the file so APO drops the EQ at once.
pub fn render(state: &EqState, live: &Live) -> String {
    let mut out = String::from("# Written by Buffer. Edits here are overwritten.\n");
    if state.enabled {
        let mut outputs = state.outputs.clone();
        // a game preset can land on an output that has no EQ of its own yet
        if let Some((dev, _)) = &live.game {
            outputs.entry(dev.clone()).or_default();
        }
        for (id, ch) in &outputs {
            channel_section(&mut out, id, ch, live);
        }
        channel_section(&mut out, &state.mic_device, &state.mic, live);
    } else if let Some(s) = &live.solo {
        channel_section(&mut out, &s.device, &Channel { enabled: false, ..Channel::default() }, live);
    }
    // later lines of APO's config.txt must not be scoped to our last device
    out.push_str("Device: all\n");
    out
}

/// Writes buffer.txt next to APO's config (APO reloads it within ~0.5 s) and, once the EQ is on, hooks it in.
/// `NotFound` when APO isn't installed.
pub fn apply(state: &EqState, live: &Live) -> std::io::Result<()> {
    let path = apo::include_path()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Equalizer APO is not installed"))?;
    write_atomic(&path, render(state, live).as_bytes())?;
    if state.enabled {
        apo::hook()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "{0.0.0.00000000}.{aaaa-bbbb}";
    const MIC: &str = "{0.0.1.00000000}.{cccc-dddd}";

    fn state() -> EqState {
        let mut s = EqState { enabled: true, mic_device: MIC.into(), ..Default::default() };
        s.outputs.insert(OUT.into(), Channel::default());
        s
    }

    #[test]
    fn flat_has_no_filters_or_preamp() {
        let mut s = state();
        s.mic.bands.iter_mut().for_each(|b| b.on = false);
        s.outputs.get_mut(OUT).unwrap().bands.iter_mut().for_each(|b| b.on = false);
        assert_eq!(
            render(&s, &Live::default()),
            "# Written by Buffer. Edits here are overwritten.\nDevice: {aaaa-bbbb}\nDevice: {cccc-dddd}\nDevice: all\n"
        );
    }

    #[test]
    fn every_kind_has_its_apo_line() {
        let lines: Vec<String> = [
            Kind::Peak,
            Kind::LowShelf,
            Kind::HighShelf,
            Kind::LowCut,
            Kind::HighCut,
            Kind::Notch,
            Kind::BandPass,
        ]
        .iter()
        .map(|&k| filter_line(&Band::new(k, 1000.0, 3.0, 0.707)))
        .collect();
        assert_eq!(
            lines,
            [
                "Filter: ON PK Fc 1000.0 Hz Gain 3.0 dB Q 0.707",
                "Filter: ON LSC Fc 1000.0 Hz Gain 3.0 dB Q 0.707",
                "Filter: ON HSC Fc 1000.0 Hz Gain 3.0 dB Q 0.707",
                "Filter: ON HPQ Fc 1000.0 Hz Q 0.707",
                "Filter: ON LPQ Fc 1000.0 Hz Q 0.707",
                "Filter: ON NO Fc 1000.0 Hz Q 0.707",
                "Filter: ON BP Fc 1000.0 Hz Q 0.707",
            ]
        );
    }

    #[test]
    fn boost_gets_matching_preamp() {
        let mut s = state();
        s.outputs.get_mut(OUT).unwrap().bands[3] = Band::new(Kind::Peak, 1000.0, 6.0, 1.0);
        let txt = render(&s, &Live::default());
        assert!(txt.contains("Preamp: -6.0 dB\n"), "{txt}");
        assert!(txt.contains("Filter: ON PK Fc 1000.0 Hz Gain 6.0 dB Q 1.000\n"));
    }

    #[test]
    fn disabled_state_writes_no_device_sections() {
        let mut s = state();
        s.enabled = false;
        assert_eq!(render(&s, &Live::default()), "# Written by Buffer. Edits here are overwritten.\nDevice: all\n");
    }

    #[test]
    fn solo_replaces_only_its_device() {
        let mut s = state();
        s.mic.bands[4].gain = 3.0;
        let txt = render(&s, &Live { solo: Some(Solo { device: OUT.into(), f: 3000.0, q: 2.0 }), game: None });
        let (out, mic) = txt.split_once("Device: {cccc-dddd}").unwrap();
        assert!(out.ends_with("Filter: ON BP Fc 3000.0 Hz Q 2.000\n"), "{txt}");
        assert!(!out.contains("PK") && mic.contains("PK"));
    }

    #[test]
    fn each_output_gets_its_own_section() {
        let mut s = state();
        s.outputs.insert("{0.0.0.00000000}.{eeee}".into(), Channel::default());
        assert!(s.set_preset("{0.0.0.00000000}.{eeee}", "gaming"));
        let txt = render(&s, &Live::default());
        assert!(txt.contains("Device: {aaaa-bbbb}\n") && txt.contains("Device: {eeee}\n"));
        assert_eq!(s.outputs["{0.0.0.00000000}.{eeee}"].preset, "gaming");
        assert_eq!(s.outputs[OUT].preset, "flat");
    }

    #[test]
    fn game_overlay_swaps_bands_but_keeps_state() {
        let mut s = state();
        s.outputs.get_mut(OUT).unwrap().bands[3].gain = -4.0;
        let live = Live { solo: None, game: Some((OUT.into(), presets::GAMING)) };
        let txt = render(&s, &live);
        assert!(txt.contains("Gain 4.5 dB"), "gaming bell at 3 kHz: {txt}");
        assert!(!txt.contains("Gain -4.0 dB"));
        assert_eq!(s.outputs[OUT].bands[3].gain, -4.0, "the saved EQ is untouched");
        // an output without its own EQ still gets the game preset
        let other = Live { solo: None, game: Some(("{0.0.0.00000000}.{ffff}".into(), presets::GAMING)) };
        assert!(render(&s, &other).contains("Device: {ffff}\nPreamp:"));
    }

    #[test]
    fn editing_a_builtin_preset_overrides_it_until_reset() {
        let mut s = state();
        assert_eq!(s.preset_bands("gaming"), Some(presets::GAMING));
        let mut mine = presets::GAMING;
        mine[2].gain = 9.0;
        s.user_presets.push(UserPreset { name: "gaming".into(), bands: mine });
        assert_eq!(s.preset_bands("gaming"), Some(mine), "the override wins");
        assert!(s.set_preset(OUT, "gaming"));
        assert_eq!(s.outputs[OUT].bands, mine);
        assert!(s.reset_preset("gaming"));
        assert_eq!(s.preset_bands("gaming"), Some(presets::GAMING));
        assert_eq!(s.outputs[OUT].bands, presets::GAMING, "channels on the preset get the shipped bands back");
        assert!(!s.reset_preset("Mine"), "only built-in presets can be reset");
    }

    #[test]
    fn hostile_input_cannot_start_a_new_directive() {
        let mut s = state();
        s.outputs.insert("{0.0.0.00000000}.{aaaa}\nInclude: C:\\evil.txt".into(), Channel::default());
        s.mic_device = "{mic}\r\nPreamp: 40 dB".into();
        s.outputs.get_mut(OUT).unwrap().bands[0] = Band::new(Kind::Peak, f64::NAN, f64::INFINITY, -5.0);
        let txt = render(&s, &Live::default());
        assert!(!txt.contains("evil") && !txt.contains("Preamp: 40"), "{txt}");
        assert!(!txt.contains("NaN") && !txt.contains("inf"), "{txt}");
        // every line is one of ours
        assert!(txt.lines().all(|l| l.starts_with('#') || l.starts_with("Device: ") || l.starts_with("Preamp: ") || l.starts_with("Filter: ")), "{txt}");
    }

    #[test]
    fn a_legacy_eq_json_moves_to_the_buffer_folder() {
        let base = std::env::temp_dir().join(format!("ml-eq-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("moments-lite").join("eq")).unwrap();
        std::fs::write(base.join("moments-lite").join("eq.json"), "{\"enabled\":true}").unwrap();
        migrate_legacy_eq(&base);
        assert_eq!(std::fs::read_to_string(base.join("Buffer").join("eq.json")).unwrap(), "{\"enabled\":true}");
        assert!(!base.join("moments-lite").exists(), "the empty stray folder is gone");
        // a file that already exists in the new place is never overwritten
        std::fs::create_dir_all(base.join("moments-lite")).unwrap();
        std::fs::write(base.join("moments-lite").join("eq.json"), "old").unwrap();
        migrate_legacy_eq(&base);
        assert_eq!(std::fs::read_to_string(base.join("Buffer").join("eq.json")).unwrap(), "{\"enabled\":true}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn games_are_remembered_most_recent_first() {
        let mut s = state();
        assert!(s.note_game("cs2", "cs2"));
        assert!(s.note_game("hades", "Hades"));
        assert!(!s.note_game("hades", "Hades"), "nothing new, nothing to save");
        assert!(s.note_game("cs2", "cs2"), "back to the front counts as a change");
        assert_eq!(s.recent_games, ["cs2", "hades"]);
        for i in 0..40 {
            s.note_game(&format!("g{i}"), "g");
        }
        assert_eq!(s.recent_games.len(), 30, "the list is capped");
        assert_eq!(s.recent_games[0], "g39");
    }

    #[test]
    fn state_round_trips_through_json() {
        let mut s = state();
        s.user_presets.push(UserPreset { name: "Mine".into(), bands: presets::GAMING });
        s.game_presets.insert("cs2".into(), "gaming".into());
        let back: EqState = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.preset_bands("Mine"), Some(presets::GAMING));
        assert!(!s.set_preset(OUT, "nope"));
    }
}
