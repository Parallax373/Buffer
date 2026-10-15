# One step release: bump the version, commit, push and tag. GitHub then builds, signs and publishes the
# installer (about 10 minutes) and installed copies offer the update by themselves.
#   .\scripts\release.ps1            # next patch version (0.2.3 -> 0.2.4)
#   .\scripts\release.ps1 0.3.0      # a specific version
#   .\scripts\release.ps1 -DryRun    # run every check and show what would happen, change nothing
#   .\scripts\release.ps1 -Local     # build here (tests, thin LTO, ~3 min) and publish from this machine instead of GitHub
param([string]$Version = "", [switch]$DryRun, [switch]$Local, [string]$Notes = "", [switch]$Ask)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# -Ask: used by the VS Code status bar buttons, so a stray click cannot release anything
if ($Ask -and -not $DryRun) {
    $what = if ($Local) { "built on this PC (about 3 minutes)" } else { "built by GitHub (about 10 minutes)" }
    $answer = Read-Host "Release the committed state as the next version, $what. Type YES to continue"
    if ($answer -ne "YES") { Write-Host "Cancelled, nothing was released." -ForegroundColor Yellow; exit 0 }
}

function Fail($msg) { Write-Host ""; Write-Host "NOT RELEASED: $msg" -ForegroundColor Red; exit 1 }
function Invoke-Git([string[]]$a) {
    & git @a
    if ($LASTEXITCODE -ne 0) { Fail "git $($a -join ' ') failed (exit $LASTEXITCODE). Nothing was tagged after this point." }
}
function Check($ok, $label, $detail = "") {
    if ($ok) { Write-Host ("  ok    " + $label) -ForegroundColor Green } else { Fail "$label  $detail" }
}

Write-Host "Checks" -ForegroundColor Cyan
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Check ($branch -eq "main") "on branch main" "(you are on '$branch')"
$dirty = git status --porcelain | Where-Object { $_ -notmatch 'Cargo\.lock|package-lock\.json' }
Check (-not $dirty) "everything is committed" "Uncommitted changes: commit them first.`n$($dirty -join "`n")"
git fetch origin --quiet
Check ($LASTEXITCODE -eq 0) "GitHub is reachable"
$behind = [int](git rev-list --count HEAD..origin/main)
Check ($behind -eq 0) "nothing newer on GitHub" "origin/main has $behind newer commit(s); pull first."

$current = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
if (-not $Version) {
    $p = $current.Split('.')
    $Version = "$($p[0]).$($p[1]).$([int]$p[2] + 1)"
}
Check ($Version -match '^\d+\.\d+\.\d+$') "version '$Version' looks right"
$tag = "v$Version"
Check (-not (git tag --list $tag)) "tag $tag does not exist yet"
Check (-not (git ls-remote --tags origin $tag)) "tag $tag is not on GitHub yet"
Check ((Test-Path "$env:USERPROFILE\.buffer-release\updater.key") -or $true) "signing is done by GitHub (secrets set)"
$secrets = (gh secret list 2>$null) -join " "
Check ($secrets -match "TAURI_SIGNING_PRIVATE_KEY") "GitHub signing secrets exist" "run: gh secret set TAURI_SIGNING_PRIVATE_KEY"
Write-Host ""
Write-Host "Releasing $current -> $Version" -ForegroundColor Cyan

if ($DryRun) {
    Write-Host "Dry run: nothing changed. A real run would now bump the version, commit, push main and push tag $tag." -ForegroundColor Yellow
    exit 0
}

& "$root\scripts\bump-version.ps1" $Version
if ($LASTEXITCODE -ne 0) { Fail "bump-version failed" }
Invoke-Git @("add", "-A")
Invoke-Git @("commit", "-m", "Release $Version")
Invoke-Git @("push", "origin", "main")
if ($Local) {
    # build and publish from this machine; the release creates the tag (the workflow sees the release and stops)
    Write-Host ""
    Write-Host "Building locally (tests, then thin LTO) and publishing $tag ..." -ForegroundColor Cyan
    & "$root\scripts\publish.ps1" -Notes $Notes
    if ($LASTEXITCODE -ne 0) { Fail "publish failed after the version commit was pushed; run scripts\publish.ps1 to retry" }
    git fetch origin --tags --quiet
    Write-Host ""
    Write-Host "Published $tag from this machine. Installed copies offer the update within a day, or Settings > App > Check for updates." -ForegroundColor Green
    exit 0
}
Invoke-Git @("tag", $tag)
Invoke-Git @("push", "origin", $tag)
Write-Host ""
Write-Host "Pushed $tag. GitHub is building it now: https://github.com/Wheatlay/Buffer/actions" -ForegroundColor Green
Write-Host "In about 10 minutes your installed Buffer shows the update chip (or Settings > App > Check for updates)."
