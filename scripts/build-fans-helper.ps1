# Builds the fan helper (helpers/fans, LibreHardwareMonitorLib) into helpers/fans/dist/buffer-fans.zip and prints its SHA-256.
# The zip is what `ml-fans install` unpacks into Program Files; a release uploads it and pins that hash in ml-fans/src/install.rs.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$proj = Join-Path $root 'helpers\fans'
$out = Join-Path $proj 'dist'
$pub = Join-Path $proj 'publish'
Remove-Item -Recurse -Force $pub, $out -ErrorAction SilentlyContinue
dotnet publish (Join-Path $proj 'BufferFans.csproj') -c Release -o $pub
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }
# debugging and Mono leftovers the helper never loads
'mscordaccore*.dll', 'mscordbi.dll', 'libMonoPosixHelper.dll', 'Microsoft.DiaSymReader.Native.amd64.dll', 'createdump.exe', '*.pdb' |
  ForEach-Object { Get-ChildItem $pub -Filter $_ -ErrorAction SilentlyContinue | Remove-Item -Force }
New-Item -ItemType Directory -Force $out | Out-Null
$zip = Join-Path $out 'buffer-fans.zip'
$tar = Join-Path (Join-Path $env:SystemRoot 'System32') 'tar.exe'   # not Git's tar, which treats C: as a host
& $tar -a -c -f $zip -C $pub .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
'{0}  {1:N1} MB  sha256 {2}' -f $zip, ((Get-Item $zip).Length / 1MB), $sha
Remove-Item -Recurse -Force $pub
