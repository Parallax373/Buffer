//! Other programs that want the same hardware as Buffer, and how to get a lighting program out of the way.
//!
//! The recorder reads the lists to say who is in the way (`away.rs`); the app uses them to close a program from a
//! button. Only programs on these lists can be closed, and only by the names listed here, so the PowerShell that
//! does it never contains anything but constants.

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

/// What a user can do without a prompt: close the programs and turn their entries in the user's own startup list off
/// (the same switch the Startup apps page of the Task Manager uses, so it can be turned back on there). Prints the
/// processes that are still running.
fn user_script(procs: &[String]) -> String {
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$n = @({names})
foreach ($x in $n) {{ Get-Process -Name $x | Stop-Process -Force }}
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
Start-Sleep -Milliseconds 800
$left = @(Get-Process -Name $n | ForEach-Object {{ $_.ProcessName }} | Sort-Object -Unique)
Write-Output ($left -join ',')
"#,
        names = ps_names(procs)
    )
}

/// What needs administrator rights: their services (stopped, and no longer started with Windows: set to Manual, so
/// the program can still start one itself), their logon and boot tasks (disabled), the machine-wide startup entries
/// (switched off the same way as the user's), and whatever is still running. Exit code 0 = nothing of them is left.
fn admin_script(procs: &[String]) -> String {
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$n = @({names})
$svc = Get-CimInstance Win32_Service | Where-Object {{ $s = $_; $s.PathName -and ($n | Where-Object {{ $s.PathName -like ('*' + $_ + '.exe*') }}) }}
foreach ($s in $svc) {{
  if ($s.StartMode -eq 'Auto') {{ Set-Service -Name $s.Name -StartupType Manual }}
  if ($s.State -eq 'Running') {{ Stop-Service -Name $s.Name -Force }}
}}
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
foreach ($x in $n) {{ Get-Process -Name $x | Stop-Process -Force }}
Start-Sleep -Milliseconds 800
if (Get-Process -Name $n) {{ exit 1 }} else {{ exit 0 }}
"#,
        names = ps_names(procs)
    )
}

/// Closes the lighting programs called `names` (each must be on [`LIGHTING`]) and turns their start with Windows off:
/// first what needs no prompt, then one administrator prompt for services, tasks and machine-wide entries. Returns
/// an error text when the prompt was declined or something of them still runs.
pub fn close_lighting(names: &[String]) -> Result<(), String> {
    if names.is_empty() {
        return Err("nothing to close".into());
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
    // 1. no prompt: close them and switch off the user's own startup entries
    let _ = elevate::run("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &user_script(&procs)]);
    // 2. one prompt: services, tasks, machine-wide entries, and whatever came back
    match elevate::elevated(&admin_script(&procs))? {
        0 => Ok(()),
        99 => Err("the Windows prompt was declined (the programs may be closed, but they will start again with Windows)".into()),
        c => Err(format!("{} could not be closed completely (exit {c})", names.join(", "))),
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
        for s in [user_script(&procs), admin_script(&procs)] {
            assert!(s.contains("'razer synapse 3','razercentralservice'"), "the names are in the script");
            assert_eq!(s.matches('{').count(), s.matches('}').count(), "braces are balanced");
        }
        assert!(admin_script(&procs).contains("exit 1"));
    }

    /// The two scripts against a made-up program, for real: the user script switches off a startup entry the way the
    /// Task Manager does (the entry is made here and removed again), the admin script is only read through (it is run
    /// without the prompt, where it can find nothing to change) and must finish with 0 and without parse errors.
    #[test]
    #[ignore = "uses the real registry (a temporary value) and PowerShell"]
    fn the_scripts_work_on_a_made_up_program() {
        use std::process::Command;
        let reg = |args: &[&str]| elevate::run("reg", args).unwrap();
        let run = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let ok = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
        let procs = vec!["bufferfakeprog".to_string()];
        reg(&["add", run, "/v", "BufferTestProg", "/t", "REG_SZ", "/d", r#""C:\Fake\bufferfakeprog.exe" --autostart"#, "/f"]);
        reg(&["delete", ok, "/v", "BufferTestProg", "/f"]);
        let out = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &user_script(&procs)]).output().unwrap();
        let left = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let flag = String::from_utf8_lossy(&reg(&["query", ok, "/v", "BufferTestProg"]).stdout).to_string();
        reg(&["delete", run, "/v", "BufferTestProg", "/f"]);
        reg(&["delete", ok, "/v", "BufferTestProg", "/f"]);
        assert_eq!(left, "", "no process of it is left, and the script printed nothing else (stderr: {})", String::from_utf8_lossy(&out.stderr));
        assert!(flag.to_lowercase().contains("030000000000000000000000"), "the startup entry is switched off: [{flag}] stderr of the script: [{}]", String::from_utf8_lossy(&out.stderr));
        let admin = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &admin_script(&procs)]).output().unwrap();
        assert_eq!(admin.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&admin.stderr));
        assert!(admin.stderr.is_empty(), "no errors: {}", String::from_utf8_lossy(&admin.stderr));
    }

    #[test]
    fn unknown_programs_are_refused_without_running_anything() {
        assert!(close_lighting(&["explorer".to_string()]).is_err());
        assert!(close_lighting(&["Razer Synapse".to_string(), "explorer".to_string()]).is_err(), "one unknown name refuses the whole call");
        assert!(close_lighting(&[]).is_err());
    }
}
