//! `cargo run -p ml-rgb --example colors`: the LED colours OpenRGB last sent to each device (what the hardware shows
//! while a device is in Direct mode), one line per device.
fn main() -> Result<(), String> {
    let mut c = ml_rgb::client::Client::connect()?;
    for (i, d) in c.devices()?.iter().enumerate() {
        println!("#{i} {} [{}] first colours: {:?}", d.name, d.modes.get(d.active_mode as usize).map_or("?", |m| m.name.as_str()), d.colors.iter().take(3).collect::<Vec<_>>());
    }
    Ok(())
}
