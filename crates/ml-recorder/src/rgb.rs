//! RGB hosting: the recorder is the always-on process, so it owns OpenRGB's server and the effect render loop. The
//! lights then keep their scene after the Buffer window is closed, and Advanced effects run across devices.
//!
//! One worker thread: while `enabled` (rgb.json) and OpenRGB is installed it starts the elevated server through its
//! scheduled task (or reuses a server that already answers), connects with ml-rgb, and shows the scene. A static scene
//! (Simple mode, or paused) is sent once; a playing Advanced scene is streamed at its frame rate, with no allocation
//! per frame. A dropped socket is reconnected with back-off. Devices Buffer took over go back to the mode they had
//! when RGB is turned off or the recorder exits. `rgb.json` is written only here (like eq.json).

use crate::session::log;
use ml_rgb::{
    client::Client,
    engine::{color_at, to_bytes, Env},
    install,
    proto::Device,
    scene::{Look, Scene},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize, Default)]
struct File {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    scene: Scene,
    /// device key -> name of the mode it had before Buffer took over (survives a recorder restart or crash)
    #[serde(default)]
    restore: BTreeMap<String, String>,
    /// (profile, profile reply as hex) of the keyboard before Buffer wrote to it; present only while we hold it
    #[serde(default)]
    kb_backup: Option<(u8, String)>,
}

/// The keyboard is not an OpenRGB device; the page sees it as one with this name and index.
const KB_NAME: &str = "Dark Project Midnight 87";
const KB_INDEX: usize = 1000;
/// at most one stored-profile write per this long (flash wear); the latest colour wins
const KB_EVERY: Duration = Duration::from_secs(2);

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    (s.len() % 2 == 0).then(|| ()).and_then(|_| (0..s.len() / 2).map(|i| u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()).collect())
}

/// What the keyboard should show: (colour, effect id, brightness step 0..=4, speed step 1..=5).
type KbWant = ([u8; 3], u8, u8, u8);

/// The keyboard runs its own effects (one write each): Static = Solid, Breathing, Rainbow = Colour Cycle, Wave.
/// Static keeps its colour pre-scaled by the brightness (full brightness step), the effects use the keyboard's own
/// brightness steps. Off is solid black.
fn kb_want(l: &Look) -> KbWant {
    use ml_rgb::darkproject::effect;
    let speed = (5.0 - 4.0 * ((l.speed - 0.2) / 2.8).clamp(0.0, 1.0)).round() as u8;
    if !l.on {
        return ([0; 3], effect::SOLID, 4, 3);
    }
    let step = ((l.br / 100.0 * 4.0).ceil() as u8).clamp(1, 4);
    let full = Look { br: 100.0, ..l.clone() }.rgb();
    match l.fx.as_str() {
        "breathing" => (full, effect::BREATHING, step, speed),
        "rainbow" => (full, effect::COLOR_CYCLE, step, speed),
        "wave" => (full, effect::WAVE, step, speed),
        _ => (l.rgb(), effect::SOLID, 4, 3),
    }
}

fn kb_snapshot(b: &(u8, String)) -> Option<ml_rgb::darkproject::Snapshot> {
    Some(ml_rgb::darkproject::Snapshot { profile: b.0, profile_reply: unhex(&b.1)?, custom: None })
}

fn file_path() -> PathBuf {
    crate::config::data_dir().join("rgb.json")
}

