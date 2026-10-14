# Builds the Windows installer end to end:
#   ffmpeg (fetched + checksum-verified) -> recorder -> app -> NSIS package.
# Requirements: Rust (msvc) + VS Build Tools, Node. Nothing else: ffmpeg ships inside the installer.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

& "$PSScriptRoot\scripts\fetch-ffmpeg.ps1"

cargo build --release -p ml-recorder
if ($LASTEXITCODE -ne 0) { throw "recorder build failed" }

npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

npx tauri build
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$installer = Get-ChildItem target\release\bundle\nsis\*.exe | Select-Object -First 1
if (-not $installer) { throw "installer not found" }
Write-Host ("Installer: {0} ({1:N1} MB)" -f $installer.FullName, ($installer.Length / 1MB))
