//! OpenRGB SDK wire format (protocol 5), the part Buffer needs: framing, controller data, colour updates.
//! OpenRGB runs as its own process (GPL-2.0, never linked); this is a client for its documented TCP socket.
//! Measured against OpenRGB 1.0 (server protocol 6, we ask for 5): after the LED colours the server appends 6 bytes
//! (a u16 and a u32) that are not used here.

use serde::Serialize;

pub const MAGIC: &[u8; 4] = b"ORGB";
pub const PROTOCOL: u32 = 5;

pub const REQ_COUNT: u32 = 0;
pub const REQ_DATA: u32 = 1;
pub const REQ_PROTOCOL: u32 = 40;
pub const SET_NAME: u32 = 50;
pub const UPDATE_LEDS: u32 = 1050;
pub const SET_CUSTOM_MODE: u32 = 1100;
pub const UPDATE_MODE: u32 = 1101;
pub const RESIZE_ZONE: u32 = 1000;

/// Mode flags (OpenRGB `MODE_FLAG_*`).
pub mod flag {
    pub const SPEED: u32 = 1 << 0;
    pub const DIR_LR: u32 = 1 << 1;
    pub const DIR_UD: u32 = 1 << 2;
    pub const DIR_HV: u32 = 1 << 3;
    pub const BRIGHTNESS: u32 = 1 << 4;
    pub const PER_LED_COLOR: u32 = 1 << 5;
    pub const MODE_COLORS: u32 = 1 << 6;
    pub const RANDOM_COLOR: u32 = 1 << 7;
    pub const MANUAL_SAVE: u32 = 1 << 8;
    pub const AUTOMATIC_SAVE: u32 = 1 << 9;
}

/// One frame: `ORGB`, device index, packet id, payload size, payload.
pub fn frame(dev: u32, id: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(16 + payload.len());
    v.extend_from_slice(MAGIC);
    v.extend_from_slice(&dev.to_le_bytes());
    v.extend_from_slice(&id.to_le_bytes());
    v.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    v.extend_from_slice(payload);
    v
}

