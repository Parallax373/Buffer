//! Equalizer APO on this machine: where its config lives, whether our include is hooked in, and which endpoints
//! it is attached to. Measured on a real install (2026-10-16): the config folder is writable by Users, the audio
//! engine cannot read files under the user profile, and `Device: {endpoint guid}` scopes the lines below it.

use serde::Serialize;
use std::path::PathBuf;
use std::time::SystemTime;

/// Our file, next to APO's config.txt (the audio engine reads it there).
pub const FILE: &str = "buffer.txt";
const LINE: &str = "Include: buffer.txt";
const CLSID: &str = "EACD2258-FCAC-4FF4-B36D-419E924A6D79";

/// The config APO installs with: -6 dB preamp, the example include and a flat graphic EQ. It only makes things
/// quieter, so hooking in replaces it instead of keeping it.
fn is_stock(config: &str) -> bool {
    let lines: Vec<&str> = config.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines.len() == 3
        && lines[0].eq_ignore_ascii_case("Preamp: -6 dB")
        && lines[1].eq_ignore_ascii_case("Include: example.txt")
        && lines[2].starts_with("GraphicEQ: 25 0; 40 0;")
        && lines[2].split(';').all(|p| p.trim().ends_with(" 0"))
}

fn is_ours(line: &str) -> bool {
    line.trim().eq_ignore_ascii_case(LINE)
}

/// `config.txt` with our include, or `None` when it is already there (idempotent).
pub fn with_include(config: &str) -> Option<String> {
    if config.lines().any(is_ours) {
        return None;
    }
    if is_stock(config) {
        return Some(format!("{LINE}\r\n"));
    }
    let mut out = config.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str("\r\n");
    }
    out.push_str(LINE);
    out.push_str("\r\n");
    Some(out)
}

/// `config.txt` without our include (uninstall); every other line stays as it was.
pub fn without_include(config: &str) -> String {
    config.split_inclusive('\n').filter(|l| !is_ours(l)).collect()
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    pub installed: bool,
    pub config_dir: Option<PathBuf>,
    pub install_dir: Option<PathBuf>,
    /// our include line is in config.txt
    pub hooked: bool,
    /// endpoint guids (`{...}`, lower case) APO is attached to, render and capture
    pub devices: Vec<String>,
    /// APO was installed, or attached to a device, after Windows last started: the audio engine may not have
    /// loaded it yet. A hint, not a proof (restarting the audio service is enough too).
    pub restart_pending: bool,
}

pub fn status() -> Status {
    let Some(dir) = config_dir() else { return Status::default() };
    let hooked = std::fs::read_to_string(dir.join("config.txt")).map(|c| c.lines().any(is_ours)).unwrap_or(false);
    let install_dir = reg::string(r"SOFTWARE\EqualizerAPO", "InstallPath").map(PathBuf::from);
    let (devices, newest) = attached_devices();
    let boot = boot_time();
    let installed_at = install_dir.as_ref().and_then(|d| std::fs::metadata(d).ok()?.created().ok());
    let restart_pending = boot.is_some_and(|b| installed_at.is_some_and(|t| t > b) || newest.is_some_and(|t| t > b));
    Status { installed: true, install_dir, config_dir: Some(dir), hooked, devices, restart_pending }
}

/// When Windows last started (now minus the uptime).
fn boot_time() -> Option<SystemTime> {
    SystemTime::now().checked_sub(reg::uptime())
}

pub fn config_dir() -> Option<PathBuf> {
    reg::string(r"SOFTWARE\EqualizerAPO", "ConfigPath").map(PathBuf::from).filter(|p| p.is_dir())
}

pub fn include_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(FILE))
}

/// `config.txt` as bytes with our include added: `Ok(None)` when it is already there. The user's own lines are never
/// rewritten: a file that is not UTF-8 (a Windows code page: an accented letter in a comment or a path) only gets
/// our line appended, and UTF-16 is refused, because an ASCII line appended to it would corrupt it.
pub fn with_include_bytes(config: &[u8]) -> Result<Option<Vec<u8>>, String> {
    if let Ok(text) = std::str::from_utf8(config) {
        return Ok(with_include(text).map(String::into_bytes));
    }
    if config.starts_with(&[0xFF, 0xFE]) || config.starts_with(&[0xFE, 0xFF]) {
        return Err("config.txt is UTF-16: add the line `Include: buffer.txt` to it yourself".into());
    }
    if config.windows(LINE.len()).any(|w| w.eq_ignore_ascii_case(LINE.as_bytes())) {
        return Ok(None);
    }
    let mut out = config.to_vec();
    if !out.ends_with(b"\n") {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(LINE.as_bytes());
    out.extend_from_slice(b"\r\n");
    Ok(Some(out))
}

/// Adds our include to config.txt (once). Needs no elevation: APO's installer gives Users write access. A config that
/// cannot be read is an error, never "empty": writing over it would throw the user's own setup away.
pub fn hook() -> std::io::Result<()> {
    let dir = config_dir().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "Equalizer APO is not installed"))?;
    let path = dir.join("config.txt");
    let cur = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    match with_include_bytes(&cur).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))? {
        Some(new) => crate::write_atomic(&path, &new),
        None => Ok(()),
    }
}

