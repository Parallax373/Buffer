#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod config;
mod identify;
mod input;
mod longrec;
mod control;
mod overlay;
mod pick;
mod session;
mod tray;
mod win;

use audio::{spawn_capture, Kind, Sink};
use config::Config;
use session::{log, supervise, Shared};
use std::{
    process::Command,
    sync::{atomic::AtomicBool, atomic::AtomicU32, atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
use wasapi::{DeviceEnumerator, Direction};

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "BufferRecorder";

fn attach_console() {
    // The release build is a GUI-subsystem exe (no console window at login); still let CLI
    // subcommands print when started from a terminal.
    #[cfg(not(debug_assertions))]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
    }
}

fn list_devices() {
    let _ = wasapi::initialize_mta();
    let Ok(en) = DeviceEnumerator::new() else {
        println!("cannot enumerate audio devices");
        return;
    };
    for (label, dir) in [("playback (loopback sources)", Direction::Render), ("microphones", Direction::Capture)] {
        println!("[{label}]");
        if let Ok(coll) = en.get_device_collection(&dir) {
            for d in &coll {
                if let Ok(d) = d {
                    println!("  {}\n    id: {}", d.get_friendlyname().unwrap_or_default(), d.get_id().unwrap_or_default());
                }
            }
        }
    }
}

/// Machine-readable device list for the UI's settings page.
fn devices_json() {
    let _ = wasapi::initialize_mta();
    let mut render = Vec::new();
    let mut capture = Vec::new();
    if let Ok(en) = DeviceEnumerator::new() {
        for (dir, out) in [(Direction::Render, &mut render), (Direction::Capture, &mut capture)] {
            if let Ok(coll) = en.get_device_collection(&dir) {
                for d in &coll {
                    if let Ok(d) = d {
                        out.push(serde_json::json!({
                            "id": d.get_id().unwrap_or_default(),
                            "name": d.get_friendlyname().unwrap_or_default(),
                        }));
                    }
                }
            }
        }
    }
    let id_of = |dir: Direction, role: wasapi::Role| {
        DeviceEnumerator::new()
            .ok()
            .and_then(|en| en.get_default_device_for_role(&dir, &role).ok())
            .and_then(|d| d.get_id().ok())
            .unwrap_or_default()
    };
    println!(
        "{}",
        serde_json::json!({
            "render": render,
            "capture": capture,
            "default": {
                "render": id_of(Direction::Render, wasapi::Role::Console),
                "communications": id_of(Direction::Render, wasapi::Role::Communications),
                "capture": id_of(Direction::Capture, wasapi::Role::Console),
            },
        })
    );
}

/// Peak level of the given endpoints (ids or "@default:*" tokens), measured in parallel for ~350 ms.
fn levels_json(args: Vec<String>) {
    // optional first argument "--ms=N" sets the measuring window (default 350 ms)
    let ms: u64 = args.iter().find_map(|a| a.strip_prefix("--ms=").and_then(|v| v.parse().ok())).unwrap_or(350).clamp(50, 2000);
    let tokens: Vec<String> = args.into_iter().filter(|a| !a.starts_with("--ms=")).collect();
    let handles: Vec<_> = tokens
        .into_iter()
        .map(|t| std::thread::spawn(move || (t.clone(), audio::measure_peak(&t, ms))))
        .collect();
    let mut map = serde_json::Map::new();
    for h in handles {
        if let Ok((t, p)) = h.join() {
            map.insert(t, serde_json::json!(p));
        }
    }
    println!("{}", serde_json::Value::Object(map));
}

/// Monitors in enumeration order (index = the "monitor" setting), with their resolution.
fn monitors_json() {
    println!(
        "{}",
        serde_json::json!(win::monitors()
            .into_iter()
            .enumerate()
            .map(|(i, m)| serde_json::json!({
                "index": i, "width": m.width, "height": m.height, "primary": m.primary,
                "left": m.left, "top": m.top, "name": m.name,
            }))
            .collect::<Vec<_>>())
    );
}

fn autostart_enabled() -> bool {
    let mut cmd = Command::new("reg");
    cmd.args(["query", RUN_KEY, "/v", RUN_VALUE]);
    ml_core::export::hide_window(&mut cmd);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

fn run() {
    win::make_dpi_aware();
    if !win::claim_single_instance("Local\\BufferRecorder") {
        println!("recorder is already running");
        return;
    }
    let cfg = Config::load();
    let sinks = [
        Sink::new("Game", Kind::Loopback, "Game"),
        Sink::new("Chat", Kind::Loopback, "Chat"),
        Sink::new("Mic", Kind::Microphone, ""),
    ];
    sinks[0].set_cfg(cfg.game.clone());
    sinks[1].set_cfg(cfg.chat.clone());
    sinks[2].set_cfg(cfg.mic.clone());
    let (popup_tx, popup_rx) = std::sync::mpsc::channel();

    let shared = Arc::new(Shared {
        cfg: Mutex::new(cfg.clone()),
        sinks,
        quit: AtomicBool::new(false),
        restart: AtomicBool::new(false),
        recording: AtomicBool::new(false),
        restarts: AtomicU32::new(0),
        last_error: Mutex::new(String::new()),
        last_saved: Mutex::new(String::new()),
        started: Instant::now(),
        save_lock: Mutex::new(()),
        job: win::Job::new(),
        popups: Mutex::new(popup_tx),
        encoder: Mutex::new(String::new()),
        capture: Mutex::new("ddagrab"),
        fast_failures: AtomicU32::new(0),
        active_game: Mutex::new(None),
        idle: AtomicBool::new(false),
        monitor_now: AtomicU32::new(0),
        post_roll_active: AtomicBool::new(false),
        post_roll_skip: AtomicBool::new(false),
        post_roll_until: Mutex::new(None),
        flash: Mutex::new(None),
        markers: Mutex::new(Vec::new()),
        hotkey_hits: AtomicU32::new(0),
        kbps_now: AtomicU32::new(0),
        encoder_override: Mutex::new(None),
        long: Mutex::new(None),
        long_stopping: AtomicBool::new(false),
        finalizing: AtomicBool::new(false),
        restart_pending: AtomicBool::new(false),
    });
    {
        let cfg = cfg.clone();
        std::thread::spawn(move || longrec::recover_orphans(&cfg));
    }
    tray::apply_app_sources(&shared);
    log(&format!("recorder starting (ffmpeg: {})", ml_core::tools::ffmpeg().display()));

    let stop_capture = Arc::new(AtomicBool::new(false));
    for s in &shared.sinks {
        spawn_capture(s.clone(), stop_capture.clone());
    }
    if let Err(e) = control::serve(shared.clone()) {
        log(&format!("control port unavailable: {e}"));
    }

    // Tray icon + global hotkey share one message-loop thread.
    let ui_shared = shared.clone();
    let hotkey = cfg.hotkey.clone();
    std::thread::Builder::new()
        .name("tray".into())
        .spawn(move || tray::run(ui_shared, hotkey, popup_rx))
        .expect("spawn tray thread");

    let sup = shared.clone();
    let handle = std::thread::spawn(move || supervise(sup));
    while !shared.quit.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(200));
    }
    // closing the recorder must not lose a long recording in progress
    let _ = longrec::stop(&shared);
    stop_capture.store(true, Ordering::Relaxed);
    let _ = handle.join();
    log("recorder stopped");
}

