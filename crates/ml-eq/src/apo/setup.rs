//! Putting Equalizer APO on this machine without its wizard and without its device picker.
//!
//! APO's installer (NSIS) always ends by opening `DeviceSelector.exe /i`, and that program has no switch to attach
//! devices (its `main.cpp` only knows `/u`). So the app runs the pinned installer silently, stops the picker the moment
//! it starts, and does the picker's job itself: the same registry writes as `DeviceAPOInfo::install()` in APO's source
//! (GPL-2.0, <https://sourceforge.net/projects/equalizerapo/>), in the same layout, so APO's own `Uninstall.exe`
//! (which runs `DeviceSelector /u`) restores every device afterwards.
//!
//! Everything that needs thought is a pure function here and unit-tested: [`plan_device`] turns "what the endpoint's
//! `FxProperties` looks like now" into a flat list of registry [`Op`]s. The elevated PowerShell (`apo_setup.ps1`)
//! only applies that list, keeps an undo log, and rolls everything back if a step fails.

use super::reg;
use std::collections::BTreeMap;
use std::path::Path;

pub const PRE_MIX: &str = "{EACD2258-FCAC-4FF4-B36D-419E924A6D79}";
pub const POST_MIX: &str = "{EC1CC9CE-FAED-4822-828A-82A81A6F018F}";

const MM: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio";
const AUDIO_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Audio";
const CHILD: &str = r"SOFTWARE\EqualizerAPO\Child APOs";

const LFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},1";
const GFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},2";
const SFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5";
const MFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},6";
const EFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},7";
const MULTI_FX: [&str; 3] = [
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},13",
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},14",
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},15",
];
/// The five slots APO records and restores, in the order of its `allGuidValueNames`.
const SLOTS: [&str; 5] = [LFX, GFX, SFX, MFX, EFX];
const SFX_MODES: &str = "{d3993a3f-99c2-4402-b5ec-a92a0367664b},5";
const MFX_MODES: &str = "{d3993a3f-99c2-4402-b5ec-a92a0367664b},6";
const EFX_MODES: &str = "{d3993a3f-99c2-4402-b5ec-a92a0367664b},7";
const DEFAULT_MODE: &str = "{C18E2F7E-933D-4965-B7D1-1EEF228D2AF3}";
const FX_TITLE: &str = "{b725f130-47ef-101a-a5f1-02608c9eebac},10";
const DISABLE_ENHANCEMENTS: &str = "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5";
/// Present on Bluetooth devices Windows 11 has combined (render + capture): EFX does not work there.
const COMBINED: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},41";
const NO_KEY: &str = "!KEY";
const NO_VALUE: &str = "!VALUE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Render,
    Capture,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Render => "Render",
            Kind::Capture => "Capture",
        }
    }

    /// Render or capture, from a WASAPI endpoint id (`{0.0.0.00000000}.{guid}` is playback, `{0.0.1...}` capture).
    pub fn of_id(id: &str) -> Kind {
        if id.starts_with("{0.0.1.") {
            Kind::Capture
        } else {
            Kind::Render
        }
    }
}

/// One registry write, applied in order by the elevated script. Paths are under HKLM (64-bit view).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Key(String),
    Sz(String, String, String),
    Multi(String, String, String),
    Dword(String, String, u32),
    Del(String, String),
}

/// What an endpoint's `FxProperties` looks like now (value names lower case).
#[derive(Debug, Clone, Default)]
pub struct Fx {
    pub key: bool,
    /// name -> text for REG_SZ values, `None` for any other type
    pub values: BTreeMap<String, Option<String>>,
    pub combined: bool,
}

impl Fx {
    fn has(&self, name: &str) -> bool {
        self.values.contains_key(&name.to_ascii_lowercase())
    }

    fn text(&self, name: &str) -> Option<&str> {
        self.values.get(&name.to_ascii_lowercase()).and_then(|v| v.as_deref())
    }

