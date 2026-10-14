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
    let mut cmd = Command::new("ffprobe");
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
