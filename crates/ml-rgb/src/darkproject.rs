//! Dark Project keyboards of the "CommonKeyboardSeries" family (VID 0x342D, PID 0xE40F, e.g. DPKB_MIDNIGHT_87_ANSI).
//!
//! Protocol notes: `docs-rgb-keyboard.md`. Summary: HID feature report id 7 on the vendor collection (usage page
//! 0xFF01); every lighting change is a read-modify-write of the keyboard's STORED profile (command 0x82 read, 0x02
//! write). There is no volatile "live" lighting command, so every write here changes the stored profile. The driver
//! therefore works with snapshots: take one before writing, `restore` writes it back byte for byte.
//!
//! Only lighting commands are implemented (0x81, 0x82, 0x8A reads; 0x02 and 0x0A writes). Profile switching (0x01,
//! including its 0xFF factory reset form), key bindings, macros, Snap Tap, sleep/debounce and bootloader/firmware
//! commands (0x30, 0x32) are deliberately absent and `build_*` helpers refuse to emit them.
//!
//! The packet builders are pure functions (no hardware); the HID transport is Windows-only (`hidapi`, windows-native).

/// Vendor id of the keyboard (Dark Project).
pub const VID: u16 = 0x342D;
/// Product id of the CommonKeyboardSeries keyboards.
pub const PID: u16 = 0xE40F;
/// HID feature report id used for every command.
pub const REPORT_ID: u8 = 7;
/// Vendor usage page of the configuration collection.
pub const USAGE_PAGE: u16 = 0xFF01;
/// Number of stored profiles.
pub const PROFILES: u8 = 3;
/// Number of stored per-key (custom) lighting presets per profile.
pub const CUSTOM_PRESETS: u8 = 5;
/// LED slots in a per-key plane.
pub const LED_SLOTS: usize = 96;
/// Bytes of the profile payload (command byte included, report id excluded).
pub const PAYLOAD_LEN: usize = 256;
/// Wait between a command and reading its answer; the vendor configurator uses 100 ms for this family.
pub const REPLY_DELAY_MS: u64 = 100;

const CMD_WRITE_PROFILE: u8 = 0x02;
const CMD_WRITE_CUSTOM: u8 = 0x0A;
const CMD_READ_CURRENT_PROFILE: u8 = 0x81;
const CMD_READ_PROFILE: u8 = 0x82;
const CMD_READ_CUSTOM: u8 = 0x8A;

/// HID effect ids (the value stored in profile byte 8).
pub mod effect {
    pub const WAVE: u8 = 0;
    pub const COLOR_CYCLE: u8 = 1;
    pub const RANDOM: u8 = 2;
    pub const BREATHING: u8 = 3;
    pub const SOLID: u8 = 5;
    pub const CUSTOM: u8 = 14;
}

/// Key names in the order of the per-key planes for DPKB_MIDNIGHT_87_ANSI (vendor `ledCodes`; "" is an unused slot,
/// `K64` is the ISO-only key). Slot index = position in each of the R/G/B planes. Column-major: 6 rows per column.
pub const MIDNIGHT_87_ANSI_LEDS: [&str; LED_SLOTS] = [
    "Escape", "Backquote", "Tab", "CapsLock", "K64", "ShiftLeft", "F1", "Digit1", "KeyQ", "KeyA", "KeyZ",
    "ControlLeft", "F2", "Digit2", "KeyW", "KeyS", "KeyX", "MetaLeft", "F3", "Digit3", "KeyE", "KeyD", "KeyC",
    "AltLeft", "F4", "Digit4", "KeyR", "KeyF", "KeyV", "Space", "F5", "Digit5", "KeyT", "KeyG", "KeyB", "", "F6",
    "Digit6", "KeyY", "KeyH", "KeyN", "", "F7", "Digit7", "KeyU", "KeyJ", "KeyM", "", "F8", "Digit8", "KeyI",
    "KeyK", "Comma", "", "F9", "Digit9", "KeyO", "KeyL", "Period", "", "F10", "Digit0", "KeyP", "Semicolon",
    "Slash", "AltRight", "F11", "Minus", "BracketLeft", "Quote", "ShiftRight", "Custom_Fnkey", "F12", "Equal",
    "BracketRight", "Enter", "ArrowUp", "Menu", "PrintScreen", "Backspace", "Backslash", "", "ArrowRight",
    "ControlRight", "ScrollLock", "Insert", "Delete", "PageUp", "", "ArrowLeft", "Pause", "Home", "End", "PageDown",
    "", "ArrowDown",
];

