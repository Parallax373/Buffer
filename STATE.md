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

## Live EQ (Sonar-like, on top of Equalizer APO)
- Equalizer APO (free, GPL, not bundled) does all DSP inside the Windows audio engine: no added latency, works with
  Buffer closed. Optional: first-run wizard step "EQ" (off by default) or the EQ page installs the pinned
  `EqualizerAPO-x64-1.4.2.exe` (SHA-256 checked, UAC) — `src-tauri/src/eq.rs`.
- `crates/ml-eq`: model (7 bands × 7 shapes, per-output System EQ + one Mic EQ, AutoEQ headphone stage, user and
  per-game presets), `buffer.txt` writer, RBJ curve maths (mirrored in `ui/js/eq.js`), registry detection.
- The **recorder is the only writer** of `%APPDATA%\moments-lite\eq.json` and `<APO>\config\buffer.txt`
  (control commands `eq-get|eq-set|eq-bypass|eq-solo|eq-preset|eq-status|eq-outputs|eq-output|eq-listen`).
  The app goes through `recorder_cmd`; uninstall runs `buffer-recorder eq-unhook`.
- Measured on a real install (2026-10-16): APO's config folder is writable by Users (no elevation after install);
  the audio engine can NOT read an include under the user profile (so buffer.txt lives in APO's folder); APO
  hot-reloads an edited include in < 1 s; `Device: {endpoint guid}` scopes lines; all 7 generated filter lines work.
  Hooking in replaces APO's stock config (it only adds -6 dB) with `Include: buffer.txt`, otherwise appends the line.
- One `Device:` section per output, so the EQ follows the Windows default output by itself. Output switch
  binding `output_hotkey` + tray "Output" submenu use the undocumented IPolicyConfig (`endpoints.rs`, like
  EarTrumpet); same interface turns "Listen to this device" on for the mic (verified: on/off round-trip).
- Game presets: while a game in `game_presets` is in front its preset is an in-memory overlay (`ml_eq::Live`,
  like solo) on the output in use, never saved; it moves with the output when the default changes
  (`eq::follow_output`, every 2 s and right after a switch from Buffer).
- The EQ page (`ui/js/eq.js`) always says what is heard: a "now" bar (device · preset or `game → preset` · headphone
  correction). While a game preset plays, `eq-get` returns its bands (`game_bands`); the graph draws those, locks the
  dots, faders and preset chips, and shows my own EQ as a faint dashed line; "Edit my EQ" unlocks it (`viewOwn`, UI only).
- The games card lists games that have a preset, the one in front and the last five from `eq.json: recent_games`
  (recorder-owned, most recent first, capped at 30). Library clips can't seed it: their names (e.g. `Counter-Strike-2`)
  don't map back to the exe stem the recorder matches on, so a game never seen in front is added by picking its .exe
  (`App.api.pickFile` -> `eq-game-add <stem>`). The card for headphone profiles is called "AutoEQ" (headphones and
  earphones only: the AutoEq database has no speakers).
- Games are listed automatically: the recorder stores every game it sees in front in `eq.json: seen_games` (stem ->
  name); each row has one choice (my EQ / a preset). The recorder owns that list (`eq-set` ignores the page's copy;
  `eq-game-add|-forget <stem>` change it). Choosing a preset for the running game applies at once (`refresh_game`).
  The built-in preset id `gaming` is shown as "Footsteps" ("Kroki") so it isn't mistaken for the per-game presets.
  Debug builds have `eq-testgame <stem>|off` to fake a game in front.
- The tray's audio items are refreshed in tray-icon's event handler on the right click, before the menu opens
  (thread-local `AUDIO` in tray.rs); nothing polls devices in the background.
- `apo::status().restart_pending`: APO's install folder or an attached device's FxProperties key is newer than
  the last boot — shown as "Restart may be needed" (a hint; never seen true here, the user had rebooted).
- **Clips and the EQ:** endpoint loopback and mic capture are post-APO, so Game/Chat (device sources) and Mic are
  recorded WITH the EQ; per-app sources (`@app:`) are pre-APO and stay clean (measured).
- Spectrum: the app opens its own WASAPI loopback/capture only while the EQ page is open (own radix-2 FFT, 160
  log bins as raw bytes over a `tauri::ipc::Channel`, ~30 fps).

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
