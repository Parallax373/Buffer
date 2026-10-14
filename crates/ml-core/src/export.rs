use crate::probe::{probe, MediaInfo};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Codec {
    H264Nvenc,
    HevcNvenc,
    X264,
}

impl Codec {
    fn args(self) -> &'static [&'static str] {
        match self {
            Codec::H264Nvenc => &[
                "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-multipass", "fullres",
            ],
            Codec::HevcNvenc => &[
                "-c:v", "hevc_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-multipass", "fullres",
                "-tag:v", "hvc1",
            ],
            Codec::X264 => &["-c:v", "libx264", "-preset", "slow"],
        }
    }
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    pub input: PathBuf,
    pub output: PathBuf,
    pub start: f64,
    pub end: Option<f64>,
    pub target_bytes: u64,
    pub max_height: Option<u32>,
    pub codec: Codec,
    pub audio_kbps: u32,
    /// (audio track name, gain). Tracks not listed use gain 1.0; gain 0 drops the track.
    pub volumes: Vec<(String, f32)>,
    /// Crop to 16:9 (letterboxed/ultrawide sources lose the sides, narrow ones the top and bottom);
    /// the value is the horizontal position 0.0 (left) ..= 1.0 (right).
    #[serde(default)]
    pub crop_wide: Option<f64>,
    /// Playback speed of the exported clip (0.5 ..= 4.0).
    #[serde(default = "one")]
    pub speed: f64,
    /// Normalise the mixed audio to about -16 LUFS.
    #[serde(default)]
    pub normalize: bool,
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub size: u64,
    pub attempts: u32,
    pub video_kbps: u64,
}

/// Fraction of the byte budget used for payload; the rest absorbs muxing overhead and rate-control error.
const BUDGET_FACTOR: f64 = 0.96;
const MIN_VIDEO_KBPS: i64 = 150;
const MAX_ATTEMPTS: u32 = 4;

pub fn export(opts: &ExportOptions, mut on_progress: impl FnMut(f64)) -> Result<ExportResult> {
    let info = probe(&opts.input)?;
    let end = opts.end.unwrap_or(info.duration).min(info.duration);
    let src_dur = end - opts.start;
    if src_dur <= 0.0 {
        bail!("empty range: start {} >= end {}", opts.start, end);
    }
    let speed = opts.speed.clamp(0.5, 4.0);
    let out_dur = src_dur / speed;

    let gains = resolve_gains(&info, &opts.volumes);
    let audio_kbps = if gains.is_empty() { 0 } else { opts.audio_kbps as i64 };
    let budget_bits = opts.target_bytes as f64 * 8.0 * BUDGET_FACTOR;
    let mut video_kbps = ((budget_bits / out_dur) / 1000.0) as i64 - audio_kbps;

    let mut attempts = 0;
    loop {
        attempts += 1;
        if video_kbps < MIN_VIDEO_KBPS {
            bail!(
                "target too small for a {:.0}s clip: only {} kbps left for video (min {}). Trim, lower the resolution or raise the target.",
                out_dur,
                video_kbps,
                MIN_VIDEO_KBPS
            );
        }
        let job = Job { opts, info: &info, gains: &gains, start: opts.start, src_dur, out_dur, speed };
        job.run(video_kbps as u64, &mut on_progress)?;
        let size = std::fs::metadata(&opts.output)?.len();
        if size <= opts.target_bytes {
            return Ok(ExportResult { size, attempts, video_kbps: video_kbps as u64 });
        }
        if attempts >= MAX_ATTEMPTS {
            bail!(
                "output {} bytes still exceeds target {} after {} attempts",
                size,
                opts.target_bytes,
                attempts
            );
        }
        // Scale the video rate by how far we overshot, with a little extra margin.
        let ratio = opts.target_bytes as f64 / size as f64 * 0.97;
        video_kbps = (video_kbps as f64 * ratio) as i64;
    }
}

fn resolve_gains(info: &MediaInfo, volumes: &[(String, f32)]) -> Vec<(usize, f32)> {
    info.audio
        .iter()
        .filter_map(|t| {
            let g = volumes
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(&t.name))
                .map(|(_, g)| *g)
                .unwrap_or(1.0);
            (g > 0.0).then_some((t.index, g))
        })
        .collect()
}

