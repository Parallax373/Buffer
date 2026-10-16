//! Magnitude response of the bands (RBJ cookbook biquads at 48 kHz, as APO runs them). `ui/js/eq.js` draws the
//! same maths; keep the two in step.

use crate::{Band, Kind};
use std::f64::consts::PI;

const FS: f64 = 48_000.0;

/// Normalised biquad coefficients (b0, b1, b2, a1, a2).
fn coeffs(b: &Band) -> [f64; 5] {
    let w0 = 2.0 * PI * b.f.clamp(10.0, FS * 0.49) / FS;
    let (sin, cos) = w0.sin_cos();
    let q = b.q.max(0.05);
    let alpha = sin / (2.0 * q);
    let a = 10f64.powf(b.gain / 40.0);
    let [b0, b1, b2, a0, a1, a2] = match b.kind {
        Kind::Peak => [1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a],
        Kind::LowShelf => {
            let s = 2.0 * a.sqrt() * alpha;
            [
                a * ((a + 1.0) - (a - 1.0) * cos + s),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - s),
                (a + 1.0) + (a - 1.0) * cos + s,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - s,
            ]
        }
        Kind::HighShelf => {
            let s = 2.0 * a.sqrt() * alpha;
            [
                a * ((a + 1.0) + (a - 1.0) * cos + s),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - s),
                (a + 1.0) - (a - 1.0) * cos + s,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - s,
            ]
        }
        Kind::LowCut => [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        Kind::HighCut => [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        Kind::Notch => [1.0, -2.0 * cos, 1.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        Kind::BandPass => [alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cos, 1.0 - alpha],
    };
    [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0]
}

/// Gain of one band at `f` Hz, in dB.
pub fn band_db(b: &Band, f: f64) -> f64 {
    let [b0, b1, b2, a1, a2] = coeffs(b);
    let w = 2.0 * PI * f / FS;
    let (c1, s1) = (w.cos(), -w.sin());
    let (c2, s2) = ((2.0 * w).cos(), -(2.0 * w).sin());
    let num = ((b0 + b1 * c1 + b2 * c2).powi(2) + (b1 * s1 + b2 * s2).powi(2)).sqrt();
    let den = ((1.0 + a1 * c1 + a2 * c2).powi(2) + (a1 * s1 + a2 * s2).powi(2)).sqrt();
    20.0 * (num / den).max(1e-9).log10()
}

pub fn total_db(bands: &[Band], f: f64) -> f64 {
    bands.iter().filter(|b| b.on).map(|b| band_db(b, f)).sum()
}

/// Highest point of the summed curve over 20 Hz – 20 kHz (1/48 octave steps).
pub fn peak_db(bands: &[Band]) -> f64 {
    if bands.is_empty() {
        return 0.0;
    }
    (0..=480).map(|i| total_db(bands, 20.0 * 2f64.powf(i as f64 / 48.0))).fold(f64::MIN, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_hits_its_gain_at_centre() {
        let b = Band::new(Kind::Peak, 1000.0, 6.0, 1.0);
        assert!((band_db(&b, 1000.0) - 6.0).abs() < 0.01);
        assert!(band_db(&b, 100.0).abs() < 0.3);
        assert!((peak_db(&[b]) - 6.0).abs() < 0.05);
    }

    #[test]
    fn cuts_and_shelves_behave() {
        let hp = Band::new(Kind::LowCut, 100.0, 0.0, 0.707);
        assert!(band_db(&hp, 20.0) < -20.0 && band_db(&hp, 5000.0).abs() < 0.1);
        let hs = Band::new(Kind::HighShelf, 8000.0, 4.0, 0.707);
        assert!((band_db(&hs, 20000.0) - 4.0).abs() < 0.5 && band_db(&hs, 100.0).abs() < 0.1);
        let no = Band::new(Kind::Notch, 1000.0, 0.0, 2.0);
        assert!(band_db(&no, 1000.0) < -40.0);
    }

    #[test]
    fn flat_is_zero() {
        assert!(peak_db(&crate::presets::FLAT).abs() < 1e-9);
    }
}
