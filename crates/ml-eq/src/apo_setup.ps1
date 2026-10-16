# Buffer: sets up Equalizer APO in ONE elevated run (see apo/setup.rs, which fills in the four marked values and passes
# this inline with -EncodedCommand: no script file is ever written anywhere). All or nothing: any failure undoes
# every registry write of this run and, if this run installed APO, runs APO's own uninstaller.
# Exit codes: 0 ok, 10 installer hash, 11 installer, 12 attach, 13 audio service, 14 anything else.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Exe  = '@@EXE@@'
$Hash = '@@HASH@@'
$Log  = '@@LOG@@'
$Ops  = @'
@@OPS@@
'@

function L([string]$m) { if ($Log) { Add-Content -LiteralPath $Log -Value ('{0:HH:mm:ss.fff} {1}' -f (Get-Date), $m) } }

$hk = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
$undo = New-Object System.Collections.ArrayList
$installedNow = $false
$code = 0
$PF = "$env:ProgramFiles\EqualizerAPO"
$PRE = '{EACD2258-FCAC-4FF4-B36D-419E924A6D79}'
$POST = '{EC1CC9CE-FAED-4822-828A-82A81A6F018F}'

# Endpoint keys: Administrators may set values there but not create subkeys, so open with exactly those rights.
function Open-Key([string]$path) {
  if ($path -like 'SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\*') {
    return $hk.OpenSubKey($path, 'ReadWriteSubTree', 'SetValue,QueryValues,ReadPermissions')
  }
  return $hk.OpenSubKey($path, $true)
}

function Ensure-Key([string]$path) {
  $probe = $hk.OpenSubKey($path)
  if ($probe) { $probe.Close(); return }
  $acc = ''; $first = $null
  foreach ($p in $path.Split('\')) {
    $acc = if ($acc) { "$acc\$p" } else { $p }
    $k = $hk.OpenSubKey($acc)
    if ($k) { $k.Close() } elseif (-not $first) { $first = $acc }
  }
  $hk.CreateSubKey($path).Close()
  [void]$undo.Add(@('delkey', $first))
}

function Set-Val([string]$path, [string]$name, $val, [string]$kind) {
  $k = Open-Key $path
  if (-not $k) { throw "no key $path" }
  try {
    $had = $k.GetValueNames() -contains $name
    $old = $null; $oldKind = 'String'
    if ($had) { $old = $k.GetValue($name, $null, 'DoNotExpandEnvironmentNames'); $oldKind = $k.GetValueKind($name) }
    [void]$undo.Add(@('val', $path, $name, $had, $old, $oldKind))
    $k.SetValue($name, $val, $kind)
  } finally { $k.Close() }
}

function Del-Val([string]$path, [string]$name) {
  $k = Open-Key $path
  if (-not $k) { return }
  try {
    if ($k.GetValueNames() -contains $name) {
      [void]$undo.Add(@('val', $path, $name, $true, $k.GetValue($name, $null, 'DoNotExpandEnvironmentNames'), $k.GetValueKind($name)))
      $k.DeleteValue($name, $false)
    }
  } finally { $k.Close() }
}

function Do-Undo {
  for ($i = $undo.Count - 1; $i -ge 0; $i--) {
    $u = $undo[$i]
    try {
      if ($u[0] -eq 'val') {
        $k = Open-Key $u[1]
        if ($k) {
          if ($u[3]) { $k.SetValue($u[2], $u[4], $u[5]) } else { $k.DeleteValue($u[2], $false) }
          $k.Close()
        }
      } elseif ($u[0] -eq 'delkey') { $hk.DeleteSubKeyTree($u[1], $false) }
    } catch { L ("undo failed: " + $_.Exception.Message) }
  }
  $undo.Clear()
}

function Apo-Dir {
  $k = $hk.OpenSubKey('SOFTWARE\EqualizerAPO')
  if (-not $k) { return $null }
  $v = $k.GetValue('InstallPath'); $k.Close(); return $v
}

function Registered {
  foreach ($g in $PRE, $POST) {
    foreach ($base in 'SOFTWARE\Classes\AudioEngine\AudioProcessingObjects', 'SOFTWARE\Classes\CLSID') {
      $k = $hk.OpenSubKey("$base\$g")
      if (-not $k) { return $false }
      $k.Close()
    }
  }
  return $true
}

function Apo-Ok {
  $d = Apo-Dir
  return [bool]($d -and (Test-Path -LiteralPath "$d\EqualizerAPO.dll") -and (Test-Path -LiteralPath "$d\Uninstall.exe") -and (Registered))
}

function Remove-Apo {
  $d = Apo-Dir
  if (-not $d) { $d = $PF }
  $u = Join-Path $d 'Uninstall.exe'
  if (Test-Path -LiteralPath $u) {
    # "_?=" keeps the uninstaller from copying itself away and returning at once
    $p = Start-Process -FilePath $u -ArgumentList '/S', "_?=$d" -PassThru
    # The uninstaller runs `DeviceSelector /u`, which restores the devices but then lingers: stop it after a while.
    $end = (Get-Date).AddSeconds(120)
    while (-not $p.HasExited -and (Get-Date) -lt $end) {
      foreach ($s in @(Get-Process -Name DeviceSelector -ErrorAction SilentlyContinue)) {
        try { if (((Get-Date) - $s.StartTime).TotalSeconds -gt 12) { $s.Kill() } } catch {}
      }
      Start-Sleep -Milliseconds 300
    }
    if (-not $p.HasExited) { try { $p.Kill() } catch {} }
    Remove-Item -LiteralPath $u -Force -ErrorAction SilentlyContinue
  }
  # this run made the folder (and its config): take what is left of it
  if ($d -eq $PF) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }
  try { $hk.DeleteSubKeyTree('SOFTWARE\EqualizerAPO', $false) } catch {}
}

