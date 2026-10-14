# Third-party software

Buffer's own code is MIT-licensed (see `LICENSE`). The installer also ships, or builds on, the following.

## FFmpeg (shipped as `ffmpeg.exe`)
Buffer starts FFmpeg as a separate program for recording, trimming and exporting; it is not linked into Buffer.
The bundled build is the "release essentials" build from gyan.dev, which is licensed under the **GNU GPL v3**
(`FFMPEG-LICENSE.txt` is installed next to `ffmpeg.exe`).

* FFmpeg project and source code: https://ffmpeg.org/ (source: https://ffmpeg.org/download.html#get-sources)
* Build used, with its configuration and the matching source references: https://www.gyan.dev/ffmpeg/builds/

If you redistribute Buffer's installer you also redistribute that FFmpeg build and must keep these notices and make the
corresponding FFmpeg source available (the links above satisfy this for the unmodified build).

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
