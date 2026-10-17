# Third-party software

Buffer's own code is MIT-licensed (see `LICENSE`). The installer also ships, or builds on, the following.

## FFmpeg (shipped as `ffmpeg.exe`)
Buffer starts FFmpeg as a separate program for recording, trimming and exporting; it is not linked into Buffer.
The bundled build is a trimmed build of **FFmpeg 9.0.2** made from the unmodified upstream release, with only the
components Buffer uses (capture, NVENC/AMF/QuickSync/x264 encoding, AAC, MP4/MKV/MPEG-TS, common decoders and the
exporter's filters). It is licensed under the **GNU GPL v3** because it includes **x264** (GPL v2 or later) and
FFmpeg's GPL parts; it also links **dav1d** (BSD 2-clause), the NVIDIA/AMD/Intel encoder headers and **oneVPL**
(MIT). `FFMPEG-LICENSE.txt` is installed next to `ffmpeg.exe`.

* FFmpeg project and source code: https://ffmpeg.org/ (the exact tarball: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz)
* How the binary is built (every `configure` option): [scripts/build-ffmpeg-min.sh](scripts/build-ffmpeg-min.sh)
* The binary itself, with its SHA-256: the `ffmpeg-9.0.2-min-1` release of this repository
* x264: https://www.videolan.org/developers/x264.html, dav1d: https://code.videolan.org/videolan/dav1d

That script plus the upstream tarball is the complete corresponding source for the shipped `ffmpeg.exe`. If you
redistribute Buffer's installer you also redistribute that FFmpeg build and must keep these notices and make the
corresponding source available (the links above satisfy this for the unmodified build). The full gyan.dev
"release essentials" build can still be used instead: `scripts\fetch-ffmpeg.ps1 -Essentials`.

## Equalizer APO (not shipped; installed on request)
The live EQ is processed by **Equalizer APO** (GNU GPL v2), a separate program that runs inside the Windows audio
engine. Buffer does not include or link it: when you turn the EQ on, Buffer downloads the official
`EqualizerAPO-x64-1.4.2.exe` from SourceForge, checks its SHA-256 and runs it, and afterwards only writes its own
`buffer.txt` into Equalizer APO's config folder. Uninstalling Buffer removes that file and its include line, not
Equalizer APO. Project and source code: https://sourceforge.net/projects/equalizerapo/

## OpenRGB (not shipped; downloaded on request)
The RGB page controls lights through **OpenRGB** (GNU GPL v2), a separate program. Buffer does not include or link
it: when you click "Enable RGB", Buffer downloads the official `OpenRGB_1.0_Windows_64_81bbe18.zip` from the OpenRGB
GitHub release, checks its SHA-256, unpacks it into its own data folder and runs it as a hidden background program
that Buffer talks to over a local socket (127.0.0.1:6742). It is stopped when Buffer exits. Project and source code:
https://gitlab.com/CalcProgrammer1/OpenRGB

## LibreHardwareMonitor and PawnIO (fan control; not shipped, installed on request)
The Fans page reads sensors and sets fan speeds through **LibreHardwareMonitorLib** (Mozilla Public License 2.0), used unmodified inside
a small helper program, `buffer-fans.exe`, that is built from `helpers/fans` in this repository (C#, .NET 8, published self-contained) and
installed into `%ProgramFiles%\Buffer\Fans` only when you click "Enable fans". The helper runs as a separate process that Buffer talks to
over a named pipe only you can open. Hardware access on the motherboard goes through the **PawnIO** driver (GPL-2.0, by namazso), which
Buffer installs from its official signed installer (SHA-256 checked) only when it is missing and never removes. LibreHardwareMonitor and the
.NET runtime files are included in the helper's zip with their licences; project and source: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor,
https://github.com/namazso/PawnIO. Buffer's importer reads (never runs) FanControl's `userConfig.json`.

## AutoEq headphone profiles (downloaded on request)
The headphone search reads the results of **AutoEq** by Jaakko Pasanen (MIT) from GitHub when you use it:
https://github.com/jaakkopasanen/AutoEq

## Application framework and runtime
* **Tauri** (MIT or Apache-2.0) and its plugins (dialog, drag, single-instance, updater): https://tauri.app/
* **Microsoft Edge WebView2 Runtime**, used to display the interface; installed by Windows or by the installer
  under Microsoft's own terms: https://developer.microsoft.com/microsoft-edge/webview2/
* **NSIS** (installer toolkit; zlib/bzip2/CPL terms): https://nsis.sourceforge.io/

## Fonts (bundled, SIL Open Font License 1.1)
* **Instrument Sans**, © the Instrument Sans Project Authors
* **JetBrains Mono**, © 2020 The JetBrains Mono Project Authors

The OFL permits bundling and redistribution with software; the fonts are not sold separately.

## Rust libraries
Buffer is built from open-source Rust crates (for example `wasapi`, `tray-icon`, `windows-sys`, `serde`, `clap`,
`trash`). Their exact versions are pinned in `Cargo.lock`; list their licences with
`cargo install cargo-license` and `cargo license`.