/// LED slot of a key name from [`MIDNIGHT_87_ANSI_LEDS`].
pub fn led_slot(name: &str) -> Option<usize> {
    if name.is_empty() {
        return None;
    }
    MIDNIGHT_87_ANSI_LEDS.iter().position(|n| *n == name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Profile or preset index out of range.
    BadIndex,
    /// A reply was too short, had a wrong command echo or an implausible value; nothing was written.
    BadReply(&'static str),
    /// More colours than LED slots.
    TooManyKeys,
    /// No matching keyboard / collection.
    NotFound,
    /// Transport failure (message from hidapi).
    Hid(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadIndex => write!(f, "profile/preset index out of range"),
            Error::BadReply(w) => write!(f, "unexpected keyboard reply: {w}"),
            Error::TooManyKeys => write!(f, "more than {LED_SLOTS} key colours"),
            Error::NotFound => write!(f, "Dark Project keyboard not found"),
            Error::Hid(m) => write!(f, "HID error: {m}"),
        }
    }
}
impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------- pure packet builders

fn payload() -> [u8; PAYLOAD_LEN] {
    [0u8; PAYLOAD_LEN]
}

fn check_profile(profile: u8) -> Result<()> {
    if profile < PROFILES {
        Ok(())
    } else {
        Err(Error::BadIndex)
    }
}

/// Request for "which profile is active" (reply byte 2 = profile + 1).
pub fn build_read_current_profile() -> [u8; PAYLOAD_LEN] {
    let mut p = payload();
    p[0] = CMD_READ_CURRENT_PROFILE;
    p
}

/// Request for the stored profile `profile` (0-based). The reply (with report id in byte 0) is the "snapshot".
pub fn build_read_profile(profile: u8) -> Result<[u8; PAYLOAD_LEN]> {
    check_profile(profile)?;
    let mut p = payload();
    p[0] = CMD_READ_PROFILE;
    p[1] = profile + 1;
    Ok(p)
}

/// Request for one 192-byte half (`chunk` 0 or 1) of a stored custom preset. Reply data starts at byte 8.
pub fn build_read_custom(profile: u8, preset: u8, chunk: u8) -> Result<[u8; PAYLOAD_LEN]> {
    check_profile(profile)?;
    if preset >= CUSTOM_PRESETS || chunk > 1 {
        return Err(Error::BadIndex);
    }
    let mut p = payload();
    p[0] = CMD_READ_CUSTOM;
    p[1] = profile + 1;
    p[2] = preset + 1;
    p[3] = chunk + 1;
    Ok(p)
}

/// Validate a profile reply (report id included in byte 0) before it is used as a template for a write.
pub fn validate_snapshot(profile: u8, reply: &[u8]) -> Result<()> {
    check_profile(profile)?;
    if reply.len() < 128 {
        return Err(Error::BadReply("profile reply shorter than 128 bytes"));
    }
    if reply[0] != REPORT_ID {
        return Err(Error::BadReply("report id is not 7"));
    }
    if reply[1] != CMD_READ_PROFILE {
        return Err(Error::BadReply("command echo is not 0x82"));
    }
    if reply[2] != profile + 1 {
        return Err(Error::BadReply("reply is for another profile"));
    }
    if reply[9] > effect::CUSTOM {
        return Err(Error::BadReply("unknown effect id"));
    }
    Ok(())
}

/// Turn a profile reply into the write that stores exactly the same profile (command 0x02). This is both the base
/// of every lighting change and the "restore" packet.
pub fn build_write_profile_from_snapshot(profile: u8, reply: &[u8]) -> Result<[u8; PAYLOAD_LEN]> {
    validate_snapshot(profile, reply)?;
    let mut p = payload();
    let n = (reply.len() - 1).min(PAYLOAD_LEN);
    p[..n].copy_from_slice(&reply[1..1 + n]);
    p[0] = CMD_WRITE_PROFILE;
    Ok(p)
}

/// Solid colour for the profile in `snapshot`. `brightness` is the keyboard's step 0..=4. Only these bytes differ
/// from the snapshot: 0 (command), 8 (effect), 9+5 (brightness), 37+5 (multicolour off), 52 (custom preset off),
/// 58/66/74 (R/G/B of colour 0) and 82 (the vendor sets 8 for every effect except Breathing).
pub fn build_static(profile: u8, snapshot: &[u8], rgb: [u8; 3], brightness: u8) -> Result<[u8; PAYLOAD_LEN]> {
    let mut p = build_write_profile_from_snapshot(profile, snapshot)?;
    let e = effect::SOLID as usize;
    p[8] = effect::SOLID;
    p[9 + e] = brightness.min(4);
    p[37 + e] = 0;
    p[52] = 0;
    p[58] = rgb[0];
    p[66] = rgb[1];
    p[74] = rgb[2];
    p[82] = 8;
    Ok(p)
}

/// One of the keyboard's own effects (the keyboard animates it itself, so this is a single write): `effect_id` from
/// [`effect`], `speed_step` 1 (slowest) ..= 5 (fastest), `brightness` step 0..=4. Colour 0 is `rgb`; the multicolour
/// flag is off, except for Colour Cycle which ignores colours. Same bytes as [`build_static`] plus 23+e (speed).
pub fn build_effect(profile: u8, snapshot: &[u8], effect_id: u8, rgb: [u8; 3], brightness: u8, speed_step: u8) -> Result<[u8; PAYLOAD_LEN]> {
    if !matches!(effect_id, effect::WAVE | effect::COLOR_CYCLE | effect::BREATHING | effect::SOLID) {
        return Err(Error::BadIndex);
    }
    let mut p = build_write_profile_from_snapshot(profile, snapshot)?;
    let e = effect_id as usize;
    p[8] = effect_id;
    p[9 + e] = brightness.min(4);
    p[23 + e] = speed_step.clamp(1, 5);
    p[37 + e] = 0;
    p[52] = 0;
    p[58] = rgb[0];
    p[66] = rgb[1];
    p[74] = rgb[2];
    p[82] = if effect_id == effect::BREATHING { 0 } else { 8 };
    Ok(p)
}

/// Select the "Custom" (per-key) effect using stored preset `preset` (0-based) at brightness step 0..=4.
/// Bytes that differ from the snapshot: 0, 8, 9+14, 52 (= preset + 1), 82. (Byte 37+14 would be 51, which the
/// vendor overwrites with the wave direction, so it is left alone.)
pub fn build_select_custom(profile: u8, snapshot: &[u8], preset: u8, brightness: u8) -> Result<[u8; PAYLOAD_LEN]> {
    if preset >= CUSTOM_PRESETS {
        return Err(Error::BadIndex);
    }
    let mut p = build_write_profile_from_snapshot(profile, snapshot)?;
    let e = effect::CUSTOM as usize;
    p[8] = effect::CUSTOM;
    p[9 + e] = brightness.min(4);
    p[52] = preset + 1;
    p[82] = 8;
    Ok(p)
}

/// The two 0x0A reports that store a per-key preset. `colors[i]` is the colour of LED slot `i`
/// (see [`MIDNIGHT_87_ANSI_LEDS`]); missing slots are black. Each report carries 192 bytes from byte 7: chunk 0 =
/// R plane + G plane, chunk 1 = B plane + 96 zero bytes.
pub fn build_custom_chunks(profile: u8, preset: u8, colors: &[[u8; 3]]) -> Result<[[u8; PAYLOAD_LEN]; 2]> {
    check_profile(profile)?;
    if preset >= CUSTOM_PRESETS {
        return Err(Error::BadIndex);
    }
    if colors.len() > LED_SLOTS {
        return Err(Error::TooManyKeys);
    }
    let mut planes = [0u8; 2 * 192];
    for (i, c) in colors.iter().enumerate() {
        planes[i] = c[0];
        planes[LED_SLOTS + i] = c[1];
        planes[2 * LED_SLOTS + i] = c[2];
    }
    let mut out = [payload(), payload()];
    for (chunk, p) in out.iter_mut().enumerate() {
        p[0] = CMD_WRITE_CUSTOM;
        p[1] = profile + 1;
        p[2] = preset + 1;
        p[3] = chunk as u8 + 1;
        p[7..7 + 192].copy_from_slice(&planes[chunk * 192..chunk * 192 + 192]);
    }
    Ok(out)
}

/// Same chunks from raw data read back with 0x8A (replies `reply[8..8+192]`), used by restore.
pub fn build_custom_chunk_from_reply(profile: u8, preset: u8, chunk: u8, reply: &[u8]) -> Result<[u8; PAYLOAD_LEN]> {
    check_profile(profile)?;
    if preset >= CUSTOM_PRESETS || chunk > 1 {
        return Err(Error::BadIndex);
    }
    if reply.len() < 8 + 192 || reply[0] != REPORT_ID || reply[1] != CMD_READ_CUSTOM {
        return Err(Error::BadReply("custom preset reply malformed"));
    }
    let mut p = payload();
    p[0] = CMD_WRITE_CUSTOM;
    p[1] = profile + 1;
    p[2] = preset + 1;
    p[3] = chunk + 1;
    p[7..7 + 192].copy_from_slice(&reply[8..8 + 192]);
    Ok(p)
}

/// Total size (report id included) of feature report `id` from a HID report descriptor, or None. The Windows HID
/// stack wants exactly this many bytes in `HidD_SetFeature`/`HidD_GetFeature`; the vendor's web app sends 256/264
/// byte payloads and the browser pads them, so the driver pads the same way.
pub fn feature_report_len(descriptor: &[u8], id: u8) -> Option<usize> {
    let (mut i, mut cur_id, mut size, mut count) = (0usize, 0u8, 0usize, 0usize);
    let mut bits: Option<usize> = None;
    while i < descriptor.len() {
        let b = descriptor[i];
        if b == 0xFE {
            i += 3 + *descriptor.get(i + 1)? as usize;
            continue;
        }
        let n = match b & 3 {
            3 => 4,
            k => k as usize,
        };
        let data = descriptor.get(i + 1..i + 1 + n)?;
        let value = data.iter().enumerate().fold(0usize, |a, (k, v)| a | (*v as usize) << (8 * k));
        match b & 0xFC {
            0x84 => cur_id = value as u8,
            0x74 => size = value,
            0x94 => count = value,
            0xB0 if cur_id == id => bits = Some(bits.unwrap_or(0) + size * count),
            _ => {}
        }
        i += 1 + n;
    }
    bits.map(|b| 1 + b.div_ceil(8))
}

// ---------------------------------------------------------------- transport (Windows only)

/// A snapshot of the stored state that a lighting call may change; give it to `restore`.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub profile: u8,
    pub profile_reply: Vec<u8>,
    /// (preset, [chunk0 reply, chunk1 reply]) when a per-key preset was captured.
    pub custom: Option<(u8, [Vec<u8>; 2])>,
}

