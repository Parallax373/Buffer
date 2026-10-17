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
        .ok_or_else(|| "cannot hash the download".to_string())
}

/// Downloads `url` to `dest` and checks the hash. Returns the file held open for reading only, so it cannot be
/// swapped or rewritten until the guard is dropped.
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
        return Err("download failed".into());
    }
    let hold = std::fs::OpenOptions::new().read(true).share_mode(1).open(dest).map_err(|e| e.to_string())?; // FILE_SHARE_READ
    if sha256(dest)? != sha {
        return Err("the download does not match the expected hash".into());
    }
    Ok(hold)
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
    let st = Command::new("powershell.exe")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &outer])
        .creation_flags(NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    st.code().ok_or_else(|| "the elevated step was interrupted".to_string())
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
    fn quotes_paths_for_powershell() {
        assert_eq!(q(Path::new(r"C:\a'b")), r"C:\a''b");
    }
}
