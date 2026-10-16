//! `cargo run -p ml-rgb --example list` with an OpenRGB server running: prints what it found.
fn main() -> Result<(), String> {
    let mut c = ml_rgb::client::Client::connect()?;
    for (i, d) in c.devices()?.iter().enumerate() {
        println!("#{i} {} [{}] modes={:?} zones={:?} leds={}", d.name, d.vendor, d.modes.iter().map(|m| &m.name).collect::<Vec<_>>(), d.zones.iter().map(|z| (&z.name, z.leds)).collect::<Vec<_>>(), d.led_names.len());
    }
    Ok(())
}
