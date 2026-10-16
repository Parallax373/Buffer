# Dark Project keyboard lighting (VID 342D, PID E40F)

Interoperability notes for the user's own keyboard. Driver: `crates/ml-rgb/src/darkproject.rs`.

## Which device is what

| USB id | Product string (bus reported) | What it is |
|---|---|---|
| 342D:E40F | `DPKB_MIDNIGHT_87_ANSI` | The Dark Project keyboard itself (Midnight 87, ANSI). Interfaces: MI_00 keyboard, MI_01 (5 HID collections: vendor, mouse, consumer, vendor, keyboard), MI_02 vendor. |
| 320F:706E | `G3M PRO` | NOT the keyboard and NOT its receiver. eVision chipset, MI_00 is a HID mouse. A separate pointing device; out of scope. |

342D:E40F is the keyboard's own USB identity (wired). It is not a receiver for 320F:706E.
The vendor configurator (software.darkproject.eu, WebHID) contains no 320F entry at all; its registry
lists 342D:E40F (25 models) and 342D:E410 (4 models) as `CommonKeyboardSeries`, and `DPKB_MIDNIGHT_87_ANSI`
(device id `0x342D0xE40F005`, style `GK843US`) is among them.

## Sources and confidence

- The configurator bundle `main.67f2a4ad434666c9.js` (class with `FeatureId = 7` and `LEDType`, `ApplyLighting`,
  `ApplySingleCustomLighting`, `ApplyReset`, `ApplyEnterBootloader`, ...), read statically from a public mirror
  (github.com/allllpina/darkproject-fix). Nothing was executed.
- Third-party notes/registry derived from the same bundle (github.com/scarzxx/DarkProject-Soft) for the model LED table
  and independent cross-check of offsets.
- Confidence: command bytes and offsets for static colour and per-key: high on paper (bundle code and the
  independent project agree). Never verified on this keyboard: the ISO/Midnight variants are "same family, not
  hardware verified" in the third-party project (only the Bushido was verified there). The 0xFF01 usage page and the
  feature report size come from that project, not from this machine.
- OpenRGB has no Dark Project CommonKeyboardSeries support (its Dark Project controller is for VID 0x195D). Not related.

## Transport

- HID **feature reports**, report id **7**, on the vendor collection with usage page **0xFF01**. The collection with
  usage page/usage 0xFF00/0xFF00 is an input-only event channel (0xF1 = profile changed, 0xF0 = Snap Tap changed).
- Request: `SetFeature(7, payload)` where payload[0] = command. Then wait **100 ms** (vendor delay for this family) and
  `GetFeature(7)` for read commands. The vendor sends 256 or 264 byte payloads and the browser pads them to the
  descriptor's size (the firmware-update path sends 2055 bytes through the same report id), so the report is larger than
  257 bytes; the driver reads the size from the HID report descriptor and zero-pads. Write commands have no readable
  acknowledgement.
- hidapi/Windows buffers include the report id as byte 0. **Reply offsets are write-payload offsets + 1.** Everything
  below is in write-payload offsets unless it says "reply".

## Commands used by the driver (lighting only)

| Cmd | Dir | Meaning |
|---|---|---|
| `0x81` | read | active profile: reply[2] = profile + 1 (1..3) |
| `0x82` p | read | whole stored profile `p` = 1..3: `[0x82, p, 0...]`. Reply[0] = 7, reply[1] = 0x82, reply[2] = p |
| `0x02` | write | write whole stored profile (256 bytes): reply[1..] of a `0x82` read with byte 0 replaced by 0x02 |
| `0x8A` p k c | read | per-key preset `k` = 1..5 of profile `p`, half `c` = 1..2: `[0x8A, p, k, c]`; data = reply[8 .. 8+192] |
| `0x0A` p k c | write | store half `c` of per-key preset: `[0x0A, p, k, c, 0, 0, 0, data[192]...]` (data from byte 7) |

### Profile buffer (write offsets)