/// (device, packet id, payload size) from a 16 byte header.
pub fn header(h: &[u8; 16]) -> Result<(u32, u32, u32), String> {
    if &h[..4] != MAGIC {
        return Err("not an OpenRGB packet".into());
    }
    let u = |i: usize| u32::from_le_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]);
    Ok((u(4), u(8), u(12)))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Mode {
    pub name: String,
    pub value: i32,
    pub flags: u32,
    pub speed_min: u32,
    pub speed_max: u32,
    pub brightness_min: u32,
    pub brightness_max: u32,
    pub colors_min: u32,
    pub colors_max: u32,
    pub speed: u32,
    pub brightness: u32,
    pub direction: u32,
    pub color_mode: u32,
    /// the mode as the server sent it, so it can be sent back unchanged (restore)
    #[serde(skip)]
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Zone {
    pub name: String,
    pub kind: i32,
    pub leds_min: u32,
    pub leds_max: u32,
    pub leds: u32,
}

impl Zone {
    /// An addressable header whose length the user can set (min and max differ).
    pub fn resizable(&self) -> bool {
        self.leds_min != self.leds_max
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Device {
    pub kind: i32,
    pub name: String,
    pub vendor: String,
    pub description: String,
    pub location: String,
    pub active_mode: i32,
    pub modes: Vec<Mode>,
    pub zones: Vec<Zone>,
    pub led_names: Vec<String>,
    pub colors: Vec<[u8; 3]>,
}

impl Device {
    /// Direct / Custom: the mode in which per-LED colours are shown at once.
    pub fn direct_mode(&self) -> Option<usize> {
        self.modes.iter().position(|m| matches!(m.name.to_ascii_lowercase().as_str(), "direct" | "custom"))
    }
}

struct Rd<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let s = self.b.get(self.o..self.o + n).ok_or("controller data is cut short")?;
        self.o += n;
        Ok(s)
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }
    /// u16 length (counting the trailing NUL), bytes, NUL
    fn string(&mut self) -> Result<String, String> {
        let n = self.u16()? as usize;
        let s = self.take(n)?;
        Ok(String::from_utf8_lossy(&s[..n.saturating_sub(1)]).into_owned())
    }
    fn colors(&mut self) -> Result<Vec<[u8; 3]>, String> {
        let n = self.u16()? as usize;
        let s = self.take(4 * n)?;
        Ok(s.chunks_exact(4).map(|c| [c[0], c[1], c[2]]).collect())
    }
}

/// Parses the payload of a REQ_DATA reply (including its leading size field).
pub fn parse_device(d: &[u8]) -> Result<Device, String> {
    let mut r = Rd { b: d, o: 0 };
    r.u32()?;
    let kind = r.i32()?;
    let (name, vendor, description) = (r.string()?, r.string()?, r.string()?);
    let _version = r.string()?;
    let _serial = r.string()?;
    let location = r.string()?;
    let n_modes = r.u16()?;
    let active_mode = r.i32()?;
    let mut modes = Vec::with_capacity(n_modes as usize);
    for _ in 0..n_modes {
        let start = r.o;
        let name = r.string()?;
        let value = r.i32()?;
        let flags = r.u32()?;
        let (speed_min, speed_max, brightness_min, brightness_max, colors_min, colors_max) = (r.u32()?, r.u32()?, r.u32()?, r.u32()?, r.u32()?, r.u32()?);
        let speed = r.u32()?;
        let brightness = r.u32()?;
        let (direction, color_mode) = (r.u32()?, r.u32()?);
        r.colors()?;
        modes.push(Mode { name, value, flags, speed_min, speed_max, brightness_min, brightness_max, colors_min, colors_max, speed, brightness, direction, color_mode, raw: d[start..r.o].to_vec() });
    }
    let n_zones = r.u16()?;
    let mut zones = Vec::with_capacity(n_zones as usize);
    for _ in 0..n_zones {
        let name = r.string()?;
        let kind = r.i32()?;
        let (leds_min, leds_max, leds) = (r.u32()?, r.u32()?, r.u32()?);
        let matrix = r.u16()? as usize;
        r.take(matrix)?;
        for _ in 0..r.u16()? {
            r.string()?;
            r.i32()?;
            r.u32()?;
            r.u32()?;
        }
        r.u32()?; // zone flags
        zones.push(Zone { name, kind, leds_min, leds_max, leds });
    }
    let n_leds = r.u16()?;
    let mut led_names = Vec::with_capacity(n_leds as usize);
    for _ in 0..n_leds {
        led_names.push(r.string()?);
        r.u32()?;
    }
    let colors = r.colors()?;
    Ok(Device { kind, name, vendor, description, location, active_mode, modes, zones, led_names, colors })
}

/// The mode Buffer streams colours in: "Direct" (or "Custom") with a colour per LED, and not one that saves to the
/// device's memory on every change. `None` when the device has no such mode (it is then left to `SET_CUSTOM_MODE`).
pub fn direct_mode(modes: &[Mode]) -> Option<usize> {
    modes.iter().position(|m| {
        (m.name.eq_ignore_ascii_case("direct") || m.name.eq_ignore_ascii_case("custom"))
            && m.flags & flag::PER_LED_COLOR != 0
            && m.flags & flag::AUTOMATIC_SAVE == 0
    })
}

/// UPDATE_LEDS payload: total size, colour count, one `r g b 0` per LED.
pub fn leds_payload(colors: &[[u8; 3]]) -> Vec<u8> {
    let size = 4 + 2 + 4 * colors.len();
    let mut v = Vec::with_capacity(size);
    v.extend_from_slice(&(size as u32).to_le_bytes());
    v.extend_from_slice(&(colors.len() as u16).to_le_bytes());
    for c in colors {
        v.extend_from_slice(&[c[0], c[1], c[2], 0]);
    }
    v
}

/// A whole UPDATE_LEDS packet (header + payload) written into `buf`, reusing its capacity: the per-frame path allocates nothing.
pub fn write_leds_frame(buf: &mut Vec<u8>, dev: u32, colors: &[[u8; 3]]) {
    let size = 4 + 2 + 4 * colors.len();
    buf.clear();
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&dev.to_le_bytes());
    buf.extend_from_slice(&UPDATE_LEDS.to_le_bytes());
    buf.extend_from_slice(&(size as u32).to_le_bytes());
    buf.extend_from_slice(&(size as u32).to_le_bytes());
    buf.extend_from_slice(&(colors.len() as u16).to_le_bytes());
    for c in colors {
        buf.extend_from_slice(&[c[0], c[1], c[2], 0]);
    }
}

