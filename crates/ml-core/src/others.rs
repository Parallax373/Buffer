//! Other programs that want the same hardware as Buffer, and how to get a lighting program out of the way.
//!
//! The recorder reads the lists to say who is in the way (`away.rs`); the app uses them for two buttons:
//! closing the programs, and, as a separate choice, turning their start with Windows off. Only programs on these
//! lists can be touched, and only by the names listed here, so the PowerShell never contains anything but constants.

use crate::elevate;

/// Other lighting programs: (process name, what to call it). Lower case.
pub const LIGHTING: &[(&str, &str)] = &[
    ("signalrgb.exe", "SignalRGB"),
    ("icue.exe", "iCUE"),
    ("armourycrate.service.exe", "Armoury Crate"),
    ("armourycrate.usersessionhelper.exe", "Armoury Crate"),
    ("lightingservice.exe", "Aura"),
    ("lghub.exe", "Logitech G HUB"),
    ("lghub_agent.exe", "Logitech G HUB"),
    ("razer synapse 3.exe", "Razer Synapse"),
    ("razercentralservice.exe", "Razer Synapse"),
    ("nzxt cam.exe", "NZXT CAM"),
    ("msi.centralserver.exe", "MSI Center"),
    ("dragoncenter.exe", "Dragon Center"),
    ("rgbfusion.exe", "RGB Fusion"),
    ("steelseriesgg.exe", "SteelSeries GG"),
    ("steelseriesengine.exe", "SteelSeries GG"),
    ("steelseriesggclient.exe", "SteelSeries GG"),
];

/// Other fan controllers: (process name, what to call it, true = they only touch the graphics card).
/// MSI Afterburner is often left open just for its overlay, so it only takes the GPU fans away from Buffer.
pub const FANS: &[(&str, &str, bool)] = &[
    ("fancontrol.exe", "FanControl", false),
    ("fancontrol.service.exe", "FanControl", false),
    ("speedfan.exe", "SpeedFan", false),
    ("argusmonitor.exe", "Argus Monitor", false),
    ("msi.centralserver.exe", "MSI Center", false),
    ("dragoncenter.exe", "Dragon Center", false),
    ("armourycrate.service.exe", "Armoury Crate", false),
    ("msiafterburner.exe", "MSI Afterburner", true),
    ("nvidiaapp.exe", "NVIDIA app", true),
];

/// The process names (without `.exe`, as PowerShell's `Get-Process` wants them) of the lighting program `name`.
/// Empty for a name that is not on the list.
pub fn lighting_processes(name: &str) -> Vec<String> {
    LIGHTING
        .iter()
        .filter(|(_, n)| *n == name)
        .map(|(exe, _)| exe.strip_suffix(".exe").unwrap_or(exe).to_string())
        .collect()
}

/// Only plain characters go into a script, whatever a list says.
fn plain(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b' ' | b'-'))
}

fn ps_names(procs: &[String]) -> String {
    procs.iter().map(|p| format!("'{p}'")).collect::<Vec<_>>().join(",")
}

/// The process names of every program in `names`, checked; an error for a name that is not on the list.
fn processes_of(names: &[String]) -> Result<Vec<String>, String> {
    if names.is_empty() {
        return Err("nothing to do".into());
    }
    let mut procs: Vec<String> = Vec::new();
    for n in names {
        let p = lighting_processes(n);
        if p.is_empty() {
            return Err(format!("{n} cannot be closed from Buffer"));
        }
        procs.extend(p);
    }
    procs.sort();
    procs.dedup();
    if let Some(bad) = procs.iter().find(|p| !plain(p)) {
        return Err(format!("unexpected process name '{bad}'"));
    }
    Ok(procs)
}

// ───────────────────────────── closing ─────────────────────────────

/// Closes the programs and prints which of their processes still run. Changes no setting.
fn close_script(procs: &[String]) -> String {
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$n = @({names})
foreach ($x in $n) {{ Get-Process -Name $x | Stop-Process -Force }}
Start-Sleep -Milliseconds 800
$left = @(Get-Process -Name $n | ForEach-Object {{ $_.ProcessName }} | Sort-Object -Unique)
Write-Output ($left -join ',')
"#,
        names = ps_names(procs)
    )
}

/// For what a user cannot close: a running service of the program is stopped (its start type is left as it is), then
/// its processes are closed. Exit code 0 = nothing of it is left.
fn close_admin_script(procs: &[String]) -> String {
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$n = @({names})
$svc = Get-CimInstance Win32_Service | Where-Object {{ $s = $_; $s.State -eq 'Running' -and $s.PathName -and ($n | Where-Object {{ $s.PathName -like ('*' + $_ + '.exe*') }}) }}
foreach ($s in $svc) {{ Stop-Service -Name $s.Name -Force }}
foreach ($x in $n) {{ Get-Process -Name $x | Stop-Process -Force }}
Start-Sleep -Milliseconds 800
if (Get-Process -Name $n) {{ exit 1 }} else {{ exit 0 }}
"#,
        names = ps_names(procs)
    )
}

