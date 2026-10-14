//! WASAPI capture of one audio source (loopback of a playback device, or a microphone).
//! The recorder owns capture so it can meter levels and notice device loss itself.

use crate::config::{DeviceRef, SourceCfg};
use crate::pick::{self, Endpoint, Role};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use wasapi::{DeviceEnumerator, Direction, Role as WinRole, SampleType, StreamMode, WaveFormat};

/// Config value meaning "whichever device Windows currently uses" (speakers, headset, ...).
pub const FOLLOW_DEFAULT: &str = "@default";
pub const RATE: u32 = 48_000;
/// Bytes per frame of the interleaved stereo f32 stream sent to ffmpeg.
pub const FRAME_BYTES: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Capture what a playback device is playing.
    Loopback,
    Microphone,
}

pub struct Sink {
    pub name: &'static str,
    pub kind: Kind,
    /// The configured primary/secondary device. Only changes when the user changes settings.
    pub cfg: Mutex<SourceCfg>,
    /// Substring used to guess a device by name on a fresh, unconfigured install.
    pub name_hint: &'static str,
    pub buf: Mutex<VecDeque<u8>>,
    /// Peak of the last chunk, in thousandths of full scale.
    pub level: AtomicU32,
    pub live: AtomicBool,
    pub device_name: Mutex<String>,
    pub role: Mutex<&'static str>,
    pub status: Mutex<String>,
    /// Bumped when the configuration changes so the capture thread re-evaluates immediately.
    pub generation: AtomicU32,
}

impl Sink {
    pub fn new(name: &'static str, kind: Kind, name_hint: &'static str) -> Arc<Sink> {
        Arc::new(Sink {
            name,
            kind,
            cfg: Mutex::new(SourceCfg::default()),
            name_hint,
            buf: Mutex::new(VecDeque::new()),
            level: AtomicU32::new(0),
            live: AtomicBool::new(false),
            device_name: Mutex::new(String::new()),
            role: Mutex::new("waiting"),
            status: Mutex::new("starting".into()),
            generation: AtomicU32::new(0),
        })
    }

