//! Long-form recording: keeps everything from "start" to "stop" instead of only the last minutes.
//!
//! It reuses the rolling buffer's ffmpeg session. Each finished 2-second segment is appended, byte for
//! byte, to one growing `.rec.ts` file in the output folder (MPEG-TS joins like that without re-timing),
//! so the file survives a crash and the recorder needs no second encoder. On stop the file is remuxed to
//! an MP4 with the same three named audio tracks as an instant clip.

use crate::config::Config;
use crate::overlay::Event;
use crate::session::{current_game_name, log, segments, Shared};
use crate::win;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::Ordering, Arc},
    thread,
    time::{Duration, Instant},
};

/// Below this much free space on the output drive a long recording stops by itself.
const MIN_FREE: u64 = 2 * 1024 * 1024 * 1024;
const TS_PACKET: u64 = 188;

pub struct Long {
    pub started: Instant,
    dir: PathBuf,
    stem: String,
    /// `.rec.ts` files in order; a recorder restart (new timestamps) begins a new part.
    parts: Vec<PathBuf>,
    cur: Option<File>,
    /// Name of the last segment that was appended; only newer ones are taken.
    last: String,
    pub bytes: u64,
    last_disk_check: Instant,
}

fn seg_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn active(shared: &Shared) -> bool {
    shared.long.lock().unwrap().is_some()
}

pub fn elapsed_secs(shared: &Shared) -> Option<u64> {
    shared.long.lock().unwrap().as_ref().map(|l| l.started.elapsed().as_secs())
}

pub fn bytes(shared: &Shared) -> u64 {
    shared.long.lock().unwrap().as_ref().map_or(0, |l| l.bytes)
}

pub fn start(shared: &Arc<Shared>) -> Result<(), String> {
    let cfg: Config = shared.cfg.lock().unwrap().clone();
    let mut slot = shared.long.lock().unwrap();
    if slot.is_some() {
        return Err(crate::lang::t("err.busy"));
    }
    let game = current_game_name(&cfg);
    let mut dir = PathBuf::from(&cfg.output_dir);
    if cfg.per_game_folders {
        dir = dir.join(&game);
    }
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    if win::free_bytes(&dir).is_some_and(|f| f < MIN_FREE) {
        return Err(crate::lang::t("err.space"));
    }
    *slot = Some(Long {
        started: Instant::now(),
        dir,
        stem: format!("{game}__{}", win::local_stamp()),
        parts: Vec::new(),
        cur: None,
        // everything already in the buffer is older than "now"; the segment being written belongs to the past too
        last: segments().last().map(|p| seg_name(p)).unwrap_or_default(),
        bytes: 0,
        last_disk_check: Instant::now(),
    });
    drop(slot);
    log("long recording started");
    Ok(())
}

/// Appends finished segments to the current part. `include_newest` also takes the one still being written
/// (only right before the session ends or restarts; a partial last packet is trimmed away).
fn append(l: &mut Long, include_newest: bool) -> Result<(), String> {
    let segs = segments();
    let limit = if include_newest { segs.len() } else { segs.len().saturating_sub(1) };
    for p in &segs[..limit] {
        let name = seg_name(p);
        if name <= l.last {
            continue;
        }
        let mut data = fs::read(p).map_err(|e| e.to_string())?;
        data.truncate(data.len() - data.len() % TS_PACKET as usize);
        if l.cur.is_none() {
            let n = l.parts.len() + 1;
            let path = l.dir.join(if n == 1 { format!("{}.rec.ts", l.stem) } else { format!("{}.p{n}.rec.ts", l.stem) });
            let f = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            l.parts.push(path);
            l.cur = Some(f);
        }
        l.cur.as_mut().unwrap().write_all(&data).map_err(|e| e.to_string())?;
        l.bytes += data.len() as u64;
        l.last = name;
    }
    Ok(())
}

