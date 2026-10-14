# Builds the Windows installer end to end:
#   ffmpeg (fetched + checksum-verified) -> recorder -> app -> NSIS package.
# Requirements: Rust (msvc) + VS Build Tools, Node. Nothing else: ffmpeg ships inside the installer.
#
#   .\build-installer.ps1          # plain installer (what you test locally)
#   .\build-installer.ps1 -Sign    # release build: also produces the signed update package (.sig) that the
#                                  # in-app updater verifies. Needs the updater key, see RELEASING.md.
param([switch]$Sign)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

& "$PSScriptRoot\scripts\fetch-ffmpeg.ps1"

cargo build --release -p ml-recorder
if ($LASTEXITCODE -ne 0) { throw "recorder build failed" }

npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

$tauriArgs = @()
if ($Sign) {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        # local fallback: the key lives outside the repository
        $keyDir = Join-Path $env:USERPROFILE ".buffer-release"
        $keyFile = Join-Path $keyDir "updater.key"
        if (-not (Test-Path $keyFile)) { throw "No updater key: set TAURI_SIGNING_PRIVATE_KEY or create $keyFile (see RELEASING.md)" }
        $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyFile -Raw).Trim()
        $pwFile = Join-Path $keyDir "updater.pw"
        if ((Test-Path $pwFile) -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $pwFile -Raw).Trim()
        }
    }
    $tauriArgs += @("--config", "src-tauri/tauri.release.conf.json")
}

npx tauri build @tauriArgs
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$installer = Get-ChildItem target\release\bundle\nsis\*.exe | Select-Object -First 1
if (-not $installer) { throw "installer not found" }
Write-Host ("Installer: {0} ({1:N1} MB)" -f $installer.FullName, ($installer.Length / 1MB))
if ($Sign) {
    if (-not (Test-Path "$($installer.FullName).sig")) { throw "update signature was not produced" }
    Write-Host "Update signature: $($installer.FullName).sig"
}
