# RGB scene (stable contract)

The scene is one JSON object: what the Advanced page keeps in `localStorage` (`buffer.rgb.advanced.v1`) plus the fields
the recorder needs. The always-on recorder owns it: it persists it in `%APPDATA%\Buffer\rgb.json`
(`{ "version": 1, "enabled": bool, "scene": <scene>, "restore": {...} }`, recorder is the only writer) and renders it to
OpenRGB. Types: `crates/ml-rgb/src/scene.rs` (+ `engine.rs` for layers). Unknown keys are kept and returned unchanged
(`view`, `plane`, `snap`, `sel`, `selLayer`, `fxName`, `mine`, `cam`, `zoom2`, `pan2`, ...), so UI-only state can live in the scene.
Every field has a default; a bare `{}` is a valid, empty Simple scene.

## Commands (recorder control port 47821, one JSON line back; Tauri names in brackets)

| command | effect |
|---|---|
| `rgb-status` [`rgb_status`] | `{ok, installed, enabled, running, connected, devices, playing, streaming, fps, error}` |
| `rgb-scene-get` [`rgb_scene_get`] | `{ok, scene}` |
| `rgb-scene-set <json>` [`rgb_scene_set(scene)`] | replaces the scene, persists it, applies it at once. `{ok}` or `{ok:false,error}` |
| `rgb-look <json>` [`rgb_look(look)`] | merges one Simple look (see below) into `scene.simple`, sets `mode:"simple"` |
| `rgb-devices` [`rgb_start`] | re-reads the OpenRGB device list: `{ok, devices:[{index, name, vendor, description, kind, location, active_mode, modes, zones, led_names, colors}]}` |
| `rgb-enable` / `rgb-disable` | start / stop hosting OpenRGB (`disable` puts every device back to its earlier mode) |

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

`devices[]`: `{id, type, name, ex?, x, y, z, rot, sc, link, pts?}`. `type` is `header|gpu|ram|fan|strip|keyboard|headset`
(built-in LED layouts as in the artifact); `pts` (optional, `[[x,y,z],...]` in cm, local space, x right, y up, z to the front)
replaces the layout. World position of a LED = `(x,y,z) + R_y(rot) * pts * sc`. `link` = `{name, nth}` names the OpenRGB device that
shows this device (`name` as in `rgb-devices`); no `link` = only simulated, never sent. If the OpenRGB device has a different LED count than
the layout, LED i takes layout point `floor(i * pts / leds)`.

`layers[]`: `{on, gen, p, stops, blend, opacity}`; `gen` = `wave|radial|rainbow|noise|scan|solid|sparkle|audio`;
`p` = `{speed, scale, rot, axis 0|1|2, mirror, ease, trail, width}`; `stops` = `[{p 0..1, c "#rrggbb"}]` (at least 2);
`blend` = `add|mix|multiply|max`; `opacity` 0..1. The `audio` generator follows the level of the game audio the recorder already meters.

Simple mode drives only devices listed in `simple`; Advanced drives only devices with a `link`. A device that drops out of the scene is
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
