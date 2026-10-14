//! The recording pipeline: one supervised ffmpeg process that grabs the desktop, encodes it on the GPU
//! and writes a rolling set of short MPEG-TS segments. Audio is captured by this process (see audio.rs)
//! and streamed to ffmpeg over loopback TCP, so silence and device loss never stall or desync the video.

use crate::audio::{Sink, FRAME_BYTES, RATE};
use crate::config::{buffer_dir, log_path, Config, SEGMENT_SECS};
use crate::overlay::{Event, Popup};
use crate::win::{self, Job};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::Sender,
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// The game that is running right now (set by the tray thread's detection).
#[derive(Clone)]
pub struct ActiveGame {
    pub pid: u32,
    pub name: String,
    pub monitor: usize,
}

pub struct Shared {
    pub cfg: Mutex<Config>,
    pub sinks: [Arc<Sink>; 3],
    pub quit: AtomicBool,
    pub restart: AtomicBool,
    pub recording: AtomicBool,
    pub restarts: AtomicU32,
    pub last_error: Mutex<String>,
    pub last_saved: Mutex<String>,
    pub started: Instant,
    pub save_lock: Mutex<()>,
    pub job: Option<Job>,
    /// Popups are drawn on the tray thread; everyone else just queues them here.
    pub popups: Mutex<Sender<Popup>>,
    /// Encoder actually in use (resolved from the "auto" setting).
    pub encoder: Mutex<String>,
    /// "ddagrab" (GPU desktop duplication) or "gdigrab" (slower, works almost everywhere).
    pub capture: Mutex<&'static str>,
    pub fast_failures: AtomicU32,
    pub active_game: Mutex<Option<ActiveGame>>,
    /// True while the buffer is deliberately paused ("record only games" and no game is running).
    pub idle: AtomicBool,
    /// Monitor index the current session captures.
    pub monitor_now: AtomicU32,
    /// A save is waiting out its post-roll; a second hotkey press sets `post_roll_skip` to save at once.
    pub post_roll_active: AtomicBool,
    pub post_roll_skip: AtomicBool,
    /// When the pending post-roll save will happen (for the tray countdown).
    pub post_roll_until: Mutex<Option<Instant>>,
    /// Outcome of the last save, shown briefly on the tray icon: (when, succeeded).
    pub flash: Mutex<Option<(Instant, bool)>>,
    /// How many times the save hotkey was pressed (the setup wizard uses it to test the shortcut).
    pub hotkey_hits: AtomicU32,
    /// Video bitrate (kb/s) of the running session, for diagnostics.
    pub kbps_now: AtomicU32,
    /// Measured load of the recorder and its encoder, tenths of a percent (gpu: -1 = unavailable).
    pub cpu_x10: AtomicU32,
    pub gpu_x10: std::sync::atomic::AtomicI32,
    /// Set when the supervisor gave up on the configured encoder (it survives settings reloads).
    pub encoder_override: Mutex<Option<String>>,
    /// The long recording in progress, if any (see longrec.rs).
    pub long: Mutex<Option<crate::longrec::Long>>,
    pub long_stopping: AtomicBool,
    /// A long recording is being remuxed into its MP4.
    pub finalizing: AtomicBool,
    /// A restart was asked for during a long recording; it happens once the recording ends.
    pub restart_pending: AtomicBool,
}

impl Shared {
    pub fn popup(&self, event: Event, title: impl Into<String>, sub: impl Into<String>) {
        // errors are always shown; the rest follows the "Buffer active popup" setting
        if !self.cfg.lock().unwrap().popup && !event.is_error() {
            return;
        }
        let _ = self.popups.lock().unwrap().send(Popup { event, title: title.into(), sub: sub.into() });
        crate::overlay::wake();
    }
}

pub fn log(msg: &str) {
    let _ = fs::create_dir_all(log_path().parent().unwrap());
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "[{}] {msg}", win::local_stamp());
    }
}

