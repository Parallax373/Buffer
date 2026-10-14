//! Which audio endpoint a source should use. Pure logic so the rules are unit-tested.
//!
//! Rules (the point is that plugging/unplugging devices never rewrites anyone's settings):
//!  1. the configured primary device, matched by endpoint ID, then by exact name;
//!  2. else the configured secondary device;
//!  3. else, if nothing is configured at all (fresh install), an automatic guess;
//!  4. else wait. A configured-but-missing device never silently becomes "whatever Windows default is".
//! The configuration itself is never modified by any of this; when the primary comes back it wins again.

use crate::config::{DeviceRef, SourceCfg};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Primary,
    Secondary,
    Auto,
    Waiting,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Role::Primary => "primary",
            Role::Secondary => "secondary",
            Role::Auto => "auto",
            Role::Waiting => "waiting",
        }
    }
}

fn find<'a>(list: &'a [Endpoint], want: &DeviceRef) -> Option<&'a Endpoint> {
    if !want.id.is_empty() {
        if let Some(e) = list.iter().find(|e| e.id == want.id) {
            return Some(e);
        }
    }
    if !want.name.is_empty() {
        return list.iter().find(|e| e.name.eq_ignore_ascii_case(&want.name));
    }
    None
}

pub fn resolve(cfg: &SourceCfg, available: &[Endpoint], auto: Option<&Endpoint>) -> (Role, Option<Endpoint>) {
    if let Some(p) = &cfg.primary {
        if let Some(e) = find(available, p) {
            return (Role::Primary, Some(e.clone()));
        }
    }
    if let Some(s) = &cfg.secondary {
        if let Some(e) = find(available, s) {
            return (Role::Secondary, Some(e.clone()));
        }
    }
    if cfg.primary.is_none() && cfg.secondary.is_none() {
        return match auto {
            Some(e) => (Role::Auto, Some(e.clone())),
            None => (Role::Waiting, None),
        };
    }
    (Role::Waiting, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(id: &str, name: &str) -> Endpoint {
        Endpoint { id: id.into(), name: name.into() }
    }
    fn dev(id: &str, name: &str) -> Option<DeviceRef> {
        Some(DeviceRef { id: id.into(), name: name.into() })
    }
    fn cfg(p: Option<DeviceRef>, s: Option<DeviceRef>) -> SourceCfg {
        SourceCfg { primary: p, secondary: s }
    }

    #[test]
    fn primary_wins_when_present() {
        let list = [ep("a", "Headset"), ep("b", "Speakers")];
        let (role, e) = resolve(&cfg(dev("a", "Headset"), dev("b", "Speakers")), &list, None);
        assert_eq!((role, e.unwrap().id), (Role::Primary, "a".into()));
    }

    #[test]
    fn falls_back_to_secondary_then_back_to_primary() {
        let c = cfg(dev("a", "Headset"), dev("b", "Speakers"));
        let (role, e) = resolve(&c, &[ep("b", "Speakers")], None);
        assert_eq!((role, e.unwrap().id), (Role::Secondary, "b".into()));
        // headset plugged in again: primary is preferred again, config untouched
        let (role, e) = resolve(&c, &[ep("a", "Headset"), ep("b", "Speakers")], None);
        assert_eq!((role, e.unwrap().id), (Role::Primary, "a".into()));
    }

    #[test]
    fn same_device_with_new_id_is_found_by_name() {
        let c = cfg(dev("old-id", "Mikrofon (Arctis 5 Chat)"), None);
        let (role, e) = resolve(&c, &[ep("new-id", "mikrofon (arctis 5 chat)")], None);
        assert_eq!((role, e.unwrap().id), (Role::Primary, "new-id".into()));
    }

    #[test]
    fn configured_but_missing_never_becomes_the_windows_default() {
        let c = cfg(dev("a", "Headset"), None);
        let default = ep("z", "Monitor audio");
        let (role, e) = resolve(&c, &[ep("z", "Monitor audio")], Some(&default));
        assert_eq!((role, e), (Role::Waiting, None));
    }

    #[test]
    fn unconfigured_uses_the_automatic_guess() {
        let guess = ep("g", "Game endpoint");
        let (role, e) = resolve(&SourceCfg::default(), &[ep("g", "Game endpoint")], Some(&guess));
        assert_eq!((role, e.unwrap().id), (Role::Auto, "g".into()));
        let (role, e) = resolve(&SourceCfg::default(), &[], None);
        assert_eq!((role, e), (Role::Waiting, None));
    }

    #[test]
    fn only_a_secondary_configured_still_waits_instead_of_guessing() {
        let c = cfg(None, dev("b", "Speakers"));
        let guess = ep("g", "Other");
        let (role, _) = resolve(&c, &[ep("g", "Other")], Some(&guess));
        assert_eq!(role, Role::Waiting);
    }
}
