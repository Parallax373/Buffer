# Turns release-notes/<version>.md into the two texts a release needs (format: release-notes/TEMPLATE.md):
#   the GitHub release body (Markdown, with the install note and the installer hash as a footer) and
#   the in-app notes for latest.json (plain text: the update popover shows no Markdown).
#   .\scripts\release-notes.ps1 -Version 0.4.0                          # check the file, print both texts
#   .\scripts\release-notes.ps1 -Version 0.4.0 -Installer <exe> -GithubOut body.md -AppOut app.txt
param(
    [Parameter(Mandatory)][string]$Version,
    [string]$Installer = "",
    [string]$GithubOut = "",
    [string]$AppOut = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$Version = $Version.TrimStart("v")
$file = Join-Path $root "release-notes/$Version.md"
if (-not (Test-Path $file)) { throw "No release notes: write release-notes/$Version.md (copy release-notes/TEMPLATE.md)" }

# read as UTF-8 explicitly: Windows PowerShell 5.1 reads BOM-less files as ANSI
$lines = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8) -split "`r?`n"
$sections = @("New", "Improved", "Fixed", "Removed", "Heads-up")
$summary = $null
$current = $null
$items = [ordered]@{}
foreach ($raw in $lines) {
    $line = $raw.TrimEnd()
    if (-not $line.Trim() -or $line -match '^\s*<!--.*-->\s*$') { continue }
    if ($line -match '^##\s+(.+)$') {
        $current = $Matches[1].Trim()
        if ($sections -notcontains $current) { throw "release-notes/$Version.md: unknown section '## $current' (use: $($sections -join ', '))" }
        if (-not $items.Contains($current)) { $items[$current] = New-Object System.Collections.ArrayList }
        continue
    }
    if ($line -match '^#') { throw "release-notes/$Version.md: only '## <section>' headings are used, found '$line'" }
    if (-not $current) {
        if ($summary) { throw "release-notes/$Version.md: the summary is one line; put the rest under a section" }
        $summary = $line.Trim()
        continue
    }
    if ($line -match '^\s*-\s+(.+)$') { [void]$items[$current].Add($Matches[1].Trim()); continue }
    if ($line -match '^\s+(\S.*)$' -and $items[$current].Count) {
        # a wrapped bullet continues on an indented line
        $items[$current][$items[$current].Count - 1] += " " + $Matches[1].Trim()
        continue
    }
    throw "release-notes/$Version.md: under '## $current' every line is a '- ' bullet, found '$line'"
}
if (-not $summary) { throw "release-notes/$Version.md: the first line is a one-sentence summary" }
$empty = @($items.Keys | Where-Object { -not $items[$_].Count })
if ($empty) { throw "release-notes/$Version.md: empty section(s): $($empty -join ', ')" }
if (-not $items.Count) { throw "release-notes/$Version.md: no sections; add at least '## New', '## Improved' or '## Fixed'" }

# sections always come out in the fixed order, whatever order they were written in
$order = @($sections | Where-Object { $items.Contains($_) })

$gh = New-Object System.Text.StringBuilder
[void]$gh.AppendLine($summary).AppendLine()
foreach ($s in $order) {
    [void]$gh.AppendLine("### $s")
    foreach ($i in $items[$s]) { [void]$gh.AppendLine("- $i") }
    [void]$gh.AppendLine()
}
[void]$gh.AppendLine("---").AppendLine()
[void]$gh.AppendLine("**Install:** Windows 10/11 x64. Run the installer: no questions are asked, ffmpeg is included, and the first-run setup opens when it finishes. Existing installs offer this update by themselves.")
if ($Installer) {
    $hash = (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLower()
    [void]$gh.AppendLine().AppendLine("SHA-256 of ``$(Split-Path $Installer -Leaf)``: ``$hash``")
}

# the popover is plain text: no Markdown marks, the summary first so a cut-off still says the main thing
$plain = { param($t) ($t -replace '\*\*(.+?)\*\*', '$1' -replace '`([^`]+)`', '$1' -replace '\[([^\]]+)\]\([^)]+\)', '$1') }
$app = New-Object System.Text.StringBuilder
[void]$app.Append((& $plain $summary))
foreach ($s in $order) {
    [void]$app.AppendLine().AppendLine().Append($s)
    # the bullet as a char code: Windows PowerShell 5.1 reads this script as ANSI
    foreach ($i in $items[$s]) { [void]$app.AppendLine().Append([string][char]0x2022 + " " + (& $plain $i)) }
}

$utf8 = New-Object Text.UTF8Encoding $false
if ($GithubOut) { [IO.File]::WriteAllText($GithubOut, $gh.ToString(), $utf8) }
if ($AppOut) { [IO.File]::WriteAllText($AppOut, $app.ToString(), $utf8) }
if (-not $GithubOut -and -not $AppOut) {
    Write-Host "--- GitHub release body ---" -ForegroundColor Cyan
    Write-Host $gh.ToString()
    Write-Host "--- In-app notes (latest.json) ---" -ForegroundColor Cyan
    Write-Host $app.ToString()
}
