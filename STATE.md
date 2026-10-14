# Moments Lite — project state

A small, reliable Windows replacement for the SteelSeries GG "Moments" clip recorder and editor:
no bloat, no launcher/update breakage, a richer editor, and a size-targeted exporter (e.g. for Discord).

## Layout
- `crates/ml-core` — probe + export (ffmpeg wrapper: target size, trim, 16:9 crop, speed, loudness, NVENC).
- `crates/ml-cli` — `ml` command line over ml-core.
- `crates/ml-recorder` — background recorder (separate process, tray icon, global hotkey).
- `src-tauri` + `ui/` — Tauri v2 app; plain HTML/CSS/JS, no bundler. Fonts are bundled in `ui/fonts`.
- `build-installer.ps1` — builds recorder + app + NSIS installer (`target/release/bundle/nsis`).

## Recorder (always-on)
- ffmpeg `ddagrab` + NVENC → rolling 2-second MPEG-TS segments in `%LOCALAPPDATA%\moments-lite\buffer`.
- Audio is captured by the recorder itself via WASAPI (Game and Chat as loopback of playback endpoints, Mic as
  capture), fed to ffmpeg at real-time rate (zeros while silent/unplugged) so streams never desync or stall.
- Save (hotkey / tray / UI) joins the last N seconds byte-wise (`concat:` protocol) and remuxes to MP4 with three
  audio tracks tagged `Game`/`Chat`/`Mic` — the same layout as SteelSeries clips. File name `Game__YYYY-MM-DD__HH-MM-SS.mp4`
  (game = executable name of the foreground window, or `Desktop`; map names in `recorder.json: game_names`).
- Reliability: supervisor restarts ffmpeg with back-off; audio sources reconnect every 2 s; single-instance mutex;
  ffmpeg lives in a kill-on-close job object; tray icon is green (all live) / amber (a source is down) / red (stopped).
- Config: `%APPDATA%\moments-lite\recorder.json` (UI: Ustawienia → Nagrywanie). fps, width, bitrate, buffer length,
  monitor, hotkey, devices, audio offset (ms). Control: `ml-recorder status|save|reload|quit` on 127.0.0.1:47821.
- Autostart: HKCU Run key (`ml-recorder install-autostart`), done by the installer and by Settings.

## UI (design handoff "Moments Lite")
Library (virtualised grid, lazy thumbnails, categories/games/favourites, bulk bar, details panel),
Editor (preview with per-track gain, waveforms, trim, 16:9 crop, speed, loudness, export panel, drag-out),
Exports (history, drag-out), Settings (Nagrywanie, Wygląd, Ogólne, Eksport, Skróty, Zaawansowane).
Favourites/exports/settings persist in `%APPDATA%\moments-lite\app-state.json`.

## Distribution
- `build-installer.ps1` fetches a checksum-verified static ffmpeg (vendor/, not committed), builds the recorder and app,
  and produces a ~30 MB NSIS installer: per-user, no questions asked, ffmpeg + recorder inside, app opens its first-run
  wizard when done. Custom template: `src-tauri/windows/installer.nsi` (forced passive mode + auto-launch).
- Publish: `scripts/publish.ps1` (GitHub Release via gh) or push a `v*` tag (`.github/workflows/release.yml`).
- ffmpeg is GPL; `FFMPEG-LICENSE.txt` is shipped next to it.

## Audio sources
Each of Game/Chat/Mic has a primary and an optional secondary device (id + name). Rules live in `pick.rs` (unit-tested):
primary, else secondary, else wait. A configured-but-missing device never silently becomes the Windows default and
settings are never rewritten by plug/unplug; the primary wins again as soon as it returns.

## Not verified by hand / known gaps
- The installer itself was built but not run end-to-end on a clean machine (no sandbox available here).
- Lip-sync of recorded clips (audio vs video) — durations match to ~5 ms and there is an `audio_offset_ms` knob.
- Tray menu, global hotkey, popup over a real game, drag-out to Discord were not exercised by hand.
- Popup cannot appear above exclusive-fullscreen games (borderless is fine); windowed games need "Dodatkowe gry".
- Not done: multi-cut/join, captions, import of SteelSeries-saved edits.