/// One HID collection of the keyboard, for diagnostics.
#[derive(Debug, Clone)]
pub struct CollectionInfo {
    pub path: String,
    pub usage_page: u16,
    pub usage: u16,
    pub product: String,
}

#[cfg(windows)]
pub use win::{detect, list_collections, Keyboard};

#[cfg(windows)]
mod win {
    use super::*;
    use hidapi::{HidApi, HidDevice};
    use std::{ffi::CString, thread, time::Duration};

    fn hid<E: std::fmt::Display>(e: E) -> Error {
        Error::Hid(e.to_string())
    }

    /// Enumerate every HID collection of VID/PID 342D:E40F. Sends nothing to the device.
    pub fn list_collections() -> Result<Vec<CollectionInfo>> {
        let api = HidApi::new().map_err(hid)?;
        Ok(api
            .device_list()
            .filter(|d| d.vendor_id() == VID && d.product_id() == PID)
            .map(|d| CollectionInfo {
                path: d.path().to_string_lossy().into_owned(),
                usage_page: d.usage_page(),
                usage: d.usage(),
                product: d.product_string().unwrap_or_default().to_string(),
            })
            .collect())
    }

    /// Find the configuration collection (usage page 0xFF01). Enumeration only; no report is sent.
    pub fn detect() -> Option<CollectionInfo> {
        list_collections().ok()?.into_iter().find(|c| c.usage_page == USAGE_PAGE)
    }

