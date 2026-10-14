//! Tray icon (always-visible recorder state), the global save hotkey, the "Buffer active" popup and
//! game detection. They share one thread because they all need that thread's Win32 message loop.

use crate::overlay::{self, Event, Overlay, Popup};
use crate::audio::AppSource;
use crate::session::ActiveGame;
use crate::{session, win};
use std::{
    collections::HashSet,
    process::Command,
    sync::{atomic::Ordering, mpsc::Receiver, Arc},
    thread,
};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
};

/// What the icon says. The logo mark carries the colour; a corner badge appears only for stopped, paused and errors.
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// Recording, everything works: the clean lime logo (default, no badge).
    Recording,
    /// Recording, but a problem was detected (a source is down): amber logo + "!".
    Problem,
    /// Not recording although it should (ffmpeg failed, ...): red logo + X.
    Stopped,
    /// Waiting for a game ("record only games"): grey logo + pause bars.
    Idle,
    /// Just started: grey logo until the first segment arrives.
    Starting,
    /// Post-roll running, the clip will be saved in a moment: lime logo (tooltip has the countdown).
    Saving,
    /// A clip was just saved: lime logo (tooltip says so).
    Saved,
    /// Saving failed: red logo + X.
    SaveFailed,
    /// A long recording is running: lime logo + red dot.
    LongRec,
}

/// Programs that are never treated as games even when they cover the whole screen.
pub const NEVER_GAMES: &[&str] = &[
    "explorer", "searchhost", "shellexperiencehost", "applicationframehost", "startmenuexperiencehost",
    "lockapp", "chrome", "msedge", "firefox", "opera", "brave", "vivaldi", "vlc", "mpv", "potplayer",
    "code", "devenv", "powerpnt", "winword", "excel", "buffer", "buffer-recorder", "obs64", "teams",
    "zoom", "discord", "spotify", "slack", "steamwebhelper", "taskmgr", "mstsc", "vmware", "virtualbox",
];

fn colour(state: State) -> (u8, u8, u8) {
    match state {
        State::Recording | State::Saving | State::Saved | State::LongRec => (0xc6, 0xf4, 0x32),
        State::Problem => (0xff, 0xb4, 0x54),
        State::Stopped | State::SaveFailed => (0xff, 0x5d, 0x5d),
        State::Idle | State::Starting => (0x8b, 0x91, 0x9c),
    }
}

/// 32x32 icon: the logo mark (a play triangle of scan-lines with faded tails) in the state colour and a
/// 15 px badge in the bottom-right corner that says what is going on.
fn icon(state: State) -> Icon {
    Icon::from_rgba(icon_rgba(state), 32, 32).expect("valid icon")
}

