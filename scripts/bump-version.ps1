# Sets the app version everywhere it lives (tauri.conf.json, the Cargo workspace, package.json).
#   .\scripts\bump-version.ps1 0.2.0
param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Use a plain semantic version like 0.2.0" }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$utf8 = New-Object Text.UTF8Encoding $false
$conf = Get-Content src-tauri\tauri.conf.json -Raw
[IO.File]::WriteAllText("$root\src-tauri\tauri.conf.json", ($conf -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"", 1), $utf8)

$cargo = Get-Content Cargo.toml -Raw
[IO.File]::WriteAllText("$root\Cargo.toml", ($cargo -replace '(?m)^version = "[^"]+"', "version = `"$Version`"", 1), $utf8)

$pkg = Get-Content package.json -Raw
[IO.File]::WriteAllText("$root\package.json", ($pkg -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"", 1), $utf8)

Write-Host "Version is now $Version. Next: commit, then .\scripts\publish.ps1 -Notes '...'"
