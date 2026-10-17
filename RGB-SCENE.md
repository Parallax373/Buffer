# RGB scene (stable contract)

The scene is one JSON object: what the Advanced page keeps in `localStorage` (`buffer.rgb.advanced.v1`) plus the fields
the recorder needs. The always-on recorder owns it: it persists it in `%APPDATA%\Buffer\rgb.json`
(`{ "version": 1, "enabled": bool, "scene": <scene>, "restore": {...} }`, recorder is the only writer) and renders it to
OpenRGB. Types: `crates/ml-rgb/src/scene.rs` (+ `engine.rs` for layers). Unknown keys are kept and returned unchanged
(`view`, `plane`, `snap`, `sel`, `selLayer`, `fxName`, `mine`, `cam`, `zoom2`, `pan2`, ...), so UI-only state can live in the scene.
Every field has a default; a bare `{}` is a valid, empty Simple scene. UI-only keys of the Advanced page: `tpl` (case
template: `mid|itx|dual|open|none`), `caseAt` `[x, z]` cm and `caseRot` 0|90|180|270 and `caseFlip` bool (where the case stands,
which way it faces, mirrored or not; its slots and the devices in them move with it), `field`, `slots`, `tab`, `originDev` (the origin follows that device).
`fps` is a real field.

Colour calibration is NOT in the scene: it belongs to the hardware, so it lives in `rgb.json: calib` (device key `name#n` ->
`[r, g, b]` percent) and the recorder applies it to every colour it sends to that device (Simple, Advanced, every profile,
the test pattern), in `take_over`. Not applied: a device's own (native) modes and the Dark Project keyboard.

## Commands (recorder control port 47821, one JSON line back; Tauri names in brackets)

| command | effect |
|---|---|
| `rgb-status` [`rgb_status`] | `{ok, installed, enabled, running, connected, devices, playing, streaming, fps, error}` |
| `rgb-scene-get` [`rgb_scene_get`] | `{ok, scene}` |
| `rgb-scene-set <json>` [`rgb_scene_set(scene)`] | replaces the scene, persists it, applies it at once. A scene with `merged: true` but without `simple` / `free` keeps the current ones (the Advanced page sends it so; a late save cannot undo a look set meanwhile). `{ok}` or `{ok:false,error}` |
| `rgb-look <json>` [`rgb_look(look)`] | sets one device's look (its own colour, over the effect) in `scene.simple`; the view (`mode`) stays |
| `rgb-unlook <nth> <name>` [`rgb_unlook(name, nth)`] | gives a device back: its look goes and, if placed, it joins `free` |
| `rgb-follow <nth> <name>` [`rgb_follow(name, nth)`] | the device follows the effect again: no look, not in `free` |
| `rgb-devices` [`rgb_start`] | re-reads the OpenRGB device list: `{ok, devices:[{index, name, vendor, description, kind, location, active_mode, modes, zones, led_names, colors}]}` |
| `rgb-enable` / `rgb-disable` | start / stop hosting OpenRGB (`disable` puts every device back to its earlier mode) |
| `rgb-blink <nth> <name>` [`rgb_blink(name, nth)`] | 3 s on a driven device: dim white, LED 0 flashing white, LED 1 lime (where it is, where LED 0 is, which way the LEDs run); then its frame comes back |
| `rgb-calib <name#n> <[r,g,b]\|null>` [`rgb_calib(key, value)`] | sets (or removes) a device's colour calibration in `rgb.json: calib`; every device is sent again. The key may contain spaces: the value is split off at the last space |
| `rgb-test <[r,g,b]\|off>` [`rgb_test(color)`] | calibration test pattern: every shown OpenRGB device in this colour (calibrated), the scene waits; never saved, ends after 10 min at most; `off` gives the lights back to the scene |

## Fields

