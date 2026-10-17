//! Installing the fan helper (`buffer-fans.exe`, LibreHardwareMonitor) for Buffer: one elevated, all-or-nothing step.
//!
//! Board fans are only reachable from an elevated process, so the helper runs from an on-demand scheduled task
//! ("Buffer Fans", highest privileges, no trigger); starting and stopping it needs no prompt. Like OpenRGB it lives in
//! `%ProgramFiles%\Buffer\Fans` (admin-only write), the elevated script is handed over inline (`-EncodedCommand`), and the
//! zip is held open without write sharing while the elevated side re-checks its SHA-256. The task starts the helper
//! through `start.cmd` (in the zip, so in the admin-only folder), which clears the .NET profiler / startup-hook
//! variables, because the task inherits the user's own (user-writable) environment. PawnIO (the driver) is installed only if missing and never removed.
//!
//! The helper is built by `scripts/build-fans-helper.ps1` into a zip. A release downloads a pinned zip (`RELEASE_URL`);
//! until one is published, `install_zip` takes a local build (its hash is computed here while the file is held open).

use ml_core::elevate::{elevated, fetch, pawnio_present, q, run, sha256, PAWNIO_SHA256, PAWNIO_URL};
use std::path::{Path, PathBuf};

pub const TASK: &str = "Buffer Fans";
/// Pinned helper zip of a release (empty until one is published: FANS-SPEC.md "Hosting the helper").
pub const RELEASE_URL: &str = "";
pub const RELEASE_SHA256: &str = "";

pub fn install_dir() -> PathBuf {
    let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    pf.join("Buffer").join("Fans")
}

pub fn exe() -> PathBuf {
    install_dir().join("buffer-fans.exe")
}

pub fn task_exists() -> bool {
    run("schtasks", &["/Query", "/TN", TASK]).map(|o| o.status.success()).unwrap_or(false)
}

pub fn installed() -> bool {
    static TASK_OK: ml_core::elevate::PositiveCache = ml_core::elevate::PositiveCache::new();
    exe().is_file() && TASK_OK.get(std::time::Duration::from_secs(30), task_exists)
}

/// A release can fetch the helper itself.
pub fn downloadable() -> bool {
    !RELEASE_URL.is_empty() && !RELEASE_SHA256.is_empty()
}

/// The helper zip that ships inside Buffer's installer, next to the exe (`resources` in tauri.conf.json): nothing is hosted
/// or downloaded for it. Its hash is taken at install time while the file is held open, like a local build's.
pub fn bundled_zip() -> Option<PathBuf> {
    let z = std::env::current_exe().ok()?.parent()?.join("buffer-fans.zip");
    z.is_file().then_some(z)
}

/// The zip to install from: the installer's own copy, else a development build (`scripts/build-fans-helper.ps1`).
pub fn local_zip() -> Option<PathBuf> {
    bundled_zip().or_else(dev_zip)
}

/// Where a development build of the helper zip lives (`scripts/build-fans-helper.ps1`), if it was built.
pub fn dev_zip() -> Option<PathBuf> {
    let mut d = std::env::current_exe().ok()?;
    while d.pop() {
        let z = d.join("helpers").join("fans").join("dist").join("buffer-fans.zip");
        if z.is_file() {
            return Some(z);
        }
    }
    None
}

/// Starts the elevated helper through its task (no prompt). It returns at once; the pipe appears a moment later.
pub fn start() -> Result<(), String> {
    let o = run("schtasks", &["/Run", "/TN", TASK]).map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(())
    } else {
        Err(format!("cannot start the fan helper: {}", String::from_utf8_lossy(&o.stderr).trim()))
    }
}

