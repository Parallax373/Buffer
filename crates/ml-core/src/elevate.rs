//! Shared pieces of the "install a helper into Program Files with one UAC prompt" flow (RGB and Fans use it):
//! pinned downloads held open while the elevated side re-checks them, the inline `-EncodedCommand` hand-over (never a
//! script file in a user folder) and the PawnIO driver facts.

use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

pub const NO_WINDOW: u32 = 0x0800_0000;

/// Official PawnIO installer (signed by namazso.eu). Silent flags as found in the installer: `-install -silent`.
pub const PAWNIO_URL: &str = "https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe";
pub const PAWNIO_SHA256: &str = "1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032";

pub fn run(program: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new(program).args(args).creation_flags(NO_WINDOW).output()
}

/// The PawnIO driver service exists (it is installed once and never removed by Buffer).
pub fn pawnio_present() -> bool {
    run("sc", &["query", "PawnIO"]).map(|o| o.status.success()).unwrap_or(false)
}

pub fn sha256(path: &Path) -> Result<String, String> {
    let o = Command::new("certutil").arg("-hashfile").arg(path).arg("SHA256").creation_flags(NO_WINDOW).output().map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&o.stdout)
        .lines()
        .map(|l| l.replace(' ', "").to_lowercase())
        .find(|l| l.len() == 64 && l.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "hash_failed".to_string())
}

/// Downloads `url` to `dest` and checks the hash. Returns the file held open for reading only, so it cannot be
/// swapped or rewritten until the guard is dropped. Errors are short codes the UI translates (`download_failed`,
/// `hash_mismatch`, `hash_failed`), like every error of the install flows built on this module.
pub fn fetch(url: &str, dest: &Path, sha: &str) -> Result<std::fs::File, String> {
    let _ = std::fs::remove_file(dest);
    let ok = Command::new("curl.exe")
        .args(["-sL", "--fail", "--max-time", "600", "-o"])
        .arg(dest)
        .arg(url)
        .creation_flags(NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?
        .success();
    if !ok {
        return Err("download_failed".into());
    }
    let hold = std::fs::OpenOptions::new().read(true).share_mode(1).open(dest).map_err(|e| e.to_string())?; // FILE_SHARE_READ
    if sha256(dest)? != sha {
        return Err("hash_mismatch".into());
    }
    Ok(hold)
}

/// Keeps a `true` answer for a while. Checking that a scheduled task exists starts `schtasks` (~40 ms) and the RGB and
/// Fans pages ask for their status every second or so, so a positive answer is reused; a `false` is never kept, so a
/// fresh install shows up at once (and callers check the exe first, which makes an uninstall show up at once too).
pub struct PositiveCache(std::sync::Mutex<Option<std::time::Instant>>);

impl PositiveCache {
    pub const fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    pub fn get(&self, ttl: std::time::Duration, check: impl FnOnce() -> bool) -> bool {
        let mut at = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if at.is_some_and(|t| t.elapsed() < ttl) {
            return true;
        }
        let ok = check();
        *at = if ok { Some(std::time::Instant::now()) } else { None };
        ok
    }
}

/// A path inside a single-quoted PowerShell string.
pub fn q(s: &Path) -> String {
    s.to_string_lossy().replace('\'', "''")
}

pub fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len() / 3 * 4 + 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

/// Runs `script` elevated (one UAC prompt) and returns its exit code. 99 = the prompt was declined or elevation failed.
pub fn elevated(script: &str) -> Result<i32, String> {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let outer = format!(
        "try {{ $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','{}'; exit $p.ExitCode }} catch {{ exit 99 }}",
        base64(&utf16)
    );
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &outer])
        .creation_flags(NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    // Never wait for ever: the script is hidden, so a stuck step (a driver installer, a file lock) would look like a frozen app.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(240);
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(st) => return st.code().ok_or_else(|| "interrupted".to_string()),
            None if std::time::Instant::now() > deadline => {
                let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(NO_WINDOW).output();
                let _ = child.kill();
                return Err("the elevated step did not finish in 4 minutes".to_string());
            }
            None => std::thread::sleep(std::time::Duration::from_millis(200)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn positive_cache_keeps_true_but_never_false() {
        use std::{cell::Cell, time::Duration};
        let c = PositiveCache::new();
        let calls = Cell::new(0);
        let ttl = Duration::from_secs(60);
        assert!(!c.get(ttl, || { calls.set(calls.get() + 1); false }));
        assert!(!c.get(ttl, || { calls.set(calls.get() + 1); false }));
        assert_eq!(calls.get(), 2, "a false is asked again every time");
        assert!(c.get(ttl, || { calls.set(calls.get() + 1); true }));
        assert!(c.get(ttl, || { calls.set(calls.get() + 1); false }));
        assert_eq!(calls.get(), 3, "a true is reused within the ttl");
        assert!(!c.get(Duration::ZERO, || { calls.set(calls.get() + 1); false }));
        assert_eq!(calls.get(), 4, "an expired true is checked again");
    }

    #[test]
    fn quotes_paths_for_powershell() {
        assert_eq!(q(Path::new(r"C:\a'b")), r"C:\a''b");
    }
}
