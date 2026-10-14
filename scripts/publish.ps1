# Publishes a signed installer as a GitHub Release (uses the logged-in `gh`) together with latest.json,
# the feed existing installs read to offer the update.
#   .\scripts\publish.ps1 -Notes "What changed"   # builds, tags v<version from tauri.conf.json>, uploads
#   .\scripts\publish.ps1 -SkipBuild -Draft       # reuse the installer that is already built, leave it unpublished
# Bump the version first: .\scripts\bump-version.ps1 0.2.0
param([string]$Notes = "", [switch]$SkipBuild, [switch]$Draft)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
if (-not $SkipBuild) { & "$root\build-installer.ps1" -Sign }

$installer = Get-ChildItem target\release\bundle\nsis\*_${version}_*.exe | Select-Object -First 1
if (-not $installer) { throw "No installer found; run build-installer.ps1 -Sign first." }
if (-not (Test-Path "$($installer.FullName).sig")) { throw "No update signature next to the installer; build with -Sign." }
if ($installer.Name -notmatch [regex]::Escape($version)) { throw "Installer $($installer.Name) does not match version $version" }

$feedDir = Join-Path $root "target\release\bundle\feed"
New-Item -ItemType Directory -Force $feedDir | Out-Null
Push-Location $feedDir
& "$root\scripts\make-latest-json.ps1" -Version $version -Installer $installer.FullName -Notes $Notes
Pop-Location

$hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower()
$body = @"
Buffer $version

$Notes

Windows 10/11 x64. Run the installer: no questions are asked, ffmpeg is included, and the first-run
setup opens when it finishes. Existing installs offer this update by themselves.

SHA-256 of $($installer.Name): $hash
"@

$ghArgs = @("release", "create", $tag, $installer.FullName, "$($installer.FullName).sig", "$feedDir\latest.json",
    "--title", "Buffer $version", "--notes", $body)
if ($Draft) { $ghArgs += "--draft" }
gh @ghArgs
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
Write-Host "Published $tag"
