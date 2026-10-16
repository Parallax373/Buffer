//! Moves an app to another output (EarTrumpet's "app's device"): Windows' own per-app default endpoint, the one
//! Settings › Sound › Volume mixer sets, through the undocumented factory "Windows.Media.Internal.AudioPolicyConfig".
//! Windows keeps it per app (its exe), so it survives restarts; an app pinned there no longer follows the default
//! output. The call needs a running process (it takes a pid), so an app that is not playing can only be unpinned
//! the next time it runs (`Pin::unpin`).
//!
//! Vtable (IInspectable's 6, then 19 placeholder slots, as EarTrumpet maps it): SetPersistedDefaultAudioEndpoint
//! (25), GetPersistedDefaultAudioEndpoint (26). The interface id changed in Windows 10 21H2; both are tried.

use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use windows::core::{GUID, HSTRING};

// raw-dylib, as the windows crates link: no import library from a Windows SDK is needed
#[link(name = "api-ms-win-core-winrt-l1-1-0.dll", kind = "raw-dylib", modifiers = "+verbatim")]
extern "system" {
    fn RoGetActivationFactory(class: *mut c_void, iid: *const GUID, factory: *mut *mut c_void) -> i32;
}

const IIDS: [GUID; 2] = [
    GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324), // Windows 10 21H2 and later
    GUID::from_u128(0x2a59116d_6c4f_45e0_a74f_707e3fef9258), // earlier
];
type SetFn = unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut c_void) -> i32;
type GetFn = unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut *mut c_void) -> i32;
type ReleaseFn = unsafe extern "system" fn(*mut c_void) -> u32;

/// eRender, and the two roles a player uses (eConsole, eMultimedia); communications stays the user's.
const RENDER: i32 = 0;
const ROLES: [i32; 2] = [0, 1];
/// The device-interface class of audio outputs: Windows wants the endpoint id inside a full interface path.
const RENDER_IFACE: &str = "{e6327cad-dcec-4949-ae8a-991e976a79d2}";

struct Factory(*mut c_void);

impl Factory {
    fn get() -> Option<Factory> {
        let _ = wasapi::initialize_mta();
        let name = HSTRING::from("Windows.Media.Internal.AudioPolicyConfig");
        for iid in IIDS {
            let mut f: *mut c_void = std::ptr::null_mut();
            let hr = unsafe { RoGetActivationFactory(std::mem::transmute_copy(&name), &iid, &mut f) };
            if hr >= 0 && !f.is_null() {
                return Some(Factory(f));
            }
        }
        None
    }
    fn slot(&self, i: usize) -> usize {
        unsafe { *(*(self.0 as *const *const usize)).add(i) }
    }
}

impl Drop for Factory {
    fn drop(&mut self) {
        unsafe {
            let release: ReleaseFn = std::mem::transmute(self.slot(2));
            release(self.0);
        }
    }
}

fn full_id(dev: &str) -> String {
    format!(r"\\?\SWD#MMDEVAPI#{dev}#{RENDER_IFACE}")
}

/// "\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{guid}#{class}" -> "{0.0.0.00000000}.{guid}".
fn short_id(full: &str) -> Option<String> {
    let s = full.split("MMDEVAPI#").nth(1)?.split('#').next()?;
    (!s.is_empty()).then(|| s.to_string())
}

/// Sends these processes (one app) to `dev`, or back to the default output with `None`.
pub fn set_app_output(pids: &[u32], dev: Option<&str>) -> Result<(), String> {
    let f = Factory::get().ok_or("this Windows has no per-app output")?;
    let id = dev.map(|d| HSTRING::from(full_id(d)));
    let raw: *mut c_void = id.as_ref().map(|h| unsafe { std::mem::transmute_copy(h) }).unwrap_or(std::ptr::null_mut());
    let set: SetFn = unsafe { std::mem::transmute(f.slot(25)) };
    let mut last = 0;
    for &pid in pids {
        for role in ROLES {
            let hr = unsafe { set(f.0, pid, RENDER, role, raw) };
            if hr < 0 {
                last = hr;
            }
        }
    }
    if last < 0 { Err(format!("SetPersistedDefaultAudioEndpoint failed (0x{last:08x})")) } else { Ok(()) }
}