/// Stops the helper the polite way: it hands every control back (SetDefault) before it exits. A hard kill would lose the
/// board's original settings, so `schtasks /End` is only the fallback after a few seconds. The pipe has room for one
/// connection, so the caller passes the one it holds (if any); without it a new connection is tried.
pub fn stop(existing: Option<crate::client::Client>) {
    let client = existing.or_else(|| crate::client::Client::connect().ok());
    if let Some(mut c) = client {
        let _ = c.quit();
    }
    for _ in 0..40 {
        if !crate::client::running() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    let _ = run("schtasks", &["/End", "/TN", TASK]);
}

/// SID of the signed-in user: the only account that may open the helper's pipe.
fn user_sid() -> Result<String, String> {
    let o = run("whoami", &["/user", "/fo", "csv", "/nh"]).map_err(|e| e.to_string())?;
    String::from_utf8_lossy(&o.stdout)
        .split('"')
        .find(|p| p.starts_with("S-1-"))
        .map(String::from)
        .ok_or_else(|| "cannot read the user SID".to_string())
}

const INSTALL_PS: &str = r#"
$ErrorActionPreference = 'Stop'
$zip = '{ZIP}'; $dest = '{DEST}'; $user = '{USER}'; $pawn = '{PAWN}'; $sid = '{SID}'
$tmp = "$dest.new"; $old = "$dest.old"; $code = 1; $began = $false
function Stop-Ours {
  Stop-ScheduledTask -TaskName 'Buffer Fans' -ErrorAction SilentlyContinue
  Get-Process buffer-fans -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}
try {
  $code = 10
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne '{ZIPSHA}'.ToUpper()) { throw 'hash' }
  sc.exe query PawnIO | Out-Null
  $need = ($LASTEXITCODE -ne 0)
  if ($need) {
    $code = 14
    if ((Get-FileHash -LiteralPath $pawn -Algorithm SHA256).Hash -ne '{PAWNSHA}'.ToUpper()) { throw 'hash' }
    $sig = Get-AuthenticodeSignature -LiteralPath $pawn
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'namazso') { throw 'signature' }
  }
  $code = 11
  Stop-Ours
  $began = $true
  Remove-Item -LiteralPath $tmp, $old -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  & tar.exe -xf $zip -C $tmp
  if ($LASTEXITCODE -ne 0) { throw 'unpack' }
  $f = Get-ChildItem -LiteralPath $tmp -Recurse -Filter buffer-fans.exe | Select-Object -First 1
  if (-not $f) { throw 'no exe' }
  if (Test-Path -LiteralPath $dest) { Rename-Item -LiteralPath $dest -NewName (Split-Path $old -Leaf) }
  Move-Item -LiteralPath $f.DirectoryName -Destination $dest
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue   # gone already when the exe sat in the zip root
  $code = 12
  $exe = Join-Path $dest 'buffer-fans.exe'
  $arg = '--headless "' + (Join-Path $dest 'start.cmd') + '" ' + $sid
  $a = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') -Argument $arg -WorkingDirectory $dest
  $p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
  Register-ScheduledTask -TaskName 'Buffer Fans' -Action $a -Principal $p -Settings $s -Force | Out-Null
  if ($need) {
    $code = 13
    $r = Start-Process -FilePath $pawn -ArgumentList '-install', '-silent' -Wait -PassThru
    if ($r.ExitCode -ne 0) { throw 'pawnio' }
    sc.exe query PawnIO | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'pawnio missing' }
  }
  Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  if ($began) {
    Stop-Ours
    Unregister-ScheduledTask -TaskName 'Buffer Fans' -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $dest, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $old) { Rename-Item -LiteralPath $old -NewName (Split-Path $dest -Leaf) -ErrorAction SilentlyContinue }
  }
  exit $code
}
"#;

const UNINSTALL_PS: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$dest = '{DEST}'
Stop-ScheduledTask -TaskName 'Buffer Fans'
Get-Process buffer-fans | Where-Object { $_.Path -like "$dest*" } | Stop-Process -Force
Unregister-ScheduledTask -TaskName 'Buffer Fans' -Confirm:$false
Remove-Item -LiteralPath $dest -Recurse -Force
Remove-Item -LiteralPath (Split-Path $dest) -Force
exit 0
"#;

fn reason(code: i32) -> String {
    match code {
        99 => "the Windows permission prompt was declined".into(),
        10 => "the fan helper download does not match the expected hash".into(),
        14 => "the PawnIO installer failed its hash or signature check".into(),
        11 => "cannot unpack the fan helper into Program Files".into(),
        12 => "cannot register the fan helper task".into(),
        13 => "the PawnIO driver installer failed".into(),
        c => format!("the elevated install failed (code {c})"),
    }
}

fn script(zip: &Path, zip_sha: &str, pawn: &Path, sid: &str) -> String {
    let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").unwrap_or_default());
    INSTALL_PS
        .replace("{ZIP}", &q(zip))
        .replace("{DEST}", &q(&install_dir()))
        .replace("{USER}", &user.replace('\'', "''"))
        .replace("{PAWN}", &q(pawn))
        .replace("{SID}", sid)
        .replace("{ZIPSHA}", zip_sha)
        .replace("{PAWNSHA}", PAWNIO_SHA256)
}