/// Called from the recording loop several times a second: moves finished segments into the file and
/// watches the disk. Must run before the buffer is pruned.
pub fn tick(shared: &Arc<Shared>) {
    let mut guard = shared.long.lock().unwrap();
    let Some(l) = guard.as_mut() else { return };
    let mut problem = append(l, false).err();
    if problem.is_none() && l.last_disk_check.elapsed() > Duration::from_secs(10) {
        l.last_disk_check = Instant::now();
        if win::free_bytes(&l.dir).is_some_and(|f| f < MIN_FREE) {
            problem = Some(crate::lang::t("err.disk_full"));
        }
    }
    drop(guard);
    if let Some(msg) = problem {
        stop_async(shared, Some(msg));
    }
}

/// The session is about to delete its segments (restart): take what is left and close the part.
pub fn flush_all(shared: &Shared) {
    let mut guard = shared.long.lock().unwrap();
    if let Some(l) = guard.as_mut() {
        if let Err(e) = append(l, true) {
            log(&format!("long recording: {e}"));
        }
        l.cur = None;
    }
}

pub fn toggle(shared: &Arc<Shared>) {
    if active(shared) {
        stop_async(shared, None);
    } else {
        match start(shared) {
            Ok(()) => {
                // read the shortcut first: `popup` takes the config lock itself, so it must not be held here
                let hk = shared.cfg.lock().unwrap().record_hotkey.clone();
                shared.popup(Event::Game, crate::lang::t("lr.started"), crate::lang::f("lr.started_sub", &[("hk", &hk)]));
            }
            Err(e) => shared.popup(Event::SaveFailed, crate::lang::t("lr.start_failed"), e),
        }
    }
}

pub fn stop_async(shared: &Arc<Shared>, reason: Option<String>) {
    if shared.long_stopping.swap(true, Ordering::Relaxed) {
        return;
    }
    let s = shared.clone();
    thread::spawn(move || {
        let result = stop(&s);
        s.long_stopping.store(false, Ordering::Relaxed);
        match result {
            Ok(Some(path)) => {
                win::beep();
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                s.popup(Event::Saved, reason.map_or(crate::lang::t("lr.saved"), |r| crate::lang::f("lr.stopped", &[("r", &r)])), name);
            }
            Ok(None) => {}
            Err(e) => {
                log(&format!("long recording failed: {e}"));
                *s.last_error.lock().unwrap() = format!("long recording failed: {e}");
                s.popup(Event::SaveFailed, crate::lang::t("lr.save_failed"), e);
            }
        }
    });
}