/// The output this process is pinned to, if any (tests; the mixer asks for many at once with `app_outputs`).
#[cfg_attr(not(test), allow(dead_code))]
pub fn app_output(pid: u32) -> Option<String> {
    let f = Factory::get()?;
    let get: GetFn = unsafe { std::mem::transmute(f.slot(26)) };
    let mut out: *mut c_void = std::ptr::null_mut();
    let hr = unsafe { get(f.0, pid, RENDER, 1, &mut out) };
    if hr < 0 || out.is_null() {
        return None;
    }
    // takes ownership of the returned string (freed on drop)
    let h: HSTRING = unsafe { std::mem::transmute(out) };
    short_id(&h.to_string())
}

/// `app_output` for several processes with one factory (the page asks for every app on each poll).
pub fn app_outputs(pids: &[u32]) -> Vec<Option<String>> {
    let Some(f) = Factory::get() else { return vec![None; pids.len()] };
    let get: GetFn = unsafe { std::mem::transmute(f.slot(26)) };
    pids.iter()
        .map(|&pid| {
            if pid == 0 {
                return None;
            }
            let mut out: *mut c_void = std::ptr::null_mut();
            let hr = unsafe { get(f.0, pid, RENDER, 1, &mut out) };
            if hr < 0 || out.is_null() {
                return None;
            }
            let h: HSTRING = unsafe { std::mem::transmute(out) };
            short_id(&h.to_string())
        })
        .collect()
}

/// An app Buffer pinned to an output, remembered so the page can list it while it isn't playing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Pin {
    /// The mixer's app key (lower-case exe path).
    pub key: String,
    pub name: String,
    pub icon: String,
    pub dev: String,
    /// Unpinned while not running: cleared in Windows the next time it plays.
    pub unpin: bool,
}

fn pins_path() -> std::path::PathBuf {
    crate::config::data_dir().join("pins.json")
}

pub fn pins() -> Vec<Pin> {
    std::fs::read(pins_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_pins(p: &[Pin]) {
    let _ = std::fs::create_dir_all(crate::config::data_dir());
    if let Ok(b) = serde_json::to_vec_pretty(p) {
        let _ = std::fs::write(pins_path(), b);
    }
}

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Moves a running app (all its processes) to `to`; dropping it on the default output unpins it.
pub fn move_app(app: &crate::mixer::App, to: &str) -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    let default = crate::endpoints::default_output().unwrap_or_default();
    let back = to == default;
    set_app_output(&app.pids, if back { None } else { Some(to) })?;
    let mut p = pins();
    p.retain(|x| x.key != app.key);
    if !back {
        p.push(Pin { key: app.key.clone(), name: app.name.clone(), icon: app.icon.clone(), dev: to.to_string(), unpin: false });
    }
    save_pins(&p);
    Ok(())
}

/// Unpins an app: at once when it runs, else the next time it does.
pub fn unpin(key: &str, running: Option<&crate::mixer::App>) -> Result<(), String> {
    let _g = LOCK.lock().unwrap();
    let mut p = pins();
    match running {
        Some(app) => {
            set_app_output(&app.pids, None)?;
            p.retain(|x| x.key != key);
        }
        None => p.iter_mut().filter(|x| x.key == key).for_each(|x| x.unpin = true),
    }
    save_pins(&p);
    Ok(())
}

/// Clears the pins that were unpinned while their app was closed, now that it runs (`devs` = a fresh snapshot).
pub fn settle(devs: &[crate::mixer::Dev]) {
    let pending: Vec<Pin> = pins().into_iter().filter(|p| p.unpin).collect();
    for p in pending {
        if let Some(app) = devs.iter().flat_map(|d| d.apps.iter()).find(|a| a.key == p.key) {
            let _ = unpin(&p.key, Some(app));
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn endpoint_ids_round_trip_through_the_interface_path() {
        let id = "{0.0.0.00000000}.{8c6e580a-1474-4b65-ad7e-b0a55dabd588}";
        let full = super::full_id(id);
        assert!(full.starts_with(r"\\?\SWD#MMDEVAPI#{0.0.0.00000000}."));
        assert_eq!(super::short_id(&full).as_deref(), Some(id));
        assert_eq!(super::short_id(""), None);
    }

    /// On a real machine: `cargo test -p ml-recorder appdev -- --ignored --nocapture`. The factory loads.
    #[test]
    #[ignore]
    fn factory_is_there() {
        assert!(super::Factory::get().is_some());
        println!("pinned output of this process: {:?}", super::app_output(std::process::id()));
    }
}
