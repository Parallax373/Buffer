//! Prints the report descriptor (hex) and feature report sizes of every vendor-page collection of the Midnight 87.
//! Passive: opening a HID collection and reading its descriptor sends no report.
fn main() {
    #[cfg(windows)]
    {
        let api = hidapi::HidApi::new().unwrap();
        for d in api.device_list().filter(|d| d.vendor_id() == 0x342D && d.product_id() == 0xE40F && d.usage_page() >= 0xFF00) {
            print!("page={:#06x} usage={:#06x} ", d.usage_page(), d.usage());
            match d.open_device(&api) {
                Ok(dev) => {
                    let mut buf = [0u8; 4096];
                    let n = dev.get_report_descriptor(&mut buf).unwrap_or(0);
                    println!("descriptor {n} bytes");
                    println!("{}", buf[..n].iter().map(|b| format!("{b:02x}")).collect::<String>());
                    for id in 0..=16u8 {
                        if let Some(len) = ml_rgb::darkproject::feature_report_len(&buf[..n], id) {
                            println!("  feature report id {id}: {len} bytes");
                        }
                    }
                }
                Err(e) => println!("open failed: {e}"),
            }
        }
    }
}
