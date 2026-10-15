# Buffer sound cues

The recorder embeds these five WAV files in its exe (`src/win.rs`, `Sound`). To change a sound, replace the file and
rebuild; nothing else needs to change. The current set was made by a friend of the project and converted for the app
(mono, 16-bit, 44.1 kHz, trailing silence cut with a short fade, peak -3 dBFS, `game.wav` -9 dBFS).

| File | Plays when | Character | Length |
|---|---|---|---|
| `saved.wav` | a clip was saved, or the save shortcut was pressed and the countdown started | short, satisfying "ding" | 0.15 - 0.3 s |
| `failed.wav` | a save failed, nothing to save, the recording or a source stopped working | low, two-tone, clearly "no" | 0.3 - 0.5 s |
| `rec-start.wav` | a long recording started (Alt+R) | rising, "on" | about 0.3 s |
| `rec-stop.wav` | a long recording ended | falling, the mirror of `rec-start` | about 0.3 s |
| `game.wav` | a game came to the foreground and Buffer is active | very quiet, subtle | 0.15 - 0.25 s |

Settings -> Recording has "Sounds" (everything) and "Game detected" (only `game.wav`, on by default).

## Format
- WAV, PCM 16-bit, mono, 44.1 or 48 kHz.
- Keep them short: about 0.5 to 1 s including the decay, 40 to 90 KB each (they are part of the installer; the
  five together are about 375 KB, which adds roughly 0.2 MB to it).
- Peak around -3 dBFS, similar loudness across files (`game.wav` clearly quieter). They play over games and music, so
  nothing harsh or bass-heavy.
- No silence at the start (it reads as latency), a short fade-out at the end (no click).
- One family of sounds: `saved` and `rec-start` go up, `failed` and `rec-stop` go down.
