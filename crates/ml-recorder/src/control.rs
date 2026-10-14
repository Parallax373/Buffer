//! Tiny line-based control protocol on 127.0.0.1 so the UI (and `buffer-recorder save`) can talk to the
//! running recorder. Commands: status | save | reload | quit. One JSON line is returned per command.

use crate::config::{Config, CONTROL_PORT};
use crate::session::{buffered_seconds, save, Shared};
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    sync::{atomic::Ordering, Arc},
    thread,
};

pub fn status_json(shared: &Shared) -> serde_json::Value {
    let cfg = shared.cfg.lock().unwrap().clone();
    let sources: Vec<_> = shared
        .sinks
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "device": *s.device_name.lock().unwrap(),
                "role": *s.role.lock().unwrap(),
                "live": s.live.load(Ordering::Relaxed),
                "level": s.level.load(Ordering::Relaxed) as f64 / 1000.0,
                "status": *s.status.lock().unwrap(),
            })
        })
        .collect();
    json!({
        "recording": shared.recording.load(Ordering::Relaxed),
        "idle": shared.idle.load(Ordering::Relaxed),
        "game": shared.active_game.lock().unwrap().as_ref().map(|g| g.name.clone()),
        "post_roll_s": cfg.post_roll_seconds,
        "monitor": shared.monitor_now.load(Ordering::Relaxed),
        "uptime_s": shared.started.elapsed().as_secs(),
        "restarts": shared.restarts.load(Ordering::Relaxed),
        "last_error": *shared.last_error.lock().unwrap(),
        "last_saved": *shared.last_saved.lock().unwrap(),
        "buffer_s": buffered_seconds().min(cfg.buffer_seconds),
        "buffer_target_s": cfg.buffer_seconds,
        "hotkey": cfg.hotkey,
        "output_dir": cfg.output_dir,
        "ffmpeg": ml_core::tools::ffmpeg().to_string_lossy(),
        "encoder": *shared.encoder.lock().unwrap(),
        "capture": *shared.capture.lock().unwrap(),
        "sources": sources,
    })
}

fn handle(shared: &Arc<Shared>, stream: TcpStream) {
    let Ok(read_half) = stream.try_clone() else { return };
    let mut out = stream;
    for line in BufReader::new(read_half).lines().map_while(Result::ok) {
        let reply = match line.trim() {
            "status" => status_json(shared),
            "save" => match save(shared) {
                Ok(p) => {
                    crate::win::beep();
                    json!({ "ok": true, "path": p.to_string_lossy() })
                }
                Err(e) => json!({ "ok": false, "error": e }),
            },
            "reload" => {
                let cfg = Config::load();
                shared.sinks[0].set_cfg(cfg.game.clone());
                shared.sinks[1].set_cfg(cfg.chat.clone());
                shared.sinks[2].set_cfg(cfg.mic.clone());
                *shared.cfg.lock().unwrap() = cfg;
                crate::tray::apply_app_sources(shared);
                shared.restart.store(true, Ordering::Relaxed);
                json!({ "ok": true })
            }
            "quit" => {
                shared.quit.store(true, Ordering::Relaxed);
                json!({ "ok": true })
            }
            other => json!({ "ok": false, "error": format!("unknown command '{other}'") }),
        };
        if writeln!(out, "{reply}").is_err() {
            return;
        }
    }
}

pub fn serve(shared: Arc<Shared>) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", CONTROL_PORT))?;
    thread::Builder::new().name("control".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let shared = shared.clone();
            thread::spawn(move || handle(&shared, stream));
        }
    })?;
    Ok(())
}

/// Client side: send one command to a running recorder and return its JSON reply.
pub fn send(cmd: &str) -> Result<String, String> {
    let mut s = TcpStream::connect(("127.0.0.1", CONTROL_PORT)).map_err(|_| "recorder is not running".to_string())?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(60))).ok();
    writeln!(s, "{cmd}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).map_err(|e| e.to_string())?;
    Ok(line.trim().to_string())
}
