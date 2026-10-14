# Throws awkward sequences at a real recorder process and checks that it never stops answering.
#   .\scripts\smoke-recorder.ps1                 # uses target\debug\buffer-recorder.exe
#   .\scripts\smoke-recorder.ps1 -Exe "C:\path\buffer-recorder.exe"
# It borrows the recorder: your config is backed up and restored, and recordings go to a temp folder.
param([string]$Exe = "")
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) { $Exe = Join-Path $root "target\debug\buffer-recorder.exe" }
if (-not (Test-Path $Exe)) { throw "Recorder not found: $Exe (build it with: cargo build -p ml-recorder)" }
$Exe = (Resolve-Path $Exe).Path

$cfgPath = Join-Path $env:APPDATA "Buffer\recorder.json"
$tmpOut = Join-Path $env:TEMP "buffer-smoke-out"
New-Item -ItemType Directory -Force $tmpOut | Out-Null
$hadCfg = Test-Path $cfgPath
$backup = if ($hadCfg) { [IO.File]::ReadAllBytes($cfgPath) } else { $null }

$script:fail = 0
function Say($ok, $name, $detail = "") {
    if ($ok) { Write-Host ("  PASS  " + $name) -ForegroundColor Green }
    else { Write-Host ("  FAIL  " + $name + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}
# One control command with a hard timeout: a hang is the bug we are hunting, so it must not hang us.
function Cmd([string]$c, [int]$timeout = 6) {
    $j = Start-Job { param($e, $c) & $e $c } -ArgumentList $Exe, $c
    if (Wait-Job $j -Timeout $timeout) { $r = Receive-Job $j; Remove-Job $j -Force; return ($r -join "") }
    Stop-Job $j; Remove-Job $j -Force; return "TIMEOUT"
}
function Status() {
    $r = Cmd "status" 5
    if ($r -eq "TIMEOUT" -or $r -notmatch '^\{') { return $null }
    return ($r | ConvertFrom-Json)
}
function WaitFor([scriptblock]$cond, [int]$seconds = 20) {
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end) { $s = Status; if ($s -and (& $cond $s)) { return $s }; Start-Sleep -Milliseconds 700 }
    return $null
}
function WriteConfig([hashtable]$patch) {
    $j = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    foreach ($k in $patch.Keys) { $j | Add-Member -NotePropertyName $k -NotePropertyValue $patch[$k] -Force }
    [IO.File]::WriteAllText($cfgPath, ($j | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
}
function StopRecorder() {
    Cmd "quit" 4 | Out-Null; Start-Sleep 2
    Get-Process buffer-recorder -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process ffmpeg -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*ffmpeg*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}

try {
    Write-Host "Smoke test: $Exe" -ForegroundColor Cyan
    StopRecorder
    WriteConfig @{ output_dir = $tmpOut; per_game_folders = $false; game_only = $false; post_roll_seconds = 0; hotkey = "Alt+Q"; record_hotkey = "Alt+R" }
    Start-Process $Exe -ArgumentList "run" -WindowStyle Hidden
    $s = WaitFor { param($s) $true } 25
    Say ($null -ne $s) "recorder starts and answers status"
    if (-not $s) { throw "recorder did not start" }

    Write-Host "status under load" -ForegroundColor Cyan
    $slow = 0; 1..25 | ForEach-Object { $t = Get-Date; $x = Status; if (-not $x -or ((Get-Date) - $t).TotalSeconds -gt 2) { $slow++ } }
    Say ($slow -eq 0) "25 rapid status calls all answer within 2 s" "slow/failed: $slow"

    Write-Host "save with nothing recorded" -ForegroundColor Cyan
    WaitFor { param($s) $s.recording } 25 | Out-Null
    $r = Cmd "save" 10
    Say ($r -ne "TIMEOUT") "save answers (no hang)" $r
    Say ($r -notmatch "Invalid data|Error opening") "save never leaks raw ffmpeg text" $r

    Write-Host "long recording (the 'Record all' button)" -ForegroundColor Cyan
    $r = Cmd "record-start" 8
    Say ($r -ne "TIMEOUT" -and $r -match 'ok') "record-start answers" $r
    $s = WaitFor { param($s) $s.long.active } 8
    Say ($null -ne $s) "status answers and reports it active"
    Start-Sleep 10
    $s = Status
    Say ($null -ne $s -and $s.long.elapsed_s -ge 8) "elapsed time advances" ($s.long | ConvertTo-Json -Compress)
    Say ($null -ne $s -and $s.recording) "the buffer session runs underneath"
    $r = Cmd "record-start" 6
    Say ($r -ne "TIMEOUT") "second record-start is harmless" $r
    $r = Cmd "save" 15
    Say ($r -ne "TIMEOUT") "save during a long recording answers" $r
    $r = Cmd "reload" 8
    Say ($r -ne "TIMEOUT") "reload during a long recording answers" $r
    $r = Cmd "record-stop" 8
    Say ($r -ne "TIMEOUT" -and $r -match 'ok') "record-stop answers" $r
    $s = WaitFor { param($s) -not $s.long.active -and -not $s.long.finalizing } 40
    Say ($null -ne $s) "long recording finishes (no stuck finalizing)"
    $clips = Get-ChildItem $tmpOut -Filter *.mp4 -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 100KB }
    Say (($clips | Measure-Object).Count -ge 1) "a playable-size clip was written" ("files: " + ((Get-ChildItem $tmpOut | ForEach-Object Name) -join ", "))
    $r = Cmd "record-stop" 6
    Say ($r -ne "TIMEOUT") "stop when nothing is recording is harmless" $r

    Write-Host "shortcuts and settings" -ForegroundColor Cyan
    foreach ($case in @(@{ hotkey = ""; record_hotkey = "" }, @{ hotkey = "Alt+Q"; record_hotkey = "Alt+R" }, @{ hotkey = "Ctrl+Alt+F9"; record_hotkey = "" }, @{ hotkey = "Mouse5"; record_hotkey = "Alt+R" })) {
        WriteConfig $case
        $r = Cmd "reload" 8
        $s = Status
        Say ($r -ne "TIMEOUT" -and $null -ne $s) ("reload with hotkey='" + $case.hotkey + "' record='" + $case.record_hotkey + "' keeps answering") $r
    }
    WriteConfig @{ hotkey = "Alt+Q"; record_hotkey = "Alt+R" }
    1..5 | ForEach-Object { Cmd "reload" 6 | Out-Null }
    Say ($null -ne (Status)) "five reloads in a row"

    Write-Host "settings that restart the session" -ForegroundColor Cyan
    foreach ($case in @(@{ fps = 60 }, @{ fps = 30; width = 1280 }, @{ width = 1920; buffer_seconds = 30 }, @{ buffer_seconds = 120; game_only = $true }, @{ game_only = $false })) {
        WriteConfig $case
        Cmd "reload" 8 | Out-Null
        Start-Sleep 4
        $s = Status
        Say ($null -ne $s) ("after changing " + (($case.Keys | ForEach-Object { "$_=$($case[$_])" }) -join ", ") + " still answers")
    }
    $s = WaitFor { param($s) $s.recording -or $s.idle } 25
    Say ($null -ne $s) "ends up recording or waiting, not stuck"

    Write-Host "bad input" -ForegroundColor Cyan
    foreach ($c in @("", "nonsense", "SAVE", "status extra", ("x" * 5000))) {
        $r = Cmd $c 5
        Say ($r -ne "TIMEOUT") ("command '" + ($c.Substring(0, [Math]::Min(12, $c.Length))) + "' does not hang the server")
    }
    Say ($null -ne (Status)) "still answering after bad input"

    Write-Host "shutdown" -ForegroundColor Cyan
    Cmd "quit" 5 | Out-Null
    $end = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $end -and (Get-Process buffer-recorder -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 500 }
    Say (-not (Get-Process buffer-recorder -ErrorAction SilentlyContinue)) "quit exits within 15 s"
}
finally {
    StopRecorder
    if ($hadCfg) { [IO.File]::WriteAllBytes($cfgPath, $backup) } elseif (Test-Path $cfgPath) { Remove-Item $cfgPath -Force }
    Write-Host ""
    Write-Host ("Config restored. Test recordings are in " + $tmpOut) -ForegroundColor DarkGray
}
if ($script:fail -gt 0) { Write-Host ("`n$($script:fail) check(s) FAILED") -ForegroundColor Red; exit 1 }
Write-Host "`nAll checks passed" -ForegroundColor Green