    /// Applies new settings; the capture thread follows only if something actually changed.
    pub fn set_cfg(&self, new: SourceCfg) {
        let mut cur = self.cfg.lock().unwrap();
        if *cur != new {
            *cur = new;
            self.generation.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn set_status(&self, live: bool, text: impl Into<String>) {
        self.live.store(live, Ordering::Relaxed);
        *self.status.lock().unwrap() = text.into();
    }

    fn direction(&self) -> Direction {
        match self.kind {
            Kind::Loopback => Direction::Render,
            Kind::Microphone => Direction::Capture,
        }
    }
}

/// Active endpoints of one direction.
pub fn list_endpoints(en: &DeviceEnumerator, dir: &Direction) -> Vec<Endpoint> {
    let mut out = Vec::new();
    if let Ok(coll) = en.get_device_collection(dir) {
        for d in &coll {
            if let Ok(d) = d {
                out.push(Endpoint {
                    id: d.get_id().unwrap_or_default(),
                    name: d.get_friendlyname().unwrap_or_default(),
                });
            }
        }
    }
    out
}

/// A first-run guess: a playback device whose name contains the hint, else the Windows default.
fn auto_guess(en: &DeviceEnumerator, sink: &Sink, list: &[Endpoint]) -> Option<Endpoint> {
    if sink.kind == Kind::Loopback && !sink.name_hint.is_empty() {
        let hint = sink.name_hint.to_lowercase();
        if let Some(e) = list.iter().find(|e| e.name.to_lowercase().contains(&hint)) {
            return Some(e.clone());
        }
    }
    let role = if sink.name == "Chat" { WinRole::Communications } else { WinRole::Console };
    let d = en.get_default_device_for_role(&sink.direction(), &role).ok()?;
    Some(Endpoint { id: d.get_id().ok()?, name: d.get_friendlyname().ok()? })
}

fn default_endpoint(en: &DeviceEnumerator, dir: &Direction, communications: bool) -> Option<Endpoint> {
    let role = if communications { WinRole::Communications } else { WinRole::Console };
    let d = en.get_default_device_for_role(dir, &role).ok()?;
    Some(Endpoint { id: d.get_id().ok()?, name: d.get_friendlyname().ok()? })
}

/// Replaces the "follow the Windows default" marker with the device that is the default right now.
/// If Windows has no default, the marker becomes an id that matches nothing (the source waits).
fn materialize(cfg: &SourceCfg, en: &DeviceEnumerator, sink: &Sink) -> SourceCfg {
    let dir = sink.direction();
    let fix = |r: &Option<DeviceRef>| {
        r.as_ref().map(|d| {
            if d.id == FOLLOW_DEFAULT {
                match default_endpoint(en, &dir, sink.name == "Chat") {
                    Some(e) => DeviceRef { id: e.id, name: e.name },
                    None => DeviceRef { id: "@none".into(), name: String::new() },
                }
            } else {
                d.clone()
            }
        })
    };
    SourceCfg { primary: fix(&cfg.primary), secondary: fix(&cfg.secondary) }
}

/// Peak level (0..1) of one endpoint over `ms` milliseconds, for the settings meters. A playback device is
/// measured by loopback. Accepts "@default:render" / "@default:comm" / "@default:capture".
pub fn measure_peak(token: &str, ms: u64) -> f32 {
    let _ = wasapi::initialize_mta();
    let Ok(en) = DeviceEnumerator::new() else { return 0.0 };
    let id = match token {
        "@default:render" => default_endpoint(&en, &Direction::Render, false).map(|e| e.id),
        "@default:comm" => default_endpoint(&en, &Direction::Render, true).map(|e| e.id),
        "@default:capture" => default_endpoint(&en, &Direction::Capture, false).map(|e| e.id),
        other => Some(other.to_string()),
    };
    let Some(id) = id else { return 0.0 };
    let Ok(device) = en.get_device(&id) else { return 0.0 };
    let Ok(mut client) = device.get_iaudioclient() else { return 0.0 };
    let fmt = WaveFormat::new(32, 32, &SampleType::Float, RATE as usize, 2, None);
    let Ok((_, period)) = client.get_device_period() else { return 0.0 };
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: period.max(200_000) };
    if client.initialize_client(&fmt, &Direction::Capture, &mode).is_err() {
        return 0.0;
    }
    let (Ok(event), Ok(capture)) = (client.set_get_eventhandle(), client.get_audiocaptureclient()) else {
        return 0.0;
    };
    if client.start_stream().is_err() {
        return 0.0;
    }
    let mut scratch: VecDeque<u8> = VecDeque::new();
    let mut peak = 0f32;
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        let _ = event.wait_for_event(20);
        if capture.read_from_device_to_deque(&mut scratch).is_err() {
            break;
        }
        let bytes: Vec<u8> = scratch.drain(..).collect();
        for s in bytes.chunks_exact(4) {
            peak = peak.max(f32::from_le_bytes([s[0], s[1], s[2], s[3]]).abs());
        }
    }
    let _ = client.stop_stream();
    peak.min(1.0)
}