/// Closes the lighting programs called `names` (each must be on [`LIGHTING`]). Nothing else is changed: they start
/// again with Windows unless [`disable_autostart`] is used. Only when something is still running afterwards (a
/// service, a program of another account) one administrator prompt is shown.
pub fn close_lighting(names: &[String]) -> Result<(), String> {
    let procs = processes_of(names)?;
    let out = elevate::run("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &close_script(&procs)]).map_err(|e| e.to_string())?;
    if String::from_utf8_lossy(&out.stdout).trim().is_empty() {
        return Ok(());
    }
    match elevate::elevated(&close_admin_script(&procs))? {
        0 => Ok(()),
        99 => Err("the Windows prompt was declined; some of them are still running".into()),
        c => Err(format!("{} could not be closed completely (exit {c})", names.join(", "))),
    }
}

// ───────────────────────────── autostart ─────────────────────────────

/// Turns the programs' entries in the user's own startup list off: the same switch the Startup apps page of the Task
/// Manager uses, so it can be turned back on there.
fn autostart_user_script(procs: &[String]) -> String {
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$n = @({names})
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$ok = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
if (Test-Path $run) {{
  $p = Get-ItemProperty $run
  foreach ($e in $p.PSObject.Properties) {{
    if ($e.Name -like 'PS*' -or $e.Value -isnot [string]) {{ continue }}
    $v = $e.Value
    if ($n | Where-Object {{ $v -like ('*' + $_ + '.exe*') }}) {{
      if (-not (Test-Path $ok)) {{ New-Item -Path $ok -Force | Out-Null }}
      Set-ItemProperty -Path $ok -Name $e.Name -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0)) -Type Binary
    }}
  }}
}}
"#,
        names = ps_names(procs)
    )
}

/// What needs administrator rights: the programs' services are set to start by hand (a running one is not stopped),
/// their logon and boot tasks are disabled and the machine-wide startup entries are switched off the same way as the
/// user's. Exit code 0.
fn autostart_admin_script(procs: &[String]) -> String {
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$n = @({names})
$svc = Get-CimInstance Win32_Service | Where-Object {{ $s = $_; $s.StartMode -eq 'Auto' -and $s.PathName -and ($n | Where-Object {{ $s.PathName -like ('*' + $_ + '.exe*') }}) }}
foreach ($s in $svc) {{ Set-Service -Name $s.Name -StartupType Manual }}
Get-ScheduledTask | Where-Object {{
  $t = $_
  $t.State -ne 'Disabled' -and
  ($t.Actions | Where-Object {{ $a = $_; $a.Execute -and ($n | Where-Object {{ $a.Execute -like ('*' + $_ + '.exe*') }}) }}) -and
  ($t.Triggers | Where-Object {{ $_.CimClass.CimClassName -match 'Logon|Boot' }})
}} | ForEach-Object {{ Disable-ScheduledTask -InputObject $_ | Out-Null }}
$pairs = @(
  @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'),
  @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32')
)
foreach ($pair in $pairs) {{
  $run = $pair[0]; $ok = $pair[1]
  if (-not (Test-Path $run)) {{ continue }}
  $p = Get-ItemProperty $run
  foreach ($e in $p.PSObject.Properties) {{
    if ($e.Name -like 'PS*' -or $e.Value -isnot [string]) {{ continue }}
    $v = $e.Value
    if ($n | Where-Object {{ $v -like ('*' + $_ + '.exe*') }}) {{
      if (-not (Test-Path $ok)) {{ New-Item -Path $ok -Force | Out-Null }}
      Set-ItemProperty -Path $ok -Name $e.Name -Value ([byte[]](3,0,0,0,0,0,0,0,0,0,0,0)) -Type Binary
    }}
  }}
}}
exit 0
"#,
        names = ps_names(procs)
    )
}

