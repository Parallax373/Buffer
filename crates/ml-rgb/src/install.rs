//! Installing OpenRGB for Buffer: one elevated, all-or-nothing step (one UAC prompt).
//!
//! OpenRGB only sees the motherboard and RAM when it runs elevated, so it runs from a scheduled task registered once
//! with highest privileges ("Buffer OpenRGB", on demand, no trigger). Starting and stopping that task needs no prompt.
//! An elevated task must never run a file a normal process can replace, so the exe lives in `%ProgramFiles%\Buffer\OpenRGB`
//! (admin-only write) and the elevated script is handed over inline (`-EncodedCommand`), never as a file in a user folder.
//! The downloads are pinned by SHA-256, held open without write sharing while the elevated side re-checks them.
//! PawnIO (the driver OpenRGB uses for the board and RAM) is installed only if missing and never removed.

use ml_core::elevate::{elevated, fetch, pawnio_present, q, run, PAWNIO_SHA256, PAWNIO_URL};
use std::path::{Path, PathBuf};

/// Pinned release: SHA-256 from the GitHub release page (checked 2026-10-16).
const OPENRGB_URL: &str = "https://github.com/CalcProgrammer1/OpenRGB/releases/download/release_1.0/OpenRGB_1.0_Windows_64_81bbe18.zip";
const OPENRGB_SHA256: &str = "182a52a3c97c4c4ae52c80286b4260c9666c51c3447dbc416ee8945f66192e90";

pub const TASK: &str = "Buffer OpenRGB";

pub fn install_dir() -> PathBuf {
    let pf = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    pf.join("Buffer").join("OpenRGB")
}

pub fn exe() -> PathBuf {
    install_dir().join("OpenRGB.exe")
}

pub fn task_exists() -> bool {
    run("schtasks", &["/Query", "/TN", TASK]).map(|o| o.status.success()).unwrap_or(false)
}

/// Installed = the exe is where the task expects it and the task is registered.
pub fn installed() -> bool {
    static TASK_OK: ml_core::elevate::PositiveCache = ml_core::elevate::PositiveCache::new();
    exe().is_file() && TASK_OK.get(std::time::Duration::from_secs(30), task_exists)
}

/// Starts the elevated server through the task (no prompt). It returns at once; the server needs a while to come up.
pub fn start_server() -> Result<(), String> {
    let o = run("schtasks", &["/Run", "/TN", TASK]).map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(())
    } else {
        Err(format!("cannot start OpenRGB: {}", String::from_utf8_lossy(&o.stderr).trim()))
    }
}

pub fn stop_server() {
    let _ = run("schtasks", &["/End", "/TN", TASK]);
}

const INSTALL_PS: &str = r#"
$ErrorActionPreference = 'Stop'
$zip = '{ZIP}'; $dest = '{DEST}'; $user = '{USER}'; $pawn = '{PAWN}'
$tmp = "$dest.new"; $old = "$dest.old"; $code = 1; $began = $false
function Stop-Ours {
  Stop-ScheduledTask -TaskName 'Buffer OpenRGB' -ErrorAction SilentlyContinue
  Get-Process OpenRGB -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest*" } | Stop-Process -Force -ErrorAction SilentlyContinue
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
  $f = Get-ChildItem -LiteralPath $tmp -Recurse -Filter OpenRGB.exe | Select-Object -First 1
  if (-not $f) { throw 'no exe' }
  if (Test-Path -LiteralPath $dest) { Rename-Item -LiteralPath $dest -NewName (Split-Path $old -Leaf) }
  Move-Item -LiteralPath $f.DirectoryName -Destination $dest
  Remove-Item -LiteralPath $tmp -Recurse -Force
  $code = 12
  $exe = Join-Path $dest 'OpenRGB.exe'
  $a = New-ScheduledTaskAction -Execute ('"' + $exe + '"') -Argument '--server --noautoconnect' -WorkingDirectory $dest
  $p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
  Register-ScheduledTask -TaskName 'Buffer OpenRGB' -Action $a -Principal $p -Settings $s -Force | Out-Null
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
    Unregister-ScheduledTask -TaskName 'Buffer OpenRGB' -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $dest, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $old) { Rename-Item -LiteralPath $old -NewName (Split-Path $dest -Leaf) -ErrorAction SilentlyContinue }
  }
  exit $code
}
"#;

