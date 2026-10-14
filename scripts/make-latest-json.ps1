# Writes latest.json, the feed the in-app updater reads (it is attached to every GitHub release).
#   .\scripts\make-latest-json.ps1 -Version 0.2.0 -Installer target\release\bundle\nsis\Buffer_0.2.0_x64-setup.exe -Notes "What changed"
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Installer,
    [string]$Notes = "",
    [string]$Repo = "Wheatlay/Buffer",
    [string]$Out = "latest.json"
)
$ErrorActionPreference = "Stop"
$sigFile = "$Installer.sig"
if (-not (Test-Path $sigFile)) { throw "Missing $sigFile (build with -Sign)" }
$name = Split-Path $Installer -Leaf
$feed = [ordered]@{
    version  = $Version.TrimStart("v")
    notes    = $Notes
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = (Get-Content $sigFile -Raw).Trim()
            url       = "https://github.com/$Repo/releases/download/v$($Version.TrimStart('v'))/$([uri]::EscapeDataString($name))"
        }
    }
}
# no BOM: the updater's JSON parser rejects one
[IO.File]::WriteAllText((Join-Path (Get-Location) $Out), ($feed | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
Write-Host "Wrote $Out for $($feed.version)"
