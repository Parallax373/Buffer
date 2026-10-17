//! Facts about the PC for the RGB lights: is the screen locked, how long has the user been idle, what time is it, and
//! which other lighting programs are running (they would fight over the same devices).

use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::SystemInformation::{GetLocalTime, GetTickCount};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::Foundation::CloseHandle;

/// Names (lower case) of every running process.
fn processes() -> Vec<String> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap as isize == -1 {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            out.push(String::from_utf16_lossy(&e.szExeFile[..n]).to_lowercase());
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    out
}

/// The lock screen runs as `LogonUI.exe` for as long as the session is locked.
pub fn locked(procs: &[String]) -> bool {
    procs.iter().any(|p| p == "logonui.exe")
}

/// Seconds since the last keyboard or mouse input.
pub fn idle_secs() -> u64 {
    unsafe {
        let mut i = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut i) == 0 {
            return 0;
        }
        (GetTickCount().wrapping_sub(i.dwTime) / 1000) as u64
    }
}

/// Minutes after local midnight.
pub fn minutes_now() -> u16 {
    unsafe {
        let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = std::mem::zeroed();
        GetLocalTime(&mut t);
        t.wHour * 60 + t.wMinute
    }
}

/// The other lighting programs among `procs`, each named once.
pub fn conflicts(procs: &[String]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for (exe, name) in ml_core::others::LIGHTING {
        if procs.iter().any(|p| p == exe) && !out.contains(name) {
            out.push(name);
        }
    }
    out
}

/// MSI Afterburner only fights over the fan when its own software curve is on (`SwAutoFanControl=1`: it rewrites the fan
/// speed every few seconds). Merely running, or with a fixed speed set once, it leaves the fan to others. A config that
/// cannot be read counts as controlling (the safe side).
fn afterburner_controls_fan(cfg: Option<&str>) -> bool {
    let Some(cfg) = cfg else { return true };
    cfg.lines().any(|l| l.trim().eq_ignore_ascii_case("SwAutoFanControl=1"))
}

fn afterburner_cfg() -> Option<String> {
    let pf = std::env::var_os("ProgramFiles(x86)").or_else(|| std::env::var_os("ProgramFiles"))?;
    std::fs::read_to_string(std::path::Path::new(&pf).join("MSI Afterburner").join("Profiles").join("MSIAfterburner.cfg")).ok()
}

/// The other fan programs among `procs`, each named once: (name, gpu_only).
pub fn fan_conflicts(procs: &[String]) -> Vec<(&'static str, bool)> {
    fan_conflicts_with(procs, || afterburner_controls_fan(afterburner_cfg().as_deref()))
}

fn fan_conflicts_with(procs: &[String], afterburner: impl Fn() -> bool) -> Vec<(&'static str, bool)> {
    let mut out: Vec<(&'static str, bool)> = Vec::new();
    for (exe, name, gpu) in ml_core::others::FANS {
        if *exe == "msiafterburner.exe" && procs.iter().any(|p| p == exe) && !afterburner() {
            continue;
        }
        if procs.iter().any(|p| p == exe) && !out.iter().any(|o| o.0 == *name) {
            out.push((name, *gpu));
        }
    }
    out
}

/// A cached view of the process list: refreshed at most every 2 s, shared by the lock check and the conflict check.
pub fn snapshot() -> Vec<String> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<(Instant, Vec<String>)>> = OnceLock::new();
    let c = CACHE.get_or_init(|| Mutex::new((Instant::now() - Duration::from_secs(60), Vec::new())));
    let mut g = c.lock().unwrap();
    if g.0.elapsed() > Duration::from_secs(2) {
        *g = (Instant::now(), processes());
    }
    g.1.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_each_other_program_once() {
        let p: Vec<String> = ["explorer.exe", "lghub.exe", "lghub_agent.exe", "signalrgb.exe"].iter().map(|s| s.to_string()).collect();
        assert_eq!(conflicts(&p), ["SignalRGB", "Logitech G HUB"]);
        assert!(conflicts(&["notepad.exe".to_string()]).is_empty());
        assert!(locked(&["logonui.exe".to_string()]) && !locked(&p));
    }

    #[test]
    fn fan_programs_are_told_apart_by_scope() {
        let p: Vec<String> = ["fancontrol.service.exe", "fancontrol.exe", "msiafterburner.exe"].iter().map(|s| s.to_string()).collect();
        assert_eq!(fan_conflicts_with(&p, || true), [("FanControl", false), ("MSI Afterburner", true)]);
        assert_eq!(fan_conflicts_with(&p, || false), [("FanControl", false)], "Afterburner without its software fan curve is no conflict");
        assert!(afterburner_controls_fan(Some("[Settings]\nSwAutoFanControl=1\n")));
        assert!(!afterburner_controls_fan(Some("[Settings]\nSwAutoFanControl=0\n")));
        assert!(afterburner_controls_fan(None), "unreadable config: assume it controls");
        assert!(fan_conflicts(&["explorer.exe".to_string()]).is_empty());
    }

    #[test]
    fn reads_the_clock_and_input() {
        assert!(minutes_now() < 24 * 60);
        let _ = idle_secs();
        assert!(!snapshot().is_empty(), "this test process itself is in the list");
    }
}
