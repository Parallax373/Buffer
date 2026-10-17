# Builds the Windows installer end to end:
#   ffmpeg (fetched + checksum-verified) -> recorder -> app -> NSIS package.
# Requirements: Rust (msvc) + VS Build Tools, Node. Nothing else: ffmpeg ships inside the installer.
#
#   .\build-installer.ps1          # plain installer (what you test locally)
#   .\build-installer.ps1 -Sign    # release build: also produces the signed update package (.sig) that the
#                                  # in-app updater verifies. Needs the updater key, see RELEASING.md.
#   .\build-installer.ps1 -Fast   # thin LTO + parallel codegen: several times faster to build, a few % slower code.
#                                  # For quick local releases; CI and signed releases use the full profile.
param([switch]$Sign, [switch]$Fast)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if ($Fast) {
    $env:CARGO_PROFILE_RELEASE_LTO = "thin"
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "16"
}

& "$PSScriptRoot\scripts\fetch-ffmpeg.ps1"
# the fan helper (C#, LibreHardwareMonitor) ships inside the installer as a zip: nothing to host or download
& "$PSScriptRoot\scripts\build-fans-helper.ps1"
if ($LASTEXITCODE -ne 0) { throw "fan helper build failed" }

# The installer writes ffmpeg.exe itself (hooks.nsh) and skips it when the installed copy is the same build:
# hand it the hash and the path.
$ffmpegExe = (Resolve-Path (Join-Path $PSScriptRoot "vendor\ffmpeg\ffmpeg.exe")).Path
$ffmpegId = (Get-FileHash $ffmpegExe -Algorithm SHA256).Hash.ToLower()
@("!define FFMPEG_ID `"$ffmpegId`"", "!define FFMPEG_SRC `"$ffmpegExe`"") |
    Set-Content (Join-Path $PSScriptRoot "src-tauri\windows\ffmpeg.nsh") -Encoding ASCII

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

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
# the folder keeps older installers: take the one of this version
$installer = Get-ChildItem target\release\bundle\nsis\*_${version}_*.exe | Select-Object -First 1
if (-not $installer) { throw "installer not found" }
Write-Host ("Installer: {0} ({1:N1} MB)" -f $installer.FullName, ($installer.Length / 1MB))
if ($Sign) {
    if (-not (Test-Path "$($installer.FullName).sig")) { throw "update signature was not produced" }
    Write-Host "Update signature: $($installer.FullName).sig"
}