    pub struct Keyboard {
        dev: HidDevice,
        feature_len: usize,
    }

    impl Keyboard {
        /// Open the configuration collection found by [`detect`]. Opening sends nothing.
        pub fn open(info: &CollectionInfo) -> Result<Self> {
            let api = HidApi::new().map_err(hid)?;
            let path = CString::new(info.path.clone()).map_err(hid)?;
            let dev = api.open_path(&path).map_err(hid)?;
            let mut desc = [0u8; 4096];
            let n = dev.get_report_descriptor(&mut desc).map_err(hid)?;
            let feature_len = feature_report_len(&desc[..n], REPORT_ID)
                .ok_or(Error::BadReply("collection has no feature report 7"))?;
            // Measured on the real Midnight 87: feature report 7 is 255 data bytes + the id (256 total), one byte
            // less than the configurator-derived layout assumed; every command used here ends in zero padding.
            if feature_len < PAYLOAD_LEN {
                return Err(Error::BadReply("feature report 7 smaller than 256 bytes"));
            }
            Ok(Self { dev, feature_len })
        }

        fn send(&self, payload: &[u8; PAYLOAD_LEN]) -> Result<()> {
            let mut buf = vec![0u8; self.feature_len];
            buf[0] = REPORT_ID;
            let n = PAYLOAD_LEN.min(self.feature_len - 1);
            if payload[n..].iter().any(|&b| b != 0) {
                return Err(Error::BadReply("command does not fit the device's feature report"));
            }
            buf[1..1 + n].copy_from_slice(&payload[..n]);
            self.dev.send_feature_report(&buf).map_err(hid)
        }