/// Installs the helper from a zip on disk: `expected` is its SHA-256 (a release's pinned hash), or None for a local build,
/// whose hash is taken here while the file is held open. PawnIO is fetched too if its driver is missing. One UAC prompt.
pub fn install_zip(zip: &Path, expected: Option<&str>, work: &Path) -> Result<(), String> {
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let hold = std::fs::OpenOptions::new().read(true).share_mode_read().open(zip).map_err(|e| e.to_string())?;
    let sha = sha256(zip)?;
    if expected.is_some_and(|e| e != sha) {
        return Err("the fan helper download does not match the expected hash".into());
    }
    let pawn = work.join("PawnIO_setup.exe");
    let pawn_hold = if pawnio_present() { None } else { Some(fetch(PAWNIO_URL, &pawn, PAWNIO_SHA256)) };
    let result = (|| {
        if let Some(Err(e)) = &pawn_hold {
            return Err(e.clone());
        }
        match elevated(&script(zip, &sha, &pawn, &user_sid()?))? {
            0 if installed() => Ok(()),
            0 => Err("the install finished but the fan helper is not in place".into()),
            c => Err(reason(c)),
        }
    })();
    drop((hold, pawn_hold));
    let _ = std::fs::remove_file(&pawn);
    result
}

/// The release way: download the pinned zip, then `install_zip` it.
pub fn install(work: &Path) -> Result<(), String> {
    if downloadable() {
        std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
        let zip = work.join("buffer-fans.zip");
        let hold = fetch(RELEASE_URL, &zip, RELEASE_SHA256)?;
        let r = install_zip(&zip, Some(RELEASE_SHA256), work);
        drop(hold);
        let _ = std::fs::remove_file(&zip);
        r
    } else if let Some(z) = local_zip() {
        install_zip(&z, None, work)
    } else {
        Err("the fan helper is missing from this build (run scripts/build-fans-helper.ps1)".into())
    }
}

/// Stops the helper politely, then removes the task and the Program Files copy (one prompt). PawnIO is left alone.
pub fn uninstall() -> Result<(), String> {
    stop(None);
    match elevated(&UNINSTALL_PS.replace("{DEST}", &q(&install_dir())))? {
        0 => Ok(()),
        99 => Err(reason(99)),
        c => Err(format!("the elevated uninstall failed (code {c})")),
    }
}

trait ShareRead {
    fn share_mode_read(&mut self) -> &mut Self;
}

impl ShareRead for std::fs::OpenOptions {
    fn share_mode_read(&mut self) -> &mut Self {
        use std::os::windows::fs::OpenOptionsExt;
        self.share_mode(1) // FILE_SHARE_READ
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_has_no_unfilled_placeholders() {
        let s = script(Path::new(r"C:\a'b.zip"), "h", Path::new("p"), "S-1-5-21-1");
        assert!(!["{ZIP", "{DEST", "{USER", "{PAWN", "{SID"].iter().any(|p| s.contains(p)), "{s}");
        assert!(s.contains("C:\\a''b.zip"));
        assert!(install_dir().to_string_lossy().ends_with(r"Buffer\Fans"));
    }

    #[test]
    fn the_task_starts_the_helper_through_the_script_that_clears_the_profiler_variables() {
        assert!(INSTALL_PS.contains("start.cmd"));
        let cmd = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../helpers/fans/start.cmd")).unwrap();
        for v in ["CORECLR_ENABLE_PROFILING=", "COR_ENABLE_PROFILING=", "DOTNET_STARTUP_HOOKS=", "DOTNET_EnableDiagnostics=0"] {
            assert!(cmd.contains(v), "{v}");
        }
        assert!(cmd.contains("--sid %1"));
    }

    /// Needs a UAC click and changes the machine (installs the helper from `scripts/build-fans-helper.ps1`, then removes it):
    /// `cargo test -p ml-fans install_and_uninstall -- --ignored --nocapture`. The recorder deliberately has no install
    /// command: scripts that register elevated tasks make its exe look like a dropper to Defender's ML.
    #[test]
    #[ignore]
    fn install_and_uninstall() {
        install(&std::env::temp_dir().join("buffer-fans-install-test")).unwrap();
        assert!(installed());
        uninstall().unwrap();
        assert!(!exe().exists());
    }

    /// Same, but leaves the helper installed (development): `cargo test -p ml-fans dev_install -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn dev_install() {
        install(&std::env::temp_dir().join("buffer-fans-install-test")).unwrap();
        assert!(installed());
    }

    #[test]
    fn reads_the_user_sid() {
        assert!(user_sid().unwrap().starts_with("S-1-5-"));
    }
}
