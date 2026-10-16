//! AutoEQ headphone profiles. Their `ParametricEQ.txt` is already Equalizer APO syntax:
//! `Preamp: -6.2 dB` + `Filter 1: ON LSC Fc 105 Hz Gain 5.6 dB Q 0.70`.

use crate::{Band, Kind, Profile};

fn kind(code: &str) -> Option<Kind> {
    Some(match code {
        "PK" | "PEQ" => Kind::Peak,
        "LSC" | "LS" => Kind::LowShelf,
        "HSC" | "HS" => Kind::HighShelf,
        "HP" | "HPQ" => Kind::LowCut,
        "LP" | "LPQ" => Kind::HighCut,
        "NO" => Kind::Notch,
        "BP" => Kind::BandPass,
        _ => return None,
    })
}

/// Value after `key` in a whitespace-split line, e.g. `Fc 105` -> 105.
fn after(words: &[&str], key: &str) -> Option<f64> {
    words.iter().position(|w| *w == key).and_then(|i| words.get(i + 1)).and_then(|v| v.parse().ok())
}

pub fn parse(name: &str, text: &str) -> Result<Profile, String> {
    let mut preamp = 0.0;
    let mut filters = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("Preamp:") {
            preamp = rest.split_whitespace().next().and_then(|v| v.parse().ok()).ok_or("bad Preamp line")?;
        } else if line.starts_with("Filter") {
            let Some((_, spec)) = line.split_once(':') else { continue };
            let words: Vec<&str> = spec.split_whitespace().collect();
            let on = words.first() == Some(&"ON");
            let Some(k) = words.get(1).and_then(|c| kind(c)) else { continue };
            let Some(f) = after(&words, "Fc") else { continue };
            let gain = after(&words, "Gain").unwrap_or(0.0);
            let q = after(&words, "Q").unwrap_or(0.707);
            filters.push(Band { kind: k, f, gain, q, on });
        }
    }
    if filters.is_empty() {
        return Err("no filters in profile".into());
    }
    Ok(Profile { name: name.to_string(), preamp, filters })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_autoeq_file() {
        let txt = "Preamp: -6.4 dB\r\nFilter 1: ON LSC Fc 105 Hz Gain 5.9 dB Q 0.70\r\nFilter 2: ON PK Fc 3389 Hz Gain -2.3 dB Q 2.53\r\nFilter 3: OFF PK Fc 9000 Hz Gain 1.0 dB Q 1.00\r\n";
        let p = parse("HD 600", txt).unwrap();
        assert_eq!(p.preamp, -6.4);
        assert_eq!(p.filters.len(), 3);
        assert_eq!(p.filters[0], Band { kind: Kind::LowShelf, f: 105.0, gain: 5.9, q: 0.70, on: true });
        assert!(!p.filters[2].on);
    }

    #[test]
    fn rejects_empty() {
        assert!(parse("x", "Preamp: -1 dB\n").is_err());
    }
}
