//! `cargo run -p ml-rgb --example kb_restore -- <backup.txt>`: writes back a profile saved by `kb_probe`
//! (the `profile=` and `profile_reply=` lines), then reads it again and says whether it is identical.
fn main() {
    #[cfg(windows)]
    {
        use ml_rgb::darkproject::{detect, Keyboard, Snapshot};
        let text = std::fs::read_to_string(std::env::args().nth(1).expect("backup file")).expect("read backup");
        let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)).expect("missing key").trim().to_string();
        let profile: u8 = get("profile=").parse().unwrap();
        let reply: Vec<u8> = (0..get("profile_reply=").len() / 2).map(|i| u8::from_str_radix(&get("profile_reply=")[2 * i..2 * i + 2], 16).unwrap()).collect();
        let kb = Keyboard::open(&detect().expect("keyboard")).expect("open");
        kb.restore(&Snapshot { profile, profile_reply: reply.clone(), custom: None }).expect("restore");
        std::thread::sleep(std::time::Duration::from_millis(500));
        let now = kb.snapshot(profile, None).expect("read").profile_reply;
        println!("identical to backup: {}", now == reply);
    }
}