impl File {
    fn load() -> File {
        std::fs::read(file_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    fn save(&mut self) -> Result<(), String> {
        self.version = 1;
        let p = file_path();
        std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct St {
    file: File,
    /// bumped by every outside request; the worker sleeps until it changes
    gen: u64,
    /// bumped when the scene changes
    rev: u64,
    quit: bool,
    done: bool,
    connected: bool,
    streaming: bool,
    devices: Vec<Device>,
    refresh_req: u64,
    refreshed: u64,
    error: String,
    /// raw colours for one device (`rgb-set`), applied once and not kept
    raw: Vec<(usize, Vec<[u8; 3]>)>,
}

pub struct Hub {
    st: Mutex<St>,
    cv: Condvar,
    level: Box<dyn Fn() -> f32 + Send + Sync>,
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

/// Starts the worker; `level` is the loudness (0..1) the Audio generator follows.
pub fn start(level: impl Fn() -> f32 + Send + Sync + 'static) -> Arc<Hub> {
    let hub = Arc::new(Hub { st: Mutex::new(St { file: File::load(), ..St::default() }), cv: Condvar::new(), level: Box::new(level) });
    let w = hub.clone();
    thread::Builder::new().name("rgb".into()).spawn(move || Worker { hub: w, seen: 0, backoff: 1, ours: false }.run()).expect("spawn rgb thread");
    hub
}

/// Called once from main with the recorder's shared state.
pub fn init(shared: &Arc<crate::session::Shared>) {
    let s = shared.clone();
    let hub = start(move || s.sinks[0].level.load(std::sync::atomic::Ordering::Relaxed) as f32 / 1000.0);
    let _ = HUB.set(hub);
}

/// Clean exit: puts the devices back and stops the server we started.
pub fn shutdown() {
    if let Some(h) = HUB.get() {
        h.shutdown();
    }
}

pub fn command(cmd: &str, arg: &str) -> Value {
    match HUB.get() {
        Some(h) => h.command(cmd, arg),
        None => json!({ "ok": false, "error": "RGB is not available" }),
    }
}

fn err(e: impl ToString) -> Value {
    json!({ "ok": false, "error": e.to_string() })
}

impl Hub {
    fn lock(&self) -> std::sync::MutexGuard<'_, St> {
        self.st.lock().unwrap()
    }

    fn poke(&self, st: &mut St) {
        st.gen += 1;
        self.cv.notify_all();
    }

    fn shutdown(&self) {
        let mut st = self.lock();
        st.quit = true;
        self.poke(&mut st);
        let _ = self.cv.wait_timeout_while(st, Duration::from_secs(8), |s| !s.done);
    }

    fn status(&self) -> Value {
        let (installed, st) = (install::installed(), self.lock());
        json!({
            "ok": true, "installed": installed, "enabled": st.file.enabled, "running": st.connected, "connected": st.connected,
            "devices": st.devices.len(), "playing": st.file.scene.playing, "streaming": st.streaming,
            "fps": st.file.scene.fps(), "error": st.error,
            "keyboard_found": ml_rgb::darkproject::detect().is_some(),
        })
    }

    fn devices(&self, st: &St) -> Value {
        let list: Vec<Value> = st
            .devices
            .iter()
            .enumerate()
            .map(|(i, d)| {
                let mut v = serde_json::to_value(d).unwrap_or_default();
                v["index"] = json!(i);
                v
            })
            .collect();
        let mut list = list;
        if ml_rgb::darkproject::detect().is_some() {
            // not an OpenRGB device: shown to the page as one so it gets a card and a look like the others
            list.push(json!({
                "index": KB_INDEX, "kind": 5, "name": KB_NAME, "vendor": "Dark Project", "description": "", "location": "",
                "active_mode": 0, "modes": [], "zones": [], "stored": true, "colors": [],
                // one LED per key (the keyboard's own key table), so the page draws a keyboard and not a single bar
                "led_names": ml_rgb::darkproject::MIDNIGHT_87_ANSI_LEDS.iter().filter(|n| !n.is_empty()).collect::<Vec<_>>(),
            }));
        }
        json!({ "ok": true, "devices": list })
    }

    /// Waits until `done(st)`, at most `secs`; returns the state.
    fn wait_for<'a>(&'a self, st: std::sync::MutexGuard<'a, St>, secs: u64, done: impl Fn(&St) -> bool) -> std::sync::MutexGuard<'a, St> {
        self.cv.wait_timeout_while(st, Duration::from_secs(secs), |s| !done(s)).unwrap().0
    }

    fn command(&self, cmd: &str, arg: &str) -> Value {
        match cmd {
            "rgb-status" => self.status(),
            "rgb-scene-get" => json!({ "ok": true, "scene": self.lock().file.scene }),
            "rgb-scene-set" => match serde_json::from_str::<Scene>(arg) {
                Ok(scene) => self.edit(|f| f.scene = scene),
                Err(e) => err(format!("invalid scene: {e}")),
            },
            "rgb-look" => match serde_json::from_str::<Look>(arg) {
                Ok(look) => self.edit(|f| f.scene.set_look(look)),
                Err(e) => err(format!("invalid look: {e}")),
            },
            "rgb-set" => {
                let Some((i, rest)) = arg.split_once(' ') else { return err("usage: rgb-set <index> <[[r,g,b],...]>") };
                match (i.parse::<usize>(), serde_json::from_str::<Vec<[u8; 3]>>(rest)) {
                    (Ok(i), Ok(c)) => {
                        let mut st = self.lock();
                        if !st.connected {
                            return err("RGB is not running");
                        }
                        st.raw.push((i, c));
                        self.poke(&mut st);
                        json!({ "ok": true })
                    }
                    _ => err("bad arguments"),
                }
            }
            "rgb-devices" => {
                let mut st = self.lock();
                if !st.connected {
                    return err("RGB is not running");
                }
                st.refresh_req += 1;
                let want = st.refresh_req;
                self.poke(&mut st);
                let st = self.wait_for(st, 30, |s| s.refreshed >= want || !s.connected);
                if st.refreshed < want {
                    return err("RGB is not running");
                }
                self.devices(&st)
            }
            "rgb-unlook" => {
                // give a device back: `rgb-unlook <nth> <name>` (the name may contain spaces)
                let Some((n, name)) = arg.split_once(' ') else { return err("usage: rgb-unlook <nth> <name>") };
                match n.parse::<u32>() {
                    Ok(n) => self.edit(|f| f.scene.remove_look(name, n)),
                    Err(_) => err("bad arguments"),
                }
            }
            "rgb-enable" => {
                if !install::installed() && Client::connect().is_err() {
                    return err("OpenRGB is not installed");
                }
                let mut st = self.lock();
                st.file.enabled = true;
                st.error.clear();
                if let Err(e) = st.file.save() {
                    return err(e);
                }
                self.poke(&mut st);
                let st = self.wait_for(st, 80, |s| s.connected || !s.error.is_empty());
                if st.connected {
                    drop(st);
                    self.status()
                } else {
                    err(if st.error.is_empty() { "OpenRGB did not start in time".to_string() } else { st.error.clone() })
                }
            }
            "rgb-disable" => {
                let mut st = self.lock();
                st.file.enabled = false;
                let _ = st.file.save();
                self.poke(&mut st);
                let st = self.wait_for(st, 15, |s| !s.connected);
                drop(st);
                self.status()
            }
            _ => err(format!("unknown command '{cmd}'")),
        }
    }

    fn edit(&self, f: impl FnOnce(&mut File)) -> Value {
        let mut st = self.lock();
        f(&mut st.file);
        st.rev += 1;
        let r = st.file.save();
        self.poke(&mut st);
        match r {
            Ok(()) => json!({ "ok": true }),
            Err(e) => err(e),
        }
    }
}

/// What the worker keeps per driven device.
struct Planned {
    index: usize,
    fixed: Option<[u8; 3]>,
    look: Option<Look>,
    pos: Vec<[f32; 3]>,
    buf: Vec<[u8; 3]>,
    last: Vec<[u8; 3]>,
}

struct Conn {
    c: Client,
    devs: Vec<Device>,
    /// mode index each device had before we took it over
    orig: Vec<i32>,
    taken: BTreeSet<usize>,
    /// the keyboard's HID handle, opened on first use (never moved to another thread)
    kb: Option<ml_rgb::darkproject::Keyboard>,
    kb_last: Option<KbWant>,
    kb_at: Option<Instant>,
    scene: Scene,
    rev: u64,
    plan: Vec<Planned>,
    replan: bool,
    dirty: bool,
    t: f64,
    last_tick: Instant,
    last_beat: Instant,
}

/// "name#n" where n counts same-named devices before this one.
fn key(devs: &[Device], i: usize) -> String {
    format!("{}#{}", devs[i].name, devs[..i].iter().filter(|d| d.name == devs[i].name).count())
}

struct Worker {
    hub: Arc<Hub>,
    seen: u64,
    backoff: u64,
    /// we started the server (through the task), so we stop it; one that was already running is left alone
    ours: bool,
}

impl Worker {
    /// Sleeps up to `d`, or until somebody asks for something.
    fn nap(&mut self, d: Duration) {
        let st = self.hub.lock();
        let seen = self.seen;
        let st = self.hub.cv.wait_timeout_while(st, d, |s| s.gen == seen && !s.quit).unwrap().0;
        self.seen = st.gen;
    }

    fn wanted(&self) -> (bool, bool) {
        let st = self.hub.lock();
        (st.file.enabled && !st.quit, st.quit)
    }

    fn set_error(&self, e: &str) {
        let mut st = self.hub.lock();
        if st.error != e {
            st.error = e.to_string();
            self.hub.cv.notify_all();
        }
    }

    fn run(mut self) {
        let mut conn: Option<Conn> = None;
        loop {
            let (want, quit) = self.wanted();
            if !want {
                if let Some(c) = conn.take() {
                    self.release_all(c);
                }
                if self.ours {
                    install::stop_server();
                    self.ours = false;
                }
                {
                    let mut st = self.hub.lock();
                    st.connected = false;
                    st.streaming = false;
                    st.devices.clear();
                    st.done = quit;
                    self.hub.cv.notify_all();
                }
                if quit {
                    return;
                }
                self.nap(Duration::from_secs(3600));
                continue;
            }
            if conn.is_none() {
                match self.connect() {
                    Ok(c) => {
                        conn = Some(c);
                        self.backoff = 1;
                        let mut st = self.hub.lock();
                        st.error.clear();
                        st.connected = true;
                        st.devices = conn.as_ref().unwrap().devs.clone();
                        st.refreshed = st.refresh_req;
                        self.hub.cv.notify_all();
                    }
                    Err(e) => {
                        log(&format!("rgb: {e}"));
                        self.set_error(&e);
                        let d = Duration::from_secs(self.backoff);
                        self.backoff = (self.backoff * 2).min(30);
                        self.nap(d);
                    }
                }
                continue;
            }
            if let Err(e) = self.tick(conn.as_mut().unwrap()) {
                log(&format!("rgb: connection lost: {e}"));
                conn = None; // the socket is gone: nothing to restore through, the saved modes cover a restart
                let mut st = self.hub.lock();
                st.connected = false;
                st.streaming = false;
                st.error = e;
                self.hub.cv.notify_all();
                drop(st);
                let d = Duration::from_secs(self.backoff);
                self.backoff = (self.backoff * 2).min(30);
                self.nap(d);
            }
        }
    }

    /// Reuses a server that answers, otherwise starts the elevated one through its task, then waits for the device
    /// detection to settle.
    fn connect(&mut self) -> Result<Conn, String> {
        let t0 = Instant::now();
        let mut c = match Client::connect() {
            Ok(c) => c,
            Err(_) => {
                if !install::installed() {
                    return Err("OpenRGB is not installed".into());
                }
                install::start_server()?;
                self.ours = true;
                loop {
                    match Client::connect() {
                        Ok(c) => break c,
                        Err(e) if t0.elapsed() > Duration::from_secs(60) => return Err(format!("OpenRGB does not answer: {e}")),
                        Err(_) => {
                            self.nap(Duration::from_millis(500));
                            if !self.wanted().0 {
                                return Err("stopped".into());
                            }
                        }
                    }
                }
            }
        };
        // detection goes on after the port opens: wait until the device count stops changing
        let (mut last, mut stable, t1) = (u32::MAX, 0, Instant::now());
        while stable < 3 && t1.elapsed() < Duration::from_secs(25) {
            let n = c.device_count()?;
            stable = if n == last { stable + 1 } else { 0 };
            last = n;
            if stable < 3 {
                self.nap(Duration::from_millis(700));
                if !self.wanted().0 {
                    return Err("stopped".into());
                }
            }
        }
        let devs = c.devices()?;
        let saved = self.hub.lock().file.restore.clone();
        let orig = (0..devs.len())
            .map(|i| saved.get(&key(&devs, i)).and_then(|n| devs[i].modes.iter().position(|m| &m.name == n)).map(|p| p as i32).unwrap_or(devs[i].active_mode))
            .collect();
        Ok(Conn {
            c,
            devs,
            orig,
            taken: BTreeSet::new(),
            kb: None,
            kb_last: None,
            kb_at: None,
            scene: Scene::default(),
            rev: u64::MAX,
            plan: Vec::new(),
            replan: true,
            dirty: true,
            t: 0.0,
            last_tick: Instant::now(),
            last_beat: Instant::now(),
        })
    }

    /// Puts one device back to its earlier mode.
    fn restore(&self, c: &mut Conn, i: usize) {
        let mut d = c.devs[i].clone();
        d.active_mode = c.orig[i];
        let _ = c.c.restore_mode(i as u32, &d);
        let mut st = self.hub.lock();
        st.file.restore.remove(&key(&c.devs, i));
        let _ = st.file.save();
        c.taken.remove(&i);
    }

    fn release_all(&self, mut c: Conn) {
        for i in c.taken.clone() {
            self.restore(&mut c, i);
        }
        self.kb_release(&mut c);
    }

    fn kb_open(c: &mut Conn) -> Option<&ml_rgb::darkproject::Keyboard> {
        if c.kb.is_none() {
            c.kb = ml_rgb::darkproject::detect().and_then(|i| ml_rgb::darkproject::Keyboard::open(&i).ok());
        }
        c.kb.as_ref()
    }

    /// Writes the saved profile back and forgets the backup (user turned the sync off, RGB off, or clean exit).
    fn kb_release(&self, c: &mut Conn) {
        let backup = self.hub.lock().file.kb_backup.clone();
        if let Some(b) = backup {
            let ok = match (kb_snapshot(&b), Self::kb_open(c)) {
                (Some(s), Some(k)) => k.restore(&s).is_ok(),
                _ => false,
            };
            if ok {
                let mut st = self.hub.lock();
                st.file.kb_backup = None;
                let _ = st.file.save();
            } else {
                log("rgb: keyboard profile could not be restored (kept in rgb.json, retried next time)");
            }
        }
        c.kb_last = None;
        c.kb_at = None;
    }

    /// The keyboard follows its Simple look, at most one stored-profile write per `KB_EVERY`. Returns how long to wait
    /// for a pending write.
    fn kb_sync(&self, c: &mut Conn) -> Option<Duration> {
        let (on, look, held) = {
            let st = self.hub.lock();
            let look = st.file.scene.simple.iter().find(|l| l.name == KB_NAME).map(kb_want);
            (true, look, st.file.kb_backup.is_some())
        };
        let simple = c.scene.mode == ml_rgb::scene::Mode::Simple;
        let Some(want) = look.filter(|_| on && simple) else {
            if held {
                self.kb_release(c); // opt-out, or the scene left Simple mode: give the keyboard back
            }
            return None;
        };
        if c.kb_last == Some(want) {
            return None;
        }
        if let Some(t) = c.kb_at {
            if t.elapsed() < KB_EVERY {
                return Some(KB_EVERY - t.elapsed());
            }
        }
        let backup = self.hub.lock().file.kb_backup.clone();
        let Some(kb) = Self::kb_open(c) else { return None };
        let snap = match backup.as_ref().and_then(kb_snapshot) {
            Some(s) => s,
            None => {
                let snap = match kb.current_profile().and_then(|p| kb.snapshot(p, None)) {
                    Ok(s) => s,
                    Err(e) => {
                        log(&format!("rgb: keyboard not read: {e}"));
                        return None;
                    }
                };
                // saved BEFORE the first write, so a crash cannot lose the user's profile
                let mut st = self.hub.lock();
                st.file.kb_backup = Some((snap.profile, hex(&snap.profile_reply)));
                let _ = st.file.save();
                snap
            }
        };
        let (rgb, effect_id, brightness, speed) = want;
        match c.kb.as_ref().unwrap().apply_effect(&snap, effect_id, rgb, brightness, speed) {
            Ok(()) => {
                c.kb_last = Some(want);
                c.kb_at = Some(Instant::now());
            }
            Err(e) => {
                log(&format!("rgb: keyboard write failed: {e}"));
                c.kb_at = Some(Instant::now());
            }
        }
        None
    }

    fn take_over(&self, c: &mut Conn, i: usize, colors: &[[u8; 3]]) -> Result<(), String> {
        if !c.taken.contains(&i) {
            let k = key(&c.devs, i);
            let mut st = self.hub.lock();
            if !st.file.restore.contains_key(&k) {
                if let Some(m) = c.devs[i].modes.get(c.orig[i] as usize) {
                    st.file.restore.insert(k, m.name.clone());
                    let _ = st.file.save();
                }
            }
            drop(st);
            c.c.set_colors(i as u32, colors)?;
            c.taken.insert(i);
        } else {
            c.c.frame(i as u32, colors)?;
        }
        Ok(())
    }

    fn render(&self, c: &mut Conn) {
        let env = Env { origin: c.scene.origin, level: (self.hub.level)().clamp(0.0, 1.0), bright: (c.scene.bright / 100.0).clamp(0.0, 1.0) };
        for p in c.plan.iter_mut() {
            if let Some(look) = p.look.as_ref().filter(|l| l.animated()) {
                // Simple effects need no positions: an LED's place along the device is its index
                let n = p.buf.len().max(2) as f32 - 1.0;
                for (i, o) in p.buf.iter_mut().enumerate() {
                    *o = look.at(c.t, i as f32 / n);
                }
            } else if p.fixed.is_none() {
                for (o, pos) in p.buf.iter_mut().zip(&p.pos) {
                    *o = to_bytes(color_at(&c.scene.layers, *pos, c.t, &env));
                }
            }
        }
    }

    /// One pass of the loop: apply what changed, draw a frame if the scene moves, then sleep.
    fn tick(&mut self, c: &mut Conn) -> Result<(), String> {
        let (rev, refresh, raw) = {
            let mut st = self.hub.lock();
            (st.rev, st.refresh_req > st.refreshed, std::mem::take(&mut st.raw))
        };
        if rev != c.rev {
            c.scene = self.hub.lock().file.scene.clone();
            c.rev = rev;
            c.replan = true;
        }
        if refresh {
            c.devs = c.c.devices()?;
            c.orig.resize(c.devs.len(), 0);
            c.replan = true;
            let mut st = self.hub.lock();
            st.devices = c.devs.clone();
            st.refreshed = st.refresh_req;
            self.hub.cv.notify_all();
        }
        for (i, colors) in raw {
            if i < c.devs.len() {
                self.take_over(c, i, &colors)?;
            }
        }
        if c.replan {
            let names: Vec<(&str, usize)> = c.devs.iter().map(|d| (d.name.as_str(), d.led_names.len())).collect();
            c.plan = c
                .scene
                .plan(&names)
                .into_iter()
                .filter(|p| names[p.index].1 > 0)
                .map(|p| {
                    let n = names[p.index].1;
                    let buf = vec![p.fixed.unwrap_or([0; 3]); n];
                    Planned { index: p.index, fixed: p.fixed, look: p.look, pos: p.pos, last: Vec::with_capacity(n), buf }
                })
                .collect();
            // devices that dropped out of the scene go back to their own mode
            let keep: BTreeSet<usize> = c.plan.iter().map(|p| p.index).collect();
            for i in c.taken.clone() {
                if !keep.contains(&i) {
                    self.restore(c, i);
                }
            }
            c.replan = false;
            c.dirty = true;
        }
        let advanced = c.scene.mode == ml_rgb::scene::Mode::Advanced && c.scene.playing && !c.scene.layers.is_empty() && c.plan.iter().any(|p| p.fixed.is_none());
        let simple_fx = c.scene.mode == ml_rgb::scene::Mode::Simple && c.plan.iter().any(|p| p.look.as_ref().is_some_and(Look::animated));
        let animated = advanced || simple_fx;
        let now = Instant::now();
        if animated {
            // Simple effects carry their own speed; the scene speed is the Advanced page's
            c.t += (now - c.last_tick).as_secs_f64().min(0.1) * if simple_fx { 1.0 } else { c.scene.speed.clamp(0.0, 3.0) as f64 };
        }
        c.last_tick = now;
        if animated || c.dirty {
            self.render(c);
            let mut plan = std::mem::take(&mut c.plan);
            let mut r = Ok(());
            for p in plan.iter_mut().filter(|p| p.buf != p.last) {
                r = self.take_over(c, p.index, &p.buf);
                if r.is_err() {
                    break;
                }
                p.last.clear();
                p.last.extend_from_slice(&p.buf);
            }
            c.plan = plan;
            r?;
            c.dirty = false;
        }
        {
            let mut st = self.hub.lock();
            st.streaming = animated;
        }
        // an unused socket is the first sign of a dead server: ask something small now and then (this also drains
        // packets the server pushed on its own)
        if c.last_beat.elapsed() > Duration::from_secs(5) {
            c.c.device_count()?;
            c.last_beat = Instant::now();
        }
        let kb_wait = self.kb_sync(c);
        if animated {
            let frame = Duration::from_secs_f64(1.0 / c.scene.fps() as f64);
            let spent = now.elapsed();
            self.nap(frame.saturating_sub(spent));
        } else {
            self.nap(kb_wait.unwrap_or(Duration::from_secs(5)).min(Duration::from_secs(5)));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_backup_round_trips() {
        let b = (2u8, hex(&[7, 0x82, 0, 255, 16]));
        assert_eq!(b.1, "0782 00ff10".replace(' ', ""));
        let s = kb_snapshot(&b).unwrap();
        assert_eq!((s.profile, s.profile_reply), (2, vec![7, 0x82, 0, 255, 16]));
        assert!(unhex("abc").is_none() && unhex("zz").is_none());
    }

    /// The real keyboard, through the real hub: `cargo test -p ml-recorder rgb_keyboard_sync -- --ignored --nocapture`.
    /// Shows solid colour for a few seconds, then checks the stored profile is byte for byte what it was before.
    #[test]
    #[ignore]
    fn rgb_keyboard_sync_and_restore() {
        use ml_rgb::darkproject::{detect, Keyboard};
        let tmp = std::env::temp_dir().join(format!("buffer-rgb-kb-{}", std::process::id()));
        std::env::set_var("APPDATA", &tmp);
        let Some(info) = detect() else { return println!("no keyboard: skipping") };
        let read = || {
            let k = Keyboard::open(&info).unwrap();
            let p = k.current_profile().unwrap();
            k.snapshot(p, None).unwrap().profile_reply
        };
        let before = read();
        let hub = start(|| 0.0);
        /// a failed assertion must not leave the keyboard on our colour
        struct Guard(Arc<Hub>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.command("rgb-unlook", &format!("0 {KB_NAME}"));
                thread::sleep(Duration::from_secs(4));
                self.0.command("rgb-disable", "");
                self.0.shutdown();
            }
        }
        let _guard = Guard(hub.clone());
        assert_eq!(hub.command("rgb-enable", "")["ok"], true);
        let devs = hub.command("rgb-devices", "");
        assert!(devs["devices"].as_array().unwrap().iter().any(|d| d["name"] == KB_NAME), "the keyboard is listed");
        let look = json!({ "name": KB_NAME, "nth": 0, "hue": 75, "sat": 90, "br": 100, "on": true });
        assert_eq!(hub.command("rgb-look", &look.to_string())["ok"], true);
        thread::sleep(Duration::from_secs(4));
        let during = read();
        println!("effect during: {} (before {})", during[9], before[9]);
        assert_eq!(during[9], 5, "solid colour is showing");
        assert!(hub.lock().file.kb_backup.is_some(), "the profile was saved before the write");
        // a second colour right away is held back (flash wear), then arrives
        let look2 = json!({ "name": KB_NAME, "nth": 0, "hue": 200, "sat": 90, "br": 100, "on": true });
        hub.command("rgb-look", &look2.to_string());
        thread::sleep(Duration::from_secs(4));
        let second = read();
        assert_ne!((during[59], during[67], during[75]), (second[59], second[67], second[75]), "colour moved on");
        assert_eq!(hub.command("rgb-unlook", &format!("0 {KB_NAME}"))["ok"], true);
        thread::sleep(Duration::from_secs(4));
        assert_eq!(read(), before, "the user's profile is back");
        assert!(hub.lock().file.kb_backup.is_none());
        hub.command("rgb-disable", "");
        hub.shutdown();
        assert_eq!(read(), before);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Hardware + the installed elevated OpenRGB task: `cargo test -p ml-recorder rgb_hosting -- --ignored --nocapture`.
    /// Uses a throwaway APPDATA (rgb.json), lists the devices and, briefly, sets the headset to one colour. The earlier
    /// mode is put back by `rgb-disable`. Needs "Buffer OpenRGB" to be installed (`buffer-recorder rgb-install`, one UAC click).
    #[test]
    #[ignore]
    fn rgb_hosting_lists_devices_and_restores() {
        let tmp = std::env::temp_dir().join(format!("buffer-rgb-host-{}", std::process::id()));
        std::env::set_var("APPDATA", &tmp);
        if !install::installed() && Client::connect().is_err() {
            println!("OpenRGB task not installed and no server running: skipping");
            return;
        }
        let hub = start(|| 0.0);
        let r = hub.command("rgb-enable", "");
        assert_eq!(r["ok"], true, "{r}");
        let devs = hub.command("rgb-devices", "");
        let list = devs["devices"].as_array().unwrap();
        for d in list {
            println!("#{} {} leds={}", d["index"], d["name"], d["led_names"].as_array().map_or(0, |l| l.len()));
        }
        assert!(!list.is_empty());
        if let Some(h) = list.iter().find(|d| d["name"] == "SteelSeries Arctis 5") {
            let look = json!({ "name": h["name"], "nth": 0, "hue": 200, "sat": 90, "br": 30, "on": true });
            assert_eq!(hub.command("rgb-look", &look.to_string())["ok"], true);
            thread::sleep(Duration::from_millis(1500));
            assert_eq!(hub.lock().file.restore.len(), 1, "the earlier mode is remembered while we drive the device");
            // and a short animated Advanced scene (dim): the frame loop must stream, then stop when paused
            let scene = json!({ "mode": "advanced", "playing": true, "bright": 20,
                "devices": [{ "id": 1, "type": "headset", "name": "h", "x": 0, "y": 0, "z": 0, "rot": 0, "sc": 1, "link": { "name": "SteelSeries Arctis 5", "nth": 0 } }],
                "layers": [{ "on": true, "gen": "wave", "p": {}, "stops": [{ "p": 0, "c": "#000000" }, { "p": 1, "c": "#38b6ff" }] }] });
            assert_eq!(hub.command("rgb-scene-set", &scene.to_string())["ok"], true);
            thread::sleep(Duration::from_millis(1200));
            assert_eq!(hub.status()["streaming"], true);
            let mut paused = scene.clone();
            paused["playing"] = json!(false);
            hub.command("rgb-scene-set", &paused.to_string());
            thread::sleep(Duration::from_millis(600));
            assert_eq!(hub.status()["streaming"], false);
        }
        let r = hub.command("rgb-disable", "");
        assert_eq!(r["connected"], false);
        assert!(hub.lock().file.restore.is_empty(), "everything was put back");
        hub.shutdown();
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