/// Finishes the recording and returns the MP4. Blocks while the file is remuxed.
pub fn stop(shared: &Arc<Shared>) -> Result<Option<PathBuf>, String> {
    if !active(shared) {
        return Ok(None);
    }
    let recording = shared.recording.load(Ordering::Relaxed);
    // wait for the segment being written to be finished, so the last seconds before "stop" are in the file
    if recording {
        let before = segments().last().map(|p| seg_name(p));
        for _ in 0..14 {
            if shared.quit.load(Ordering::Relaxed) || segments().last().map(|p| seg_name(p)) != before {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    let mut l = {
        let mut guard = shared.long.lock().unwrap();
        let Some(mut l) = guard.take() else { return Ok(None) };
        let r = append(&mut l, !recording || shared.quit.load(Ordering::Relaxed));
        l.cur = None;
        if let Err(e) = r {
            log(&format!("long recording: {e}"));
        }
        l
    };
    log(&format!("long recording stopped after {} s, {} MB", l.started.elapsed().as_secs(), l.bytes / 1_000_000));
    // settings changed during the recording were held back; apply them now
    if shared.restart_pending.swap(false, Ordering::Relaxed) {
        shared.restart.store(true, Ordering::Relaxed);
    }
    if l.parts.is_empty() {
        return Err("nic nie nagrano".into());
    }
    shared.finalizing.store(true, Ordering::Relaxed);
    let out = remux(&l);
    shared.finalizing.store(false, Ordering::Relaxed);
    let out = out?;
    for p in l.parts.drain(..) {
        let _ = fs::remove_file(p);
    }
    *shared.last_saved.lock().unwrap() = out.to_string_lossy().into_owned();
    log(&format!("saved {}", out.display()));
    Ok(Some(out))
}

fn remux_args(cmd: &mut Command) {
    cmd.args(["-map", "0:v:0", "-map", "0:a:0", "-map", "0:a:1", "-map", "0:a:2", "-c", "copy"])
        .args(["-bsf:a", "aac_adtstoasc"])
        .args(["-metadata:s:v:0", "handler_name=VideoHandler"])
        .args(["-metadata:s:a:0", "handler_name=Game"])
        .args(["-metadata:s:a:1", "handler_name=Chat"])
        .args(["-metadata:s:a:2", "handler_name=Mic"])
        .args(["-disposition:a:0", "default"]);
}

fn run(mut cmd: Command) -> Result<(), String> {
    ml_core::export::hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Turns `.rec.ts` parts into `<stem>.mp4`. One part is remuxed directly; several (the recorder restarted
/// mid-way) are remuxed one by one and then joined.
fn remux(l: &Long) -> Result<PathBuf, String> {
    let out = l.dir.join(format!("{}.mp4", l.stem));
    let tmp = l.dir.join(format!("{}.part.mp4", l.stem));
    let one = |input: &Path, output: &Path| {
        let mut cmd = Command::new(ml_core::tools::ffmpeg());
        cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"]).arg(input);
        remux_args(&mut cmd);
        cmd.arg(output);
        run(cmd)
    };
    if l.parts.len() == 1 {
        one(&l.parts[0], &tmp).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })?;
    } else {
        let mut mp4s = Vec::new();
        for (i, p) in l.parts.iter().enumerate() {
            let m = l.dir.join(format!("{}.p{}.tmp.mp4", l.stem, i + 1));
            if one(p, &m).is_ok() {
                mp4s.push(m);
            }
        }
        let list = l.dir.join(format!("{}.list.txt", l.stem));
        let text: String = mp4s.iter().map(|m| format!("file '{}'\n", m.to_string_lossy().replace('\\', "/").replace('\'', "'\\''"))).collect();
        let joined = fs::write(&list, text).map_err(|e| e.to_string()).and_then(|_| {
            let mut cmd = Command::new(ml_core::tools::ffmpeg());
            cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
                .arg(&list)
                .args(["-c", "copy"])
                .arg(&tmp);
            run(cmd)
        });
        let _ = fs::remove_file(&list);
        for m in &mp4s {
            let _ = fs::remove_file(m);
        }
        joined.inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })?;
    }
    fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// A recording that was cut short by a crash or power loss leaves `*.rec.ts` behind. Turn those into
/// MP4s the next time the recorder starts.
pub fn recover_orphans(cfg: &Config) {
    let root = PathBuf::from(&cfg.output_dir);
    let mut dirs = vec![root.clone()];
    if let Ok(rd) = fs::read_dir(&root) {
        dirs.extend(rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
    }
    for dir in dirs {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut found: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| seg_name(p).ends_with(".rec.ts") && !seg_name(p).contains(".p2.") && p.metadata().is_ok_and(|m| m.len() > 0))
            .collect();
        found.sort();
        for first in found {
            let stem = seg_name(&first).trim_end_matches(".rec.ts").to_string();
            let mut parts = vec![first.clone()];
            for n in 2..20 {
                let next = dir.join(format!("{stem}.p{n}.rec.ts"));
                if next.is_file() {
                    parts.push(next);
                } else {
                    break;
                }
            }
            let l = Long {
                started: Instant::now(),
                dir: dir.clone(),
                stem,
                parts: parts.clone(),
                cur: None,
                last: String::new(),
                bytes: 0,
                last_disk_check: Instant::now(),
            };
            match remux(&l) {
                Ok(out) => {
                    log(&format!("recovered {}", out.display()));
                    for p in parts {
                        let _ = fs::remove_file(p);
                    }
                }
                Err(e) => log(&format!("could not recover {}: {e}", first.display())),
            }
        }
    }
}
