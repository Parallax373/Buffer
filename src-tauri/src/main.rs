#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use ml_core::{
    export::{self, hide_window, ExportOptions, ExportResult},
    probe::{self, MediaInfo},
};
use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Condvar, Mutex},
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const VIDEO_EXT: [&str; 3] = ["mp4", "mkv", "mov"];
/// Folders the app writes to or that only hold derived files.
const SKIP_DIRS: [&str; 2] = ["Exported Clips", "Shared Clips"];
const RECORDER_PORT: u16 = 47821;

// ───────────────────────── library ─────────────────────────

#[derive(Serialize)]
struct ClipEntry {
    path: String,
    name: String,
    group: String,
    size: u64,
    modified: u64,
}

fn collect(root: &Path, dir: &Path, depth: u32, recurse: bool, out: &mut Vec<ClipEntry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            let skip = p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(n)));
            if recurse && depth < 3 && !skip {
                collect(root, &p, depth + 1, recurse, out);
            }
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| VIDEO_EXT.iter().any(|v| v.eq_ignore_ascii_case(x)))
        {
            let group = p
                .parent()
                .and_then(|d| d.strip_prefix(root).ok())
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(ClipEntry {
                path: p.to_string_lossy().into_owned(),
                name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                group,
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs()),
            });
        }
    }
}

#[tauri::command]
async fn list_clips(dirs: Vec<String>, recurse: bool) -> Result<Vec<ClipEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut v = Vec::new();
        let mut missing = Vec::new();
        for d in &dirs {
            let root = PathBuf::from(d);
            if root.is_dir() {
                collect(&root, &root, 0, recurse, &mut v);
            } else {
                missing.push(d.clone());
            }
        }
        if v.is_empty() && !missing.is_empty() {
            return Err(format!("Folder not found: {}", missing.join(", ")));
        }
        v.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn probe_clip(path: String) -> Result<MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || probe::probe(Path::new(&path)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

// ───────────────────────── cache (audio tracks, thumbnails, waveforms) ─────────────────────────

fn local_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(ml_core::paths::LOCAL_DIR_NAME)
}

fn data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Buffer")
}

fn cache_dir(input: &Path) -> Result<PathBuf, String> {
    let meta = fs::metadata(input).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    input.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified().ok().hash(&mut h);
    let dir = local_dir().join("cache").join(format!("{:016x}", h.finish()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Counting semaphore so a scrolling library never starts dozens of ffmpeg processes at once.
struct Permits {
    free: Mutex<usize>,
    cv: Condvar,
}

impl Permits {
    const fn new(n: usize) -> Self {
        Permits { free: Mutex::new(n), cv: Condvar::new() }
    }
    fn acquire(&self) -> PermitGuard<'_> {
        let mut n = self.free.lock().unwrap();
        while *n == 0 {
            n = self.cv.wait(n).unwrap();
        }
        *n -= 1;
        PermitGuard(self)
    }
}

struct PermitGuard<'a>(&'a Permits);
impl Drop for PermitGuard<'_> {
    fn drop(&mut self) {
        *self.0.free.lock().unwrap() += 1;
        self.0.cv.notify_one();
    }
}

static FFMPEG_JOBS: Permits = Permits::new(3);

fn ffmpeg_cmd() -> Command {
    let mut c = Command::new(ml_core::tools::ffmpeg());
    hide_window(&mut c);
    c
}

/// Splits every audio track into its own file (stream copy) so the preview can mix them independently.
fn prepare_audio_sync(input: &Path) -> Result<Vec<PathBuf>, String> {
    let info = probe::probe(input).map_err(|e| e.to_string())?;
    let dir = cache_dir(input)?;
    let files: Vec<PathBuf> = (0..info.audio.len()).map(|i| dir.join(format!("a{i}.m4a"))).collect();
    if files.iter().any(|f| !f.exists()) {
        let _p = FFMPEG_JOBS.acquire();
        let mut cmd = ffmpeg_cmd();
        cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"]).arg(input);
        for (i, f) in files.iter().enumerate() {
            cmd.args(["-map", &format!("0:a:{i}"), "-vn", "-c", "copy"]).arg(f);
        }
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            for f in &files {
                let _ = fs::remove_file(f);
            }
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
    }
    Ok(files)
}