fn icon_rgba(state: State) -> Vec<u8> {
    const N: usize = 32;
    let (r, g, b) = colour(state);
    let mut px = vec![0u8; N * N * 4];
    let mut put = |x: i32, y: i32, c: [u8; 4]| {
        if (0..N as i32).contains(&x) && (0..N as i32).contains(&y) {
            let i = (y as usize * N + x as usize) * 4;
            px[i..i + 4].copy_from_slice(&c);
        }
    };
    // logo: 7 bars of 3px with 1px gaps, widest in the middle (thicker than the full logo, for 16-32px)
    let tails = [9i32, 3, 11, 5, 8, 2, 10];
    for (i, tail) in tails.iter().enumerate() {
        let y0 = 2 + i as i32 * 4;
        let w = 6 + (3 - (i as i32 - 3).abs()) * 5;
        for dy in 0..3 {
            for x in 0..*tail {
                put((10 - tail).max(0) + x, y0 + dy, [r, g, b, 80]);
            }
            for x in 0..w {
                put(10 + x, y0 + dy, [r, g, b, 255]);
            }
        }
    }

    // badge centre and helpers
    let (cx, cy) = (23i32, 23i32);
    let dark = [17u8, 17, 17, 255];
    let white = [255u8, 255, 255, 255];
    let disc = |put: &mut dyn FnMut(i32, i32, [u8; 4]), rad: f32, c: [u8; 4]| {
        for dy in -9..=9 {
            for dx in -9..=9 {
                if ((dx * dx + dy * dy) as f32) <= rad * rad {
                    put(cx + dx, cy + dy, c);
                }
            }
        }
    };
    // Outline so a badge reads on any taskbar colour. Healthy recording has no badge at all:
    // a red dot looked like an error, so "all good" is simply the clean lime logo.
    let badge = matches!(state, State::Problem | State::Stopped | State::SaveFailed | State::Idle | State::LongRec);
    if badge {
        disc(&mut put, 8.2, dark);
    }
    match state {
        State::Recording => {}
        State::Problem => {
            disc(&mut put, 6.2, [0xff, 0xb4, 0x54, 255]);
            for dy in -4..=1 {
                for dx in -1..=0 {
                    put(cx + dx, cy + dy, dark);
                }
            }
            for dy in 3..=4 {
                for dx in -1..=0 {
                    put(cx + dx, cy + dy, dark);
                }
            }
        }
        State::Stopped | State::SaveFailed => {
            disc(&mut put, 6.2, [0xff, 0x5d, 0x5d, 255]);
            for d in -3..=3i32 {
                // a 2px-thick X
                for off in [0i32, 1] {
                    put(cx + d + off, cy + d, white);
                    put(cx + d + off, cy - d, white);
                }
            }
        }
        State::LongRec => disc(&mut put, 6.2, [0xff, 0x3b, 0x3b, 255]),
        State::Idle => {
            disc(&mut put, 6.2, [0x8b, 0x91, 0x9c, 255]);
            for dy in -3..=3 {
                for dx in [-3, -2, 1, 2] {
                    put(cx + dx, cy + dy, dark);
                }
            }
        }
        // Healthy or transient states carry no badge: only stopped, paused and errors are called out.
        State::Starting | State::Saving | State::Saved => {}
    }
    px
}

fn source_label(name: &str) -> String {
    match name {
        "Game" | "Chat" | "Mic" => crate::lang::t(&format!("src.{name}")),
        other => other.to_string(),
    }
}

fn state_of(shared: &session::Shared) -> (State, String) {
    let now = std::time::Instant::now();
    if let Some((at, ok)) = *shared.flash.lock().unwrap() {
        if now.duration_since(at) < std::time::Duration::from_secs(4) {
            return if ok {
                (State::Saved, crate::lang::t("tip.saved"))
            } else {
                (State::SaveFailed, crate::lang::t("tip.save_failed"))
            };
        }
    }
    if let Some(until) = *shared.post_roll_until.lock().unwrap() {
        if until > now {
            let left = until.duration_since(now).as_secs() + 1;
            return (State::Saving, crate::lang::f("tip.postroll", &[("n", &left)]));
        }
    }
    if shared.finalizing.load(Ordering::Relaxed) {
        return (State::Saving, crate::lang::t("tip.finalizing"));
    }
    if let Some(secs) = crate::longrec::elapsed_secs(shared) {
        return (State::LongRec, crate::lang::f("tip.longrec", &[("t", &clock(secs))]));
    }
    if shared.idle.load(Ordering::Relaxed) {
        return (State::Idle, crate::lang::t("tip.idle"));
    }
    if !shared.recording.load(Ordering::Relaxed) {
        let err = shared.last_error.lock().unwrap().clone();
        if err.is_empty() && shared.restarts.load(Ordering::Relaxed) == 0 && shared.started.elapsed().as_secs() < 20 {
            return (State::Starting, crate::lang::t("tip.starting"));
        }
        let msg = if err.is_empty() { crate::lang::t("word.stopped") } else { err.chars().take(90).collect() };
        return (State::Stopped, crate::lang::f("tip.stopped", &[("msg", &msg)]));
    }
    let down: Vec<String> = shared
        .sinks
        .iter()
        .filter(|s| !s.live.load(Ordering::Relaxed))
        .map(|s| source_label(s.name))
        .collect();
    if !down.is_empty() {
        return (State::Problem, crate::lang::f("tip.problem", &[("list", &down.join(", "))]));
    }
    let cfg = shared.cfg.lock().unwrap();
    let game = shared.active_game.lock().unwrap().as_ref().map(|g| format!(" · {}", g.name)).unwrap_or_default();
    (
        State::Recording,
        crate::lang::f("tip.recording", &[("cur", &session::buffered_seconds().min(cfg.buffer_seconds)), ("max", &cfg.buffer_seconds), ("game", &game)]),
    )
}

