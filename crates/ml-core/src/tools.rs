//! Locates ffmpeg/ffprobe and picks the best available video encoder.
//!
//! Lookup order: next to the running executable (the installer ships ffmpeg there, so a fresh
//! machine needs nothing), then PATH, then the winget link directory (processes started at
//! login may not have the interactive PATH).

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
};

fn find(name: &str) -> PathBuf {
    let exe = format!("{name}.exe");
    if let Ok(me) = std::env::current_exe() {
        if let Some(dir) = me.parent() {
            let candidate = dir.join(&exe);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(&exe);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = Path::new(&local).join("Microsoft").join("WinGet").join("Links").join(&exe);
        if candidate.is_file() {
            return candidate;
        }
    }
    // Not found: return the bare name so the OS error message names the tool.
    PathBuf::from(exe)
}

pub fn ffmpeg() -> &'static Path {
    static P: OnceLock<PathBuf> = OnceLock::new();
    P.get_or_init(|| find("ffmpeg"))
}

pub fn ffprobe() -> &'static Path {
    static P: OnceLock<PathBuf> = OnceLock::new();
    P.get_or_init(|| find("ffprobe"))
}

/// True when the binary was actually located (not just the bare fallback name).
pub fn available(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

/// True when this ffmpeg is the copy shipped next to the app.
pub fn is_bundled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|me| me.parent().map(|d| d.join("ffmpeg.exe")))
        .is_some_and(|p| p == ffmpeg())
}

/// Whether `encoder` really works on this machine (an encoder can be compiled in but have no hardware).
pub fn encoder_works(encoder: &str) -> bool {
    let mut cmd = Command::new(ffmpeg());
    cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30"])
        .args(["-frames:v", "5", "-c:v", encoder, "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::export::hide_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// The best H.264 encoder on this machine: NVIDIA, then AMD, then Intel, then the CPU.
pub fn best_h264_encoder() -> &'static str {
    static C: OnceLock<&'static str> = OnceLock::new();
    C.get_or_init(|| {
        for enc in ["h264_nvenc", "h264_amf", "h264_qsv"] {
            if encoder_works(enc) {
                return enc;
            }
        }
        "libx264"
    })
}