/// What to change in a mode before it is sent back (`None` keeps the server's value).
#[derive(Debug, Clone, Default)]
pub struct ModeEdit {
    pub speed: Option<u32>,
    pub brightness: Option<u32>,
    pub direction: Option<u32>,
    pub color_mode: Option<u32>,
    pub colors: Option<Vec<[u8; 3]>>,
}

/// A copy of a mode's bytes with `e` applied. Layout after the name: value, flags, speed min/max, brightness min/max,
/// colours min/max, speed, brightness, direction, colour mode (u32 each), then the colour count (u16) and 4 bytes per colour.
pub fn edit_mode(raw: &[u8], e: &ModeEdit) -> Result<Vec<u8>, String> {
    let name = u16::from_le_bytes(raw.get(..2).ok_or("mode is cut short")?.try_into().unwrap()) as usize;
    let o = 2 + name;
    let colors_at = o + 48;
    if raw.len() < colors_at + 2 {
        return Err("mode is cut short".into());
    }
    let mut v = raw[..colors_at].to_vec();
    let put = |v: &mut Vec<u8>, at: usize, x: u32| v[at..at + 4].copy_from_slice(&x.to_le_bytes());
    if let Some(x) = e.speed { put(&mut v, o + 32, x); }
    if let Some(x) = e.brightness { put(&mut v, o + 36, x); }
    if let Some(x) = e.direction { put(&mut v, o + 40, x); }
    if let Some(x) = e.color_mode { put(&mut v, o + 44, x); }
    match &e.colors {
        Some(c) => {
            v.extend_from_slice(&(c.len() as u16).to_le_bytes());
            for k in c {
                v.extend_from_slice(&[k[0], k[1], k[2], 0]);
            }
        }
        None => v.extend_from_slice(&raw[colors_at..]),
    }
    Ok(v)
}

/// UPDATE_MODE payload for a mode given as raw bytes (see [`edit_mode`]).
pub fn mode_payload_raw(mode_index: u32, raw: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + raw.len());
    v.extend_from_slice(&((8 + raw.len()) as u32).to_le_bytes());
    v.extend_from_slice(&mode_index.to_le_bytes());
    v.extend_from_slice(raw);
    v
}

/// RESIZE_ZONE payload: zone index, new LED count.
pub fn resize_payload(zone: u32, size: u32) -> Vec<u8> {
    let mut v = Vec::with_capacity(8);
    v.extend_from_slice(&zone.to_le_bytes());
    v.extend_from_slice(&size.to_le_bytes());
    v
}