pub fn unhook() -> std::io::Result<()> {
    let Some(dir) = config_dir() else { return Ok(()) };
    let path = dir.join("config.txt");
    if let Ok(cur) = std::fs::read_to_string(&path) {
        crate::write_atomic(&path, without_include(&cur).as_bytes())?;
    }
    let _ = std::fs::remove_file(dir.join(FILE));
    Ok(())
}

/// A REG_SZ value under HKLM (an endpoint property that Windows stores as plain text).
pub fn hklm_string(key: &str, value: &str) -> Option<String> {
    reg::string(key, value)
}

/// A REG_BINARY value under HKLM (endpoint properties for the recorder's mic-listen check).
pub fn hklm_binary(key: &str, value: &str) -> Option<Vec<u8>> {
    reg::binary(key, value)
}

/// Endpoints APO is attached to, and when the newest of those attachments was written.
fn attached_devices() -> (Vec<String>, Option<SystemTime>) {
    let mut out = Vec::new();
    let mut newest: Option<SystemTime> = None;
    for kind in ["Render", "Capture"] {
        let base = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\{kind}");
        for guid in reg::subkeys(&base) {
            let fx = format!(r"{base}\{guid}\FxProperties");
            if reg::any_value_contains(&fx, CLSID) {
                out.push(guid.to_ascii_lowercase());
                if let Some(t) = reg::written(&fx) {
                    newest = Some(newest.map_or(t, |n| n.max(t)));
                }
            }
        }
    }
    (out, newest)
}

/// True when APO is attached to the endpoint with this WASAPI id (`{0.0.0.00000000}.{guid}`).
pub fn attached(status: &Status, endpoint_id: &str) -> bool {
    let guid = endpoint_id.rsplit_once("}.").map(|(_, g)| g).unwrap_or(endpoint_id).to_ascii_lowercase();
    status.devices.iter().any(|d| *d == guid)
}

#[cfg(windows)]
mod reg {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegEnumValueW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        KEY_WOW64_64KEY, RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn string(key: &str, value: &str) -> Option<String> {
        let mut buf = vec![0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                wide(key).as_ptr(),
                wide(value).as_ptr(),
                RRF_RT_REG_SZ | 0x0001_0000, // RRF_SUBKEY_WOW6464KEY
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if rc != 0 {
            return None;
        }
        buf.truncate((len as usize / 2).saturating_sub(1));
        Some(String::from_utf16_lossy(&buf))
    }

    /// Last write time of a key.
    pub fn written(key: &str) -> Option<std::time::SystemTime> {
        use windows_sys::Win32::{Foundation::FILETIME, System::Registry::RegQueryInfoKeyW};
        let h = open(key)?;
        let mut ft = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let n = std::ptr::null_mut();
        let rc = unsafe { RegQueryInfoKeyW(h, std::ptr::null_mut(), n, std::ptr::null(), n, n, n, n, n, n, n, &mut ft) };
        unsafe { RegCloseKey(h) };
        if rc != 0 {
            return None;
        }
        // FILETIME: 100 ns ticks since 1601-01-01
        let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
        let unix = ticks.checked_sub(116_444_736_000_000_000)? / 10;
        Some(std::time::UNIX_EPOCH + std::time::Duration::from_micros(unix))
    }

    pub fn uptime() -> std::time::Duration {
        std::time::Duration::from_millis(unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() })
    }

