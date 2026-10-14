//! Per-user data folders and the one-time moves from earlier names.
//!
//! * `%APPDATA%\Buffer`      — settings, favourites, recorder.json
//! * `%LOCALAPPDATA%\BufferData` — caches, the rolling buffer, logs (kept apart from the install folder
//!   `%LOCALAPPDATA%\Buffer`, so uninstalling or updating never touches recordings in progress)

use std::{fs, path::PathBuf};

pub const LOCAL_DIR_NAME: &str = "BufferData";

/// Moves data from the pre-release locations when the new ones do not exist yet. Safe to call
/// from every process, repeatedly.
pub fn migrate_legacy_dirs() {
    if let Some(base) = std::env::var_os("APPDATA").map(PathBuf::from) {
        let (old, new) = (base.join("moments-lite"), base.join("Buffer"));
        if old.is_dir() && !new.exists() {
            let _ = fs::rename(&old, &new);
        }
    }
    if let Some(base) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let new = base.join(LOCAL_DIR_NAME);
        if new.exists() {
            return;
        }
        let old = base.join("moments-lite");
        if old.is_dir() {
            let _ = fs::rename(&old, &new);
            return;
        }
        // An intermediate build kept caches directly in `Buffer`, which is now the install folder.
        let mid = base.join("Buffer");
        let moved: Vec<_> = ["cache", "buffer", "recorder.log"].iter().filter(|n| mid.join(n).exists()).collect();
        if !moved.is_empty() && fs::create_dir_all(&new).is_ok() {
            for name in moved {
                let _ = fs::rename(mid.join(name), new.join(name));
            }
        }
    }
}
