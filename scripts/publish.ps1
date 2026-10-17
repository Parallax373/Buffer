# Publishes a signed installer as a GitHub Release (uses the logged-in `gh`) together with latest.json,
# the feed existing installs read to offer the update.
#   .\scripts\publish.ps1                         # builds, tags v<version from tauri.conf.json>, uploads
# The notes are release-notes/<version>.md (format: release-notes/TEMPLATE.md), checked before anything is built.
#   .\scripts\publish.ps1 -SkipBuild -Draft       # reuse the installer that is already built, leave it unpublished
# Local releases build with the fast profile (thin LTO) and run the tests first; -Full builds like CI does
# (needed again once releases are code-signed through GitHub Actions), -SkipTests skips the test run.
# Bump the version first: .\scripts\bump-version.ps1 0.2.0
param([switch]$SkipBuild, [switch]$Draft, [switch]$Full, [switch]$SkipTests)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
# fail on missing or malformed notes now, not after a 3 minute build
& "$root\scripts\release-notes.ps1" -Version $version -GithubOut "$env:TEMP\buffer-notes-check.md" | Out-Null
if (-not $SkipBuild) {
    if (-not $SkipTests) {
        # same command as CI; the app crate needs resources only the installer build creates
        cargo test --workspace --exclude buffer
        if ($LASTEXITCODE -ne 0) { throw "tests failed, nothing was published" }
    }
    $ib = Join-Path $root "build-installer.ps1"
    if ($Full) { & $ib -Sign } else { & $ib -Sign -Fast }
}

$installer = Get-ChildItem target\release\bundle\nsis\*_${version}_*.exe | Select-Object -First 1
if (-not $installer) { throw "No installer found; run build-installer.ps1 -Sign first." }
if (-not (Test-Path "$($installer.FullName).sig")) { throw "No update signature next to the installer; build with -Sign." }
if ($installer.Name -notmatch [regex]::Escape($version)) { throw "Installer $($installer.Name) does not match version $version" }

$feedDir = Join-Path $root "target\release\bundle\feed"
New-Item -ItemType Directory -Force $feedDir | Out-Null
# the notes come from release-notes/<version>.md, the same way the GitHub workflow builds them
& "$root\scripts\release-notes.ps1" -Version $version -Installer $installer.FullName `
    -GithubOut "$feedDir\release-body.md" -AppOut "$feedDir\app-notes.txt"
Push-Location $feedDir
& "$root\scripts\make-latest-json.ps1" -Version $version -Installer $installer.FullName -NotesFile "$feedDir\app-notes.txt"
Pop-Location

$ghArgs = @("release", "create", $tag, $installer.FullName, "$($installer.FullName).sig", "$feedDir\latest.json",
    "--title", "Buffer $version", "--notes-file", "$feedDir\release-body.md")
if ($Draft) { $ghArgs += "--draft" }
gh @ghArgs
if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
Write-Host "Published $tag"
