//! Mouse-button and gamepad bindings. `RegisterHotKey` only knows keyboard keys, so these are polled on
//! their own thread (never a low-level hook: a hook that stalls would freeze the mouse system-wide) and
//! delivered to the tray thread as ordinary `WM_HOTKEY` messages. Everything downstream (post-roll,
//! the setup wizard's shortcut test) therefore treats them exactly like a key press.

use crate::session::Shared;
use std::{
    sync::{atomic::Ordering, Arc},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows_sys::Win32::UI::Input::XboxController::{XInputGetState, XINPUT_STATE};
use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_HOTKEY};

/// Ids of the actions, as carried in `WM_HOTKEY`'s wParam.
pub const SAVE: usize = 1;
pub const RECORD: usize = 3;
pub const OUTPUT: usize = 4;
pub const MIC: usize = 5;

const MOD_CTRL: u8 = 1;
const MOD_ALT: u8 = 2;
const MOD_SHIFT: u8 = 4;
const MOD_WIN: u8 = 8;

/// Analog triggers become two extra "buttons" above the 16 bits XInput defines.
const LT: u32 = 0x1_0000;
const RT: u32 = 0x2_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// Virtual-key of the mouse button (0x04 middle, 0x05 X1, 0x06 X2) with the exact modifiers held.
    Mouse { vk: u16, mods: u8 },
    /// All of these gamepad buttons held at once.
    Pad(u32),
}

fn pad_bit(name: &str) -> Option<u32> {
    Some(match name {
        "up" => 0x1,
        "down" => 0x2,
        "left" => 0x4,
        "right" => 0x8,
        "menu" | "start" => 0x10,
        "view" | "back" => 0x20,
        "l3" | "ls" => 0x40,
        "r3" | "rs" => 0x80,
        "lb" => 0x100,
        "rb" => 0x200,
        "a" => 0x1000,
        "b" => 0x2000,
        "x" => 0x4000,
        "y" => 0x8000,
        "lt" => LT,
        "rt" => RT,
        _ => return None,
    })
}

/// The mouse and gamepad triggers inside a binding string such as "Alt+Q, Mouse4, Pad:View+RB".
/// Keyboard combos are ignored here (they go through `RegisterHotKey`).
pub fn parse(spec: &str) -> Vec<Trigger> {
    let mut out = Vec::new();
    for tok in spec.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        let lower = tok.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("pad:") {
            let mut mask = 0u32;
            let mut ok = true;
            for part in rest.split('+').map(str::trim) {
                match pad_bit(part) {
                    Some(b) => mask |= b,
                    None => ok = false,
                }
            }
            // a lone button is used by every game; a chord is what makes a pad shortcut safe
            if ok && mask.count_ones() >= 2 {
                out.push(Trigger::Pad(mask));
            }
            continue;
        }
        let mut mods = 0u8;
        let mut vk = None;
        let mut ok = true;
        for part in lower.split('+').map(str::trim) {
            match part {
                "ctrl" | "control" => mods |= MOD_CTRL,
                "alt" => mods |= MOD_ALT,
                "shift" => mods |= MOD_SHIFT,
                "win" | "super" => mods |= MOD_WIN,
                "mouse3" => vk = Some(0x04),
                "mouse4" => vk = Some(0x05),
                "mouse5" => vk = Some(0x06),
                _ => ok = false,
            }
        }
        if ok {
            if let Some(vk) = vk {
                out.push(Trigger::Mouse { vk, mods });
            }
        }
    }
    out
}

/// The keyboard combo of a binding string (the part `RegisterHotKey` handles), if it has one.
pub fn keyboard_part(spec: &str) -> Option<&str> {
    spec.split(',').map(str::trim).find(|t| {
        let l = t.to_ascii_lowercase();
        !t.is_empty() && !l.starts_with("pad:") && !l.contains("mouse")
    })
}

fn down(vk: i32) -> bool {
    unsafe { GetAsyncKeyState(vk) < 0 }
}

fn held_mods() -> u8 {
    (if down(0x11) { MOD_CTRL } else { 0 })
        | (if down(0x12) { MOD_ALT } else { 0 })
        | (if down(0x10) { MOD_SHIFT } else { 0 })
        | (if down(0x5B) || down(0x5C) { MOD_WIN } else { 0 })
}