const UNINSTALL_PS: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$dest = '{DEST}'
Stop-ScheduledTask -TaskName 'Buffer OpenRGB'
Get-Process OpenRGB | Where-Object { $_.Path -like "$dest*" } | Stop-Process -Force
Unregister-ScheduledTask -TaskName 'Buffer OpenRGB' -Confirm:$false
Remove-Item -LiteralPath $dest -Recurse -Force
Remove-Item -LiteralPath (Split-Path $dest) -Force
exit 0
"#;

fn reason(code: i32) -> String {
    match code {
        99 => "the Windows permission prompt was declined".into(),
        10 => "the OpenRGB download does not match the expected hash".into(),
        14 => "the PawnIO installer failed its hash or signature check".into(),
        11 => "cannot unpack OpenRGB into Program Files".into(),
        12 => "cannot register the OpenRGB task".into(),
        13 => "the PawnIO driver installer failed".into(),
        c => format!("the elevated install failed (code {c})"),
    }
}

/// Downloads and verifies OpenRGB (and PawnIO if the driver is missing) into `work`, then installs everything in one
/// elevated step. All or nothing: any failure rolls the elevated part back. Blocking, takes a minute.
pub fn install(work: &Path) -> Result<(), String> {
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let (zip, pawn) = (work.join("openrgb.zip"), work.join("PawnIO_setup.exe"));
    let zip_hold = fetch(OPENRGB_URL, &zip, OPENRGB_SHA256);
    let pawn_hold = if pawnio_present() { None } else { Some(fetch(PAWNIO_URL, &pawn, PAWNIO_SHA256)) };
    let result = (|| {
        zip_hold.as_ref().map_err(|e| e.clone())?;
        if let Some(Err(e)) = &pawn_hold {
            return Err(e.clone());
        }
        let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").unwrap_or_default());
        let script = INSTALL_PS
            .replace("{ZIP}", &q(&zip))
            .replace("{DEST}", &q(&install_dir()))
            .replace("{USER}", &user.replace('\'', "''"))
            .replace("{PAWN}", &q(&pawn))
            .replace("{ZIPSHA}", OPENRGB_SHA256)
            .replace("{PAWNSHA}", PAWNIO_SHA256);
        match elevated(&script)? {
            0 if installed() => Ok(()),
            0 => Err("the install finished but OpenRGB is not in place".into()),
            c => Err(reason(c)),
        }
    })();
    drop((zip_hold, pawn_hold));
    let _ = std::fs::remove_file(&zip);
    let _ = std::fs::remove_file(&pawn);
    result
}

/// Removes the task and the Program Files copy (one prompt). PawnIO is left alone.
pub fn uninstall() -> Result<(), String> {
    match elevated(&UNINSTALL_PS.replace("{DEST}", &q(&install_dir())))? {
        0 => Ok(()),
        99 => Err(reason(99)),
        c => Err(format!("the elevated uninstall failed (code {c})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_has_no_unfilled_placeholders_and_quotes_paths() {
        assert_eq!(q(Path::new(r"C:\a'b")), r"C:\a''b");
        let s = INSTALL_PS.replace("{ZIP}", "z").replace("{DEST}", "d").replace("{USER}", "u").replace("{PAWN}", "p").replace("{ZIPSHA}", "h").replace("{PAWNSHA}", "h");
        assert!(!["{ZIP", "{DEST", "{USER", "{PAWN"].iter().any(|p| s.contains(p)));
        assert!(install_dir().to_string_lossy().ends_with(r"Buffer\OpenRGB"));
    }

    /// Needs a UAC click, network and changes the machine: `cargo test -p ml-rgb install_and_uninstall -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn install_and_uninstall() {
        let work = std::env::temp_dir().join("buffer-rgb-install-test");
        install(&work).unwrap();
        assert!(installed());
        uninstall().unwrap();
        assert!(!exe().exists());
    }
}
