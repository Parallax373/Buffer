# Puts a single static ffmpeg.exe into vendor\ffmpeg\ so the installer can ship it.
# Source: the trimmed GPL build of FFmpeg 9.0.2 that Buffer publishes as the "ffmpeg-9.0.2-min-1" release of
# https://github.com/Wheatlay/Buffer (built with scripts/build-ffmpeg-min.sh, about 18 MB). Both files are
# verified against the SHA-256 pinned below before they are used.
#   .\scripts\fetch-ffmpeg.ps1            # the trimmed build
#   .\scripts\fetch-ffmpeg.ps1 -Essentials  # fallback: the full gyan.dev "release essentials" build (about 100 MB)
param([switch]$Essentials)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "vendor\ffmpeg"
$exe  = Join-Path $dest "ffmpeg.exe"
$marker = Join-Path $dest "source.txt"
$want = if ($Essentials) { "essentials" } else { "min-1" }
if ((Test-Path $exe) -and (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $want)) {
    Write-Host "ffmpeg already present ($want): $exe"; return
}

New-Item -ItemType Directory -Force $dest | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ("ml-ffmpeg-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $work | Out-Null

function Get-Verified($url, $sha256, $file) {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $sha256) { throw "SHA-256 mismatch for $url (expected $sha256, got $actual)" }
}

try {
    if ($Essentials) {
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
        $lic = Get-ChildItem $out -Recurse -Filter LICENSE* | Select-Object -First 1
        if ($lic) { Copy-Item $lic.FullName (Join-Path $dest "FFMPEG-LICENSE.txt") -Force }
    } else {
        $base = "https://github.com/Wheatlay/Buffer/releases/download/ffmpeg-9.0.2-min-1"
        $tmpExe = Join-Path $work "ffmpeg.exe"
        $tmpLic = Join-Path $work "FFMPEG-LICENSE.txt"
        Get-Verified "$base/ffmpeg.exe" "77cd0085e1d360df91395c0440e4d08d2afd964c071f15f61ecc3a482f989765" $tmpExe
        Get-Verified "$base/FFMPEG-LICENSE.txt" "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903" $tmpLic
        Copy-Item $tmpExe $exe -Force
        Copy-Item $tmpLic (Join-Path $dest "FFMPEG-LICENSE.txt") -Force
    }
    Set-Content -Path $marker -Value $want -Encoding ASCII
    Write-Host ("ffmpeg ready: {0} ({1:N0} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