    fn attached(&self) -> bool {
        SLOTS.iter().any(|s| self.text(s).is_some_and(|t| t.eq_ignore_ascii_case(PRE_MIX) || t.eq_ignore_ascii_case(POST_MIX)))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    LfxGfx,
    SfxMfx,
    SfxEfx,
}

/// APO's own choice for an endpoint it has not touched yet (`DeviceAPOInfo::load`, Windows 8.1+).
fn mode_for(fx: &Fx) -> Mode {
    if !fx.key {
        return Mode::LfxGfx;
    }
    let only_lfx_gfx = (fx.has(LFX) || fx.has(GFX))
        && !fx.has(SFX)
        && !fx.has(MFX)
        && !fx.has(EFX)
        && !MULTI_FX.iter().any(|m| fx.has(m));
    if only_lfx_gfx {
        Mode::LfxGfx
    } else if fx.combined {
        Mode::SfxMfx
    } else {
        Mode::SfxEfx
    }
}

/// The original APO that APO's `PreMixChild` / `PostMixChild` wraps (`getOriginalAPOPreMix` / `PostMix`).
fn originals(mode: Mode, o: &[String; 5]) -> (String, String) {
    let [l, g, s, m, e] = o;
    let none = |v: &String| v == NO_VALUE;
    let (pre, post) = match mode {
        Mode::LfxGfx => {
            let both = none(l) && none(g);
            (if both { s } else { l }, if both { m } else { g })
        }
        Mode::SfxMfx => {
            let both = none(s) && none(m);
            (if both { l } else { s }, if both { g } else { m })
        }
        Mode::SfxEfx => {
            let both = none(s) && none(e);
            (if both { l } else { s }, if both { g } else { e })
        }
    };
    let clean = |v: &String| if v == NO_KEY || v == NO_VALUE { String::new() } else { v.clone() };
    (clean(pre), clean(post))
}

/// The writes that attach APO to one endpoint, as the picker does for "tick the device, OK" with its default options
/// (pre-mix everywhere, post-mix on playback, wrap the driver's own APOs, automatic adjustment). Empty when it is
/// already attached.
pub fn plan_device(kind: Kind, guid: &str, fx: &Fx) -> Vec<Op> {
    if fx.attached() {
        return Vec::new();
    }
    let input = kind == Kind::Capture;
    let fx_path = format!(r"{MM}\{}\{guid}\FxProperties", kind.key());
    let child = format!(r"{CHILD}\{guid}");
    let mut ops = vec![Op::Key(child.clone())];

    let mut orig: [String; 5] = Default::default();
    if !fx.key {
        ops.push(Op::Key(fx_path.clone()));
        ops.push(Op::Sz(fx_path.clone(), FX_TITLE.into(), "Equalizer APO".into()));
        orig.iter_mut().for_each(|o| *o = NO_KEY.into());
    } else {
        for (o, name) in orig.iter_mut().zip(SLOTS) {
            *o = if fx.has(name) { fx.text(name).unwrap_or("").to_string() } else { NO_VALUE.into() };
        }
    }
    for (o, name) in orig.iter().zip(SLOTS) {
        ops.push(Op::Sz(child.clone(), name.into(), o.clone()));
    }

    let mode = mode_for(fx);
    let (pre_orig, post_orig) = originals(mode, &orig);
    ops.push(Op::Sz(child.clone(), "PreMixChild".into(), pre_orig));
    ops.push(Op::Sz(child.clone(), "PostMixChild".into(), if input { String::new() } else { post_orig }));
    ops.push(Op::Sz(child.clone(), "AllowSilentBufferModification".into(), "false".into()));
    ops.push(Op::Del(child.clone(), "DisableAutomaticAdjustment".into()));
    // `load()` refuses any other version, which would also break APO's own uninstall
    ops.push(Op::Sz(child, "Version".into(), "2".into()));

    let set = |ops: &mut Vec<Op>, slot: &str, modes: Option<&str>, guid_text: &str| {
        ops.push(Op::Sz(fx_path.clone(), slot.into(), guid_text.into()));
        if let Some(m) = modes {
            if !fx.has(m) {
                ops.push(Op::Multi(fx_path.clone(), m.into(), DEFAULT_MODE.into()));
            }
        }
    };
    let del = |ops: &mut Vec<Op>, slots: &[&str]| {
        for s in slots {
            if fx.has(s) {
                ops.push(Op::Del(fx_path.clone(), (*s).into()));
            }
        }
    };
    match mode {
        Mode::LfxGfx => {
            set(&mut ops, LFX, None, PRE_MIX);
            if !input {
                set(&mut ops, GFX, None, POST_MIX);
            }
            del(&mut ops, &[SFX, MFX, EFX]);
        }
        Mode::SfxMfx => {
            del(&mut ops, &[LFX, GFX]);
            set(&mut ops, SFX, Some(SFX_MODES), PRE_MIX);
            if !input {
                set(&mut ops, MFX, Some(MFX_MODES), POST_MIX);
            }
        }
        Mode::SfxEfx => {
            del(&mut ops, &[LFX, GFX]);
            set(&mut ops, SFX, Some(SFX_MODES), PRE_MIX);
            if !input {
                set(&mut ops, EFX, Some(EFX_MODES), POST_MIX);
            }
        }
    }
    // force-enable audio enhancements, otherwise Windows bypasses every APO
    del(&mut ops, &[DISABLE_ENHANCEMENTS]);
    ops
}

/// Reads an endpoint's current `FxProperties` (no elevation needed).
pub fn read_fx(kind: Kind, guid: &str) -> Fx {
    let base = format!(r"{MM}\{}\{guid}", kind.key());
    let combined = reg::has_value(&format!(r"{base}\Properties"), COMBINED);
    match reg::values(&format!(r"{base}\FxProperties")) {
        None => Fx { key: false, values: BTreeMap::new(), combined },
        Some(list) => Fx {
            key: true,
            values: list.into_iter().map(|(n, ty, data)| (n.to_ascii_lowercase(), (ty == 1).then(|| reg::utf16_text(&data)))).collect(),
            combined,
        },
    }
}

/// `{guid}` of an endpoint, lower case, from a WASAPI id or a bare guid.
pub fn guid_of(id: &str) -> String {
    id.rsplit_once("}.").map(|(_, g)| g).unwrap_or(id).to_ascii_lowercase()
}

pub fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && s[1..37].char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// Everything needed to attach APO to `devices` (those already attached are skipped).
pub fn plan_attach(devices: &[(Kind, String)]) -> Result<Vec<Op>, String> {
    let mut ops = Vec::new();
    // a driver install can switch this off; without it the audio engine refuses unsigned APOs
    if reg::dword(AUDIO_KEY, "DisableProtectedAudioDG") != Some(1) {
        ops.push(Op::Dword(AUDIO_KEY.into(), "DisableProtectedAudioDG".into(), 1));
    }
    for (kind, guid) in devices {
        let guid = guid.to_ascii_lowercase();
        if !is_guid(&guid) {
            return Err(format!("not an endpoint guid: {guid}"));
        }
        ops.extend(plan_device(*kind, &guid, &read_fx(*kind, &guid)));
    }
    Ok(ops)
}

/// Endpoints of `wanted` that APO is not attached to yet.
pub fn missing(status: &super::Status, wanted: &[(Kind, String)]) -> Vec<(Kind, String)> {
    wanted.iter().filter(|(_, g)| !status.devices.iter().any(|d| d.eq_ignore_ascii_case(g))).cloned().collect()
}

/// Long registry prefixes travel as short aliases (`%M`, `%C`): the whole script goes on one command line.
fn safe(s: &str) -> Result<String, String> {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || " {}-,!._\\:".contains(c)) {
        Ok(s.replace(MM, "%M").replace(CHILD, "%C"))
    } else {
        Err(format!("unsafe text in a registry operation: {s}"))
    }
}