fn autostart(install: bool) {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let mut cmd = Command::new("reg");
    if install {
        // drop the pre-release value name if it is still there
        let mut old = Command::new("reg");
        old.args(["delete", RUN_KEY, "/v", "MomentsLiteRecorder", "/f"]);
        ml_core::export::hide_window(&mut old);
        let _ = old.output();
        cmd.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &format!("\"{exe}\" run"), "/f"]);
    } else {
        cmd.args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    }
    ml_core::export::hide_window(&mut cmd);
    match cmd.output() {
        Ok(o) if o.status.success() => println!("autostart {}", if install { "enabled" } else { "disabled" }),
        Ok(o) => println!("autostart change failed: {}", String::from_utf8_lossy(&o.stderr).trim()),
        Err(e) => println!("autostart change failed: {e}"),
    }
}

fn main() {
    ml_core::paths::migrate_legacy_dirs();
    let arg = std::env::args().nth(1).unwrap_or_else(|| "run".into());
    match arg.as_str() {
        "run" => run(),
        other => {
            attach_console();
            match other {
                "devices" => list_devices(),
                "devices-json" => devices_json(),
                "monitors-json" => monitors_json(),
                "identify" => identify::run(),
                "levels" => levels_json(std::env::args().skip(2).collect()),
                "autostart-status" => println!("{}", if autostart_enabled() { "enabled" } else { "disabled" }),
                "status" | "save" | "reload" | "quit" | "record" | "record-start" | "record-stop" => match control::send(other) {
                    Ok(r) => println!("{r}"),
                    Err(e) => println!("{e}"),
                },
                "install-autostart" => autostart(true),
                "uninstall-autostart" => autostart(false),
                _ => println!("usage: buffer-recorder [run|devices|status|save|record|reload|quit|install-autostart|uninstall-autostart]"),
            }
        }
    }
}
