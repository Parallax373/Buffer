//! App side of the live EQ. State changes go through the recorder (`recorder_cmd "eq-set ..."`), which is the only
//! writer; this module only does what the window needs on its own: the live spectrum behind the curve, the AutoEQ
//! headphone search and installing Equalizer APO.

use ml_core::export::hide_window;
use std::{
    collections::VecDeque,
    f32::consts::PI,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tauri::ipc::{Channel, InvokeResponseBody};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

// ───────────────────────── spectrum ─────────────────────────

const N: usize = 4096;
const RATE: f32 = 48_000.0;
/// Log-spaced bins 20 Hz – 20 kHz sent per frame, one byte each (0 = -90 dBFS, 255 = 0 dBFS).
pub const BINS: usize = 160;
/// Every start bumps this; a running capture whose number is old stops by itself.
static SPECTRUM_RUN: AtomicU64 = AtomicU64::new(0);

/// In-place radix-2 FFT (N is a power of two).
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
        len <<= 1;
    }
}

/// One frame of mono samples (len N) -> BINS bytes.
pub fn analyse(samples: &[f32], window: &[f32]) -> Vec<u8> {
    let mut re: Vec<f32> = samples.iter().zip(window).map(|(s, w)| s * w).collect();
    let mut im = vec![0.0; N];
    fft(&mut re, &mut im);
    // a full-scale sine through a Hann window peaks at N/4
    let norm = 4.0 / N as f32;
    let mag: Vec<f32> = (0..N / 2).map(|i| (re[i] * re[i] + im[i] * im[i]).sqrt() * norm).collect();
    (0..BINS)
        .map(|b| {
            let f0 = 20.0 * 1000f32.powf(b as f32 / BINS as f32);
            let f1 = 20.0 * 1000f32.powf((b + 1) as f32 / BINS as f32);
            let (i0, i1) = ((f0 / RATE * N as f32) as usize, ((f1 / RATE * N as f32).ceil() as usize).max(1));
            let peak = mag[i0.min(N / 2 - 1)..i1.clamp(i0 + 1, N / 2)].iter().copied().fold(0.0, f32::max);
            let db = 20.0 * peak.max(1e-6).log10();
            (((db + 90.0) / 90.0).clamp(0.0, 1.0) * 255.0) as u8
        })
        .collect()
}

fn run_spectrum(run: u64, device_id: &str, out: &Channel) -> Result<(), String> {
    let _ = wasapi::initialize_mta();
    let en = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = en.get_device(device_id).map_err(|e| e.to_string())?;
    let mut client = device.get_iaudioclient().map_err(|e| e.to_string())?;
    let fmt = WaveFormat::new(32, 32, &SampleType::Float, RATE as usize, 2, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
    // a playback device opened for capture is a loopback of what it plays (after APO: the EQ is visible)
    client.initialize_client(&fmt, &Direction::Capture, &mode).map_err(|e| e.to_string())?;
    let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
    let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
    client.start_stream().map_err(|e| e.to_string())?;
    let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / N as f32).cos()).collect();
    let mut raw: VecDeque<u8> = VecDeque::new();
    let mut mono: VecDeque<f32> = VecDeque::with_capacity(N * 2);
    let mut last = Instant::now();
    let mut last_data = Instant::now();
    let silent = vec![0u8; BINS];
    while SPECTRUM_RUN.load(Ordering::Relaxed) == run {
        let _ = event.wait_for_event(50);
        if capture.read_from_device_to_deque(&mut raw).is_err() {
            break;
        }
        if !raw.is_empty() {
            last_data = Instant::now();
        }
        while raw.len() >= 8 {
            let b: Vec<u8> = raw.drain(..8).collect();
            let l = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            let r = f32::from_le_bytes([b[4], b[5], b[6], b[7]]);
            mono.push_back((l + r) * 0.5);
        }
        while mono.len() > N {
            mono.pop_front();
        }
        // ~30 frames a second; a loopback delivers nothing while silent, so send silence then
        if last.elapsed() >= Duration::from_millis(33) {
            last = Instant::now();
            let frame = if mono.len() == N {
                let s: Vec<f32> = mono.iter().copied().collect();
                analyse(&s, &window)
            } else {
                silent.clone()
            };
            if out.send(InvokeResponseBody::Raw(frame)).is_err() {
                break;
            }
            if last_data.elapsed() > Duration::from_millis(100) {
                // a loopback delivers nothing while silent: let the last sound fade instead of freezing on it
                mono.iter_mut().for_each(|s| *s *= 0.5);
            }
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

/// Streams spectrum frames of an endpoint (loopback for an output, the mic itself for a capture device) until
/// `eq_spectrum_stop` or another start. Costs nothing while the EQ page is closed.
#[tauri::command]
pub fn eq_spectrum_start(device: String, frames: Channel) {
    let run = SPECTRUM_RUN.fetch_add(1, Ordering::Relaxed) + 1;
    std::thread::spawn(move || {
        let _ = run_spectrum(run, &device, &frames);
    });
}

#[tauri::command]
pub fn eq_spectrum_stop() {
    SPECTRUM_RUN.fetch_add(1, Ordering::Relaxed);
}

// ───────────────────────── AutoEQ ─────────────────────────

const AUTOEQ: &str = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results";

fn curl(url: &str) -> Result<Vec<u8>, String> {
    curl_for(url, 30)
}

fn curl_for(url: &str, secs: u32) -> Result<Vec<u8>, String> {
    let mut c = Command::new("curl.exe");
    c.args(["-sL", "--fail", "--max-time", &secs.to_string(), url]);
    hide_window(&mut c);
    let o = c.output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!("download failed ({url})"));
    }
    Ok(o.stdout)
}

