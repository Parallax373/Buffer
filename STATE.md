# Moments Lite — project state

A small, reliable Windows replacement for the SteelSeries GG "Moments" clip editor. Goal: no bloat,
no launcher/update breakage, richer editor, and a size-targeted exporter (e.g. for Discord).

## Stack
- Rust workspace: `crates/ml-core` (probe + export logic), `crates/ml-cli` (`ml` CLI), `src-tauri` (Tauri v2 app).
- UI: plain HTML/CSS/JS in `ui/` (no framework, no bundler). WebView2 shell, ~8 MB exe.
- Media: system `ffmpeg`/`ffprobe` on PATH (winget `Gyan.FFmpeg`). GPU encode/decode via NVENC/NVDEC.

## Source material (what we reverse-engineered)
- SteelSeries clips are plain MP4 (H.264, 1920x808, 30 fps) with 3 AAC audio streams tagged
  `Game`, `Chat`, `Mic` (via `handler_name`). Clips live in `E:\Nagrania`.
- Their app: Go backend + Electron/React UI talking over local HTTPS (`/moments/clips/*`).
  Metadata in SQLite (`moments_clips`: trim points, `effects`, `audio_tracks_props`, `crop_format`).
  Their DB was empty on this machine, so importing saved edits is not implemented.

## Implemented
- Library: scans a folder recursively (skips `Exported Clips`, `Shared Clips`), search box.
- Preview: `<video>` + one `<audio>` per track (extracted with stream copy to a cache), per-track gain 0–200%,
  A/V drift correction.
- Edit: trim handles on timeline (also I/O keys), 16:9 crop with horizontal position, speed 0.5–2x,
  loudness normalisation.
- Export: target size in MiB (presets Discord 10 / Boost 50 / Nitro 500), max height, codec
  (H.264 NVENC, HEVC NVENC, x264), output to `<library>\Exported Clips`, automatic retry if over target,
  progress bar, reveal in Explorer, drag the finished file straight into Discord (`tauri-plugin-drag`).

## UI layout (current)
Three columns, dark theme, orange accent `#ff6a1f`:
1. Left (300 px): folder path, search, clip list (name, date, size, subfolder).
2. Center: video stage with crop overlay, transport bar (play, time, set in/out), timeline with
   selection and playhead, keyboard hint.
3. Right (300 px): Audio tracks (sliders + normalise), Format (16:9 crop, position, speed),
   Export (preset buttons, target MiB, resolution, codec, bitrate estimate with warnings, Export button,
   progress, status, drag chip).

## Not done / next
- Multi-cut + joining segments, text/captions, thumbnails in the library, import of SteelSeries edits.
- Recorder (replay buffer) as a separate process: mic as its own track, visible "mic live" indicator,
  persisted device IDs. This is the main remaining piece.
- Preview/drag-out were only build-verified, not exercised by hand in the window.

## Run
```
cargo build --release          # then target\release\moments-lite.exe
target\release\ml.exe export <clip> -s 10 --wide --vol chat=0
```
