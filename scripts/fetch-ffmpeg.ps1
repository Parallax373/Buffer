# Puts a single static ffmpeg.exe into vendor\ffmpeg\ so the installer can ship it.
# Source: gyan.dev "release essentials" build (GPL; includes NVENC/AMF/QuickSync, ddagrab, gdigrab).
# The zip is verified against the published SHA-256 before anything is extracted.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "vendor\ffmpeg"
$exe  = Join-Path $dest "ffmpeg.exe"
if (Test-Path $exe) { Write-Host "ffmpeg already present: $exe"; return }

New-Item -ItemType Directory -Force $dest | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ("ml-ffmpeg-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $work | Out-Null
try {
    $url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    $zip = Join-Path $work "ffmpeg.zip"
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $expected = ((Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content -as [string]).Trim().Split()[0].ToLower()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw "SHA-256 mismatch for ffmpeg zip (expected $expected, got $actual)" }
    $out = Join-Path $work "x"
    Expand-Archive $zip -DestinationPath $out -Force
    $found = Get-ChildItem $out -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $found) { throw "ffmpeg.exe not found in the archive" }
    Copy-Item $found.FullName $exe -Force
    # keep the licence text next to the binary (GPL redistribution)
    $lic = Get-ChildItem $out -Recurse -Filter LICENSE* | Select-Object -First 1
    if ($lic) { Copy-Item $lic.FullName (Join-Path $dest "FFMPEG-LICENSE.txt") -Force }
    Write-Host ("ffmpeg ready: {0} ({1:N0} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