fn cache_dir() -> PathBuf {
    crate::local_dir().join("eq")
}

/// `[name](./path) by source on rig` lines of AutoEQ's INDEX.md -> (name, path, source).
pub fn parse_index(md: &str) -> Vec<(String, String, String)> {
    md.lines()
        .filter_map(|l| {
            let l = l.strip_prefix("- [")?;
            let (name, rest) = l.split_once("](./")?;
            // names like "Aero (ANC Off)" keep their brackets unencoded in the path: cut at the link's own ")"
            let end = rest.rfind(") by ").or_else(|| rest.rfind(')'))?;
            let (path, rest) = (&rest[..end], &rest[end + 1..]);
            let source = rest.trim().strip_prefix("by ").unwrap_or("").split(" on ").next().unwrap_or("").to_string();
            Some((name.to_string(), path.to_string(), source))
        })
        .collect()
}

fn index() -> Result<Vec<(String, String, String)>, String> {
    let path = cache_dir().join("autoeq-index.md");
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .is_ok_and(|t| t.elapsed().unwrap_or_default() < Duration::from_secs(7 * 24 * 3600));
    let md = match fresh.then(|| std::fs::read_to_string(&path).ok()).flatten() {
        Some(md) => md,
        None => {
            let md = String::from_utf8_lossy(&curl(&format!("{AUTOEQ}/INDEX.md"))?).into_owned();
            let _ = std::fs::create_dir_all(cache_dir());
            let _ = std::fs::write(&path, &md);
            md
        }
    };
    Ok(parse_index(&md))
}

#[derive(serde::Serialize)]
pub struct Hit {
    name: String,
    source: String,
    path: String,
}

/// Headphones whose name holds every word of the query (case-insensitive), best (shortest) names first.
#[tauri::command]
pub async fn eq_autoeq_search(query: String) -> Result<Vec<Hit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits: Vec<Hit> = index()?
            .into_iter()
            .filter(|(n, _, _)| {
                let n = n.to_lowercase();
                words.iter().all(|w| n.contains(w.as_str()))
            })
            .map(|(name, path, source)| Hit { name, source, path })
            .collect();
        // the typed phrase as a whole ("arctis 5") beats the same words spread out ("Arctis Nova 5")
        let phrase = words.join(" ");
        hits.sort_by_key(|h| (!h.name.to_lowercase().contains(&phrase), h.name.len()));
        hits.truncate(30);
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads one profile (`path` as returned by the search) and parses it.
#[tauri::command]
pub async fn eq_autoeq_fetch(name: String, path: String) -> Result<ml_eq::Profile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let leaf = path.rsplit('/').next().unwrap_or("");
        let txt = curl(&format!("{AUTOEQ}/{path}/{leaf}%20ParametricEQ.txt"))?;
        ml_eq::autoeq::parse(&name, &String::from_utf8_lossy(&txt))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────── Equalizer APO ─────────────────────────

/// Pinned installer: checked against SourceForge's published hash on 2026-10-16.
const APO_URL: &str = "https://sourceforge.net/projects/equalizerapo/files/1.4.2/EqualizerAPO-x64-1.4.2.exe/download";
const APO_SHA256: &str = "7403be7427bbe1936a40dded082829b6e217fc4f5990fee5cba501f0ae055afa";

fn sha256(path: &std::path::Path) -> Result<String, String> {
    let mut c = Command::new("certutil");
    c.arg("-hashfile").arg(path).arg("SHA256");
    hide_window(&mut c);
    let o = c.output().map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .map(|l| l.replace(' ', "").to_lowercase())
        .find(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "cannot hash the installer".to_string())
}

