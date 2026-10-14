use anyhow::{bail, Result};
use clap::{Parser, Subcommand, ValueEnum};
use ml_core::{
    export::{default_output, export, Codec, ExportOptions},
    probe::probe,
};
use std::{io::Write, path::PathBuf};

#[derive(Parser)]
#[command(name = "ml", about = "Buffer: simple clip tools")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show duration, resolution and audio track names
    Probe { file: PathBuf },
    /// Export a clip so it fits under a target size
    Export {
        input: PathBuf,
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Target size in MiB (10 = Discord free, 50 = Discord boost)
        #[arg(short, long, default_value_t = 10)]
        size: u64,
        #[arg(long, default_value_t = 0.0)]
        start: f64,
        #[arg(long)]
        end: Option<f64>,
        /// Downscale to this height if the source is taller
        #[arg(long)]
        max_height: Option<u32>,
        #[arg(long, value_enum, default_value_t = CodecArg::Auto)]
        codec: CodecArg,
        #[arg(long, default_value_t = 128)]
        audio_kbps: u32,
        /// Track gain, e.g. --vol mic=1.5 --vol chat=0 (0 drops the track)
        #[arg(long = "vol", value_name = "TRACK=GAIN")]
        vol: Vec<String>,
        /// Centre-crop to 16:9
        #[arg(long)]
        wide: bool,
        #[arg(long, default_value_t = 1.0)]
        speed: f64,
        /// Normalise loudness to about -16 LUFS
        #[arg(long)]
        normalize: bool,
    },
}

#[derive(Clone, ValueEnum)]
enum CodecArg {
    Auto,
    H264,
    Hevc,
    X264,
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Probe { file } => {
            let i = probe(&file)?;
            println!(
                "{}x{} @ {:.2} fps, {:.1}s, {:.1} MiB",
                i.width,
                i.height,
                i.fps,
                i.duration,
                i.size as f64 / 1048576.0
            );
            for t in i.audio {
                println!("audio {}: {}", t.index, t.name);
            }
        }
        Cmd::Export { input, output, size, start, end, max_height, codec, audio_kbps, vol, wide, speed, normalize } => {
            let mut volumes = Vec::new();
            for v in vol {
                let Some((n, g)) = v.split_once('=') else {
                    bail!("--vol expects TRACK=GAIN, got {v}")
                };
                volumes.push((n.to_string(), g.parse::<f32>()?));
            }
            let opts = ExportOptions {
                output: output.unwrap_or_else(|| default_output(&input, size)),
                input,
                start,
                end,
                target_bytes: size * 1024 * 1024,
                max_height,
                codec: match codec {
                    CodecArg::Auto => Codec::Auto,
                    CodecArg::H264 => Codec::H264Nvenc,
                    CodecArg::Hevc => Codec::HevcNvenc,
                    CodecArg::X264 => Codec::X264,
                },
                audio_kbps,
                volumes,
                crop_wide: wide.then_some(0.5),
                speed,
                normalize,
                hwaccel: true,
            };
            let r = export(
                &opts,
                |p| {
                    print!("\r{:5.1}%", p * 100.0);
                    let _ = std::io::stdout().flush();
                },
                || false,
            )?;
            println!(
                "\r100.0%  {:.2} MiB (target {} MiB), video {} kbps, {} attempt(s)\n-> {}",
                r.size as f64 / 1048576.0,
                size,
                r.video_kbps,
                r.attempts,
                opts.output.display()
            );
        }
    }
    Ok(())
}
