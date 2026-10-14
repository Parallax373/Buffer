//! Tray icon (always-visible recorder state), the global save hotkey, the "Buffer active" popup and
//! game detection. They share one thread because they all need that thread's Win32 message loop.

use crate::overlay::{Kind, Overlay, Popup};
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Ok,
    Warn,
    Stopped,
    /// Waiting for a game ("record only games"): intentionally not recording.
    Idle,
}

/// Programs that are never treated as games even when they cover the whole screen.
const NEVER_GAMES: &[&str] = &[
    "explorer", "searchhost", "shellexperiencehost", "applicationframehost", "startmenuexperiencehost",
    "lockapp", "chrome", "msedge", "firefox", "opera", "brave", "vivaldi", "vlc", "mpv", "potplayer",
    "code", "devenv", "powerpnt", "winword", "excel", "buffer", "buffer-recorder", "obs64", "teams",
    "zoom", "discord", "spotify", "slack", "steamwebhelper", "taskmgr", "mstsc", "vmware", "virtualbox",
];

/// 32x32 logo mark: a play triangle built from scan-lines with faded tails, in the state colour
/// (lime = all good, amber = a source is down, red = stopped).
fn icon(state: State) -> Icon {
    let (r, g, b) = match state {
        State::Ok => (0xc6, 0xf4, 0x32),
        State::Warn => (0xff, 0xb4, 0x54),
        State::Stopped => (0xff, 0x5d, 0x5d),
        State::Idle => (0x8b, 0x91, 0x9c),
    };
    const N: usize = 32;
    let mut px = vec![0u8; N * N * 4];
    let put = |px: &mut Vec<u8>, x: usize, y: usize, a: u8| {
        if x < N && y < N {
            let i = (y * N + x) * 4;
            px[i..i + 4].copy_from_slice(&[r, g, b, a]);
        }
    };
    // 7 bars of 3px with 1px gaps, widest in the middle (like the full logo, thicker for 16-32px)
    let tails = [9usize, 3, 11, 5, 8, 2, 10];
    for (i, tail) in tails.iter().enumerate() {
        let y0 = 2 + i * 4;
        let w = 6 + (3 - (i as i32 - 3).unsigned_abs() as usize) * 5;
        for dy in 0..3 {
            for x in 0..*tail {
                put(&mut px, 10usize.saturating_sub(*tail) + x, y0 + dy, 80);
            }
            for x in 0..w {
                put(&mut px, 10 + x, y0 + dy, 255);
            }
        }
    }
    Icon::from_rgba(px, N as u32, N as u32).expect("valid icon")
}

fn state_of(shared: &session::Shared) -> (State, String) {
    let recording = shared.recording.load(Ordering::Relaxed);
    let down: Vec<&str> = shared.sinks.iter().filter(|s| !s.live.load(Ordering::Relaxed)).map(|s| s.name).collect();
    let buffered = session::buffered_seconds();
    if shared.idle.load(Ordering::Relaxed) {
        return (State::Idle, "Buffer — czeka na grę (nagrywa tylko gry)".to_string());
    }
    if !recording {
        let err = shared.last_error.lock().unwrap().clone();
        let msg = if err.is_empty() { "nagrywanie zatrzymane".to_string() } else { format!("nagrywanie zatrzymane: {err}") };
        return (State::Stopped, format!("Buffer — {msg}"));
    }
    if down.is_empty() {
        (State::Ok, format!("Buffer — nagrywa · bufor {buffered} s · Game/Chat/Mic działają"))
    } else {
        (State::Warn, format!("Buffer — nagrywa, ale nie działa: {}", down.join(", ")))
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
    shared.popup(Kind::Info, format!("Zapisuję klip za {roll} s"), "Naciśnij skrót ponownie, aby zapisać od razu");
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
        save_async(&s);
    });
}

fn save_async(shared: &Arc<session::Shared>) {
    let s = shared.clone();
    thread::spawn(move || match session::save(&s) {
        Ok(path) => {
            win::beep();
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            s.popup(Kind::Ok, "Zapisano klip", name);
        }
        Err(e) => {
            session::log(&format!("save failed: {e}"));
            *s.last_error.lock().unwrap() = format!("save failed: {e}");
            s.popup(Kind::Error, "Nie udało się zapisać klipu", e);
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
        shared.popup(Kind::Error, format!("{game}: nagrywanie nie działa"), "Otwórz Buffer → Ustawienia → Nagrywanie");
    } else if down.is_empty() {
        shared.popup(Kind::Ok, "Buffer aktywny", format!("{} — zapisz ostatnie {len} · {game}", cfg.hotkey));
    } else {
        shared.popup(Kind::Warn, "Buffer aktywny, ale uwaga", format!("Nie działa: {} · {} zapisuje klip", down.join(", "), cfg.hotkey));
    }
}

/// Never returns while the recorder runs.
pub fn run(shared: Arc<session::Shared>, hotkey: String, popups: Receiver<Popup>) {
    let menu = Menu::new();
    let save_i = MenuItem::new("Zapisz klip teraz", true, None);
    let open_i = MenuItem::new("Otwórz edytor", true, None);
    let quit_i = MenuItem::new("Zakończ nagrywanie", true, None);
    let _ = menu.append_items(&[&save_i, &open_i, &PredefinedMenuItem::separator(), &quit_i]);

    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .with_tooltip("Buffer")
        .with_icon(icon(State::Warn))
        .build()
        .map_err(|e| session::log(&format!("tray unavailable: {e}")))
        .ok();

    if let Err(e) = win::register_hotkey(&hotkey) {
        session::log(&e);
        *shared.last_error.lock().unwrap() = e;
    }

    let mut overlay = Overlay::new();
    let mut shown: Option<State> = None;
    let mut notified: HashSet<u32> = HashSet::new();
    let mut tick = 0u32;
    let my_pid = std::process::id();

    let hk_shared = shared.clone();
    let tick_shared = shared.clone();
    win::pump_messages(
        || hotkey_save(&hk_shared),
        || {
            tick += 1;
            overlay.tick();
            while let Ok(p) = popups.try_recv() {
                let ms = if p.kind == Kind::Error { 6500 } else { 4000 };
                overlay.show(p, ms);
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
                } else if ev.id == *open_i.id() {
                    open_editor();
                } else if ev.id == *quit_i.id() {
                    tick_shared.quit.store(true, Ordering::Relaxed);
                }
            }
            if let Some(tray) = &tray {
                let (state, tip) = state_of(&tick_shared);
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
        },
    );
}