function Restart-Audio { Restart-Service -Name audiosrv -Force -ErrorAction Stop }

try {
  if ($Exe) {
    L 'hash'
    if ((Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLower() -ne $Hash) { $code = 10; throw 'installer hash' }
    L 'install'
    $t0 = (Get-Date).AddSeconds(-1)
    $p = Start-Process -FilePath $Exe -ArgumentList '/S' -PassThru
    $installedNow = $true
    $deadline = (Get-Date).AddMinutes(4)
    # The installer ends by opening APO's device picker (no switch turns that off). Its job is done below, so the
    # picker is stopped as soon as it appears, before it has a window.
    while (-not $p.HasExited) {
      foreach ($d in @(Get-Process -Name DeviceSelector -ErrorAction SilentlyContinue)) {
        try { if ($d.StartTime -ge $t0) { $d.Kill(); L 'picker stopped' } } catch {}
      }
      if ((Get-Date) -gt $deadline) { try { $p.Kill() } catch {}; $code = 11; throw 'installer timed out' }
      Start-Sleep -Milliseconds 30
    }
    L ('installer exit ' + $p.ExitCode)
    if (-not (Apo-Ok)) { $code = 11; throw 'installer did not complete' }
  }

  $code = 12
  if (-not (Registered)) {
    L 'registering'
    $dll = (Apo-Dir) + '\EqualizerAPO.dll'
    $r = Start-Process -FilePath "$env:SystemRoot\System32\regsvr32.exe" -ArgumentList '/s', "`"$dll`"" -Wait -PassThru
    if (-not (Registered)) { throw 'APO is not registered' }
  }
  foreach ($line in ($Ops -split "`r?`n")) {
    if (-not $line.Trim()) { continue }
    $f = $line.Split('|')
    for ($i = 1; $i -le 2 -and $i -lt $f.Count; $i++) { $f[$i] = $f[$i].Replace('%M', 'SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio').Replace('%C', 'SOFTWARE\EqualizerAPO\Child APOs') }
    L $line
    switch ($f[0]) {
      'key'   { Ensure-Key $f[1] }
      'sz'    { Set-Val $f[1] $f[2] $f[3] 'String' }
      'multi' { Set-Val $f[1] $f[2] ([string[]]@($f[3])) 'MultiString' }
      'dword' { Set-Val $f[1] $f[2] ([int]$f[3]) 'DWord' }
      'del'   { Del-Val $f[1] $f[2] }
      default { throw "bad op $line" }
    }
  }

  $code = 13
  L 'restart audio'
  Restart-Audio
  $code = 0
  try {
    Start-Sleep -Seconds 2
    $loaded = @((Get-Process -Name audiodg -ErrorAction Stop).Modules | Where-Object { $_.ModuleName -eq 'EqualizerAPO.dll' }).Count
    L ("audiodg has EqualizerAPO.dll: " + ($loaded -gt 0))
  } catch { L ("audiodg modules unreadable: " + $_.Exception.Message) }
  exit 0
} catch {
  if ($code -eq 0) { $code = 14 }
  L ("FAIL ($code): " + $_.Exception.Message)
  try {
    Do-Undo
    if ($installedNow) {
      try { Restart-Audio } catch {}   # lets go of EqualizerAPO.dll before it is deleted
      Remove-Apo
    }
    try { Restart-Audio } catch {}
  } catch { L ("rollback failed: " + $_.Exception.Message) }
  exit $code
}