#[tauri::command]
async fn prepare_audio(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_audio_sync(Path::new(&path))
            .map(|v| v.iter().map(|f| f.to_string_lossy().into_owned()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn thumbnail(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let input = PathBuf::from(&path);
        let out = cache_dir(&input)?.join("thumb.jpg");
        if !out.exists() {
            let _p = FFMPEG_JOBS.acquire();
            for seek in ["2", "0"] {
                let mut cmd = ffmpeg_cmd();
                cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-ss", seek, "-i"])
                    .arg(&input)
                    .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5"])
                    .arg(&out);
                let _ = cmd.output();
                if out.exists() {
                    break;
                }
            }
        }
        if out.exists() {
            Ok(out.to_string_lossy().into_owned())
        } else {
            Err("no frame".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

const WAVE_BARS: usize = 240;

#[tauri::command]
async fn waveform(path: String, index: usize) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let input = PathBuf::from(&path);
        let cache = cache_dir(&input)?.join(format!("wave{index}.bin"));
        if let Ok(b) = fs::read(&cache) {
            if b.len() == WAVE_BARS {
                return Ok(b);
            }
        }
        let files = prepare_audio_sync(&input)?;
        let file = files.get(index).ok_or("no such track")?;
        let _p = FFMPEG_JOBS.acquire();
        let mut cmd = ffmpeg_cmd();
        cmd.args(["-v", "error", "-i"])
            .arg(file)
            .args(["-ac", "1", "-ar", "2000", "-f", "s16le", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let mut raw = Vec::new();
        child.stdout.take().unwrap().read_to_end(&mut raw).map_err(|e| e.to_string())?;
        let _ = child.wait();
        let samples: Vec<i16> = raw.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let mut bars = vec![0u8; WAVE_BARS];
        if !samples.is_empty() {
            for (i, bar) in bars.iter_mut().enumerate() {
                let a = i * samples.len() / WAVE_BARS;
                let b = ((i + 1) * samples.len() / WAVE_BARS).max(a + 1).min(samples.len());
                let peak = samples[a..b].iter().map(|s| s.unsigned_abs()).max().unwrap_or(0) as f32 / 32768.0;
                *bar = (peak.sqrt() * 100.0).round().clamp(0.0, 100.0) as u8;
            }
        }
        let _ = fs::write(&cache, &bars);
        Ok(bars)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn clear_cache() -> Result<u64, String> {
    let dir = local_dir().join("cache");
    let mut bytes = 0u64;
    fn walk(p: &Path, bytes: &mut u64) {
        if let Ok(rd) = fs::read_dir(p) {
            for e in rd.flatten() {
                let q = e.path();
                if q.is_dir() {
                    walk(&q, bytes);
                } else if let Ok(m) = e.metadata() {
                    *bytes += m.len();
                }
            }
        }
    }
    walk(&dir, &mut bytes);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}

#[tauri::command]
fn cache_size() -> u64 {
    fn walk(p: &Path) -> u64 {
        fs::read_dir(p)
            .map(|rd| {
                rd.flatten()
                    .map(|e| {
                        let q = e.path();
                        if q.is_dir() { walk(&q) } else { e.metadata().map_or(0, |m| m.len()) }
                    })
                    .sum()
            })
            .unwrap_or(0)
    }
    walk(&local_dir().join("cache"))
}

// ───────────────────────── export / files ─────────────────────────

#[tauri::command]
async fn export_clip(app: AppHandle, opts: ExportOptions) -> Result<ExportResult, String> {
    if let Some(parent) = opts.output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        export::export(&opts, |p| {
            let _ = app.emit("export-progress", p);
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    Command::new("explorer")
        .arg(format!("/select,{}", path.replace('/', "\\")))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Moves files to the Windows Recycle Bin (never a permanent delete).
#[tauri::command]
fn delete_clips(paths: Vec<String>) -> Result<usize, String> {
    let mut n = 0;
    for p in &paths {
        trash::delete(p).map_err(|e| format!("{p}: {e}"))?;
        n += 1;
    }
    Ok(n)
}

// ───────────────────────── persisted UI state ─────────────────────────

#[tauri::command]
fn load_state() -> serde_json::Value {
    fs::read(data_dir().join("app-state.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn save_state(state: serde_json::Value) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("app-state.json.tmp");
    fs::write(&tmp, serde_json::to_vec(&state).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dir.join("app-state.json")).map_err(|e| e.to_string())
}

// ───────────────────────── tools & recorder ─────────────────────────

#[derive(Serialize)]
struct ToolsStatus {
    ffmpeg_path: String,
    ffmpeg_found: bool,
    ffmpeg_bundled: bool,
    ffmpeg_version: String,
    /// Encoder the recorder and exporter will use on this machine ("h264_nvenc", "h264_amf", "h264_qsv", "libx264").
    encoder: String,
    nvenc: bool,
    gpu: String,
}

#[tauri::command]
async fn tools_status() -> ToolsStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let path = ml_core::tools::ffmpeg();
        let found = ml_core::tools::available(path);
        let mut version = String::new();
        let mut nvenc = false;
        if found {
            let mut c = ffmpeg_cmd();
            if let Ok(o) = c.arg("-version").output() {
                version = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(2)
                    .unwrap_or("")
                    .to_string();
            }
            let mut c = ffmpeg_cmd();
            if let Ok(o) = c.args(["-hide_banner", "-encoders"]).output() {
                nvenc = String::from_utf8_lossy(&o.stdout).contains("h264_nvenc");
            }
        }
        let mut gpu = String::new();
        let mut c = Command::new("nvidia-smi");
        hide_window(&mut c);
        if let Ok(o) = c.args(["--query-gpu=name", "--format=csv,noheader"]).output() {
            gpu = String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string();
        }
        let encoder = if found { ml_core::tools::best_h264_encoder().to_string() } else { String::new() };
        ToolsStatus {
            ffmpeg_path: path.to_string_lossy().into_owned(),
            ffmpeg_found: found,
            ffmpeg_bundled: ml_core::tools::is_bundled(),
            ffmpeg_version: version,
            encoder,
            nvenc,
            gpu,
        }
    })
    .await
    .unwrap_or(ToolsStatus {
        ffmpeg_path: String::new(),
        ffmpeg_found: false,
        ffmpeg_bundled: false,
        ffmpeg_version: String::new(),
        encoder: String::new(),
        nvenc: false,
        gpu: String::new(),
    })
}

fn recorder_exe() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    let dir = me.parent()?;
    let mut candidates = vec![dir.join("buffer-recorder.exe")];
    // development layout: target/<profile>/buffer.exe next to target/<profile>/buffer-recorder.exe
    candidates.push(dir.join("..").join("release").join("buffer-recorder.exe"));
    candidates.push(dir.join("..").join("debug").join("buffer-recorder.exe"));
    candidates.into_iter().find(|p| p.is_file())
}

fn recorder_cli(args: &[&str]) -> Result<String, String> {
    let exe = recorder_exe().ok_or("buffer-recorder.exe not found next to the app")?;
    let mut c = Command::new(exe);
    c.args(args);
    hide_window(&mut c);
    let o = c.output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn recorder_send(cmd: &str) -> Result<String, String> {
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], RECORDER_PORT).into(), Duration::from_millis(600))
        .map_err(|_| "recorder is not running".to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(90))).ok();
    writeln!(s, "{cmd}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}

/// status | save | reload | quit
#[tauri::command]
async fn recorder_cmd(cmd: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = recorder_send(&cmd)?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn recorder_launch() -> Result<(), String> {
    let exe = recorder_exe().ok_or("buffer-recorder.exe not found next to the app")?;
    let mut c = Command::new(exe);
    c.arg("run").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut c);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn recorder_config() -> serde_json::Value {
    fs::read(data_dir().join("recorder.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn set_recorder_config(config: serde_json::Value) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("recorder.json"), serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn recorder_devices() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let raw = recorder_cli(&["devices-json"])?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Peak level (0..1) per endpoint id / "@default:*" token, for the live meters in the audio settings.
#[tauri::command]
async fn recorder_levels(ids: Vec<String>) -> Result<serde_json::Value, String> {
    if ids.is_empty() {
        return Ok(serde_json::json!({}));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["levels"];
        args.extend(ids.iter().map(|s| s.as_str()));
        let raw = recorder_cli(&args)?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn recorder_monitors() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let raw = recorder_cli(&["monitors-json"])?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where clips go on a fresh install: the user's Videos\Buffer folder.
#[tauri::command]
fn default_clips_dir() -> String {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Videos").join("Buffer").to_string_lossy().into_owned()
}

/// `None` reports the current state; `Some(on)` changes it. Returns whether autostart is enabled.
#[tauri::command]
fn recorder_autostart(enable: Option<bool>) -> Result<bool, String> {
    match enable {
        Some(true) => {
            recorder_cli(&["install-autostart"])?;
        }
        Some(false) => {
            recorder_cli(&["uninstall-autostart"])?;
        }
        None => {}
    }
    Ok(recorder_cli(&["autostart-status"])? == "enabled")
}

fn main() {
    ml_core::paths::migrate_legacy_dirs();
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_clips,
            probe_clip,
            prepare_audio,
            thumbnail,
            waveform,
            clear_cache,
            cache_size,
            export_clip,
            reveal,
            delete_clips,
            load_state,
            save_state,
            tools_status,
            recorder_cmd,
            recorder_launch,
            recorder_config,
            set_recorder_config,
            recorder_devices,
            recorder_monitors,
            recorder_levels,
            default_clips_dir,
            recorder_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Buffer");
}