/// Stops the lighting programs called `names` (each must be on [`LIGHTING`]) from starting with Windows: first the
/// user's own startup entries (no prompt), then one administrator prompt for services, tasks and machine-wide
/// entries. Nothing is closed and nothing is removed: everything can be turned back on in Windows or in the program.
pub fn disable_autostart(names: &[String]) -> Result<(), String> {
    let procs = processes_of(names)?;
    let _ = elevate::run("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &autostart_user_script(&procs)]);
    match elevate::elevated(&autostart_admin_script(&procs))? {
        0 => Ok(()),
        99 => Err("the Windows prompt was declined (only your own startup entries were switched off)".into()),
        c => Err(format!("autostart of {} could not be turned off completely (exit {c})", names.join(", "))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_have_their_process_names() {
        assert_eq!(lighting_processes("SteelSeries GG"), ["steelseriesgg", "steelseriesengine", "steelseriesggclient"]);
        assert_eq!(lighting_processes("Razer Synapse"), ["razer synapse 3", "razercentralservice"]);
        assert!(lighting_processes("explorer").is_empty(), "only listed programs can be closed");
        assert!(lighting_processes("FanControl").is_empty(), "a fan program is not a lighting program");
    }

    #[test]
    fn every_listed_name_is_plain_text() {
        for (exe, name) in LIGHTING {
            assert!(plain(exe.strip_suffix(".exe").unwrap_or(exe)), "{exe} ({name})");
        }
        assert!(!plain("a'b"));
        assert!(!plain("a;b"));
        assert!(!plain("Upper"));
        assert!(!plain(""));
    }

    #[test]
    fn scripts_name_the_programs_and_nothing_else() {
        let procs = lighting_processes("Razer Synapse");
        for s in [close_script(&procs), close_admin_script(&procs), autostart_user_script(&procs), autostart_admin_script(&procs)] {
            assert!(s.contains("'razer synapse 3','razercentralservice'"), "the names are in the script");
            assert_eq!(s.matches('{').count(), s.matches('}').count(), "braces are balanced");
        }
    }

    /// Closing changes no setting, and turning autostart off closes nothing: that is the whole point of two buttons.
    #[test]
    fn closing_touches_no_startup_setting_and_autostart_closes_nothing() {
        let procs = lighting_processes("SteelSeries GG");
        for s in [close_script(&procs), close_admin_script(&procs)] {
            for word in ["Set-Service", "Disable-ScheduledTask", "StartupApproved", "New-Item", "Set-ItemProperty"] {
                assert!(!s.contains(word), "a close script must not contain {word}");
            }
        }
        for s in [autostart_user_script(&procs), autostart_admin_script(&procs)] {
            for word in ["Stop-Process", "Stop-Service"] {
                assert!(!s.contains(word), "an autostart script must not contain {word}");
            }
        }
    }

    /// The scripts against a made-up program, for real. Closing finds nothing and prints nothing. The user's autostart
    /// script switches off a startup entry the way the Task Manager does (the entry is made here and removed again).
    /// The admin scripts are run without the prompt, where they can find nothing to change: they must parse and end
    /// cleanly.
    #[test]
    #[ignore = "uses the real registry (a temporary value) and PowerShell"]
    fn the_scripts_work_on_a_made_up_program() {
        use std::process::Command;
        let reg = |args: &[&str]| elevate::run("reg", args).unwrap();
        let ps = |script: &str| Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script]).output().unwrap();
        let run = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let ok = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
        let procs = vec!["bufferfakeprog".to_string()];
        reg(&["add", run, "/v", "BufferTestProg", "/t", "REG_SZ", "/d", r#""C:\Fake\bufferfakeprog.exe" --autostart"#, "/f"]);
        reg(&["delete", ok, "/v", "BufferTestProg", "/f"]);
        // closing leaves the entry alone
        let closed = ps(&close_script(&procs));
        let after_close = String::from_utf8_lossy(&reg(&["query", ok, "/v", "BufferTestProg"]).stdout).to_string();
        // autostart switches it off
        let off = ps(&autostart_user_script(&procs));
        let flag = String::from_utf8_lossy(&reg(&["query", ok, "/v", "BufferTestProg"]).stdout).to_string();
        reg(&["delete", run, "/v", "BufferTestProg", "/f"]);
        reg(&["delete", ok, "/v", "BufferTestProg", "/f"]);
        assert_eq!(String::from_utf8_lossy(&closed.stdout).trim(), "", "stderr: {}", String::from_utf8_lossy(&closed.stderr));
        assert!(!after_close.to_lowercase().contains("0300000000"), "closing left the startup entry alone: [{after_close}]");
        assert!(flag.to_lowercase().contains("030000000000000000000000"), "the startup entry is switched off: [{flag}] stderr [{}]", String::from_utf8_lossy(&off.stderr));
        for script in [close_admin_script(&procs), autostart_admin_script(&procs)] {
            let admin = ps(&script);
            assert_eq!(admin.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&admin.stderr));
            assert!(admin.stderr.is_empty(), "no errors: {}", String::from_utf8_lossy(&admin.stderr));
        }
    }

    #[test]
    fn unknown_programs_are_refused_without_running_anything() {
        for f in [close_lighting, disable_autostart] {
            assert!(f(&["explorer".to_string()]).is_err());
            assert!(f(&["Razer Synapse".to_string(), "explorer".to_string()]).is_err(), "one unknown name refuses the whole call");
            assert!(f(&[]).is_err());
        }
    }
}