        fn query(&self, request: &[u8; PAYLOAD_LEN]) -> Result<Vec<u8>> {
            self.send(request)?;
            thread::sleep(Duration::from_millis(REPLY_DELAY_MS));
            let mut buf = vec![0u8; self.feature_len];
            buf[0] = REPORT_ID;
            let n = self.dev.get_feature_report(&mut buf).map_err(hid)?;
            buf.truncate(n);
            Ok(buf)
        }

        /// Active profile, 0-based.
        pub fn current_profile(&self) -> Result<u8> {
            let r = self.query(&build_read_current_profile())?;
            match r.get(2) {
                Some(&v) if (1..=PROFILES).contains(&v) => Ok(v - 1),
                _ => Err(Error::BadReply("current profile out of range")),
            }
        }

        /// Read the stored state of `profile` (and, if given, per-key preset `preset`) so it can be restored.
        pub fn snapshot(&self, profile: u8, preset: Option<u8>) -> Result<Snapshot> {
            let profile_reply = self.query(&build_read_profile(profile)?)?;
            validate_snapshot(profile, &profile_reply)?;
            let custom = match preset {
                Some(pr) => {
                    let a = self.query(&build_read_custom(profile, pr, 0)?)?;
                    let b = self.query(&build_read_custom(profile, pr, 1)?)?;
                    // Validate now so a restore cannot fail half way.
                    build_custom_chunk_from_reply(profile, pr, 0, &a)?;
                    build_custom_chunk_from_reply(profile, pr, 1, &b)?;
                    Some((pr, [a, b]))
                }
                None => None,
            };
            Ok(Snapshot { profile, profile_reply, custom })
        }