/// Buttons currently held on any connected pad. Empty slots are only re-probed every few seconds
/// because `XInputGetState` is slow for a missing controller.
struct Pads {
    connected: [bool; 4],
    next_scan: Instant,
}

impl Pads {
    fn new() -> Pads {
        Pads { connected: [false; 4], next_scan: Instant::now() }
    }

    fn buttons(&mut self) -> u32 {
        let scan = Instant::now() >= self.next_scan;
        if scan {
            self.next_scan = Instant::now() + Duration::from_secs(3);
        }
        let mut mask = 0u32;
        for slot in 0..4u32 {
            if !self.connected[slot as usize] && !scan {
                continue;
            }
            let mut st: XINPUT_STATE = unsafe { std::mem::zeroed() };
            let ok = unsafe { XInputGetState(slot, &mut st) } == 0;
            self.connected[slot as usize] = ok;
            if ok {
                mask |= st.Gamepad.wButtons as u32;
                if st.Gamepad.bLeftTrigger > 100 {
                    mask |= LT;
                }
                if st.Gamepad.bRightTrigger > 100 {
                    mask |= RT;
                }
            }
        }
        mask
    }
}

/// Starts the polling thread. Bindings are re-read from the live config, so changing them in the
/// settings takes effect at once (keyboard combos still need a recorder restart).
pub fn spawn(shared: Arc<Shared>, tray_thread: u32) {
    let _ = thread::Builder::new().name("input".into()).spawn(move || {
        let mut pads = Pads::new();
        let mut bindings: Vec<(usize, Vec<Trigger>)> = Vec::new();
        let mut refreshed = Instant::now() - Duration::from_secs(1);
        let mut was: Vec<Vec<bool>> = Vec::new();
        while !shared.quit.load(Ordering::Relaxed) {
            if refreshed.elapsed() > Duration::from_millis(500) {
                let c = shared.cfg.lock().unwrap();
                let next = vec![(SAVE, parse(&c.hotkey)), (RECORD, parse(&c.record_hotkey)), (OUTPUT, parse(&c.output_hotkey)), (MIC, parse(&c.mic_hotkey))];
                drop(c);
                if next != bindings {
                    was = next.iter().map(|(_, t)| vec![true; t.len()]).collect(); // a held button must not fire on rebind
                    bindings = next;
                }
                refreshed = Instant::now();
            }
            if bindings.iter().any(|(_, t)| !t.is_empty()) {
                let mods = held_mods();
                let pad = if bindings.iter().any(|(_, t)| t.iter().any(|x| matches!(x, Trigger::Pad(_)))) { pads.buttons() } else { 0 };
                for (i, (id, triggers)) in bindings.iter().enumerate() {
                    for (j, t) in triggers.iter().enumerate() {
                        let pressed = match *t {
                            Trigger::Mouse { vk, mods: want } => down(vk as i32) && mods == want,
                            Trigger::Pad(mask) => pad & mask == mask,
                        };
                        if pressed && !was[i][j] {
                            unsafe {
                                PostThreadMessageW(tray_thread, WM_HOTKEY, *id, 0);
                            }
                        }
                        was[i][j] = pressed;
                    }
                }
            }
            thread::sleep(Duration::from_millis(16));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mouse_and_pad() {
        assert_eq!(parse("Alt+Q"), vec![]);
        assert_eq!(parse("Mouse4"), vec![Trigger::Mouse { vk: 0x05, mods: 0 }]);
        assert_eq!(parse("Alt+Q, Ctrl+Mouse5"), vec![Trigger::Mouse { vk: 0x06, mods: MOD_CTRL }]);
        assert_eq!(parse("Pad:View+RB"), vec![Trigger::Pad(0x20 | 0x200)]);
        assert_eq!(parse("Pad:LT+RT"), vec![Trigger::Pad(LT | RT)]);
    }

    #[test]
    fn a_lone_pad_button_is_rejected() {
        assert_eq!(parse("Pad:A"), vec![]);
        assert_eq!(parse("Pad:Nope+A"), vec![]);
    }

    #[test]
    fn keyboard_part_skips_other_kinds() {
        assert_eq!(keyboard_part("Mouse4, Alt+Q, Pad:View+RB"), Some("Alt+Q"));
        assert_eq!(keyboard_part("Mouse4"), None);
        assert_eq!(keyboard_part(""), None);
    }
}