fn clock(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
    } else {
        format!("{}:{:02}", secs / 60, secs % 60)
    }
}

fn open_editor() {
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        let _ = Command::new(dir.join("buffer.exe")).spawn();
    }
}

/// Which sources use per-application capture, given the current settings and the detected game:
/// the chat app is split from the game, and "game only" records just the game's own sound.
pub fn apply_app_sources(shared: &session::Shared) {
    let cfg = shared.cfg.lock().unwrap().clone();
    let chat_app = cfg.chat_app.trim().to_lowercase();
    let chat_app = chat_app.trim_end_matches(".exe").to_string();
    shared.sinks[1].set_app(if chat_app.is_empty() { AppSource::None } else { AppSource::IncludeStem(chat_app.clone()) });
    let game = shared.active_game.lock().unwrap().clone();
    shared.sinks[0].set_app(match game {
        Some(g) if cfg.game_only => AppSource::IncludePid(g.pid),
        _ if !chat_app.is_empty() => AppSource::ExcludeStem(chat_app),
        _ => AppSource::None,
    });
}

/// Hotkey: wait the configured post-roll (so the moments right after the press are in the clip), then save.
/// Pressing again while waiting saves immediately.
fn hotkey_save(shared: &Arc<session::Shared>) {
    let roll = shared.cfg.lock().unwrap().post_roll_seconds;
    if roll == 0 {
        save_async(shared);
        return;
    }
    if shared.post_roll_active.swap(true, Ordering::Relaxed) {
        shared.post_roll_skip.store(true, Ordering::Relaxed);
        return;
    }
    shared.popup(Event::PostRoll { roll_ms: roll as u64 * 1000 }, crate::lang::f("pop.postroll", &[("n", &roll)]), crate::lang::t("pop.postroll_sub"));
    *shared.post_roll_until.lock().unwrap() = Some(std::time::Instant::now() + std::time::Duration::from_secs(roll as u64));
    let s = shared.clone();
    thread::spawn(move || {
        for _ in 0..roll * 4 {
            if s.post_roll_skip.load(Ordering::Relaxed) || s.quit.load(Ordering::Relaxed) {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(250));
        }
        s.post_roll_skip.store(false, Ordering::Relaxed);
        s.post_roll_active.store(false, Ordering::Relaxed);
        *s.post_roll_until.lock().unwrap() = None;
        save_async(&s);
    });
}

fn save_async(shared: &Arc<session::Shared>) {
    let s = shared.clone();
    thread::spawn(move || match session::save(&s) {
        Ok(path) => {
            win::beep();
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            s.popup(Event::Saved, crate::lang::t("pop.saved"), name);
        }
        Err(e) => {
            session::log(&format!("save failed: {e}"));
            *s.last_error.lock().unwrap() = format!("save failed: {e}");
            s.popup(Event::SaveFailed, crate::lang::t("pop.save_failed"), e);
        }
    });
}

/// "Buffer active" message shown when a game comes to the foreground.
fn announce_game(shared: &session::Shared, game: &str) {
    let cfg = shared.cfg.lock().unwrap().clone();
    let down: Vec<&str> = shared.sinks.iter().filter(|s| !s.live.load(Ordering::Relaxed)).map(|s| s.name).collect();
    let len = if cfg.buffer_seconds >= 60 && cfg.buffer_seconds % 60 == 0 {
        format!("{} min", cfg.buffer_seconds / 60)
    } else {
        format!("{} s", cfg.buffer_seconds)
    };
    if !shared.recording.load(Ordering::Relaxed) {
        shared.popup(Event::RecordingDown, crate::lang::f("pop.down", &[("game", &game)]), crate::lang::t("pop.down_sub"));
    } else if down.is_empty() {
        shared.popup(Event::Game, crate::lang::t("pop.active"), crate::lang::f("pop.active_sub", &[("hk", &cfg.hotkey), ("len", &len), ("game", &game)]));
    } else {
        shared.popup(Event::GameWarn, crate::lang::t("pop.warn"), crate::lang::f("pop.warn_sub", &[("list", &down.join(", ")), ("hk", &cfg.hotkey)]));
    }
}