        /// Solid `rgb` on the active profile at full brightness. WRITES THE STORED PROFILE (see module docs):
        /// take a [`Snapshot`] first and call [`Keyboard::restore`] to undo.
        pub fn set_static(&self, rgb: [u8; 3]) -> Result<Snapshot> {
            let profile = self.current_profile()?;
            let snap = self.snapshot(profile, None)?;
            self.send(&build_static(profile, &snap.profile_reply, rgb, 4)?)?;
            Ok(snap)
        }

        /// Solid `rgb` written onto the profile of `snap` (taken earlier, before the first lighting write), so every
        /// other field of the profile stays exactly as the user had it. One stored-profile write, no reads.
        pub fn apply_static(&self, snap: &Snapshot, rgb: [u8; 3]) -> Result<()> {
            self.send(&build_static(snap.profile, &snap.profile_reply, rgb, 4)?)
        }

        /// One of the keyboard's own effects written onto the profile of `snap` (see [`build_effect`]).
        pub fn apply_effect(&self, snap: &Snapshot, effect_id: u8, rgb: [u8; 3], brightness: u8, speed_step: u8) -> Result<()> {
            self.send(&build_effect(snap.profile, &snap.profile_reply, effect_id, rgb, brightness, speed_step)?)
        }

        /// Per-key colours (index = LED slot) in custom preset `preset` of the active profile, and select that
        /// preset. Overwrites the stored preset; returns the snapshot (profile + old preset) for `restore`.
        pub fn set_keys(&self, preset: u8, colors: &[[u8; 3]]) -> Result<Snapshot> {
            let profile = self.current_profile()?;
            let snap = self.snapshot(profile, Some(preset))?;
            let chunks = build_custom_chunks(profile, preset, colors)?;
            for c in &chunks {
                self.send(c)?;
                thread::sleep(Duration::from_millis(REPLY_DELAY_MS));
            }
            self.send(&build_select_custom(profile, &snap.profile_reply, preset, 4)?)?;
            Ok(snap)
        }

