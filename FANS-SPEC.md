# Fans tab: spec (decisions of 2026-10-17)

Source of the feature list: the official FanControl docs (https://getfancontrol.com/docs) and README
(https://github.com/Rem0o/FanControl.Releases). FanControl itself is closed source, a UI over LibreHardwareMonitor
(PawnIO driver since V238). Do not guess from its DLLs.

## Decisions
- **Engine:** installed on request like OpenRGB: pinned LibreHardwareMonitor (MPL-2.0, check THIRD-PARTY-NOTICES),
  one elevated all-or-nothing step into `%ProgramFiles%\Buffer\...`, on-demand scheduled task the recorder starts/stops
  without UAC, PawnIO only if missing and never removed. The recorder hosts the control loop (fans keep working with the
  window closed). Inline `-EncodedCommand` for elevated scripts, never files.
- **Import:** one-time import of `C:\Program Files (x86)\FanControl\Configurations\userConfig.json` with a preview
  (curves, nicknames, mix sensors, hidden cards). Dev PC: 9 controls, 9 curves, 1 mix (CPU + GPU), RTX 3090, B450 board.
- **Curve types:** Graph, Linear, Flat, Mix (Max/Min/Average/Sum/Subtract), Sync (control, offset %, proportional),
  Trigger (idle/load temps and speeds, response time), Auto (idle/load temp, min/max speed, step, deadband, response time).
- **Per-control tuning** (basics on top, rest in a folded "Advanced"): step up/down, start %, stop %, minimum %, offset %,
  hysteresis (applies when temperature FALLS only), response time, "ignore hysteresis at min/max points", avoid zones.
- **Detection:** first-entry scan, automatic control<->RPM pairing (change PWM, watch which fan reacts), shown as a
  case schematic reusing the RGB case templates: the tested fan spins and glows lime, a found one snaps into its slot,
  scan bar shows progress. Calibration (start/stop/min/max, RPM<->% graph) is NOT in scope for now.
- **Fail-safe:** recorder hosts; lost sensor or recorder crash = 100 % (configurable); clean exit = give control back to
  BIOS/GPU. NVIDIA cannot go below ~30 % or 0 RPM manually: at 0 % release control to the card; AMD similar.
- **Sensors:** CPU, GPU, board (drives off by default, like the user's FC). Custom sensors: only Mix for now.
- **Profiles:** curve profiles with share code `BUF-FAN1.` (see `ui/js/share.js`). No per-game, tray flyout, schedule or
  RGB link yet.
- **Conflicts:** detect FanControl, MSI Center, Afterburner etc. (as RGB's `away.rs`), show a bar naming the program and
  do NOT control fans while it runs.
- **Name:** "Fans". Also: rename (nickname), hide, drag to reorder cards; manual control with a slider + playhead.
- **Layout (2026-10-17):** Simple = A (list | detail, like RGB Simple). Advanced = ALL THREE as switchable views of one
  setup (one model, a view switch in the header like RGB's 3D/2D): A "Curves" = list | editable curve | inspector, B "Wiring" =
  sensors -> curves -> controls graph with chain highlight and a drawer, C "Case" = case schematic + live history + Curve /
  Tuning / Pairing tabs. The Detect overlay uses the case schematic. Selection is shared between the views (pick a fan in
  C, switch to A, the same curve is open). Mockup: https://claude.ai/artifact/6a5dpfZftcYyPSZpYUzGrd

## Phase 0 findings (2026-10-17, LibreHardwareMonitorLib 0.9.6 via NuGet, .NET 8 helper spike)
- Without admin: only the GPU (RTX 3090: 3 temps, 2 fan RPM, 2 writable `Control`s, idle 30 % / ~1365 rpm). CPU temp reads 0,
  the board has no sensors. With admin: Nuvoton NCT6797D, 7 writable PWM controls (`/lpc/nct6797d/0/control/0..6`), 4 fans
  with RPM (#2, #3, #5, #6; #1, #4, #7 read 0 rpm = empty headers), 4 board temps, CPU Tctl/Tdie + CCD1.
- Write works: `Control.SetSoftware(%)` on `/lpc/nct6797d/0/control/1` gave 70 % -> 1318 rpm, 30 % -> 744 rpm (about 6 s to settle).
  `ControlMode` reads `Undefined` on this board, so "give back to BIOS" cannot be read, only `SetDefault()` can be tried;
  the original software value is also restorable. Remember each control's original value before the first write.
- FanControl.Service and MSI Afterburner run on the dev PC and would fight for the same fans: stop/detect first.
  The user allowed stopping other programs for tests and said restoring after a test is not required.

## Built so far (2026-10-17)
- **Helper** `helpers/fans` (C#, LibreHardwareMonitorLib 0.9.6, `buffer-fans.exe`): line-JSON over the named pipe `\\.\pipe\buffer-fans`
  (ACL: only the user's SID; deny network). Commands hello / list / read / set / release / failsafe / quit. Owns the safety:
  a watchdog sets everything Buffer touched to the fail-safe speed after 10 s of silence; `quit` and a normal exit call `SetDefault()`.
  Published as a trimmed self-contained FOLDER (not single-file: single-file self-extracts into the user-writable %TEMP% which an
  elevated process would then load), `scripts/build-fans-helper.ps1` -> `helpers/fans/dist/buffer-fans.zip` (7.5 MB, 24 MB installed).
  `start.cmd` in the zip clears the .NET profiler / startup-hook variables (the task inherits the user's environment).
- **`ml-fans`**: `model` (setup), `curve` (engine, 13 unit tests written from the docs), `discover` (control <-> fan pairing by LHM numbering),
  `client` (pipe), `install` (task "Buffer Fans" in `%ProgramFiles%\Buffer\Fans`, one UAC; RGB's elevation code now lives in `ml-core::elevate`).
- **Recorder** `fans.rs`: worker thread, 1 s loop, `fans-*` control commands, `fans.json`. Other fan programs: FanControl & co pause
  everything, MSI Afterburner / NVIDIA app only the GPU controls (`away::fan_conflicts`).
- **Verified on the dev PC (NCT6797D board, RTX 3090)**: discovery (9 controls, paired, temps/fan RPM listed), Flat 60 % -> 1190 rpm,
  manual 30 % -> 719 rpm, recorder killed hard -> 100 % after ~10 s, restart resumes, `fans-disable` -> helper exits and the control
  returns to its earlier value (47 %).
- **Defender**: `Trojan:Win32/Bearfoos.B!ml` (generic cloud ML) blocked/removed freshly built `buffer-recorder.exe` several times while
  the install scripts were inside it (it also emptied the `BufferRecorder` Run value, restored with `install-autostart`). A new file is
  blocked for ~20 s until the cloud verdict arrives; wait after each build. The recorder therefore has NO install command (only
  installed/start/stop); installing is done by the Tauri app or `cargo test -p ml-fans dev_install -- --ignored`.
  RELEASE RISK: an ML false positive on the shipped, unsigned recorder would be serious. Check a release build before publishing.
- **Hosting the helper (decided 2026-10-17): none.** `buffer-fans.zip` is a resource of the installer (`tauri.conf.json`), built by
  `build-installer.ps1`; `install::local_zip()` finds it next to the exe. Nothing is uploaded or downloaded. Older note (superseded):
- **Hosting the helper** (superseded): `ml-fans/src/install.rs` `RELEASE_URL` / `RELEASE_SHA256` are
  empty; until a release uploads `buffer-fans.zip` the dev build zip is used.
- **FanControl internals (REA, FanControl.Service.dll)**: a real Windows service (Hosting.WindowsServices) with gRPC over named pipes
  (FanControl.IPC), so it controls fans before anyone logs in. Buffer uses an on-demand task + the recorder instead (starts at login).
- Not verified: AMD/Intel GPUs, `SetDefault()` on other boards, AIO coolers (Controller hardware is enabled but untested).

## UI built (2026-10-17)
- Simple = list | detail (`fans.js`), Advanced = Curves | Wiring | Case (`fans-adv.js`), shared selection; header: engine chip (ready /
  paused by another program / fail-safe), Simple|Advanced, Import (when a FanControl config is found), Detect, Turn off; profile bar with
  `BUF-FAN1.` copy/paste. Settings -> Advanced has Turn off / Remove helper. 9 locales, `check-i18n` green.
- Verified in the real window over CDP: gate -> enable, live values and scans, preset -> own curve on the right sensor, curve point drag saved
  to fans.json, Wiring chain highlight, Case schematic with live history, import preview on the real FanControl config (9 controls, 7 curves,
  Mix = Max, ids mapped), Detect probe on the real board (fans 1, 2, 4, 5 answered +274 to +1487 rpm; three empty headers did not).
- Not done: per-game profiles, tray/flyout, schedule, RGB link (not asked for), AMD/Intel GPU tests, release hosting of the helper zip.

## Style rules that apply
`DESIGN.md` (lime = now, faded = trail, set value = line + playhead, live value = scan), short UI text with tooltips,
all strings through `App.t()` in 9 locales, lists update in place (no flash on click), 32 px hit areas, undo toasts.
