# Fast inner loop. UI files (ui/) are served live: save a file, the window reloads - no Rust build.
# Rust changes rebuild incrementally in debug mode (a few seconds instead of minutes of LTO).
#   .\scripts\dev.ps1            # app + debug recorder
param([switch]$NoRecorder)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $NoRecorder) {
    cargo build -p ml-recorder          # target\debug\buffer-recorder.exe, found next to the dev app
    if ($LASTEXITCODE -ne 0) { throw "recorder build failed" }
}
npx tauri dev --config src-tauri/tauri.dev.conf.json