/// Is there recorded footage on disk that a save could use (even if recording has stopped since)?
pub fn has_buffer() -> bool {
    segments().iter().any(|p| fs::metadata(p).map(|m| m.len() > 4096).unwrap_or(false))
}

pub fn segments() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(buffer_dir())
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("seg_") && n.ends_with(".ts"))
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn prune(cfg: &Config) {
    let keep = (cfg.buffer_seconds / SEGMENT_SECS) as usize + 4;
    let segs = segments();
    if segs.len() > keep {
        for p in &segs[..segs.len() - keep] {
            let _ = fs::remove_file(p);
        }
    }
}

pub fn buffered_seconds() -> u32 {
    segments().len() as u32 * SEGMENT_SECS
}

/// Sends one audio source to ffmpeg at exactly real-time rate: real samples when the device delivers
/// them, zeros while it is silent or gone, and a little trimming if the device clock runs fast.
fn feed(mut stream: TcpStream, sink: Arc<Sink>, go: Arc<AtomicBool>, stop: Arc<AtomicBool>) {
    while !go.load(Ordering::Relaxed) {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    sink.buf.lock().unwrap().clear();
    let bytes_per_sec = (RATE as usize * FRAME_BYTES) as f64;
    let t0 = Instant::now();
    let mut sent: u64 = 0;
    while !stop.load(Ordering::Relaxed) {
        let mut chunk: Vec<u8> = {
            let mut q = sink.buf.lock().unwrap();
            let n = q.len() - q.len() % FRAME_BYTES;
            q.drain(..n).collect()
        };
        let expected = (t0.elapsed().as_secs_f64() * bytes_per_sec) as u64;
        let expected = expected - expected % FRAME_BYTES as u64;
        let behind_limit = (0.04 * bytes_per_sec) as u64;
        let ahead_limit = (0.10 * bytes_per_sec) as u64;
        if sent + (chunk.len() as u64) > expected + ahead_limit {
            let allowed = (expected + ahead_limit).saturating_sub(sent) as usize;
            chunk.truncate(allowed - allowed % FRAME_BYTES);
        }
        sent += chunk.len() as u64;
        if sent + behind_limit < expected {
            let pad = (expected - sent) as usize;
            chunk.resize(chunk.len() + pad, 0);
            sent += pad as u64;
        }
        if !chunk.is_empty() && stream.write_all(&chunk).is_err() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Output arguments for the chosen encoder. Segments need a closed keyframe exactly every SEGMENT_SECS,
/// whatever the encoder's own scene-cut habits are.
fn encoder_args(encoder: &str, kbps: u32, fps: u32) -> Vec<String> {
    let gop = (fps * SEGMENT_SECS).to_string();
    let rate = [
        "-b:v".to_string(),
        format!("{kbps}k"),
        "-maxrate".into(),
        format!("{}k", kbps * 3 / 2),
        "-bufsize".into(),
        format!("{}k", kbps * 2),
        "-g".into(),
        gop,
    ];
    let mut v: Vec<String> = match encoder {
        "h264_nvenc" => ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr", "-forced-idr", "1", "-no-scenecut", "1"]
            .map(String::from)
            .to_vec(),
        "h264_amf" => ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "vbr_peak", "-forced_idr", "1"].map(String::from).to_vec(),
        "h264_qsv" => ["-c:v", "h264_qsv", "-preset", "medium", "-look_ahead", "0", "-forced_idr", "1"].map(String::from).to_vec(),
        _ => ["-c:v", "libx264", "-preset", "veryfast", "-sc_threshold", "0"].map(String::from).to_vec(),
    };
    v.extend(rate);
    v.extend(["-force_key_frames".to_string(), format!("expr:gte(t,n_forced*{SEGMENT_SECS})")]);
    v
}

/// Whether `encoder` can really encode with the arguments the recorder uses (a bare test encode would
/// not catch an option that one vendor's build rejects).
fn encoder_usable(encoder: &str, fps: u32) -> bool {
    let mut cmd = Command::new(ml_core::tools::ffmpeg());
    cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
        .arg(format!("color=c=black:s=1280x720:r={fps},format=nv12"))
        .args(["-frames:v", "12"])
        .args(encoder_args(encoder, 6000, fps))
        .args(["-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    ml_core::export::hide_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// "auto": the first GPU encoder that works (NVIDIA, AMD, Intel), else the CPU. Decided once per run.
fn auto_encoder(fps: u32) -> &'static str {
    static C: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        for enc in ["h264_nvenc", "h264_amf", "h264_qsv"] {
            if encoder_usable(enc, fps) {
                return enc;
            }
            log(&format!("encoder {enc} is not usable here"));
        }
        "libx264"
    })
}

/// Which monitor to capture: the configured one, or the one the detected game is on.
pub fn desired_monitor(shared: &Shared, cfg: &Config) -> u32 {
    if cfg.follow_game_monitor {
        if let Some(g) = shared.active_game.lock().unwrap().as_ref() {
            return g.monitor as u32;
        }
    }
    cfg.monitor
}

fn run_session(shared: &Arc<Shared>) -> Result<(), String> {
    let cfg = shared.cfg.lock().unwrap().clone();
    fs::create_dir_all(buffer_dir()).map_err(|e| e.to_string())?;
    // A new ffmpeg process restarts MPEG-TS timestamps, so segments of the previous run cannot be
    // joined seamlessly with the new ones.

    // anything still unwritten in the buffer belongs to a long recording before it is deleted below
    crate::longrec::flush_all(shared);
    let forced = shared.encoder_override.lock().unwrap().clone();
    let encoder = match forced {
        Some(e) => e,
        None if cfg.encoder == "auto" || cfg.encoder.is_empty() => auto_encoder(cfg.fps).to_string(),
        None => cfg.encoder.clone(),
    };
    // The CPU cannot keep up with a game plus 1440p/60 encoding: cap it to what x264 does comfortably.
    let (cfg_fps, cfg_width) = if encoder == "libx264" {
        (cfg.fps.min(30), if cfg.width == 0 || cfg.width > 1920 { 1920 } else { cfg.width })
    } else {
        (cfg.fps, cfg.width)
    };
    let mut cfg = cfg;
    cfg.fps = cfg_fps;
    cfg.width = cfg_width;
    for old in segments() {
        let _ = fs::remove_file(old);
    }
    *shared.encoder.lock().unwrap() = encoder.clone();
    let capture = *shared.capture.lock().unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let seg_start = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let seg_pattern = buffer_dir().join("seg_%010d.ts");

    let mut cmd = Command::new(ml_core::tools::ffmpeg());
    cmd.args(["-hide_banner", "-loglevel", "warning", "-nostdin", "-nostats", "-progress", "pipe:1"]);
    // -itsoffset delays the whole input; a positive audio offset delays audio, a negative one video.
    let off = cfg.audio_offset_ms as f64 / 1000.0;
    if off < 0.0 {
        cmd.args(["-itsoffset", &format!("{:.3}", -off)]);
    }
    let monitor = desired_monitor(shared, &cfg);
    shared.monitor_now.store(monitor, Ordering::Relaxed);
    if capture == "ddagrab" {
        cmd.args(["-f", "lavfi", "-i"]).arg(format!(
            "ddagrab=output_idx={}:framerate={}:draw_mouse=1",
            monitor, cfg.fps
        ));
    } else {
        cmd.args(["-f", "gdigrab", "-framerate", &cfg.fps.to_string(), "-draw_mouse", "1", "-i", "desktop"]);
    }
    for _ in 0..3 {
        if off > 0.0 {
            cmd.args(["-itsoffset", &format!("{off:.3}")]);
        }
        cmd.args(["-thread_queue_size", "1024", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i"])
            .arg(format!("tcp://127.0.0.1:{port}"));
    }
    let scale = if cfg.width > 0 {
        format!("scale={}:-2:flags=fast_bilinear,", cfg.width)
    } else {
        String::new()
    };
    // `fps` makes the stream constant-frame-rate (desktop capture is otherwise variable).
    let download = if capture == "ddagrab" { "hwdownload,format=bgra," } else { "format=bgra," };
    cmd.args(["-filter_complex"])
        .arg(format!("[0:v]{download}{scale}fps={},format=nv12[v]", cfg.fps));
    cmd.args(["-map", "[v]", "-map", "1:a", "-map", "2:a", "-map", "3:a"]);
    // The bitrate follows what is actually captured: frame size, fps and the quality level.
    let (mon_w, mon_h) = crate::win::monitors().get(monitor as usize).map_or((1920, 1080), |m| (m.width as u32, m.height as u32));
    let (out_w, out_h) = ml_core::bitrate::output_size(cfg.width, mon_w, mon_h);
    let kbps = match ml_core::bitrate::Quality::parse(&cfg.quality) {
        Some(q) => ml_core::bitrate::recording_kbps(out_w, out_h, cfg.fps, q),
        None => cfg.video_kbps,
    };
    shared.kbps_now.store(kbps, Ordering::Relaxed);
    cmd.args(encoder_args(&encoder, kbps, cfg.fps));
    cmd.args(["-c:a", "aac", "-b:a", "192k", "-ar", "48000"])
        .args(["-max_muxing_queue_size", "4096"])
        .args(["-f", "segment", "-segment_time", &SEGMENT_SECS.to_string(), "-segment_format", "mpegts"])
        .args(["-segment_start_number", &seg_start.to_string()])
        .arg(&seg_pattern);

    let log_file: File = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
        .map_err(|e| e.to_string())?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::from(log_file)).stdin(Stdio::null());
    ml_core::export::hide_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start ffmpeg ({}): {e}", ml_core::tools::ffmpeg().display()))?;
    if let Some(job) = &shared.job {
        job.assign(&child);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let go = Arc::new(AtomicBool::new(false));
    let finish = |child: &mut std::process::Child, stop: &AtomicBool| {
        stop.store(true, Ordering::Relaxed);
        let _ = child.kill();
        let _ = child.wait();
        shared.recording.store(false, Ordering::Relaxed);
    };

    // ffmpeg connects to the three audio inputs in command order.
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut conns: Vec<TcpStream> = Vec::new();
    while conns.len() < 3 {
        match listener.accept() {
            Ok((s, _)) => {
                let _ = s.set_nonblocking(false);
                let _ = s.set_nodelay(true);
                conns.push(s);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("ffmpeg exited during start-up ({status}); see recorder.log"));
                }
                if Instant::now() > deadline {
                    finish(&mut child, &stop);
                    return Err("ffmpeg did not open its audio inputs in time".into());
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                finish(&mut child, &stop);
                return Err(e.to_string());
            }
        }
    }

    for (stream, sink) in conns.into_iter().zip(shared.sinks.iter()) {
        let (sink, go, stop) = (sink.clone(), go.clone(), stop.clone());
        thread::spawn(move || feed(stream, sink, go, stop));
    }

    // Open the audio gates as soon as ffmpeg reports its first video frame (or after a short timeout),
    // so that audio and video start from the same moment.
    {
        let stdout = child.stdout.take();
        let go = go.clone();
        thread::spawn(move || {
            if let Some(out) = stdout {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Some(n) = line.strip_prefix("frame=") {
                        if n.trim().parse::<u64>().unwrap_or(0) > 0 {
                            go.store(true, Ordering::Relaxed);
                        }
                    }
                }
            }
        });
    }
    let started = Instant::now();
    shared.recording.store(true, Ordering::Relaxed);
    log(&format!("recording session started ({capture}, {encoder}, {out_w}x{out_h}, {kbps} kb/s)"));

    let mut last_prune = Instant::now();
    let mut last_progress = Instant::now();
    let mut no_game_since: Option<Instant> = None;
    loop {
        let long = crate::longrec::active(shared);
        if shared.cfg.lock().unwrap().game_only && !long {
            if shared.active_game.lock().unwrap().is_none() {
                let since = *no_game_since.get_or_insert_with(Instant::now);
                if since.elapsed() > Duration::from_secs(10) {
                    finish(&mut child, &stop);
                    return Ok(());
                }
            } else {
                no_game_since = None;
            }
        }
        if !go.load(Ordering::Relaxed) && started.elapsed() > Duration::from_millis(2500) {
            go.store(true, Ordering::Relaxed);
        }
        // a restart would cut the long recording in two: hold it back until that recording ends
        if long && shared.restart.swap(false, Ordering::Relaxed) {
            shared.restart_pending.store(true, Ordering::Relaxed);
        }
        if shared.quit.load(Ordering::Relaxed) || (!long && shared.restart.swap(false, Ordering::Relaxed)) {
            finish(&mut child, &stop);
            return Ok(());
        }
        if let Ok(Some(status)) = child.try_wait() {
            stop.store(true, Ordering::Relaxed);
            shared.recording.store(false, Ordering::Relaxed);
            return Err(format!("ffmpeg exited ({status}); see recorder.log"));
        }
        crate::longrec::tick(shared);
        if last_prune.elapsed() > Duration::from_secs(5) {
            prune(&cfg);
            last_prune = Instant::now();
        }
        // Prune keeps the count constant once the buffer is full, so judge progress by newest-file age.
        if let Some(newest) = segments().last() {
            let fresh = fs::metadata(newest)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < Duration::from_secs(10));
            if fresh {
                last_progress = Instant::now();
                shared.fast_failures.store(0, Ordering::Relaxed);
            }
        }
        if started.elapsed() > Duration::from_secs(20) && last_progress.elapsed() > Duration::from_secs(15) {
            finish(&mut child, &stop);
            return Err("ffmpeg stopped producing output".into());
        }
        thread::sleep(Duration::from_millis(250));
    }
}

/// Supervisor: keeps a recording session alive, restarting it with back-off if ffmpeg dies.
/// After repeated early failures it falls back from GPU desktop duplication to GDI capture,
/// then from the GPU encoder to the CPU encoder, so a "weird" machine still ends up recording.
pub fn supervise(shared: Arc<Shared>) {
    let mut backoff = 2u64;
    while !shared.quit.load(Ordering::Relaxed) {
        // "record only games": wait without capturing until a game is running
        let waiting = {
            let c = shared.cfg.lock().unwrap();
            c.game_only && shared.active_game.lock().unwrap().is_none() && !crate::longrec::active(&shared)
        };
        if waiting {
            shared.idle.store(true, Ordering::Relaxed);
            shared.recording.store(false, Ordering::Relaxed);
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        shared.idle.store(false, Ordering::Relaxed);
        let began = Instant::now();
        match run_session(&shared) {
            Ok(()) => {
                // Reload happens through the control channel; keep the config it just stored.
                backoff = 2;
            }
            Err(e) => {
                log(&format!("session ended: {e}"));
                *shared.last_error.lock().unwrap() = e;
                shared.restarts.fetch_add(1, Ordering::Relaxed);
                if began.elapsed() > Duration::from_secs(60) {
                    backoff = 2;
                    shared.fast_failures.store(0, Ordering::Relaxed);
                } else {
                    let n = shared.fast_failures.fetch_add(1, Ordering::Relaxed) + 1;
                    if n == 3 {
                        let mut cap = shared.capture.lock().unwrap();
                        if *cap == "ddagrab" {
                            *cap = "gdigrab";
                            log("falling back to GDI capture");
                        }
                    } else if n == 5 {
                        let mut forced = shared.encoder_override.lock().unwrap();
                        if forced.as_deref() != Some("libx264") {
                            *forced = Some("libx264".into());
                            log("falling back to the CPU encoder");
                        }
                    }
                }
                for _ in 0..backoff * 4 {
                    if shared.quit.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
                backoff = (backoff * 2).min(30);
            }
        }
    }
}

fn clean_name(s: &str) -> String {
    let t: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    t.trim_matches('-').to_string()
}

/// Display name of the game that is in the foreground (or "Desktop").
pub fn current_game_name(cfg: &Config) -> String {
    let stem = win::foreground_exe_stem().unwrap_or_default().to_lowercase();
    // Browsers, chat apps and the shell are not games: such clips are filed under "Desktop".
    if stem.is_empty() || crate::tray::NEVER_GAMES.contains(&stem.as_str()) {
        "Desktop".to_string()
    } else {
        cfg.game_names.get(&stem).cloned().unwrap_or_else(|| clean_name(&stem))
    }
}

/// Writes the last `buffer_seconds` of the rolling buffer to a finished MP4 in the output folder.
pub fn save(shared: &Arc<Shared>) -> Result<PathBuf, String> {
    let result = save_inner(shared);
    *shared.flash.lock().unwrap() = Some((Instant::now(), result.is_ok()));
    result
}

fn save_inner(shared: &Arc<Shared>) -> Result<PathBuf, String> {
    let _guard = shared.save_lock.lock().unwrap();
    let cfg = shared.cfg.lock().unwrap().clone();

    // empty or truncated files (a session that never produced data) would make the whole join fail
    let mut all: Vec<PathBuf> = segments()
        .into_iter()
        .filter(|p| fs::metadata(p).map(|m| m.len() > 4096).unwrap_or(false))
        .collect();
    // The newest segment is still being written and its audio is usually shorter than its video.
    if all.len() > 1 {
        all.pop();
    }
    let want = (cfg.buffer_seconds / SEGMENT_SECS) as usize;
    let take = all.len().min(want);
    if take == 0 {
        return Err(crate::lang::t("err.empty"));
    }
    let picked = &all[all.len() - take..];

    let game = current_game_name(&cfg);
    let mut out_dir = PathBuf::from(&cfg.output_dir);
    if cfg.per_game_folders {
        out_dir = out_dir.join(&game);
    }
    fs::create_dir_all(&out_dir).map_err(|e| format!("cannot create {}: {e}", out_dir.display()))?;
    let out = out_dir.join(format!("{}__{}.mp4", game, win::local_stamp()));
    let tmp = out.with_extension("part.mp4");

    // Byte-level concatenation (concat: protocol) keeps the original continuous MPEG-TS timestamps.
    // The concat *demuxer* re-times each file by its container duration, which is a little longer
    // than the video it holds and shows up as a stutter every segment.
    let joined = picked
        .iter()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("|");

    let mut cmd = Command::new(ml_core::tools::ffmpeg());
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(format!("concat:{joined}"))
        .args(["-map", "0:v:0", "-map", "0:a:0", "-map", "0:a:1", "-map", "0:a:2", "-c", "copy"])
        .args(["-bsf:a", "aac_adtstoasc"])
        .args(["-metadata:s:v:0", "handler_name=VideoHandler"])
        .args(["-metadata:s:a:0", "handler_name=Game"])
        .args(["-metadata:s:a:1", "handler_name=Chat"])
        .args(["-metadata:s:a:2", "handler_name=Mic"])
        .args(["-disposition:a:0", "default", "-movflags", "+faststart"])
        .arg(&tmp);
    ml_core::export::hide_window(&mut cmd);
    let result = cmd.output().map_err(|e| e.to_string())?;
    if !result.status.success() {
        let _ = fs::remove_file(&tmp);
        // the raw ffmpeg text goes to the log; the user gets one short sentence
        log(&format!("ffmpeg could not join the buffer: {}", String::from_utf8_lossy(&result.stderr).trim()));
        return Err(crate::lang::t("err.read"));
    }
    fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    *shared.last_saved.lock().unwrap() = out.to_string_lossy().into_owned();
    log(&format!("saved {}", out.display()));
    Ok(out)
}