fn capture_once(sink: &Sink, stop: &AtomicBool) -> Result<(), String> {
    let generation = sink.generation.load(Ordering::Relaxed);
    let en = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let dir = sink.direction();
    let list = list_endpoints(&en, &dir);
    let raw_cfg = sink.cfg.lock().unwrap().clone();
    let cfg = materialize(&raw_cfg, &en, sink);
    let guess = auto_guess(&en, sink, &list);
    let (role, chosen) = pick::resolve(&cfg, &list, guess.as_ref());
    let follows_default =
        role == Role::Primary && raw_cfg.primary.as_ref().is_some_and(|d| d.id == FOLLOW_DEFAULT);
    let Some(chosen) = chosen else {
        *sink.role.lock().unwrap() = Role::Waiting.label();
        let wanted = cfg.primary.as_ref().map(|d| d.name.clone()).unwrap_or_default();
        return Err(format!("waiting for device {wanted}").trim().to_string());
    };

    let device = en.get_device(&chosen.id).map_err(|e| e.to_string())?;
    *sink.device_name.lock().unwrap() = chosen.name.clone();
    *sink.role.lock().unwrap() = if follows_default { "default" } else { role.label() };

    let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let fmt = WaveFormat::new(32, 32, &SampleType::Float, RATE as usize, 2, None);
    let (_, min_period) = client.get_device_period().map_err(|e| e.to_string())?;
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: min_period.max(200_000) };
    // For a playback device, Direction::Capture selects loopback.
    client.initialize_client(&fmt, &Direction::Capture, &mode).map_err(|e| e.to_string())?;
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;
    sink.set_status(true, "live");

    let mut scratch: VecDeque<u8> = VecDeque::new();
    let mut last_check = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        if sink.generation.load(Ordering::Relaxed) != generation {
            let _ = client.stop_stream();
            return Err("reconfigured".into());
        }
        // Once a second: would the rules pick a different device now (primary came back, or ours left)?
        if last_check.elapsed() >= Duration::from_secs(1) {
            last_check = Instant::now();
            let now = list_endpoints(&en, &dir);
            let guess = auto_guess(&en, sink, &now);
            let live_cfg = materialize(&sink.cfg.lock().unwrap().clone(), &en, sink);
            let (r, e) = pick::resolve(&live_cfg, &now, guess.as_ref());
            if r != role || e.map(|e| e.id) != Some(chosen.id.clone()) {
                let _ = client.stop_stream();
                return Err("reconfigured".into());
            }
        }
        // Loopback of a silent device delivers no packets, so poll on a short timeout.
        let _ = event.wait_for_event(20);
        capture.read_from_device_to_deque(&mut scratch).map_err(|e| e.to_string())?;
        if scratch.is_empty() {
            sink.level.store(0, Ordering::Relaxed);
            continue;
        }
        let bytes: Vec<u8> = scratch.drain(..).collect();
        let mut peak = 0f32;
        for s in bytes.chunks_exact(4) {
            let v = f32::from_le_bytes([s[0], s[1], s[2], s[3]]).abs();
            if v > peak {
                peak = v;
            }
        }
        sink.level.store((peak.min(1.0) * 1000.0) as u32, Ordering::Relaxed);
        let mut q = sink.buf.lock().unwrap();
        q.extend(bytes);
        // Never let the queue grow without bound if the feeder is not draining.
        let cap = RATE as usize * FRAME_BYTES * 2;
        if q.len() > cap {
            let drop = q.len() - cap;
            q.drain(..drop);
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

/// Runs forever: captures, and on any failure (device unplugged, driver reset) reports it and retries.
pub fn spawn_capture(sink: Arc<Sink>, stop: Arc<AtomicBool>) {
    thread::Builder::new()
        .name(format!("capture-{}", sink.name))
        .spawn(move || {
            let _ = wasapi::initialize_mta();
            while !stop.load(Ordering::Relaxed) {
                match capture_once(&sink, &stop) {
                    Ok(()) => break,
                    Err(e) if e == "reconfigured" => {}
                    Err(e) => {
                        sink.level.store(0, Ordering::Relaxed);
                        sink.set_status(false, format!("down: {e}"));
                        // Poll quickly while waiting so a reconnect is picked up within about a second.
                        let seen = sink.generation.load(Ordering::Relaxed);
                        for _ in 0..4 {
                            if stop.load(Ordering::Relaxed) || sink.generation.load(Ordering::Relaxed) != seen {
                                break;
                            }
                            thread::sleep(Duration::from_millis(250));
                        }
                    }
                }
            }
        })
        .expect("spawn capture thread");
}
