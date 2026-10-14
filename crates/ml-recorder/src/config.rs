use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Segment length of the rolling buffer, in seconds.
pub const SEGMENT_SECS: u32 = 2;
/// Loopback control port (localhost only). The single-instance mutex guards against two recorders.
pub const CONTROL_PORT: u16 = 47821;

/// A remembered audio endpoint. The ID is authoritative; the name lets us find the same physical
/// device again if Windows hands it a new ID after it was plugged into another port.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DeviceRef {
    pub id: String,
    pub name: String,
}

/// One audio source (Game / Chat / Mic): a preferred device and an optional fallback.
/// Both empty means "choose automatically" (only meant for a brand-new, not yet configured install).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceCfg {
    pub primary: Option<DeviceRef>,
    pub secondary: Option<DeviceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Where finished clips are written (same folder the editor scans).
    pub output_dir: String,
    /// Put every clip into a sub-folder named after the game.
    pub per_game_folders: bool,
    /// How many seconds a saved clip contains.
    pub buffer_seconds: u32,
    pub fps: u32,
    /// Output width in pixels (height keeps the aspect ratio). 0 = native resolution.
    pub width: u32,
    pub video_kbps: u32,
    /// Which monitor to capture (0 = primary).
    pub monitor: u32,
    /// "auto" picks NVENC, then AMF, then QuickSync, then CPU. Or force one of h264_nvenc / h264_amf / h264_qsv / libx264.
    pub encoder: String,
    /// Shifts audio against video, in milliseconds (positive = audio later). Tune by ear if lips and
    /// voice drift apart on this machine; saved clips are not touched, only new recordings.
    pub audio_offset_ms: i32,
    /// e.g. "Alt+Q". Changing it requires restarting the recorder.
    pub hotkey: String,
    pub game: SourceCfg,
    pub chat: SourceCfg,
    pub mic: SourceCfg,
    /// Show the "Buffer active" popup when a game starts and when a clip is saved.
    pub popup: bool,
    /// Executable stems (lowercase) that are never treated as a game.
    pub ignore_apps: Vec<String>,
    /// Executable stems (lowercase) that are always treated as a game, even in a window.
    pub extra_games: Vec<String>,
    /// Executable stem (lowercase) -> display name used in file names, e.g. "cs2" -> "Counter-Strike-2".
    pub game_names: std::collections::BTreeMap<String, String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            output_dir: default_output_dir(),
            per_game_folders: false,
            buffer_seconds: 120,
            fps: 30,
            width: 1920,
            video_kbps: 14_000,
            monitor: 0,
            encoder: "auto".into(),
            audio_offset_ms: 0,
            hotkey: "Alt+Q".into(),
            game: SourceCfg::default(),
            chat: SourceCfg::default(),
            mic: SourceCfg::default(),
            popup: true,
            ignore_apps: Vec::new(),
            extra_games: Vec::new(),
            game_names: Default::default(),
        }
    }
}

pub fn default_output_dir() -> String {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Videos").join("Buffer").to_string_lossy().into_owned()
}

pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Buffer")
}

pub fn local_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join(ml_core::paths::LOCAL_DIR_NAME)
}

pub fn config_path() -> PathBuf {
    data_dir().join("recorder.json")
}

pub fn buffer_dir() -> PathBuf {
    local_dir().join("buffer")
}

pub fn log_path() -> PathBuf {
    local_dir().join("recorder.log")
}

impl Config {
    /// Reads the config. A missing file yields defaults (and is written so it can be edited);
    /// an unreadable one keeps the previous behaviour of falling back to defaults too.
    pub fn load() -> Config {
        let path = config_path();
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => {
                let cfg = Config::default();
                let _ = std::fs::create_dir_all(data_dir());
                let _ = std::fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap_or_default());
                cfg
            }
        }
    }
}