/// Installed?, hooked?, which endpoints APO is attached to.
#[tauri::command]
pub fn eq_apo_status() -> ml_eq::apo::Status {
    ml_eq::apo::status()
}

/// What the EQ is for: every playback device that is plugged in, and the microphone (the one the Mic EQ is set to,
/// else the Windows default). Same ids as the rest of the app (`{0.0.0.00000000}.{guid}`).
fn wanted_endpoints() -> Vec<(ml_eq::apo::Kind, String)> {
    use ml_eq::apo::{guid_of, Kind};
    let _ = wasapi::initialize_mta();
    let Ok(en) = DeviceEnumerator::new() else { return Vec::new() };
    let mut out: Vec<(Kind, String)> = Vec::new();
    if let Ok(coll) = en.get_device_collection(&Direction::Render) {
        out.extend(coll.into_iter().flatten().filter_map(|d| d.get_id().ok()).map(|id| (Kind::Render, guid_of(&id))));
    }
    let chosen = ml_eq::EqState::load().mic_device;
    let mic = en
        .get_device(&chosen)
        .ok()
        .filter(|d| matches!(d.get_state(), Ok(wasapi::DeviceState::Active)))
        .and_then(|d| d.get_id().ok())
        .or_else(|| en.get_default_device_for_role(&Direction::Capture, &wasapi::Role::Console).ok()?.get_id().ok());
    if let Some(id) = mic {
        out.push((Kind::Capture, guid_of(&id)));
    }
    out.retain(|(_, g)| ml_eq::apo::is_guid(g));
    out.dedup();
    out
}

/// Runs the elevated setup script (one UAC prompt) and waits for it; its exit code says how it went.
fn run_elevated(script: &str) -> Result<(), String> {
    let mut c = Command::new("powershell");
    // The script travels inline (-EncodedCommand), never as a file anyone else could replace before it runs.
    c.args([
        "-NoProfile",
        "-Command",
        "try { $p = Start-Process -FilePath powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
         -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$env:BUFFER_APO_CMD; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 99 }",
    ])
    .env("BUFFER_APO_CMD", ml_eq::apo::encode_command(script));
    hide_window(&mut c);
    let o = c.output().map_err(|e| e.to_string())?;
    let code = o.status.code().unwrap_or(-1);
    if code == 99 {
        eprintln!("elevation: {}", String::from_utf8_lossy(&o.stderr));
    }
    match ml_eq::apo::exit_message(code) {
        None => Ok(()),
        Some(m) => Err(m.to_string()),
    }
}

/// The pinned installer in the cache, downloaded and hash-checked if needed.
fn apo_installer() -> Result<PathBuf, String> {
    let exe = cache_dir().join("EqualizerAPO-x64-1.4.2.exe");
    if sha256(&exe).ok().as_deref() != Some(APO_SHA256) {
        std::fs::create_dir_all(cache_dir()).map_err(|e| e.to_string())?;
        // 12 MB: a slow line needs far more than the 30 s a profile gets
        std::fs::write(&exe, curl_for(APO_URL, 600)?).map_err(|e| e.to_string())?;
        if sha256(&exe)? != APO_SHA256 {
            let _ = std::fs::remove_file(&exe);
            return Err("the downloaded installer does not match the expected hash".into());
        }
    }
    Ok(exe)
}

/// Gets Equalizer APO working for Buffer in one step: installs it if it is not there (no wizard, no device picker),
/// attaches it to the devices the EQ needs and restarts the Windows audio service so the engine loads it. One UAC
/// prompt; all or nothing. Without anything to do it returns at once, without a prompt.
fn apo_setup() -> Result<ml_eq::apo::Status, String> {
    apo_setup_with(&[])
}

fn apo_setup_with(extra: &[ml_eq::apo::Op]) -> Result<ml_eq::apo::Status, String> {
    let st = ml_eq::apo::status();
    let todo = ml_eq::apo::missing(&st, &wanted_endpoints());
    if st.installed && todo.is_empty() && extra.is_empty() {
        return Ok(st);
    }
    let mut ops = ml_eq::apo::plan_attach(&todo)?;
    ops.extend_from_slice(extra);
    let exe = if st.installed { None } else { Some(apo_installer()?) };
    // From the check below until the setup is done this handle stays open with only read sharing: nobody can change
    // or swap the installer in between, so what runs elevated is exactly what was hashed. (The elevated script
    // hashes it once more before it starts it.)
    let _hold = match &exe {
        Some(p) => {
            use std::os::windows::fs::OpenOptionsExt;
            let h = std::fs::OpenOptions::new().read(true).share_mode(1).open(p).map_err(|e| e.to_string())?; // FILE_SHARE_READ
            if sha256(p)? != APO_SHA256 {
                return Err("the installer on disk does not match the expected hash".into());
            }
            Some(h)
        }
        None => None,
    };
    run_elevated(&ml_eq::apo::setup_script(exe.as_deref(), APO_SHA256, &ops, None)?)?;
    let st = ml_eq::apo::status();
    if !st.installed {
        return Err("Equalizer APO is not installed".into());
    }
    Ok(st)
}

