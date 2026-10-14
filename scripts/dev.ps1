# Fast inner loop. UI files (ui/) are served live: save a file and the window reloads - no Rust build.
# Rust changes rebuild incrementally in debug mode (seconds instead of minutes of LTO).
#   .\scripts\dev.ps1                # debug recorder + app with live UI
#   .\scripts\dev.ps1 -NoRecorder    # app only (talks to an already running recorder)
# The installer is only for releases (build-installer.ps1 / publish.ps1).
param([switch]$NoRecorder)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $NoRecorder) {
    cargo build -p ml-recorder
    if ($LASTEXITCODE -ne 0) { throw "recorder build failed" }
    # Only one recorder may run (single-instance lock): replace an installed/old one with the debug build.
    Get-Process buffer-recorder -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    Start-Process (Resolve-Path "target\debug\buffer-recorder.exe") -ArgumentList "run" -WindowStyle Hidden
}
npx tauri dev --config src-tauri/tauri.dev.conf.json
