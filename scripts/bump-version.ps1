# Sets the app version everywhere it lives (tauri.conf.json, the Cargo workspace, package.json).
#   .\scripts\bump-version.ps1 0.2.0
param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Use a plain semantic version like 0.2.0" }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$utf8 = New-Object Text.UTF8Encoding $false

# Replaces only the first match (Windows PowerShell 5.1's -replace has no count argument).
function Set-First([string]$Path, [string]$Pattern, [string]$Replacement) {
    $text = [IO.File]::ReadAllText("$root\$Path")
    $re = New-Object Text.RegularExpressions.Regex($Pattern)
    if (-not $re.IsMatch($text)) { throw "No version found in $Path" }
    [IO.File]::WriteAllText("$root\$Path", $re.Replace($text, $Replacement, 1), $utf8)
}

Set-First "src-tauri\tauri.conf.json" '"version":\s*"[^"]+"' "`"version`": `"$Version`""
Set-First "Cargo.toml" '(?m)^version = "[^"]+"' "version = `"$Version`""
Set-First "package.json" '"version":\s*"[^"]+"' "`"version`": `"$Version`""

# package-lock.json repeats the app version twice (top level and packages[""]); it drifted to 3.1.0 once
$lock = [IO.File]::ReadAllText("$root\package-lock.json")
$lockRe = New-Object Text.RegularExpressions.Regex('("name":\s*"buffer",\s*"version":\s*)"[^"]+"')
[IO.File]::WriteAllText("$root\package-lock.json", $lockRe.Replace($lock, "`$1`"$Version`""), $utf8)

Write-Host "Version is now $Version. Releases need release-notes/$Version.md (format: release-notes/TEMPLATE.md)."