/// The ops as the script reads them: one `type|path|name|value` line each. Only a small alphabet is allowed, so a
/// value read from the registry can never carry a quote or a separator into the elevated script.
pub fn ops_text(ops: &[Op]) -> Result<String, String> {
    let mut out = String::new();
    for op in ops {
        let line = match op {
            Op::Key(p) => format!("key|{}", safe(p)?),
            Op::Sz(p, n, v) => format!("sz|{}|{}|{}", safe(p)?, safe(n)?, safe(v)?),
            Op::Multi(p, n, v) => format!("multi|{}|{}|{}", safe(p)?, safe(n)?, safe(v)?),
            Op::Dword(p, n, v) => format!("dword|{}|{}|{v}", safe(p)?, safe(n)?),
            Op::Del(p, n) => format!("del|{}|{}", safe(p)?, safe(n)?),
        };
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

const SCRIPT: &str = include_str!("../apo_setup.ps1");

/// The elevated script: installs from `installer` when given (its SHA-256 is checked again inside), then applies
/// `ops` and restarts the Windows audio service; any failure undoes everything this run did. `log` is for tests.
pub fn setup_script(installer: Option<&Path>, sha256: &str, ops: &[Op], log: Option<&Path>) -> Result<String, String> {
    let path_text = |p: &Path| -> Result<String, String> {
        let s = p.to_str().ok_or("path is not text")?;
        if s.chars().any(|c| c == '\'' || c == '\r' || c == '\n' || c == '"' || c == '`' || c == '$') {
            return Err("unsafe character in a path".into());
        }
        Ok(s.to_string())
    };
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("bad hash".into());
    }
    // comments and indentation do not need to travel
    let script: String = SCRIPT
        .lines()
        .filter(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
        .map(|l| l.trim_start())
        .collect::<Vec<_>>()
        .join("\n");
    let out = script
        .replace("@@EXE@@", &installer.map(path_text).transpose()?.unwrap_or_default())
        .replace("@@HASH@@", &sha256.to_ascii_lowercase())
        .replace("@@LOG@@", &log.map(path_text).transpose()?.unwrap_or_default())
        .replace("@@OPS@@", ops_text(ops)?.trim_end());
    // CreateProcess takes 32767 characters; the UTF-16 base64 form is 8/3 of the text
    if out.len() * 8 / 3 > 30_000 {
        return Err("too many devices to set up in one step".into());
    }
    Ok(out)
}

/// `powershell -EncodedCommand` wants base64 of UTF-16LE.
pub fn encode_command(script: &str) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Exit codes of the elevated script, as text for the UI.
pub fn exit_message(code: i32) -> Option<&'static str> {
    match code {
        0 => None,
        99 => Some("cancelled"),
        10 => Some("the installer does not match the expected hash"),
        11 => Some("Equalizer APO's installer did not finish (nothing was changed)"),
        12 => Some("could not attach Equalizer APO to the audio devices (nothing was changed)"),
        13 => Some("the Windows audio service did not restart (nothing was changed)"),
        _ => Some("setup failed (nothing was changed)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const G: &str = "{51828c0d-bfff-4a01-b3e8-140a4b0ec4bc}";

    fn fx(values: &[(&str, &str)]) -> Fx {
        Fx { key: true, values: values.iter().map(|(n, v)| (n.to_ascii_lowercase(), Some(v.to_string()))).collect(), combined: false }
    }

    fn sz(ops: &[Op], path_end: &str, name: &str) -> Option<String> {
        ops.iter().find_map(|o| match o {
            Op::Sz(p, n, v) if p.ends_with(path_end) && n == name => Some(v.clone()),
            _ => None,
        })
    }

    /// The driver's APOs on this PC's PHL monitor / Arctis outputs before APO was attached; what APO's own picker wrote
    /// for them is in the registry (`Child APOs`) and this test pins the same result.
    #[test]
    fn a_typical_playback_device_gets_what_the_picker_wrote() {
        let f = fx(&[
            (FX_TITLE, "Microsoft Audio Home Theater Effects"),
            (SFX, "{C9453E73-8C5C-4463-9984-AF8BAB2F5447}"),
            (MFX, "{13AB3EBD-137E-4903-9D89-60BE8277FD17}"),
            ("{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},3", "{5860E1C5-F95C-4a7a-8EC8-8AEF24F379A1}"),
        ]);
        let ops = plan_device(Kind::Render, G, &f);
        let child = format!("\\{G}");
        assert_eq!(sz(&ops, &child, SFX).unwrap(), "{C9453E73-8C5C-4463-9984-AF8BAB2F5447}");
        assert_eq!(sz(&ops, &child, MFX).unwrap(), "{13AB3EBD-137E-4903-9D89-60BE8277FD17}");
        for s in [LFX, GFX, EFX] {
            assert_eq!(sz(&ops, &child, s).unwrap(), NO_VALUE);
        }
        assert_eq!(sz(&ops, &child, "PreMixChild").unwrap(), "{C9453E73-8C5C-4463-9984-AF8BAB2F5447}");
        assert_eq!(sz(&ops, &child, "PostMixChild").unwrap(), "");
        assert_eq!(sz(&ops, &child, "Version").unwrap(), "2");
        assert_eq!(sz(&ops, &child, "AllowSilentBufferModification").unwrap(), "false");
        // SFX/EFX: pre-mix in SFX, post-mix in EFX, MFX stays, default processing modes added where missing
        assert_eq!(sz(&ops, "FxProperties", SFX).unwrap(), PRE_MIX);
        assert_eq!(sz(&ops, "FxProperties", EFX).unwrap(), POST_MIX);
        assert_eq!(sz(&ops, "FxProperties", MFX), None);
        assert!(ops.iter().any(|o| matches!(o, Op::Multi(_, n, v) if n == SFX_MODES && v == DEFAULT_MODE)));
        assert!(ops.iter().any(|o| matches!(o, Op::Multi(_, n, _) if n == EFX_MODES)));
    }

    #[test]
    fn a_microphone_gets_pre_mix_only() {
        let f = fx(&[("{9e6136e0-57ab-4949-b57a-3627be142855},100", "SWD\\x")]);
        let ops = plan_device(Kind::Capture, "{4a9ba4ae-dff0-428d-897c-420134d316f3}", &f);
        let child = "\\{4a9ba4ae-dff0-428d-897c-420134d316f3}";
        for s in SLOTS {
            assert_eq!(sz(&ops, child, s).unwrap(), NO_VALUE, "this is what the picker wrote for the Arctis mic");
        }
        assert_eq!(sz(&ops, child, "PreMixChild").unwrap(), "");
        assert_eq!(sz(&ops, child, "PostMixChild").unwrap(), "");
        assert_eq!(sz(&ops, "FxProperties", SFX).unwrap(), PRE_MIX);
        assert_eq!(sz(&ops, "FxProperties", EFX), None);
        assert!(!ops.iter().any(|o| matches!(o, Op::Multi(_, n, _) if n == EFX_MODES)));
    }

    #[test]
    fn an_attached_device_is_left_alone() {
        let f = fx(&[(SFX, PRE_MIX), (EFX, POST_MIX)]);
        assert!(plan_device(Kind::Render, G, &f).is_empty());
    }

    #[test]
    fn lfx_gfx_only_drivers_and_combined_bluetooth_devices_pick_their_mode() {
        let lg = fx(&[(LFX, "{AAAAAAAA-0000-0000-0000-000000000001}"), (GFX, "{AAAAAAAA-0000-0000-0000-000000000002}")]);
        let ops = plan_device(Kind::Render, G, &lg);
        assert_eq!(sz(&ops, "FxProperties", LFX).unwrap(), PRE_MIX);
        assert_eq!(sz(&ops, "FxProperties", GFX).unwrap(), POST_MIX);
        assert_eq!(sz(&ops, "PreMixChild", "PreMixChild"), None);
        assert_eq!(sz(&ops, &format!("\\{G}"), "PreMixChild").unwrap(), "{AAAAAAAA-0000-0000-0000-000000000001}");
        assert_eq!(sz(&ops, &format!("\\{G}"), "PostMixChild").unwrap(), "{AAAAAAAA-0000-0000-0000-000000000002}");

        let mut bt = fx(&[(SFX, "{AAAAAAAA-0000-0000-0000-000000000003}")]);
        bt.combined = true;
        let ops = plan_device(Kind::Render, G, &bt);
        assert_eq!(sz(&ops, "FxProperties", MFX).unwrap(), POST_MIX);
        assert_eq!(sz(&ops, "FxProperties", EFX), None);
    }

    #[test]
    fn a_device_without_fx_properties_gets_the_key_and_a_title() {
        let ops = plan_device(Kind::Render, G, &Fx::default());
        assert!(ops.iter().any(|o| matches!(o, Op::Key(p) if p.ends_with("FxProperties"))));
        assert_eq!(sz(&ops, "FxProperties", FX_TITLE).unwrap(), "Equalizer APO");
        for s in SLOTS {
            assert_eq!(sz(&ops, &format!("\\{G}"), s).unwrap(), NO_KEY);
        }
        // APO restores such a device by deleting the key it made; the undo log of the script does the same
        assert_eq!(sz(&ops, "FxProperties", LFX).unwrap(), PRE_MIX);
    }

    #[test]
    fn enhancements_flag_is_cleared_only_when_present() {
        let off = fx(&[(SFX, "{AAAAAAAA-0000-0000-0000-000000000003}"), (DISABLE_ENHANCEMENTS, "x")]);
        assert!(plan_device(Kind::Render, G, &off).iter().any(|o| matches!(o, Op::Del(_, n) if n == DISABLE_ENHANCEMENTS)));
        let on = fx(&[(SFX, "{AAAAAAAA-0000-0000-0000-000000000003}")]);
        assert!(!plan_device(Kind::Render, G, &on).iter().any(|o| matches!(o, Op::Del(_, n) if n == DISABLE_ENHANCEMENTS)));
    }

    #[test]
    fn ops_cannot_smuggle_quotes_into_the_script() {
        assert!(ops_text(&[Op::Sz("a".into(), "b".into(), "x'@\n".into())]).is_err());
        assert!(ops_text(&[Op::Sz("a|b".into(), "b".into(), "x".into())]).is_err());
        let t = ops_text(&[Op::Key(r"SOFTWARE\EqualizerAPO\Child APOs\{a-b}".into()), Op::Dword("k".into(), "n".into(), 1)]).unwrap();
        assert_eq!(t, "key|%C\\{a-b}\ndword|k|n|1\n");
    }

    #[test]
    fn script_gets_its_values_and_nothing_else() {
        let s = setup_script(Some(Path::new(r"C:\Users\x\eq\a.exe")), &"AB".repeat(32), &[Op::Key("k".into())], None).unwrap();
        assert!(s.contains(r"C:\Users\x\eq\a.exe") && s.contains(&"ab".repeat(32)) && s.contains("key|k"));
        assert!(!s.contains("@@"));
        assert!(setup_script(Some(Path::new("C:\\a'b.exe")), &"ab".repeat(32), &[], None).is_err());
        assert!(setup_script(None, "short", &[], None).is_err());
    }

    /// The generated script must be valid PowerShell with real-looking ops and paths (parse only, nothing runs).
    #[cfg(windows)]
    #[test]
    fn generated_script_parses_in_powershell() {
        let ops = plan_device(Kind::Render, G, &fx(&[(SFX, "{C9453E73-8C5C-4463-9984-AF8BAB2F5447}")]));
        let script = setup_script(Some(Path::new(r"C:\Users\x y\AppData\Local\Buffer\eq\a.exe")), &"ab".repeat(32), &ops, Some(Path::new(r"C:\t\log.txt"))).unwrap();
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:BUFFER_TEST_SCRIPT, [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count",
            ])
            .env("BUFFER_TEST_SCRIPT", &script)
            .output();
        let Ok(out) = out else { return }; // no PowerShell: nothing to check
        assert!(out.status.success(), "parse errors: {}", String::from_utf8_lossy(&out.stdout));
        // the whole thing, UTF-16 + base64, must fit into one command line
        assert!(encode_command(&script).len() < 24_000, "script too long: {}", encode_command(&script).len());
    }

    #[test]
    fn base64_matches_known_values() {
        // "A" in UTF-16LE is 41 00
        assert_eq!(encode_command("A"), "QQA=");
        assert_eq!(encode_command("Hi"), "SABpAA==");
        assert_eq!(encode_command("abc"), "YQBiAGMA");
    }

    /// Ground truth: `cargo test -p ml-eq -- --ignored attached_here --nocapture` on a PC where APO's own picker attached
    /// devices. The originals it recorded give the "before" state; the plan must reproduce what it wrote.
    #[test]
    #[ignore]
    fn plan_matches_what_the_picker_wrote_on_attached_here() {
        let mut checked = 0;
        for guid in reg::subkeys(CHILD) {
            let child = format!(r"{CHILD}\{guid}");
            let kind = if reg::subkeys(&format!(r"{MM}\Render")).iter().any(|g| g.eq_ignore_ascii_case(&guid)) { Kind::Render } else { Kind::Capture };
            let cur = read_fx(kind, &guid);
            let rec = |name: &str| reg::values(&child).unwrap().into_iter().find(|(n, _, _)| n.eq_ignore_ascii_case(name)).map(|(_, _, d)| reg::utf16_text(&d));
            let mut before = Fx { key: cur.key, values: BTreeMap::new(), combined: cur.combined };
            for slot in SLOTS {
                match rec(slot).unwrap().as_str() {
                    NO_KEY => before.key = false,
                    NO_VALUE => {}
                    v => {
                        before.values.insert(slot.to_ascii_lowercase(), Some(v.to_string()));
                    }
                }
            }
            for m in MULTI_FX {
                if let Some(v) = cur.values.get(&m.to_ascii_lowercase()) {
                    before.values.insert(m.to_ascii_lowercase(), v.clone());
                }
            }
            let ops = plan_device(kind, &guid, &before);
            assert!(!ops.is_empty(), "{guid}: planned nothing");
            for op in &ops {
                match op {
                    Op::Sz(p, n, v) if p.ends_with("Child APOs") || p.contains("Child APOs") => {
                        if n == "DisableAutomaticAdjustment" {
                            continue;
                        }
                        assert_eq!(rec(n).as_deref(), Some(v.as_str()), "{guid} child {n}");
                    }
                    Op::Sz(_, n, v) => assert_eq!(cur.text(n), Some(v.as_str()), "{guid} fx {n}"),
                    Op::Multi(_, n, _) => assert!(cur.has(n), "{guid} fx {n} should exist"),
                    Op::Del(p, n) if p.ends_with("FxProperties") => assert!(!cur.has(n), "{guid} fx {n} should be gone"),
                    _ => {}
                }
            }
            // the other direction: the picker's child record has nothing the plan lacks
            let wrote: Vec<&str> = ops.iter().filter_map(|o| match o { Op::Sz(p, n, _) if p.contains("Child APOs") => Some(n.as_str()), _ => None }).collect();
            for (n, _, _) in reg::values(&child).unwrap() {
                assert!(wrote.iter().any(|w| w.eq_ignore_ascii_case(&n)), "{guid}: picker wrote {n}, plan did not");
            }
            checked += 1;
            println!("{guid} ({kind:?}): plan reproduces the picker's registry writes ({} ops)", ops.len());
        }
        assert!(checked > 0, "no device has a Child APOs record on this PC");
    }

    #[test]
    fn guids() {
        assert!(is_guid(G));
        assert!(!is_guid("{51828c0d-bfff-4a01-b3e8-140a4b0ec4b}"));
        assert!(!is_guid("{51828c0d-bfff-4a01-b3e8-140a4b0ec4b;}"));
        assert_eq!(guid_of("{0.0.0.00000000}.{51828C0D-BFFF-4A01-B3E8-140A4B0EC4BC}"), G);
        assert_eq!(Kind::of_id("{0.0.1.00000000}.{x}"), Kind::Capture);
        assert_eq!(Kind::of_id("{0.0.0.00000000}.{x}"), Kind::Render);
    }
}
