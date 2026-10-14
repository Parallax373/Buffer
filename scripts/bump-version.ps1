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

Write-Host "Version is now $Version. Next: commit, then .\scripts\publish.ps1 -Notes '...'"
