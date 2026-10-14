# One step release: bump the version, commit, push and tag. GitHub then builds, signs and publishes the
# installer (about 10 minutes) and installed copies offer the update by themselves.
#   .\scripts\release.ps1            # next patch version (0.2.2 -> 0.2.3)
#   .\scripts\release.ps1 0.3.0      # a specific version
param([string]$Version = "")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (git status --porcelain | Where-Object { $_ -notmatch 'Cargo\.lock|package-lock\.json' }) {
    throw "There are uncommitted changes. Commit them first, then release."
}
$current = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
if (-not $Version) {
    $p = $current.Split('.')
    $Version = "$($p[0]).$($p[1]).$([int]$p[2] + 1)"
}
Write-Host "Releasing $current -> $Version"

& "$root\scripts\bump-version.ps1" $Version
git add -A
git commit -m "Release $Version"
git push origin main
git tag "v$Version"
git push origin "v$Version"
Write-Host ""
Write-Host "Pushed v$Version. GitHub is building it now: https://github.com/Wheatlay/Buffer/actions"
Write-Host "In about 10 minutes your installed Buffer shows the update chip (or Settings > App > Check for updates)."
