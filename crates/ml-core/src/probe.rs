use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{path::Path, process::Command};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioTrack {
    /// Index among audio streams only (`0:a:<index>`).
    pub index: usize,
    /// Track label from the container (`handler_name`), e.g. Game / Chat / Mic.
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MediaInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub size: u64,
    pub audio: Vec<AudioTrack>,
}

#[derive(Deserialize)]
struct Probe {
    streams: Vec<Stream>,
    format: Format,
}

#[derive(Deserialize)]
struct Stream {
    codec_type: String,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    tags: Option<Tags>,
}

#[derive(Deserialize)]
struct Tags {
    handler_name: Option<String>,
}

#[derive(Deserialize)]
struct Format {
    duration: Option<String>,
    size: Option<String>,
}

pub fn probe(path: &Path) -> Result<MediaInfo> {
    // The installer ships only ffmpeg.exe (ffprobe would add ~100 MB); fall back to reading its banner.
    if !crate::tools::available(crate::tools::ffprobe()) {
        return probe_with_ffmpeg(path);
    }
    let mut cmd = Command::new(crate::tools::ffprobe());
    cmd.args(["-v", "error", "-show_streams", "-show_format", "-of", "json"])
        .arg(path);
    crate::export::hide_window(&mut cmd);
    let out = cmd
        .output()
        .context("failed to run ffprobe (is ffmpeg installed and on PATH?)")?;
    if !out.status.success() {
        bail!("ffprobe failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    let p: Probe = serde_json::from_slice(&out.stdout).context("bad ffprobe output")?;

    let video = p
        .streams
        .iter()
        .find(|s| s.codec_type == "video")
        .context("no video stream")?;
    let audio = p
        .streams
        .iter()
        .filter(|s| s.codec_type == "audio")
        .enumerate()
        .map(|(index, s)| AudioTrack {
            index,
            name: s
                .tags
                .as_ref()
                .and_then(|t| t.handler_name.clone())
                .unwrap_or_else(|| format!("Track {}", index + 1)),
        })
        .collect();

    Ok(MediaInfo {
        duration: p.format.duration.as_deref().and_then(|d| d.parse().ok()).unwrap_or(0.0),
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps: video.r_frame_rate.as_deref().map(parse_rate).unwrap_or(0.0),
        size: p.format.size.as_deref().and_then(|d| d.parse().ok()).unwrap_or(0),
        audio,
    })
}

fn parse_rate(r: &str) -> f64 {
    match r.split_once('/') {
        Some((n, d)) => {
            let (n, d): (f64, f64) = (n.parse().unwrap_or(0.0), d.parse().unwrap_or(1.0));
            if d == 0.0 {
                0.0
            } else {
                n / d
            }
        }
        None => r.parse().unwrap_or(0.0),
    }
}

/// Parses the stream summary that `ffmpeg -i <file>` prints (to stderr, exit code 1 is expected).
fn probe_with_ffmpeg(path: &Path) -> Result<MediaInfo> {
    let mut cmd = Command::new(crate::tools::ffmpeg());
    cmd.args(["-hide_banner", "-i"]).arg(path);
    crate::export::hide_window(&mut cmd);
    let out = cmd
        .output()
        .context("failed to run ffmpeg (is it installed?)")?;
    let text = String::from_utf8_lossy(&out.stderr).into_owned();
    parse_ffmpeg_banner(&text, std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
}

fn parse_ffmpeg_banner(text: &str, size: u64) -> Result<MediaInfo> {
    let mut duration = 0.0;
    let (mut width, mut height, mut fps) = (0u32, 0u32, 0.0f64);
    let mut have_video = false;
    let mut audio: Vec<AudioTrack> = Vec::new();
    // Which stream the following "handler_name" metadata line belongs to.
    #[derive(PartialEq)]
    enum Cur {
        None,
        Video,
        Audio(usize),
    }
    let mut cur = Cur::None;

    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("Duration:") {
            let stamp = rest.trim().split(',').next().unwrap_or("");
            let mut parts = stamp.split(':');
            if let (Some(h), Some(m), Some(s)) = (parts.next(), parts.next(), parts.next()) {
                duration = h.parse::<f64>().unwrap_or(0.0) * 3600.0
                    + m.parse::<f64>().unwrap_or(0.0) * 60.0
                    + s.parse::<f64>().unwrap_or(0.0);
            }
        } else if t.starts_with("Stream #") {
            if t.contains(" Video:") && !have_video {
                have_video = true;
                cur = Cur::Video;
                for token in t.split(", ") {
                    let tok = token.trim();
                    // "1920x808 [SAR 1:1 DAR 240:101]" — digits x digits, not a hex FourCC like 0x31637661
                    let dims = tok.split_whitespace().next().unwrap_or("");
                    if let Some((w, h)) = dims.split_once('x') {
                        if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                            if w > 0 && h > 0 && width == 0 {
                                width = w;
                                height = h;
                            }
                        }
                    }
                    if let Some(n) = tok.strip_suffix(" fps") {
                        fps = n.trim().parse().unwrap_or(fps);
                    }
                }
            } else if t.contains(" Audio:") {
                let index = audio.len();
                audio.push(AudioTrack { index, name: format!("Track {}", index + 1) });
                cur = Cur::Audio(index);
            } else {
                cur = Cur::None;
            }
        } else if let Some(rest) = t.strip_prefix("handler_name") {
            if let (Cur::Audio(i), Some((_, v))) = (&cur, rest.split_once(':')) {
                let name = v.trim();
                if !name.is_empty() && !name.eq_ignore_ascii_case("SoundHandler") {
                    audio[*i].name = name.to_string();
                }
            }
        }
    }
    if !have_video {
        bail!("no video stream found");
    }
    Ok(MediaInfo { duration, width, height, fps, size, audio })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_steelseries_style_banner() {
        let banner = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mp4':
  Duration: 00:01:59.57, start: 0.000000, bitrate: 5572 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x808 [SAR 1:1 DAR 240:101], 4982 kb/s, 30 fps, 30 tbr, 90k tbn (default)
    Metadata:
      handler_name    : VideoHandler
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 191 kb/s (default)
    Metadata:
      handler_name    : Game
  Stream #0:2[0x3](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 191 kb/s
    Metadata:
      handler_name    : Chat
  Stream #0:3[0x4](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s
    Metadata:
      handler_name    : Mic
At least one output file must be specified";
        let i = parse_ffmpeg_banner(banner, 100).unwrap();
        assert!((i.duration - 119.57).abs() < 0.001);
        assert_eq!((i.width, i.height), (1920, 808));
        assert_eq!(i.fps, 30.0);
        assert_eq!(i.audio.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["Game", "Chat", "Mic"]);
    }
}