| Offset | Meaning |
|---:|---|
| 0 | command (0x02) |
| 1 | profile + 1 (copied from the read) |
| 7 | polling rate index (1=125, 2=250, 3=500, 4=1000 Hz) |
| 8 | HID effect id |
| 9 + e | brightness step 0..4 for effect e |
| 23 + e | speed step 1..5 for effect e (5 - 4 * percent/100, rounded) |
| 37 + e | multicolour flag for effect e (8 = on, 0 = off) |
| 51 | direction (0 right, 3 up, 1 left, 2 down); Spiral Wave uses offset 83 instead |
| 52 | 0 = normal effect, 1..5 = custom (per-key) preset + 1 |
| 58 + n / 66 + n / 74 + n | R / G / B of colour slot n (n = 0..7) |
| 82 | vendor writes 8 for every effect except Breathing (0) |
| 85 | debounce copy |
| 87 | input latency index |

Effect ids: 0 Wave, 1 Colour Cycle, 2 Random, 3 Breathing, 4 Footprint, 5 **Solid**, 6 Spiral Wave, 7 Star,
8 River, 9 Ripples, 10 Trigger, 11 Colour Discharge, 12 Sine Wave, 13 Rain, 14 **Custom (per key)**.
Brightness_write = ceil(4 * percent / 100). There is no checksum in this family (none in the bundle's
CommonKeyboardSeries code; other families such as SparkLink use one).

### Static colour (what `set_static` sends)

Read `0x82` for the active profile, then write it back with: byte0 = 0x02, byte8 = 5 (Solid), byte14 (9+5) = 4,
byte42 (37+5) = 0, byte52 = 0, bytes 58/66/74 = R/G/B, byte82 = 8. Every other byte is copied unchanged
(unit-tested: only these offsets differ from the snapshot).

### Per-key colours (what `set_keys` sends)

1. `0x0A` chunk 1 and chunk 2 for preset k: header `[0x0A, profile+1, k+1, chunk+1]`, data from byte 7. Concatenated data
   is three planes of 96 bytes in LED-slot order: R[96], G[96], B[96], then 96 zero bytes. Chunk 1 = R + G,
   chunk 2 = B + zeros.
2. Profile write with effect 14 (Custom), byte52 = k + 1, brightness byte 9+14.

LED slot order for `DPKB_MIDNIGHT_87_ANSI` is the vendor `ledCodes` list (column-major, 6 rows per column; empty
strings are unused slots; `K64` is the ISO key; `Custom_Fnkey` is the Fn key). It is embedded as
`MIDNIGHT_87_ANSI_LEDS` in the driver. Not hardware verified; if lighting lands on the wrong keys the table is the
first suspect.

## Persistence: why there is no "live only" mode

Every lighting command above rewrites the **stored** profile (`0x02`) or one of the five stored custom presets
(`0x0A`). The bundle has no volatile or "preview" lighting command; each colour change in the web app is exactly
this read-modify-write. The 0x02 buffer also carries polling rate, input latency and debounce, so a bad template would
corrupt those too (the driver refuses templates that fail a sanity check: report id 7, echo 0x82, profile number,
effect id <= 14).

Restore strategy: `Keyboard::snapshot()` reads the profile (`0x82`) and optionally the custom preset (`0x8A`, two
halves) before anything is written; `Keyboard::restore()` writes those bytes back unchanged. `set_static` and
`set_keys` return the snapshot they took. The same state can be recreated from software.darkproject.eu (it reads the
profile on connect and rewrites it).

## DO NOT SEND (the driver cannot emit these)

| Bytes | What it does (from the bundle) |
|---|---|
| `0x01, 0xFF` | `ApplyReset`: factory reset of all profiles. (`0x01, n` alone switches profile n; stored, not needed.) |
| `0x30, 0x00` | `ApplyEnterBootloader` / `ApplyExitBootloader` (the latter is 2055 bytes long) |
| `0x32, i, n, ...` | firmware chunk write (2048 data bytes from offset 7, checksum in bytes 3-4 of last chunk) |
| `0x03` | key bindings (both layers) |
| `0x04`, `0x05` | macro metadata / macro data |
| `0x09` | Snap Tap |
| `0x0B` | sleep time / debounce |

`darkproject::tests::never_emits_dangerous_commands` asserts the builders only produce 0x02, 0x0A, 0x81, 0x82, 0x8A.

## Status of the live test

None was done; no report of any kind (not even a read) was sent to the keyboard. Reasons: the only lighting write is
a stored-profile write, which fails the "non-persistent, lighting-only" condition; the Midnight 87 is not hardware
verified in any source; and the 0xFF01 collection/feature size are unconfirmed on this PC. Enumeration
(`detect()` / `list_collections()`) sends nothing and is safe to run to confirm the collection.
