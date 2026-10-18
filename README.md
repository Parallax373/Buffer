<div align="center">

# Buffer

### Save the clip **after** it happens.

Always-on clip recorder and editor for Windows.

[**Download for Windows**](https://github.com/Wheatlay/Buffer/releases/latest)  ·  Windows 10 and 11  ·  installs in a minute

```powershell
winget install Wheatlay.Buffer
```

</div>

---

Small on purpose. No launcher, no account, no overlay, nothing to babysit.

| | |
|---|---|
| **19 MB** | the whole installer |
| **0** | questions during install |
| **1** | hotkey to save a clip |

<p align="center">
  <img src="docs/screenshots/library.png" alt="Library: every clip, sorted by game" width="780"><br>
  <sub>Library. Every clip, sorted by game.</sub>
</p>

<p align="center">
  <img src="docs/screenshots/editor.png" alt="Editor: trim, pick a size, drag it into Discord" width="780"><br>
  <sub>Editor. Trim, pick a size, drag it into Discord.</sub>
</p>

## What it does

- **Always-on recorder.** Buffer keeps the last minutes in the background (NVENC when your GPU has it). Press one hotkey and the moment that just happened is saved as an MP4.
- **Three audio tracks.** Game, voice chat and microphone are saved separately, so you can mute your friends or fix your mic afterwards. Devices that disappear are picked up again automatically, and Buffer warns you when your mic is also playing through the speakers and ending up in the game track.
- **Library.** Every clip, sorted by game or grouped by date (collapse or expand all with one click), with favorites, search and bulk actions. Stays smooth with thousands of clips, and clips from other recorders are filed by their folder.
- **Editor.** Trim, 16:9 crop, speed, per-track volume and loudness, a zoomable timeline.
- **Live EQ (optional).** A 7-band parametric EQ for your outputs and your mic, in the style of SteelSeries Sonar: presets for games, voice and music, AutoEQ correction for your headphone model, presets that switch with the game in front, and an output switch on a hotkey. The sound is processed by [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) inside Windows itself, so there is no added delay and it keeps working with Buffer closed. It is not part of the installer: the first-run setup or the EQ page downloads and installs it only if you turn the EQ on. Note that clips recorded from a device include the EQ.
- **Sound Switcher.** A second tray icon in the style of EarTrumpet: click it for every playback device and the volume of each app, change the default output, mute, or scroll over the icon to change the volume. Switch output (and microphone) with a hotkey, with a short popup naming the new device. The EQ follows the device you switch to.
- **RGB (optional).** One page for the lights of your PC: colour, brightness and power per device, or an Advanced view with a 3D/2D model of your desk and case and effects synced across devices. Colour calibration with Warmth and Tint dials, profiles and share codes. It runs on [OpenRGB](https://openrgb.org), which is installed on request and never bundled, and the lights stay on after you close the window.
- **Fans (optional).** Fan curves for your CPU, graphics card and case fans: a Simple view with one Quiet-to-Cool dial per group, or Advanced with Curves, Wiring and a Case view with live fan speeds and an airflow estimate. Buffer finds out which fan is which by spinning each one, imports your setup from FanControl, and has profiles and share codes. Fail-safe: if Buffer stops, the fans go back to the board's own settings. Needs administrator approval once; it uses [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor).
- **Exports to a size.** Pick Discord (10 MB), Boost (50 MB) or 500 MB and drag the result straight into a chat window.
- **Updates itself.** Updates are checked in the background and verified against Buffer's key; installing takes a few seconds, and the bundled FFmpeg is only rewritten when it changed.
- **Your language.** English, Polski, Deutsch, Español, Français, Українська, Türkçe, 日本語 and 简体中文.

## Install

With winget:

```powershell
winget install Wheatlay.Buffer
```

Or download the latest installer from [Releases](https://github.com/Wheatlay/Buffer/releases/latest) and run it. It is per-user, asks nothing, and opens a short first-run setup when it is done.

The installer is not code-signed yet, so Windows SmartScreen may show "Unknown publisher": choose More info, then Run anyway. Updates are verified with Buffer's own key.

## Build from source

Rust workspace plus a [Tauri v2](https://tauri.app) app with a plain HTML/CSS/JS interface (no bundler).

```powershell
.\scripts\dev.ps1            # debug build, the UI reloads when you save a file
.\build-installer.ps1        # release installer (fetches and verifies ffmpeg)
```

Architecture notes are in [STATE.md](STATE.md), release steps in [RELEASING.md](RELEASING.md), and translations live in `ui/js/locales/` (`node scripts/check-i18n.js` checks them).

## License

[MIT](LICENSE). Buffer ships with a GPL build of ffmpeg; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Equalizer APO (GPL) is a separate program that Buffer can install on request and only configures; it is not bundled. OpenRGB (GPL-2.0) is likewise installed on request and never linked. Fan control uses LibreHardwareMonitor (MPL-2.0). Headphone profiles come from [AutoEq](https://github.com/jaakkopasanen/AutoEq) (MIT).
