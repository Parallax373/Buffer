//! Fan hosting: the recorder is the always-on process, so it owns the control loop and the fans keep following their
//! curves after the Buffer window is closed.
//!
//! One worker thread. While `enabled` (fans.json) and the helper is installed it starts the elevated helper through its
//! task (or reuses a running one), connects to its pipe and, once a second, reads the sensors, runs `ml_fans::curve::Engine`
//! and sends the changed speeds. Safety lives on two levels: the helper's own watchdog puts every control Buffer touched
//! to the fail-safe speed if we go quiet (recorder crash), and a clean stop or disable asks the helper to `quit`, which
//! hands every control back. Another fan program (FanControl, ...) pauses the controls it can fight us over.
//! `fans.json` is written only here, like rgb.json.

use crate::session::log;
use ml_fans::{
    client::{Client, SensorInfo},
    curve::{Engine, Out, Readings},
    discover::discover,
    install,
    model::Setup,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
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
    setup: Setup,
    /// named setups (curve profiles) and the one in use
    #[serde(default)]
    profiles: BTreeMap<String, Setup>,
    #[serde(default)]
    active_profile: Option<String>,
}

fn file_path() -> PathBuf {
    crate::config::data_dir().join("fans.json")
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
    quit: bool,
    done: bool,
    connected: bool,
    admin: bool,
    version: String,
    error: String,
    sensors: Vec<SensorInfo>,
    readings: Readings,
    outputs: HashMap<String, f32>,
    taken: Vec<String>,
    failed: bool,
    /// other fan programs that are running: (name, they only touch the graphics card)
    conflicts: Vec<(&'static str, bool)>,
    /// the worker resets the curve engine at its next cycle
    reset_engine: bool,
    /// `fans-probe-start`: the worker spins each control up in turn and pairs it with the fan that answered
    probe_req: bool,
    probe: Probe,
    /// `fans-boost`: one control held at a speed until then (the setup wizard spins a fan so the user can see which it is);
    /// it ends by itself, so a page that goes away leaves nothing loud behind
    boost: Option<(String, f32, Instant)>,
}

/// Progress of the pairing probe, shown by the page.
#[derive(Serialize, Default, Clone)]
struct Probe {
    running: bool,
    done: bool,
    total: usize,
    index: usize,
    /// the control being tried now
    current: Option<String>,
    /// (control id, the fan sensor that answered, its rise in rpm)
    results: Vec<(String, Option<String>, f32)>,
    error: String,
}

pub struct Hub {
    st: Mutex<St>,
    cv: Condvar,
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

pub fn init() {
    let hub = Arc::new(Hub { st: Mutex::new(St { file: File::load(), ..St::default() }), cv: Condvar::new() });
    let w = hub.clone();
    thread::Builder::new().name("fans".into()).spawn(move || Worker { hub: w, client: None, engine: Engine::new(), sent: HashMap::new(), seen: 0, started: Instant::now() }.run()).expect("spawn fans thread");
    let _ = HUB.set(hub);
}

/// Clean exit: the helper hands every control back and ends.
pub fn shutdown() {
    if let Some(h) = HUB.get() {
        h.shutdown();
    }
}

pub fn command(cmd: &str, arg: &str) -> Value {
    match HUB.get() {
        Some(h) => h.command(cmd, arg),
        None => json!({ "ok": false, "error": "fans are not available" }),
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

    /// A loaded profile starts the curves from scratch (their hysteresis memory belongs to the old ones).
    fn engine_reset(&self, st: &mut St) {
        st.reset_engine = true;
    }

    fn shutdown(&self) {
        let mut st = self.lock();
        st.quit = true;
        self.poke(&mut st);
        let _ = self.cv.wait_timeout_while(st, Duration::from_secs(10), |s| !s.done);
    }

    fn status(&self) -> Value {
        let (installed, st) = (install::installed(), self.lock());
        let values: BTreeMap<&String, f32> = st.readings.iter().map(|(k, v)| (k, *v)).collect();
        json!({
            "ok": true, "installed": installed, "enabled": st.file.enabled, "connected": st.connected, "admin": st.admin,
            "version": st.version, "error": st.error, "downloadable": install::downloadable(), "dev_build": install::local_zip().is_some(),
            "conflicts": st.conflicts.iter().map(|(n, g)| json!({ "name": n, "gpu_only": g })).collect::<Vec<_>>(),
            "sensors": st.sensors.iter().map(|s| json!({ "id": s.id, "name": s.name, "hw": s.hw, "hw_type": s.hw_type, "kind": s.kind, "control": s.control })).collect::<Vec<_>>(),
            "probe": st.probe, "boost": st.boost.as_ref().filter(|b| b.2 > Instant::now()).map(|b| &b.0), "values": values, "outputs": st.outputs, "taken": st.taken, "failed": st.failed,
            "setup": st.file.setup, "profiles": st.file.profiles.keys().collect::<Vec<_>>(), "profile": st.file.active_profile,
        })
    }

    fn command(&self, cmd: &str, arg: &str) -> Value {
        match cmd {
            "fans-status" => self.status(),
            "fans-enable" => {
                let mut st = self.lock();
                st.file.enabled = true;
                st.error.clear();
                if let Err(e) = st.file.save() {
                    return err(e);
                }
                self.poke(&mut st);
                json!({ "ok": true })
            }
            "fans-disable" => {
                let mut st = self.lock();
                st.file.enabled = false;
                if let Err(e) = st.file.save() {
                    return err(e);
                }
                self.poke(&mut st);
                // the worker hands the controls back and stops the helper; wait for that (the caller may uninstall next)
                let _ = self.cv.wait_timeout_while(st, Duration::from_secs(10), |s| s.connected);
                json!({ "ok": true })
            }
            "fans-setup-set" => match serde_json::from_str::<Setup>(arg) {
                Ok(setup) => {
                    let mut st = self.lock();
                    st.file.setup = setup;
                    if let Err(e) = st.file.save() {
                        return err(e);
                    }
                    self.poke(&mut st);
                    json!({ "ok": true })
                }
                Err(e) => err(format!("not a fan setup: {e}")),
            },
            // `fans-profile save|load|delete <name>`: a named copy of the whole setup (curves, mixes, controls)
            "fans-profile" => {
                let (action, name) = arg.trim().split_once(' ').unwrap_or((arg.trim(), ""));
                let name = name.trim().to_string();
                if name.is_empty() || name.len() > 60 {
                    return err("a profile needs a name of up to 60 characters");
                }
                let mut st = self.lock();
                match action {
                    "save" => {
                        let cur = st.file.setup.clone();
                        st.file.profiles.insert(name.clone(), cur);
                        st.file.active_profile = Some(name);
                    }
                    "load" => match st.file.profiles.get(&name).cloned() {
                        Some(p) => {
                            st.file.setup = p;
                            st.file.active_profile = Some(name);
                            self.engine_reset(&mut st);
                        }
                        None => return err("no such profile"),
                    },
                    "delete" => {
                        st.file.profiles.remove(&name);
                        if st.file.active_profile.as_deref() == Some(name.as_str()) {
                            st.file.active_profile = None;
                        }
                    }
                    _ => return err("unknown profile action"),
                }
                if let Err(e) = st.file.save() {
                    return err(e);
                }
                self.poke(&mut st);
                json!({ "ok": true })
            }
            // spins every board control up in turn and pairs it with the fan that answered (the page asks first: it is audible)
            "fans-probe-start" => {
                let mut st = self.lock();
                if !st.connected {
                    return err("the fan helper is not running");
                }
                if st.conflicts.iter().any(|(_, gpu_only)| !gpu_only) {
                    return err("another fan program is running");
                }
                if st.probe.running {
                    return err("already running");
                }
                st.probe = Probe { running: true, ..Probe::default() };
                st.probe_req = true;
                self.poke(&mut st);
                json!({ "ok": true })
            }
            // `fans-boost <control id> <percent> <seconds>` holds one control at a speed for at most 15 s (the page renews it
            // while a wizard step is open); `fans-boost off` ends it at once
            "fans-boost" => {
                let mut st = self.lock();
                if arg.trim() == "off" {
                    st.boost = None;
                    self.poke(&mut st);
                    return json!({ "ok": true });
                }
                let mut it = arg.trim().rsplitn(3, ' ');
                let (Some(secs), Some(pct), Some(id)) = (it.next(), it.next(), it.next()) else { return err("usage: fans-boost <id> <percent> <seconds>") };
                let (Ok(secs), Ok(pct)) = (secs.parse::<f32>(), pct.parse::<f32>()) else { return err("bad number") };
                if !st.connected {
                    return err("the fan helper is not running");
                }
                if st.probe.running {
                    return err("the pairing probe is running");
                }
                if !st.file.setup.controls.iter().any(|c| c.id == id) {
                    return err("no such control");
                }
                if st.conflicts.iter().any(|(_, gpu_only)| !gpu_only || id.starts_with("/gpu")) {
                    return err("another fan program is running");
                }
                st.boost = Some((id.to_string(), pct.clamp(0.0, 100.0), Instant::now() + Duration::from_secs_f32(secs.clamp(1.0, 15.0))));
                self.poke(&mut st);
                json!({ "ok": true })
            }
            "fans-import-find" => json!({ "ok": true, "paths": ml_fans::import::candidates().iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>() }),
            // reads a FanControl configuration and returns what it would become; nothing is applied (the page applies it)
            "fans-import" => {
                let path = arg.trim().trim_matches('"');
                let text = match std::fs::read_to_string(path) {
                    Ok(t) => t,
                    Err(e) => return err(format!("cannot read {path}: {e}")),
                };
                let st = self.lock();
                match ml_fans::import::from_fancontrol(&text, &st.sensors, &st.file.setup) {
                    Ok(r) => json!({ "ok": true, "controls": r.controls, "curves": r.curves, "mixes": r.mixes, "hidden": r.hidden, "notes": r.notes, "setup": r.setup }),
                    Err(e) => err(e),
                }
            }
            "fans-detect" => {
                let mut st = self.lock();
                let sensors = st.sensors.clone();
                let added = discover(&mut st.file.setup, &sensors);
                if added > 0 {
                    let _ = st.file.save();
                    self.poke(&mut st);
                }
                json!({ "ok": true, "added": added })
            }
            _ => err("unknown fans command"),
        }
    }
}

struct Worker {
    hub: Arc<Hub>,
    client: Option<Client>,
    engine: Engine,
    /// what the helper was last given per control (so unchanged speeds are not sent again)
    sent: HashMap<String, f32>,
    seen: u64,
    started: Instant,
}

impl Worker {
    fn run(mut self) {
        loop {
            let (quit, enabled, setup) = {
                let mut st = self.hub.lock();
                if std::mem::take(&mut st.reset_engine) {
                    self.engine.reset();
                    self.sent.clear();
                }
                (st.quit, st.file.enabled, st.file.setup.clone())
            };
            if quit {
                self.hand_back();
                break;
            }
            if !enabled || !install::installed() {
                if self.client.is_some() {
                    self.hand_back();
                }
                self.set_connected(false, "");
                self.wait(Duration::from_secs(2));
                continue;
            }
            if self.client.is_some() && std::mem::take(&mut self.hub.lock().probe_req) {
                if let Err(e) = self.probe() {
                    log(&format!("fans probe: {e}"));
                    let mut st = self.hub.lock();
                    st.probe.running = false;
                    st.probe.done = true;
                    st.probe.error = e;
                    self.hub.cv.notify_all();
                }
                continue;
            }
            if self.client.is_none() {
                if let Err(e) = self.connect(&setup) {
                    self.set_connected(false, &e);
                    self.wait(Duration::from_secs(3));
                    continue;
                }
            }
            if let Err(e) = self.tick(&setup) {
                log(&format!("fans: {e}"));
                self.client = None;
                self.sent.clear();
                self.set_connected(false, &e);
            }
            self.wait(Duration::from_secs(1));
        }
        let mut st = self.hub.lock();
        st.done = true;
        self.hub.cv.notify_all();
    }

    fn wait(&mut self, d: Duration) {
        let seen = self.seen;
        let st = self.hub.lock();
        let (st, _) = self.hub.cv.wait_timeout_while(st, d, |s| s.gen == seen && !s.quit).unwrap();
        self.seen = st.gen;
    }

    fn set_connected(&self, on: bool, error: &str) {
        let mut st = self.hub.lock();
        st.connected = on;
        st.error = error.to_string();
        if !on {
            st.taken.clear();
            st.outputs.clear();
        }
        self.hub.cv.notify_all();
    }

    fn connect(&mut self, setup: &Setup) -> Result<(), String> {
        let mut c = match Client::connect() {
            Ok(c) => c,
            Err(_) => {
                install::start()?;
                let mut got = None;
                for _ in 0..40 {
                    thread::sleep(Duration::from_millis(250));
                    if let Ok(c) = Client::connect() {
                        got = Some(c);
                        break;
                    }
                }
                got.ok_or_else(|| "the fan helper did not come up".to_string())?
            }
        };
        let (version, admin) = c.hello()?;
        // if we ever go quiet (a crash) the helper puts what we touched to the fail-safe speed on its own
        c.failsafe(setup.failsafe, 10.0)?;
        let sensors = c.list()?;
        {
            let mut st = self.hub.lock();
            st.version = version;
            st.admin = admin;
            let added = discover(&mut st.file.setup, &sensors);
            st.sensors = sensors;
            if added > 0 {
                log(&format!("fans: {added} new controls found"));
                let _ = st.file.save();
            }
        }
        self.client = Some(c);
        self.sent.clear();
        self.engine.reset();
        Ok(())
    }

    fn tick(&mut self, setup: &Setup) -> Result<(), String> {
        let c = self.client.as_mut().ok_or("not connected")?;
        let reading = c.read()?;
        let procs = crate::away::snapshot();
        let conflicts = crate::away::fan_conflicts(&procs);
        let now = self.started.elapsed().as_secs_f64();
        let mut steps = self.engine.step(setup, now, &reading.values);
        // a wizard boost replaces that one control's curve until it runs out
        let boost = {
            let mut st = self.hub.lock();
            if st.boost.as_ref().is_some_and(|b| b.2 <= Instant::now()) {
                st.boost = None;
            }
            st.boost.clone()
        };
        if let Some((bid, pct, _)) = &boost {
            match steps.iter_mut().find(|(id, _)| id == bid) {
                Some(s) => s.1 = Out::Set(*pct),
                None => steps.push((bid.clone(), Out::Set(*pct))),
            }
        }
        let (mut set, mut release) = (Vec::new(), Vec::new());
        for (id, out) in steps {
            let blocked = conflicts.iter().any(|(_, gpu_only)| !gpu_only || id.starts_with("/gpu"));
            match out {
                Out::Set(p) if !blocked => {
                    let p = p.clamp(0.0, 100.0);
                    let unchanged = self.sent.get(&id).is_some_and(|s| (s - p).abs() < 0.5) && reading.taken.contains(&id);
                    if !unchanged {
                        self.sent.insert(id.clone(), p);
                        set.push((id, p));
                    }
                }
                _ => {
                    self.sent.remove(&id);
                    if reading.taken.contains(&id) {
                        release.push(id);
                    }
                }
            }
        }
        if reading.failed {
            // the helper's watchdog fired while we were away: everything must be sent again
            self.sent.clear();
        }
        if !set.is_empty() {
            c.set(&set)?;
        }
        if !release.is_empty() {
            c.release(&release)?;
        }
        let mut st = self.hub.lock();
        st.connected = true;
        st.error.clear();
        st.readings = reading.values;
        st.outputs = self.engine.outputs.clone();
        st.taken = reading.taken;
        st.failed = reading.failed;
        st.conflicts = conflicts;
        self.hub.cv.notify_all();
        Ok(())
    }

    /// Pairs every board control with the fan that answers when it is driven to 100 %. The curve loop is paused meanwhile;
    /// the helper's watchdog stays fed by the one-second reads. GPU controls are left alone (they are paired by number).
    fn probe(&mut self) -> Result<(), String> {
        let (ctls, sensors): (Vec<String>, Vec<SensorInfo>) = {
            let st = self.hub.lock();
            (st.file.setup.controls.iter().filter(|c| !c.id.starts_with("/gpu")).map(|c| c.id.clone()).collect(), st.sensors.clone())
        };
        let fans: Vec<&str> = sensors.iter().filter(|s| s.kind == "fan").map(|s| s.id.as_str()).collect();
        self.hub.lock().probe.total = ctls.len();
        let rpms = |r: &ml_fans::client::Reading| -> Vec<(String, f32)> { fans.iter().filter_map(|f| r.values.get(*f).map(|v| (f.to_string(), *v))).collect() };
        for (i, id) in ctls.iter().enumerate() {
            {
                let mut st = self.hub.lock();
                st.probe.index = i;
                st.probe.current = Some(id.clone());
                self.hub.cv.notify_all();
            }
            let c = self.client.as_mut().ok_or("not connected")?;
            let before = rpms(&c.read()?);
            c.set(&[(id.clone(), 100.0)])?;
            let mut after = before.clone();
            for _ in 0..7 {
                thread::sleep(Duration::from_secs(1));
                after = rpms(&c.read()?);
            }
            c.release(&[id.clone()])?;
            let found = ml_fans::pair::answering_fan(&before, &after, 150.0);
            self.hub.lock().probe.results.push((id.clone(), found.as_ref().map(|f| f.0.clone()), found.map_or(0.0, |f| f.1)));
            thread::sleep(Duration::from_secs(2)); // the fan slows down again before the next one is tried
            self.client.as_mut().ok_or("not connected")?.read()?;
        }
        let mut st = self.hub.lock();
        let results = st.probe.results.clone();
        let rpm_now = st.readings.clone();
        for (id, fan, _) in results {
            let Some(c) = st.file.setup.controls.iter_mut().find(|c| c.id == id) else { continue };
            match fan {
                // it answered: it is paired, and it is plainly a real fan
                Some(fan) => {
                    c.fan = Some(fan);
                    c.hidden = false;
                }
                // driven to 100 % and nothing moved, and its own speed sensor reads 0: an empty header (this is proof, unlike
                // a single 0 in a list; the page lists hidden ones, and Detect shows one again when a fan is plugged in)
                None if c.fan.as_ref().and_then(|f| rpm_now.get(f)).is_some_and(|v| *v < 1.0) => c.hidden = true,
                None => {}
            }
        }
        let _ = st.file.save();
        st.probe.running = false;
        st.probe.done = true;
        st.probe.current = None;
        self.sent.clear();
        self.engine.reset();
        self.hub.cv.notify_all();
        Ok(())
    }

    /// Hands every control back and stops the helper (it releases them with SetDefault before it exits).
    fn hand_back(&mut self) {
        if let Some(c) = self.client.take() {
            install::stop(Some(c));
        }
        self.sent.clear();
        self.engine.reset();
        self.set_connected(false, "");
    }
}