        /// Write a snapshot back byte for byte (preset first, then the profile that selects it).
        pub fn restore(&self, snap: &Snapshot) -> Result<()> {
            let mut packets = Vec::new();
            if let Some((pr, chunks)) = &snap.custom {
                for (i, r) in chunks.iter().enumerate() {
                    packets.push(build_custom_chunk_from_reply(snap.profile, *pr, i as u8, r)?);
                }
            }
            packets.push(build_write_profile_from_snapshot(snap.profile, &snap.profile_reply)?);
            for p in &packets {
                self.send(p)?;
                thread::sleep(Duration::from_millis(REPLY_DELAY_MS));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_reply(profile: u8) -> Vec<u8> {
        let mut r = vec![0u8; 257];
        r[0] = REPORT_ID;
        r[1] = CMD_READ_PROFILE;
        r[2] = profile + 1;
        r[8] = 4; // polling rate index, must survive
        r[9] = effect::WAVE;
        r[88] = 1; // input latency, must survive
        r[86] = 5; // debounce copy, must survive
        for (i, b) in r.iter_mut().enumerate().skip(10) {
            if i != 88 && i != 86 {
                *b = (i % 7) as u8; // arbitrary content that must be preserved
            }
        }
        r
    }

    fn diff(a: &[u8], b: &[u8]) -> Vec<usize> {
        (0..a.len().min(b.len())).filter(|&i| a[i] != b[i]).collect()
    }

    #[test]
    fn read_requests() {
        let p = build_read_profile(2).unwrap();
        assert_eq!(&p[..3], &[0x82, 3, 0]);
        assert_eq!(p.len(), 256);
        assert_eq!(build_read_current_profile()[0], 0x81);
        let c = build_read_custom(1, 4, 1).unwrap();
        assert_eq!(&c[..4], &[0x8A, 2, 5, 2]);
        assert_eq!(build_read_profile(3), Err(Error::BadIndex));
        assert_eq!(build_read_custom(0, 5, 0), Err(Error::BadIndex));
        assert_eq!(build_read_custom(0, 0, 2), Err(Error::BadIndex));
    }

    #[test]
    fn restore_packet_is_the_snapshot_with_write_command() {
        let r = fake_reply(1);
        let p = build_write_profile_from_snapshot(1, &r).unwrap();
        assert_eq!(p[0], 0x02);
        assert_eq!(&p[1..], &r[2..]);
        assert_eq!(p[1], 2);
    }

    #[test]
    fn static_changes_only_expected_bytes() {
        let r = fake_reply(0);
        let base = build_write_profile_from_snapshot(0, &r).unwrap();
        let p = build_static(0, &r, [0xB4, 0xFF, 0x00], 4).unwrap();
        let changed = diff(&base, &p);
        let allowed = [8usize, 14, 42, 52, 58, 66, 74, 82];
        assert!(changed.iter().all(|i| allowed.contains(i)), "unexpected bytes changed: {changed:?}");
        assert_eq!((p[0], p[8], p[14], p[42], p[52], p[82]), (0x02, 5, 4, 0, 0, 8));
        assert_eq!((p[58], p[66], p[74]), (0xB4, 0xFF, 0x00));
        // polling rate, latency, debounce preserved
        assert_eq!((p[7], p[87], p[85]), (base[7], base[87], base[85]));
    }

    #[test]
    fn effects_change_only_their_own_bytes() {
        let r = fake_reply(0);
        let base = build_write_profile_from_snapshot(0, &r).unwrap();
        // breathing (3): brightness at 9+3, speed at 23+3, colour 0, byte 82 = 0
        let p = build_effect(0, &r, effect::BREATHING, [1, 2, 3], 2, 4).unwrap();
        assert_eq!((p[8], p[12], p[26], p[40], p[52], p[58], p[66], p[74], p[82]), (3, 2, 4, 0, 0, 1, 2, 3, 0));
        assert!(diff(&base, &p).iter().all(|i| [8usize, 12, 26, 40, 52, 58, 66, 74, 82].contains(i)), "{:?}", diff(&base, &p));
        // colour cycle (1), wave (0): speed clamps into 1..=5
        assert_eq!(build_effect(0, &r, effect::COLOR_CYCLE, [0; 3], 4, 9).unwrap()[24], 5);
        assert_eq!(build_effect(0, &r, effect::WAVE, [0; 3], 4, 0).unwrap()[23], 1);
        // anything else (footprint, custom, reset-like ids) is refused
        assert_eq!(build_effect(0, &r, effect::CUSTOM, [0; 3], 4, 3), Err(Error::BadIndex));
        assert_eq!(build_effect(0, &r, 4, [0; 3], 4, 3), Err(Error::BadIndex));
        // polling rate, latency, debounce preserved
        assert_eq!((p[7], p[87], p[85]), (base[7], base[87], base[85]));
    }

    #[test]
    fn select_custom_sets_preset_index() {
        let r = fake_reply(0);
        let base = build_write_profile_from_snapshot(0, &r).unwrap();
        let p = build_select_custom(0, &r, 2, 3).unwrap();
        assert_eq!((p[8], p[23], p[52], p[82]), (14, 3, 3, 8));
        let allowed = [8usize, 23, 52, 82];
        assert!(diff(&base, &p).iter().all(|i| allowed.contains(i)));
        assert_eq!(build_select_custom(0, &r, 5, 3), Err(Error::BadIndex));
    }

    #[test]
    fn custom_chunks_layout() {
        let mut colors = vec![[0u8; 3]; LED_SLOTS];
        colors[0] = [1, 2, 3];
        colors[95] = [4, 5, 6];
        let c = build_custom_chunks(1, 3, &colors).unwrap();
        for (i, p) in c.iter().enumerate() {
            assert_eq!(&p[..4], &[0x0A, 2, 4, i as u8 + 1]);
            assert_eq!(&p[4..7], &[0, 0, 0]);
        }
        // chunk 0: R plane then G plane
        assert_eq!((c[0][7], c[0][7 + 95], c[0][7 + 96], c[0][7 + 96 + 95]), (1, 4, 2, 5));
        // chunk 1: B plane then zeros
        assert_eq!((c[1][7], c[1][7 + 95]), (3, 6));
        assert!(c[1][7 + 96..7 + 192].iter().all(|b| *b == 0));
        assert!(c[0][7 + 192..].iter().all(|b| *b == 0));
        assert_eq!(build_custom_chunks(0, 0, &vec![[0; 3]; 97]), Err(Error::TooManyKeys));
    }

    #[test]
    fn restore_custom_chunk_roundtrip() {
        let colors: Vec<[u8; 3]> = (0..LED_SLOTS).map(|i| [i as u8, 255 - i as u8, 7]).collect();
        let chunks = build_custom_chunks(0, 1, &colors).unwrap();
        for (i, c) in chunks.iter().enumerate() {
            // a reply carries the same 192 bytes from byte 8 (report id shifts everything by one)
            let mut reply = vec![0u8; 257];
            reply[0] = REPORT_ID;
            reply[1] = CMD_READ_CUSTOM;
            reply[8..8 + 192].copy_from_slice(&c[7..7 + 192]);
            let w = build_custom_chunk_from_reply(0, 1, i as u8, &reply).unwrap();
            assert_eq!(&w[..], &c[..]);
        }
    }

    #[test]
    fn bad_replies_are_refused() {
        let mut r = fake_reply(0);
        assert!(build_static(1, &r, [0; 3], 4).is_err()); // wrong profile
        r[1] = 0x81;
        assert!(build_static(0, &r, [0; 3], 4).is_err()); // wrong echo
        assert!(build_static(0, &r[..50], [0; 3], 4).is_err()); // short
        let mut r = fake_reply(0);
        r[9] = 99;
        assert!(build_static(0, &r, [0; 3], 4).is_err()); // implausible effect
    }

    #[test]
    fn never_emits_dangerous_commands() {
        let r = fake_reply(0);
        let mut all: Vec<[u8; PAYLOAD_LEN]> = vec![
            build_read_current_profile(),
            build_read_profile(0).unwrap(),
            build_read_custom(0, 0, 0).unwrap(),
            build_static(0, &r, [1, 2, 3], 4).unwrap(),
            build_select_custom(0, &r, 0, 4).unwrap(),
        ];
        all.extend(build_custom_chunks(0, 0, &[]).unwrap());
        for p in all {
            assert!([0x02, 0x0A, 0x81, 0x82, 0x8A].contains(&p[0]), "cmd {:#x}", p[0]);
        }
    }

    #[test]
    fn descriptor_feature_size() {
        // Usage Page FF01, Usage 1, Collection, Report ID 7, size 8, count 2055, Feature, End
        let d = [
            0x06, 0x01, 0xFF, 0x09, 0x01, 0xA1, 0x01, 0x85, 0x07, 0x75, 0x08, 0x96, 0x07, 0x08, 0xB1, 0x02, 0xC0,
        ];
        assert_eq!(feature_report_len(&d, 7), Some(2056));
        assert_eq!(feature_report_len(&d, 8), None);
    }

    #[test]
    fn led_table() {
        assert_eq!(MIDNIGHT_87_ANSI_LEDS.len(), 96);
        assert_eq!(led_slot("Escape"), Some(0));
        assert_eq!(led_slot("ArrowDown"), Some(95));
        assert_eq!(led_slot(""), None);
    }
}
