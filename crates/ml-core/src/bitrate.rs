//! How much video bitrate a recording gets. One formula, mirrored in the UI estimates (ui/js/recording.js),
//! so the numbers on the settings screen are the numbers the recorder actually uses.
//!
//! Anchor: 14 Mb/s for 1920x804 at 30 fps, "Standard". Bitrate grows with the pixel count (exponent 0.75:
//! bigger frames compress a little better per pixel) and with the frame rate (exponent 0.77: 60 fps = 1.7x).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Low,
    Standard,
    High,
}

impl Quality {
    pub fn parse(s: &str) -> Option<Quality> {
        match s {
            "low" => Some(Quality::Low),
            "std" => Some(Quality::Standard),
            "high" => Some(Quality::High),
            _ => None,
        }
    }

    fn factor(self) -> f64 {
        match self {
            Quality::Low => 0.55,
            Quality::Standard => 1.0,
            Quality::High => 1.4,
        }
    }
}

const ANCHOR_KBPS: f64 = 14_000.0;
const ANCHOR_PIXELS: f64 = 1920.0 * 804.0;

/// Recording bitrate in kb/s for the given output frame size, frame rate and quality level.
pub fn recording_kbps(width: u32, height: u32, fps: u32, quality: Quality) -> u32 {
    let pixels = (width.max(1) as f64) * (height.max(1) as f64);
    let k = ANCHOR_KBPS
        * (pixels / ANCHOR_PIXELS).powf(0.75)
        * (fps.max(1) as f64 / 30.0).powf(0.77)
        * quality.factor();
    k.round().clamp(2_000.0, 120_000.0) as u32
}

/// Output frame size of a capture: `target_width` (0 = native) is capped at the monitor width, the height
/// keeps the aspect ratio and is rounded to an even number (encoders need that).
pub fn output_size(target_width: u32, mon_w: u32, mon_h: u32) -> (u32, u32) {
    let mon_w = mon_w.max(2);
    let w = if target_width > 0 { target_width.min(mon_w) } else { mon_w };
    let h = ((mon_h as f64 * w as f64 / mon_w as f64) / 2.0).round() as u32 * 2;
    (w, h.max(2))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: u32, b: f64, tol: f64) -> bool {
        (a as f64 - b).abs() / b <= tol
    }

    #[test]
    fn anchor_is_14_mbps() {
        assert_eq!(recording_kbps(1920, 804, 30, Quality::Standard), 14_000);
    }

    #[test]
    fn bigger_frames_cost_more() {
        let p720 = recording_kbps(1280, 536, 30, Quality::Standard);
        let p1080 = recording_kbps(1920, 804, 30, Quality::Standard);
        let p1440 = recording_kbps(2560, 1072, 30, Quality::Standard);
        let native = recording_kbps(3440, 1440, 30, Quality::Standard);
        assert!(p720 < p1080 && p1080 < p1440 && p1440 < native);
        assert!(near(p720, 7_600.0, 0.05), "{p720}");
        assert!(near(p1440, 21_600.0, 0.05), "{p1440}");
    }

    #[test]
    fn sixty_fps_is_about_1_7x_and_quality_scales() {
        let a = recording_kbps(1920, 804, 30, Quality::Standard) as f64;
        let b = recording_kbps(1920, 804, 60, Quality::Standard) as f64;
        assert!((b / a - 1.7).abs() < 0.02);
        assert!(recording_kbps(1920, 804, 30, Quality::Low) < recording_kbps(1920, 804, 30, Quality::High));
    }

    #[test]
    fn output_size_keeps_aspect_and_is_even() {
        assert_eq!(output_size(1920, 3440, 1440), (1920, 804));
        assert_eq!(output_size(0, 3440, 1440), (3440, 1440));
        assert_eq!(output_size(2560, 1920, 1080), (1920, 1080)); // never upscale past the monitor
    }
}
