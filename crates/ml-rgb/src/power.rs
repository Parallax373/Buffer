//! When the lights should go out by themselves: the screen is locked, the PC has been idle for a while, or the clock is
//! inside a quiet window. Pure decision logic (the recorder feeds it the facts), so it is easy to test.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Power {
    /// lights go out while the screen is locked
    #[serde(default = "yes")]
    pub lock: bool,
    /// lights go out after this many minutes without keyboard or mouse input (0 = never)
    #[serde(default)]
    pub idle_min: u32,
    /// lights go out inside the window `from`..`to` (minutes after midnight; the window may wrap past midnight)
    #[serde(default)]
    pub schedule: bool,
    #[serde(default = "from")]
    pub from: u16,
    #[serde(default = "to")]
    pub to: u16,
}

fn yes() -> bool {
    true
}
fn from() -> u16 {
    23 * 60
}
fn to() -> u16 {
    7 * 60
}

impl Default for Power {
    fn default() -> Self {
        Power { lock: true, idle_min: 0, schedule: false, from: from(), to: to() }
    }
}

impl Power {
    /// Why the lights should be out right now, if they should: `"lock"`, `"idle"` or `"schedule"`.
    pub fn away(&self, locked: bool, idle_secs: u64, minutes: u16) -> Option<&'static str> {
        if self.lock && locked {
            return Some("lock");
        }
        if self.idle_min > 0 && idle_secs >= self.idle_min as u64 * 60 {
            return Some("idle");
        }
        if self.schedule && in_window(self.from, self.to, minutes) {
            return Some("schedule");
        }
        None
    }

    /// Anything to watch for? (the recorder polls faster only then)
    pub fn active(&self) -> bool {
        self.lock || self.idle_min > 0 || self.schedule
    }
}

/// `minutes` is inside `from..to`; a window with `from > to` runs through midnight; `from == to` is empty.
pub fn in_window(from: u16, to: u16, minutes: u16) -> bool {
    match from.cmp(&to) {
        std::cmp::Ordering::Equal => false,
        std::cmp::Ordering::Less => minutes >= from && minutes < to,
        std::cmp::Ordering::Greater => minutes >= from || minutes < to,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_wrap_past_midnight() {
        assert!(in_window(23 * 60, 7 * 60, 23 * 60 + 30));
        assert!(in_window(23 * 60, 7 * 60, 2 * 60));
        assert!(!in_window(23 * 60, 7 * 60, 7 * 60));
        assert!(!in_window(23 * 60, 7 * 60, 12 * 60));
        assert!(in_window(9 * 60, 17 * 60, 9 * 60) && !in_window(9 * 60, 17 * 60, 17 * 60));
        assert!(!in_window(600, 600, 600), "an empty window never matches");
    }

    #[test]
    fn the_first_reason_wins_and_defaults_are_quiet() {
        let mut p = Power::default();
        assert_eq!(p.away(false, 99_999, 3 * 60), None, "idle and schedule are off by default");
        assert_eq!(p.away(true, 0, 12 * 60), Some("lock"));
        p.idle_min = 5;
        assert_eq!(p.away(false, 299, 0), None);
        assert_eq!(p.away(false, 300, 0), Some("idle"));
        p.schedule = true;
        assert_eq!(p.away(false, 0, 23 * 60 + 1), Some("schedule"));
        p.lock = false;
        assert_eq!(p.away(true, 0, 12 * 60), None, "lock turned off");
        assert!(Power { lock: false, ..Power::default() }.active() == false);
        let old: Power = serde_json::from_str("{}").unwrap();
        assert_eq!(old, Power::default());
    }
}