    pub fn binary(key: &str, value: &str) -> Option<Vec<u8>> {
        let mut buf = vec![0u8; 4096];
        let mut len = buf.len() as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                wide(key).as_ptr(),
                wide(value).as_ptr(),
                RRF_RT_REG_BINARY | 0x0001_0000,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut len,
            )
        };
        (rc == 0).then(|| {
            buf.truncate(len as usize);
            buf
        })
    }

    fn open(key: &str) -> Option<HKEY> {
        let mut h: HKEY = std::ptr::null_mut();
        let rc = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, wide(key).as_ptr(), 0, KEY_READ | KEY_WOW64_64KEY, &mut h) };
        (rc == 0).then_some(h)
    }

    pub fn subkeys(key: &str) -> Vec<String> {
        let Some(h) = open(key) else { return Vec::new() };
        let mut out = Vec::new();
        for i in 0.. {
            let mut name = [0u16; 256];
            let mut len = name.len() as u32;
            let rc = unsafe {
                RegEnumKeyExW(h, i, name.as_mut_ptr(), &mut len, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut())
            };
            if rc != 0 {
                break;
            }
            out.push(String::from_utf16_lossy(&name[..len as usize]));
        }
        unsafe { RegCloseKey(h) };
        out
    }

    /// Some value of the key holds `needle` (case-insensitive) as UTF-16 text.
    pub fn any_value_contains(key: &str, needle: &str) -> bool {
        let Some(h) = open(key) else { return false };
        let needle = needle.to_ascii_lowercase();
        let mut found = false;
        for i in 0.. {
            let mut name = [0u16; 256];
            let mut name_len = name.len() as u32;
            let mut data = vec![0u8; 4096];
            let mut data_len = data.len() as u32;
            let rc = unsafe {
                RegEnumValueW(h, i, name.as_mut_ptr(), &mut name_len, std::ptr::null(), std::ptr::null_mut(), data.as_mut_ptr(), &mut data_len)
            };
            if rc == 234 {
                continue; // ERROR_MORE_DATA: a large binary blob, not a CLSID string
            }
            if rc != 0 {
                break;
            }
            let words: Vec<u16> = data[..data_len as usize].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            if String::from_utf16_lossy(&words).to_ascii_lowercase().contains(&needle) {
                found = true;
                break;
            }
        }
        unsafe { RegCloseKey(h) };
        found
    }
}

#[cfg(not(windows))]
mod reg {
    pub fn string(_: &str, _: &str) -> Option<String> {
        None
    }
    pub fn binary(_: &str, _: &str) -> Option<Vec<u8>> {
        None
    }
    pub fn written(_: &str) -> Option<std::time::SystemTime> {
        None
    }
    pub fn uptime() -> std::time::Duration {
        std::time::Duration::ZERO
    }
    pub fn subkeys(_: &str) -> Vec<String> {
        Vec::new()
    }
    pub fn any_value_contains(_: &str, _: &str) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STOCK: &str = "Preamp: -6 dB\r\nInclude: example.txt\r\nGraphicEQ: 25 0; 40 0; 63 0; 100 0; 160 0; 250 0; 400 0; 630 0; 1000 0; 1600 0; 2500 0; 4000 0; 6300 0; 10000 0; 16000 0";

    #[test]
    fn stock_config_is_replaced() {
        assert_eq!(with_include(STOCK).unwrap(), "Include: buffer.txt\r\n");
    }

    #[test]
    fn own_config_is_kept_and_include_added_once() {
        let base = "Preamp: -3 dB\r\nInclude: mine.txt";
        let once = with_include(base).unwrap();
        assert_eq!(once, "Preamp: -3 dB\r\nInclude: mine.txt\r\nInclude: buffer.txt\r\n");
        assert_eq!(with_include(&once), None);
        assert_eq!(without_include(&once), "Preamp: -3 dB\r\nInclude: mine.txt\r\n");
    }

    #[test]
    fn an_ansi_config_is_appended_to_never_rewritten() {
        // "Filtr ł" in Windows-1250: 0xB3 is not valid UTF-8
        let ansi: Vec<u8> = b"# \xB3\xF3d\xBC\r\nPreamp: -3 dB".to_vec();
        let out = with_include_bytes(&ansi).unwrap().unwrap();
        assert!(out.starts_with(&ansi), "the user's bytes are untouched");
        assert!(out.ends_with(b"\r\nInclude: buffer.txt\r\n"));
        assert_eq!(with_include_bytes(&out).unwrap(), None, "second time: nothing to do");
    }

    #[test]
    fn a_utf16_config_is_refused() {
        let utf16 = [0xFF, 0xFE, b'P', 0, b'r', 0];
        assert!(with_include_bytes(&utf16).is_err());
    }

    #[test]
    fn tweaked_stock_is_not_stock() {
        assert!(!is_stock(&STOCK.replace("1000 0", "1000 3")));
    }

    /// `cargo test -p ml-eq -- --ignored --nocapture` on a machine with APO: prints what was detected.
    #[test]
    #[ignore]
    fn print_local_status() {
        println!("{:#?}", status());
    }

    #[test]
    fn attached_matches_endpoint_ids() {
        let st = Status { devices: vec!["{51828c0d-bfff-4a01-b3e8-140a4b0ec4bc}".into()], ..Default::default() };
        assert!(attached(&st, "{0.0.0.00000000}.{51828C0D-BFFF-4A01-B3E8-140A4B0EC4BC}"));
        assert!(!attached(&st, "{0.0.0.00000000}.{aaaa}"));
    }
}
