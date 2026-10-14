# Publishes the installer as a GitHub Release (uses the logged-in `gh`).
#   .\scripts\publish.ps1            # builds, tags v<version from tauri.conf.json>, uploads
#   .\scripts\publish.ps1 -SkipBuild # reuse the installer that is already built
# The version comes from src-tauri\tauri.conf.json; bump it (and the workspace version in Cargo.toml) first.
param([switch]$SkipBuild, [switch]$Draft)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
if (-not $SkipBuild) { & "$root\build-installer.ps1" }

$installer = Get-ChildItem target\release\bundle\nsis\*.exe | Select-Object -First 1
if (-not $installer) { throw "No installer found; run build-installer.ps1 first." }

$hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower()
$notes = @"
Buffer $version

Windows 10/11 x64. Run the installer: no questions are asked, ffmpeg is included, and the first-run
setup opens when it finishes (folder, audio sources, quality, shortcut).

SHA-256 of $($installer.Name): $hash
"@

$args = @("release", "create", $tag, $installer.FullName, "--title", "Buffer $version", "--notes", $notes)
if ($Draft) { $args += "--draft" }
gh @args
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
Write-Host "Published $tag"
