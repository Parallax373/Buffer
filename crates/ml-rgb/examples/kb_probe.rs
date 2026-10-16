//! Dark Project Midnight 87 probe. `cargo run -p ml-rgb --example kb_probe` only reads (enumerate, current profile,
//! snapshot) and writes the snapshot hex to the path given as the first argument. With `--set` it also shows
//! solid lime for 3 s on the stored profile and restores the snapshot, then checks the restore byte for byte.
fn main() {
    #[cfg(windows)]
    {
        use ml_rgb::darkproject::{detect, list_collections, Keyboard};
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        for c in list_collections().unwrap_or_default() {
            println!("collection page={:#06x} usage={:#06x} {:?}", c.usage_page, c.usage, c.product);
        }
        let Some(info) = detect() else { return println!("no configuration collection found") };
        let kb = Keyboard::open(&info).expect("open");
        let profile = kb.current_profile().expect("current profile");
        println!("current profile {profile}");
        let snap = kb.snapshot(profile, Some(0)).expect("snapshot");
        println!("profile reply {} bytes, custom preset captured: {}", snap.profile_reply.len(), snap.custom.is_some());
        if let Some(path) = std::env::args().nth(1).filter(|a| a != "--set") {
            let mut out = format!("profile={}\nprofile_reply={}\n", snap.profile, hex(&snap.profile_reply));
            if let Some((p, ch)) = &snap.custom {
                out += &format!("preset={p}\nchunk0={}\nchunk1={}\n", hex(&ch[0]), hex(&ch[1]));
            }
            std::fs::write(path, out).expect("write backup");
        }
        if std::env::args().any(|a| a == "--set") {
            let before = snap.profile_reply.clone();
            let taken = kb.set_static([0xc6, 0xf4, 0x32]).expect("set_static");
            println!("set lime; look at the keyboard");
            std::thread::sleep(std::time::Duration::from_secs(3));
            kb.restore(&taken).expect("restore");
            let after = kb.snapshot(profile, None).expect("re-read").profile_reply;
            println!("restore identical: {}", after == before);
        }
    }
}