| field | type | meaning |
|---|---|---|
| `mode` | `"simple"` \| `"advanced"` | the recorder also accepts the artifact's `"adv"`; it always returns `"advanced"` |
| `playing` | bool (default true) | false = one still frame of the Advanced scene, nothing is streamed |
| `speed` | 0..3 (1) | global playback speed |
| `bright` | 0..100 (100) | global brightness of the Advanced scene |
| `fps` | 5..60, optional (30) | render rate while playing |
| `origin` | [x,y,z] cm | origin of Radial and Scan |
| `devices[]` | see below | Advanced: where each device sits in space |
| `layers[]` | see below | Advanced: the effect (identical to the artifact's layers) |
| `simple[]` | `{name, nth, hue 0..359, sat 0..100, br 0..100, on}` | Simple: one static colour per OpenRGB device (`nth` = n-th device with that name, default 0) |

`devices[]`: `{id, type, name, ex?, x, y, z, rot, sc, link, pts?, trim, delay}`. `type` is `header|gpu|ram|fan|strip|keyboard|headset`
(built-in LED layouts as in the artifact); `pts` (optional, `[[x,y,z],...]` in cm, local space, x right, y up, z to the front)
replaces the layout. World position of a LED = `(x,y,z) + R_y(rot) * pts * sc`. `link` = `{name, nth}` names the OpenRGB device that
shows this device (`name` as in `rgb-devices`); no `link` = only simulated, never sent. If the OpenRGB device has MORE LEDs than
the layout, LED i takes layout point `floor(i * pts / leds)`; if it has FEWER, LED i sits at the middle of its group of points
`[floor(i * pts / leds), floor((i + 1) * pts / leds))` (a board OpenRGB sees as one LED, laid over three fans, shows one colour taken
at their middle; the page's preview paints the whole group in that colour).

Per device (optional, neutral when absent): `trim` 0..100 (100) its own brightness, `delay` ms (0) it runs behind the scene. The
recorder computes `color_at(its layers, pos, t - delay) * trim/100`. UI-only device keys: `slot` (the template place it sits in),
`parts` (`[{slot, n}]`: one device spread over several places, n LEDs drawn in each, in order), `led0` and `rev` (how far LED 0
was moved and whether the order is reversed; `pts` already holds the result). A `wb` key from an earlier build is ignored.

`layers[]`: `{on, gen, p, stops, blend, opacity, skip?}`; `skip` = scene device ids the layer does not act on ("Applies to";
on the layer, so it moves with it when layers are reordered or copied). `gen` = `wave|radial|rainbow|noise|scan|solid|sparkle|audio`;
`p` = `{speed, scale, rot, axis 0|1|2, mirror, ease, trail, width}`; `stops` = `[{p 0..1, c "#rrggbb"}]` (at least 2);
`blend` = `add|mix|multiply|max`; `opacity` 0..1. The `audio` generator follows the level of the game audio the recorder already meters.

**One scene, two views (2026-10-17).** `mode` is only the view that is open; the recorder drives the same whatever it says. Per
OpenRGB device: a look in `simple` wins (its own colour / effect / native mode); otherwise a placed device with a `link` follows the
layers, unless its key is in `free` (given back) or there are no layers; otherwise it shows its own lighting. `free` = device keys
(`name#n`) placed in the scene that Buffer leaves alone. `merged: true` marks the new form: an older scene is migrated once (recorder
load, and `rgb-scene-set` of an old-form scene) so that what was lit stays lit: a Simple-mode scene puts every placed device without a
look into `free`; an Advanced-mode scene's looks (they were not shown) move to `simple_before_merge`. Looks run on their own clock,
the effect on the scene's (`speed`). The Dark Project keyboard follows its look in every view. A device that drops out of the scene is
put back to the mode it had before Buffer took over.

## Example

```json
{
  "mode": "advanced", "playing": true, "speed": 1, "bright": 100, "origin": [0, 18, 0],
  "devices": [
    { "id": 2, "type": "gpu", "name": "PNY RTX 3090", "x": -30, "y": 16, "z": 0, "rot": 90, "sc": 1,
      "link": { "name": "PNY GeForce RTX 3090 XLR8 Revel EPIC-X", "nth": 0 } },
    { "id": 7, "type": "headset", "name": "SteelSeries Arctis 5", "x": 34, "y": 0, "z": -10, "rot": 0, "sc": 1,
      "link": { "name": "SteelSeries Arctis 5", "nth": 0 } }
  ],
  "layers": [
    { "on": true, "gen": "scan", "p": { "speed": 0.8, "scale": 1, "rot": 0, "axis": 0, "mirror": false, "ease": 0, "trail": 0.8, "width": 3 },
      "stops": [ { "p": 0, "c": "#c6f432" }, { "p": 1, "c": "#c6f432" } ], "blend": "add", "opacity": 1 }
  ],
  "simple": [ { "name": "SteelSeries Arctis 5", "nth": 0, "hue": 75, "sat": 90, "br": 100, "on": true } ]
}
```
