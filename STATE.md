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
- ffmpeg `ddagrab` + a GPU encoder (NVENC, else AMF, else QuickSync, else x264) → rolling 2-second MPEG-TS segments in `%LOCALAPPDATA%\moments-lite\buffer`.
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
  and produces a ~9 MB NSIS installer: per-user, no questions asked, ffmpeg + recorder inside, app opens its first-run
  wizard when done. Custom template: `src-tauri/windows/installer.nsi` (forced passive mode + auto-launch).
- ffmpeg is our own trimmed build of FFmpeg 9.0.2 (~18 MB; `scripts/build-ffmpeg-min.sh`, MSYS2), published as the
  `ffmpeg-9.0.2-min-1` release and pinned by SHA-256 in `scripts/fetch-ffmpeg.ps1`. `fetch-ffmpeg.ps1 -Essentials` falls
  back to the full gyan.dev build (100 MB). A needed component missing from the trimmed build shows up as a runtime
  "decoder/encoder/filter not found": add it to the script, rebuild, bump the release tag and the pinned hash.
- The installer writes `ffmpeg.exe` itself (`src-tauri/windows/hooks.nsh`, hash marker `ffmpeg.id`): an update skips the
  write when the installed copy is the same build. `build-installer.ps1` generates `ffmpeg.nsh` (hash + path).
- Publish: `scripts/release.ps1 -Local` (build here, ~3 min, thin LTO, tests first) or `scripts/release.ps1` (tag; GitHub
  Actions builds it, ~10 min, full LTO). Only the CI path can be Authenticode-signed (SignPath).
- ffmpeg is GPL; `FFMPEG-LICENSE.txt` is shipped next to it.

## Encoders, bindings, long recording
- Encoder "auto": each candidate is probed with the recorder's real arguments (`encoder_usable`); a failing GPU encoder
  falls back to libx264 for the rest of the run (`Shared.encoder_override`, survives settings reloads). x264 is capped
  at 1080p30. Every encoder gets `-force_key_frames` so segments stay 2.0 s. AMF/QSV were NOT run on real hardware
  (only `ffmpeg -h encoder=` option names were checked); NVENC and x264 were.
- Bindings (`hotkey`, `marker_hotkey`, `record_hotkey`) are comma-separated: keyboard combo (RegisterHotKey, needs a
  restart), `Mouse3/4/5` with optional modifiers, `Pad:View+RB` chords (>= 2 buttons, XInput only). `input.rs` polls
  mouse/pad on its own thread (no hooks) and posts WM_HOTKEY to the tray thread; applied live. Pad path untested (no pad).
- Long recording (`longrec.rs`, Alt+R / tray / Settings button / `record-start|record-stop`): finished segments are
  appended to `<game>__<stamp>.rec.ts` next to the clips, remuxed to MP4 on stop (3 named tracks, no faststart).
  Restarts/reloads are held back until it ends; `game_only` idle is overridden; stops itself below 2 GB free;
  orphaned `.rec.ts` files are recovered at recorder start.

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

## Languages (i18n)
- UI text lives in `ui/js/locales/<code>.js` (en = master/fallback, pl, de, es, fr, uk, tr, ja, zh); `ui/js/i18n.js` provides
  `App.t(key, vars)` (`{name}` placeholders, plural objects via `Intl.PluralRules`). Call `App.t()` at draw time, never at script load:
  the language is known only after the saved state loads.
- English is the default (`settings.lang`). The OS language is only *suggested*: a link on wizard step 1 for new users, a one-time
  dismissible bar for returning users (`settings.langHint` = handled). Switching saves state and reloads the window.
- All catalogs except `pl` are AI-translated; Settings → App → Language shows a small "AI-translated" note for them (`ai: true`).
- Add a key to `en.js` first, then every locale; `node scripts/check-i18n.js` checks key/placeholder/plural parity.
- The recorder (tray menu, tooltip, popups, overlay) uses `crates/ml-recorder/src/lang.rs` (same 9 languages); the app writes `lang` into recorder.json on boot and on language switch.