/// Downloads the pinned Equalizer APO installer (hash checked), installs it and attaches it to the devices the EQ
/// needs: a single UAC prompt, no installer pages, no device picker.
#[tauri::command]
pub async fn eq_install_apo() -> Result<ml_eq::apo::Status, String> {
    tauri::async_runtime::spawn_blocking(apo_setup).await.map_err(|e| e.to_string())?
}

/// Attaches an installed Equalizer APO to the devices the EQ needs (the "not active on this device" chip).
#[tauri::command]
pub async fn eq_attach_apo() -> Result<ml_eq::apo::Status, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if !ml_eq::apo::status().installed {
            return Err("Equalizer APO is not installed".to_string());
        }
        apo_setup()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real machine, real UAC prompt, real audio service restart: `cargo test -p buffer apo_ -- --ignored --nocapture
    /// --test-threads=1` on a PC WITHOUT Equalizer APO. The first test breaks the setup on purpose and expects the PC
    /// to be exactly as before; the second one is the real thing.
    #[test]
    #[ignore]
    fn apo_a_failed_setup_leaves_nothing_behind() {
        assert!(!ml_eq::apo::status().installed, "run this on a PC without Equalizer APO");
        let bogus = ml_eq::apo::Op::Sz(r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\{00000000-0000-0000-0000-000000000000}\FxProperties".into(), "x".into(), "y".into());
        let r = apo_setup_with(&[bogus]);
        println!("result: {r:?}");
        assert!(r.is_err());
        assert!(!ml_eq::apo::status().installed);
    }

    #[test]
    #[ignore]
    fn apo_setup_end_to_end() {
        assert!(!ml_eq::apo::status().installed, "run this on a PC without Equalizer APO");
        let st = apo_setup().expect("setup");
        println!("{st:#?}");
        assert!(st.installed);
        let want = wanted_endpoints();
        assert!(ml_eq::apo::missing(&st, &want).is_empty(), "still not attached: {:?}", ml_eq::apo::missing(&st, &want));
        // asking again changes nothing and shows no prompt
        assert!(apo_setup().is_ok());
    }

    #[test]
    fn sine_lands_in_its_bin() {
        let window: Vec<f32> = (0..N).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / N as f32).cos()).collect();
        let s: Vec<f32> = (0..N).map(|i| 0.5 * (2.0 * PI * 1000.0 * i as f32 / RATE).sin()).collect();
        let bins = analyse(&s, &window);
        let top = (0..BINS).max_by_key(|&b| bins[b]).unwrap();
        let f = 20.0 * 1000f32.powf((top as f32 + 0.5) / BINS as f32);
        assert!((900.0..1100.0).contains(&f), "peak bin at {f} Hz");
        // -6 dBFS sine -> about 84/90 of full scale
        assert!((230..=245).contains(&bins[top]), "{}", bins[top]);
        assert!(bins[BINS - 1] < 60, "far bins stay low: {}", bins[BINS - 1]);
    }

    #[test]
    fn index_lines_parse() {
        let md = "# Index\n\n- [SteelSeries Arctis 5 2019 Edition](./Rtings/HMS%20II.3%20over-ear/SteelSeries%20Arctis%205%202019%20Edition) by Rtings on HMS II.3\n- [1Custom SA02](./crinacle/711%20in-ear/1Custom%20SA02) by crinacle on 711\n";
        let v = parse_index(md);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].0, "SteelSeries Arctis 5 2019 Edition");
        assert_eq!(v[0].1, "Rtings/HMS%20II.3%20over-ear/SteelSeries%20Arctis%205%202019%20Edition");
        assert_eq!(v[0].2, "Rtings");
        let br = parse_index("- [1MORE Aero (ANC Off)](./HypetheSonics/GRAS%20RA0045%20in-ear/1MORE%20Aero%20(ANC%20Off)) by HypetheSonics on GRAS RA0045");
        assert_eq!(br[0].1, "HypetheSonics/GRAS%20RA0045%20in-ear/1MORE%20Aero%20(ANC%20Off)");
        assert_eq!(br[0].2, "HypetheSonics");
    }
}
