//! `cargo run -p ml-rgb --example modes` with an OpenRGB server running: every device's modes with what they can do
//! (speed, brightness, direction, colours, saves to the device) and the resizable zones.
use ml_rgb::proto::flag;

fn main() -> Result<(), String> {
    let mut c = ml_rgb::client::Client::connect()?;
    for (i, d) in c.devices()?.iter().enumerate() {
        println!("#{i} {} [{}]  active mode: {}", d.name, d.vendor, d.modes.get(d.active_mode as usize).map_or("?", |m| m.name.as_str()));
        for m in &d.modes {
            let f = |bit: u32, s: &'static str| if m.flags & bit != 0 { s } else { "" };
            println!(
                "    {:<18} {} {} {} {} {} {} {} speed {}..{} colours {}..{}",
                m.name,
                f(flag::SPEED, "speed"),
                f(flag::BRIGHTNESS, "bright"),
                f(flag::DIR_LR, "dir"),
                f(flag::PER_LED_COLOR, "per-led"),
                f(flag::MODE_COLORS, "colours"),
                f(flag::MANUAL_SAVE, "SAVE-manual"),
                f(flag::AUTOMATIC_SAVE, "SAVE-auto"),
                m.speed_min, m.speed_max, m.colors_min, m.colors_max
            );
        }
        for (z, zone) in d.zones.iter().enumerate() {
            println!("    zone {z} {:?}: {} LEDs, {}..{}{}", zone.name, zone.leds, zone.leds_min, zone.leds_max, if zone.resizable() { "  (resizable)" } else { "" });
        }
    }
    Ok(())
}