/// Never returns while the recorder runs.
pub fn run(shared: Arc<session::Shared>, hotkey: String, popups: Receiver<Popup>) {
    let menu = Menu::new();
    let save_i = MenuItem::new(crate::lang::t("menu.save"), true, None);
    let rec_i = MenuItem::new(crate::lang::t("menu.record"), true, None);
    let open_i = MenuItem::new(crate::lang::t("menu.open"), true, None);
    let quit_i = MenuItem::new(crate::lang::t("menu.quit"), true, None);
    let _ = menu.append_items(&[&save_i, &rec_i, &open_i, &PredefinedMenuItem::separator(), &quit_i]);

    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .with_tooltip("Buffer")
        .with_icon(icon(State::Starting))
        .build()
        .map_err(|e| session::log(&format!("tray unavailable: {e}")))
        .ok();

    if let Err(e) = win::register_hotkey(&hotkey) {
        session::log(&e);
        *shared.last_error.lock().unwrap() = e;
    }
    let marker_hotkey = shared.cfg.lock().unwrap().marker_hotkey.clone();
    if !marker_hotkey.is_empty() {
        if let Err(e) = win::register_hotkey_id(&marker_hotkey, 2) {
            session::log(&e);
        }
    }

    if let Some(hk) = Some(shared.cfg.lock().unwrap().record_hotkey.clone()).filter(|h| !h.is_empty()) {
        if let Err(e) = win::register_hotkey_id(&hk, crate::input::RECORD as i32) {
            session::log(&e);
        }
    }
    crate::input::spawn(shared.clone(), unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() });

    overlay::bind_thread();
    let mut overlay = Overlay::new();
    let mut shown: Option<State> = None;
    let mut notified: HashSet<u32> = HashSet::new();
    let mut tick = 0u32;
    let my_pid = std::process::id();

    let hk_shared = shared.clone();
    let tick_shared = shared.clone();
    win::pump_messages(|ev| match ev {
        win::Pump::Hotkey(id) => {
            if id == crate::input::RECORD {
                crate::longrec::toggle(&hk_shared);
            } else if id == 2 {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64);
                let mut m = hk_shared.markers.lock().unwrap();
                m.push(now);
                let keep = 400;
                if m.len() > keep {
                    let cut = m.len() - keep;
                    m.drain(..cut);
                }
                drop(m);
                hk_shared.popup(Event::Marker, crate::lang::t("pop.marker"), crate::lang::t("pop.marker_sub"));
            } else {
                hk_shared.hotkey_hits.fetch_add(1, Ordering::Relaxed);
                hotkey_save(&hk_shared);
            }
        }
        win::Pump::Wake => {
            while let Ok(p) = popups.try_recv() {
                overlay.push(p);
            }
        }
        win::Pump::Timer(id) if overlay.is_anim_timer(id) => overlay.frame(),
        win::Pump::Timer(_) => {
            tick += 1;
            while let Ok(p) = popups.try_recv() {
                overlay.push(p);
            }
            // Left click opens the app; the context menu belongs to the right button.
            while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                    open_editor();
                }
            }
            while let Ok(ev) = MenuEvent::receiver().try_recv() {
                if ev.id == *save_i.id() {
                    save_async(&tick_shared);
                } else if ev.id == *rec_i.id() {
                    crate::longrec::toggle(&tick_shared);
                } else if ev.id == *open_i.id() {
                    open_editor();
                } else if ev.id == *quit_i.id() {
                    tick_shared.quit.store(true, Ordering::Relaxed);
                }
            }
            if let Some(tray) = &tray {
                let (state, tip) = state_of(&tick_shared);
                let _ = rec_i.set_text(match crate::longrec::elapsed_secs(&tick_shared) {
                    Some(s) => crate::lang::f("menu.record_stop", &[("t", &clock(s))]),
                    None => crate::lang::t("menu.record"),
                });
                let _ = tray.set_tooltip(Some(tip));
                if shown != Some(state) {
                    let _ = tray.set_icon(Some(icon(state)));
                    shown = Some(state);
                }
            }
            // Game detection: twice a second is plenty and costs next to nothing.
            let cfg = tick_shared.cfg.lock().unwrap().clone();
            // 1) the game we know about has exited
            let gone = {
                let g = tick_shared.active_game.lock().unwrap();
                g.as_ref().is_some_and(|g| !win::pid_alive(g.pid))
            };
            if gone {
                *tick_shared.active_game.lock().unwrap() = None;
                apply_app_sources(&tick_shared);
            }
            // 2) a new game came to the foreground / the known one moved to another monitor
            if let Some(fg) = win::foreground() {
                if fg.pid != my_pid {
                    let ignored = NEVER_GAMES.contains(&fg.stem.as_str()) || cfg.ignore_apps.iter().any(|a| a == &fg.stem);
                    let forced = cfg.extra_games.iter().any(|a| a == &fg.stem);
                    if !ignored && (fg.fullscreen || forced) {
                        let known = tick_shared.active_game.lock().unwrap().clone();
                        let name = session::current_game_name(&cfg);
                        match known {
                            Some(g) if g.pid == fg.pid => {
                                if g.monitor != fg.monitor {
                                    tick_shared.active_game.lock().unwrap().as_mut().unwrap().monitor = fg.monitor;
                                    if cfg.follow_game_monitor
                                        && session::desired_monitor(&tick_shared, &cfg)
                                            != tick_shared.monitor_now.load(Ordering::Relaxed)
                                    {
                                        tick_shared.restart.store(true, Ordering::Relaxed);
                                    }
                                }
                            }
                            _ => {
                                *tick_shared.active_game.lock().unwrap() =
                                    Some(ActiveGame { pid: fg.pid, name: name.clone(), monitor: fg.monitor });
                                apply_app_sources(&tick_shared);
                                if cfg.follow_game_monitor
                                    && session::desired_monitor(&tick_shared, &cfg)
                                        != tick_shared.monitor_now.load(Ordering::Relaxed)
                                    && tick_shared.recording.load(Ordering::Relaxed)
                                {
                                    tick_shared.restart.store(true, Ordering::Relaxed);
                                }
                                if !notified.contains(&fg.pid) {
                                    notified.insert(fg.pid);
                                    if notified.len() > 256 {
                                        notified.clear();
                                    }
                                    announce_game(&tick_shared, &name);
                                }
                            }
                        }
                    }
                }
            }
            let _ = tick;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_state_has_a_valid_icon() {
        for s in [State::Recording, State::Problem, State::Stopped, State::Idle, State::Starting, State::Saving, State::Saved, State::SaveFailed, State::LongRec] {
            assert_eq!(icon_rgba(s).len(), 32 * 32 * 4);
            let _ = icon(s);
        }
    }

    /// Dev helper: `ICON_DUMP=<file> cargo test dump_icons` writes every state side by side as raw RGBA.
    #[test]
    fn dump_icons() {
        let Ok(path) = std::env::var("ICON_DUMP") else { return };
        let states = [State::Recording, State::Problem, State::Stopped, State::Idle, State::Starting, State::Saving, State::Saved, State::SaveFailed, State::LongRec];
        let mut out = Vec::new();
        for y in 0..32 {
            for s in states {
                let px = icon_rgba(s);
                out.extend_from_slice(&px[y * 32 * 4..(y + 1) * 32 * 4]);
            }
        }
        std::fs::write(path, out).unwrap();
    }
}
