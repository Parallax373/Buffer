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
    path::{Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter};

const VIDEO_EXT: [&str; 3] = ["mp4", "mkv", "mov"];
/// Folders the app writes to or that only hold derived files.
const SKIP_DIRS: [&str; 2] = ["Exported Clips", "Shared Clips"];

#[derive(Serialize)]
struct ClipEntry {
    path: String,
    name: String,
    group: String,
    size: u64,
    modified: u64,
}

fn collect(root: &Path, dir: &Path, depth: u32, out: &mut Vec<ClipEntry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            let skip = p
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(n)));
            if depth < 3 && !skip {
                collect(root, &p, depth + 1, out);
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
async fn list_clips(dir: String) -> Result<Vec<ClipEntry>, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("Folder not found: {dir}"));
    }
    let mut v = Vec::new();
    collect(&root, &root, 0, &mut v);
    v.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(v)
}

#[tauri::command]
async fn probe_clip(path: String) -> Result<MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || probe::probe(Path::new(&path)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

fn cache_dir(input: &Path) -> Result<PathBuf, String> {
    let meta = fs::metadata(input).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    input.hash(&mut h);
    meta.len().hash(&mut h);
    meta.modified().ok().hash(&mut h);
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("moments-lite").join("cache").join(format!("{:016x}", h.finish()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Splits every audio track into its own file (stream copy) so the preview can mix them independently.
#[tauri::command]
async fn prepare_audio(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let input = PathBuf::from(&path);
        let info = probe::probe(&input).map_err(|e| e.to_string())?;
        let dir = cache_dir(&input)?;
        let files: Vec<PathBuf> = (0..info.audio.len()).map(|i| dir.join(format!("a{i}.m4a"))).collect();
        if files.iter().any(|f| !f.exists()) {
            let mut cmd = Command::new("ffmpeg");
            cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"]).arg(&input);
            for (i, f) in files.iter().enumerate() {
                cmd.args(["-map", &format!("0:a:{i}"), "-vn", "-c", "copy"]).arg(f);
            }
            hide_window(&mut cmd);
            let out = cmd.output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                for f in &files {
                    let _ = fs::remove_file(f);
                }
                return Err(String::from_utf8_lossy(&out.stderr).into_owned());
            }
        }
        Ok(files.iter().map(|f| f.to_string_lossy().into_owned()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![list_clips, probe_clip, prepare_audio, export_clip, reveal])
        .run(tauri::generate_context!())
        .expect("error while running Moments Lite");
}