struct Job<'a> {
    opts: &'a ExportOptions,
    info: &'a MediaInfo,
    gains: &'a [(usize, f32)],
    start: f64,
    src_dur: f64,
    out_dur: f64,
    speed: f64,
}

impl Job<'_> {
    fn audio_graph(&self) -> String {
        let mut g = String::new();
        for (i, (idx, gain)) in self.gains.iter().enumerate() {
            g.push_str(&format!("[0:a:{idx}]volume={gain}[a{i}];"));
        }
        let mut tail = Vec::new();
        if self.gains.len() > 1 {
            tail.push(format!("amix=inputs={}:duration=longest:normalize=0", self.gains.len()));
        }
        if self.speed != 1.0 {
            tail.push(format!("atempo={}", self.speed));
        }
        if self.opts.normalize {
            tail.push("loudnorm=I=-16:TP=-1.5:LRA=11".to_string());
        } else if self.gains.len() > 1 {
            tail.push("alimiter=limit=0.97".to_string());
        }
        if tail.is_empty() {
            tail.push("anull".to_string());
        }
        for i in 0..self.gains.len() {
            g.push_str(&format!("[a{i}]"));
        }
        g.push_str(&tail.join(","));
        g.push_str("[aout]");
        g
    }

    fn video_filters(&self) -> Vec<String> {
        let mut vf = Vec::new();
        if let Some(pos) = self.opts.crop_wide {
            let pos = pos.clamp(0.0, 1.0);
            vf.push(format!(
                "crop=w=min(iw\\,trunc(ih*16/9/2)*2):h=min(ih\\,trunc(iw*9/16/2)*2):x=(iw-ow)*{pos:.4}:y=(ih-oh)/2"
            ));
        }
        if let Some(h) = self.opts.max_height.filter(|h| self.info.height > *h) {
            vf.push(format!("scale=-2:{h}:flags=lanczos"));
        }
        if self.speed != 1.0 {
            vf.push(format!("setpts=PTS/{}", self.speed));
        }
        vf
    }

    fn run(&self, video_kbps: u64, on_progress: &mut impl FnMut(f64)) -> Result<()> {
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]);
        if self.opts.codec != Codec::X264 {
            // Let the GPU decode too; frames come back to system memory for the CPU filters.
            cmd.args(["-hwaccel", "auto"]);
        }
        cmd.args(["-ss", &format!("{:.3}", self.start), "-t", &format!("{:.3}", self.src_dur)])
            .arg("-i")
            .arg(&self.opts.input);
        if !self.gains.is_empty() {
            cmd.args(["-filter_complex", &self.audio_graph()]);
        }
        cmd.args(["-map", "0:v:0"]);
        let vf = self.video_filters();
        if !vf.is_empty() {
            cmd.args(["-vf", &vf.join(",")]);
        }
        if self.gains.is_empty() {
            cmd.arg("-an");
        } else {
            cmd.args(["-map", "[aout]", "-c:a", "aac", "-b:a", &format!("{}k", self.opts.audio_kbps)]);
        }
        let v = video_kbps.to_string();
        cmd.args(self.opts.codec.args())
            .args([
                "-b:v",
                &format!("{v}k"),
                "-maxrate",
                &format!("{v}k"),
                "-bufsize",
                &format!("{}k", video_kbps * 2),
            ])
            .args(["-pix_fmt", "yuv420p", "-movflags", "+faststart"])
            .arg(&self.opts.output);
        hide_window(&mut cmd);

        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("failed to run ffmpeg (is it on PATH?)")?;
        let stdout = child.stdout.take().unwrap();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = us.trim().parse::<f64>() {
                    on_progress((us / 1e6 / self.out_dur).clamp(0.0, 1.0));
                }
            }
        }
        let out = child.wait_with_output()?;
        if !out.status.success() {
            bail!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(())
    }
}

/// Keep ffmpeg from flashing a console window when launched from a GUI app.
pub fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

pub fn default_output(input: &Path, size_mb: u64) -> PathBuf {
    let stem = input.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    input.with_file_name(format!("{stem}_{size_mb}MB.mp4"))
}
