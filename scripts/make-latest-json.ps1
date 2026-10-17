# Writes latest.json, the feed the in-app updater reads (it is attached to every GitHub release).
#   .\scripts\make-latest-json.ps1 -Version 0.2.0 -Installer target\release\bundle\nsis\Buffer_0.2.0_x64-setup.exe -NotesFile app-notes.txt
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Installer,
    [string]$Notes = "",
    [string]$NotesFile = "",   # the in-app text from release-notes.ps1 -AppOut; wins over -Notes
    [string]$Repo = "Wheatlay/Buffer",
    [string]$Out = "latest.json"
)
$ErrorActionPreference = "Stop"
$sigFile = "$Installer.sig"
if (-not (Test-Path $sigFile)) { throw "Missing $sigFile (build with -Sign)" }
if ($NotesFile) { $Notes = [IO.File]::ReadAllText($NotesFile, [Text.Encoding]::UTF8) }
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