/// UPDATE_MODE payload that makes `mode_index` active with the mode bytes as they came from the server.
pub fn mode_payload(mode_index: u32, mode: &Mode) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + mode.raw.len());
    v.extend_from_slice(&((8 + mode.raw.len()) as u32).to_le_bytes());
    v.extend_from_slice(&mode_index.to_le_bytes());
    v.extend_from_slice(&mode.raw);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    /// Controller data of a SteelSeries Arctis 5 as OpenRGB 1.0 sent it (captured 2026-10-16).
    const ARCTIS: &str = "6c010000080000001500537465656c536572696573204172637469732035000c00537465656c536572696573002400537465656c5365726965732041726374697320352048656164736574204465766963650001000009003030303030303030005e004849443a205c5c3f5c484944235649445f31303338265049445f31324141264d495f3035233826333462353062313226302630303030237b34643165353562322d663136662d313163662d383863622d3030313131313030303033307d000100000000000700446972656374000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000020005004c656674000000000001000000010000000100000000000000000000000600526967687400000000000100000001000000010000000000000000000000020005004c656674000000000006005269676874000000000002000000000000000000000001000000";

    #[test]
    fn parses_a_real_headset() {
        let d = parse_device(&unhex(ARCTIS)).unwrap();
        assert_eq!(d.name, "SteelSeries Arctis 5");
        assert_eq!(d.vendor, "SteelSeries");
        assert_eq!(d.modes.len(), 1);
        assert_eq!(d.direct_mode(), Some(0));
        assert_eq!(d.zones.iter().map(|z| (z.name.as_str(), z.leds)).collect::<Vec<_>>(), [("Left", 1), ("Right", 1)]);
        assert_eq!(d.led_names, ["Left", "Right"]);
        assert_eq!(d.colors, [[0, 0, 0], [0, 0, 0]]);
    }

    #[test]
    fn truncated_data_is_an_error_not_a_panic() {
        let full = unhex(ARCTIS);
        for cut in [0, 3, 40, 200, full.len() - 9] {
            assert!(parse_device(&full[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn frames_and_headers_round_trip() {
        let f = frame(3, UPDATE_LEDS, &leds_payload(&[[1, 2, 3]]));
        let h: [u8; 16] = f[..16].try_into().unwrap();
        assert_eq!(header(&h).unwrap(), (3, UPDATE_LEDS, 10));
        assert_eq!(&f[16..], &[10, 0, 0, 0, 1, 0, 1, 2, 3, 0]);
        assert!(header(&[0; 16]).is_err());
    }

    #[test]
    fn the_reusable_frame_equals_the_allocating_one() {
        let c = [[1, 2, 3], [4, 5, 6]];
        let mut b = Vec::new();
        write_leds_frame(&mut b, 7, &c);
        assert_eq!(b, frame(7, UPDATE_LEDS, &leds_payload(&c)));
    }

    /// A mode as the server sends it, built by hand ("Rainbow Wave": speed, brightness, direction, 2 mode colours).
    fn fake_mode() -> Vec<u8> {
        let mut v = Vec::new();
        let name = b"Rainbow Wave\0";
        v.extend_from_slice(&(name.len() as u16).to_le_bytes());
        v.extend_from_slice(name);
        for x in [2u32, flag::SPEED | flag::DIR_LR | flag::BRIGHTNESS | flag::MODE_COLORS, 1, 5, 0, 100, 0, 2, 3, 100, 0, 2] {
            v.extend_from_slice(&x.to_le_bytes());
        }
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&[9, 8, 7, 0]);
        v
    }

    #[test]
    fn edit_mode_changes_only_what_is_asked() {
        let raw = fake_mode();
        assert_eq!(edit_mode(&raw, &ModeEdit::default()).unwrap(), raw, "no edit, same bytes");
        let e = edit_mode(&raw, &ModeEdit { speed: Some(5), direction: Some(1), colors: Some(vec![[1, 2, 3], [4, 5, 6]]), ..Default::default() }).unwrap();
        let o = 2 + 13;
        let u = |at: usize| u32::from_le_bytes(e[o + at..o + at + 4].try_into().unwrap());
        assert_eq!((u(32), u(36), u(40), u(44)), (5, 100, 1, 2), "speed and direction set, brightness and colour mode kept");
        assert_eq!(&e[o + 48..], &[2, 0, 1, 2, 3, 0, 4, 5, 6, 0], "two colours");
        assert_eq!(&e[..o + 32], &raw[..o + 32], "everything before the values is untouched");
        assert!(edit_mode(&raw[..10], &ModeEdit::default()).is_err());
        assert_eq!(mode_payload_raw(3, &raw).len(), 8 + raw.len());
        assert_eq!(resize_payload(1, 30), [1, 0, 0, 0, 30, 0, 0, 0]);
    }

    #[test]
    fn mode_payload_keeps_the_server_bytes() {
        let d = parse_device(&unhex(ARCTIS)).unwrap();
        let p = mode_payload(0, &d.modes[0]);
        assert_eq!(p.len(), 8 + d.modes[0].raw.len());
        assert_eq!(&p[8..], &d.modes[0].raw[..]);
    }

    #[test]
    fn direct_mode_is_found_by_name_and_flags() {
        let m = |name: &str, flags: u32| Mode { name: name.into(), value: 0, flags, speed_min: 0, speed_max: 0, brightness_min: 0, brightness_max: 0, colors_min: 0, colors_max: 0, speed: 0, brightness: 0, direction: 0, color_mode: 0, raw: Vec::new() };
        let aerox = [m("Direct", flag::BRIGHTNESS | flag::PER_LED_COLOR | flag::MANUAL_SAVE), m("Rainbow Breathing", flag::MANUAL_SAVE)];
        assert_eq!(direct_mode(&aerox), Some(0));
        assert_eq!(direct_mode(&[m("Static", flag::MODE_COLORS), m("custom", flag::PER_LED_COLOR)]), Some(1));
        // a Direct that writes to the device's memory every time is left alone, and so is a mode without a colour per LED
        assert_eq!(direct_mode(&[m("Direct", flag::PER_LED_COLOR | flag::AUTOMATIC_SAVE)]), None);
        assert_eq!(direct_mode(&[m("Direct", 0), m("Rainbow", flag::PER_LED_COLOR)]), None);
    }
}
