//! `cargo run -p ml-rgb --example setcolor -- "<device name starts with>" R G B`: puts one device in its Direct mode with
//! one colour, straight through OpenRGB (a repair tool for tests; Buffer's own page goes through the recorder).
fn main() -> Result<(), String> {
    let a: Vec<String> = std::env::args().collect();
    let (name, rgb) = (a.get(1).ok_or("device name")?, [2, 3, 4].map(|i| a.get(i).and_then(|s| s.parse::<u8>().ok()).unwrap_or(0)));
    let mut c = ml_rgb::client::Client::connect()?;
    for (i, d) in c.devices()?.iter().enumerate() {
        if d.name.starts_with(name.as_str()) {
            c.set_colors(i as u32, &vec![rgb; d.led_names.len().max(1)])?;
            println!("#{i} {} -> {rgb:?}", d.name);
        }
    }
    Ok(())
}
