//! Optional scan, `buffer-recorder import-icons <game>...`: for game names that have no saved icon yet, finds the
//! installed game (Steam libraries, Epic manifests, the usual install folders) and keeps its exe icon as
//! `%APPDATA%\Buffer\icons\<game>.png`, the same file the recorder writes the first time it records a game.
//! Prints `{"found":[...],"missing":[...]}`. Nothing is installed, changed or sent anywhere.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

struct Install {
    name: String,
    dir: PathBuf,
    exe: Option<PathBuf>,
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

fn icon_file(game: &str) -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    let name: String = game.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) { '-' } else { c }).collect();
    Some(PathBuf::from(base).join("Buffer").join("icons").join(format!("{name}.png")))
}

/// `"key"  "value"` lines of a Valve KeyValues file: the first value of `key` in `text`.
fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let want = format!("\"{key}\"");
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix(&want)?.trim();
            let v = rest.strip_prefix('"')?.strip_suffix('"')?;
            Some(v.replace("\\\\", "\\"))
        })
        .collect()
}

fn steam_root() -> Option<PathBuf> {
    let mut c = Command::new("reg");
    c.args(["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"]);
    ml_core::export::hide_window(&mut c);
    let out = String::from_utf8_lossy(&c.output().ok()?.stdout).into_owned();
    let line = out.lines().find(|l| l.contains("SteamPath"))?;
    let value = line.split("REG_SZ").nth(1)?.trim();
    Some(PathBuf::from(value.replace('/', "\\")))
}

fn steam_installs(out: &mut Vec<Install>) {
    let Some(root) = steam_root() else { return };
    let mut libs = vec![root.clone()];
    if let Ok(t) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        libs.extend(vdf_values(&t, "path").into_iter().map(PathBuf::from));
    }
    for lib in libs {
        let apps = lib.join("steamapps");
        let Ok(rd) = fs::read_dir(&apps) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if !(n.starts_with("appmanifest_") && n.ends_with(".acf")) {
                continue;
            }
            let Ok(t) = fs::read_to_string(e.path()) else { continue };
            let name = vdf_values(&t, "name").into_iter().next();
            let dir = vdf_values(&t, "installdir").into_iter().next();
            if let (Some(name), Some(dir)) = (name, dir) {
                out.push(Install { name, dir: apps.join("common").join(dir), exe: None });
            }
        }
    }
}

fn epic_installs(out: &mut Vec<Install>) {
    let Some(pd) = std::env::var_os("ProgramData") else { return };
    let dir = PathBuf::from(pd).join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests");
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if e.path().extension().and_then(|x| x.to_str()) != Some("item") {
            continue;
        }
        let Ok(b) = fs::read(e.path()) else { continue };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&b) else { continue };
        let (Some(name), Some(loc)) = (v["DisplayName"].as_str(), v["InstallLocation"].as_str()) else { continue };
        let exe = v["LaunchExecutable"].as_str().filter(|s| !s.is_empty()).map(|s| Path::new(loc).join(s));
        out.push(Install { name: name.to_string(), dir: PathBuf::from(loc), exe });
    }
}

/// Plain folders: every sub-folder of the usual places counts as a game named after the folder.
fn folder_installs(out: &mut Vec<Install>) {
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(p) = std::env::var_os(var) {
            roots.push(PathBuf::from(p));
        }
    }
    for d in b'C'..=b'Z' {
        for sub in ["Games", "Epic Games", "GOG Games", "GOG Galaxy/Games"] {
            roots.push(PathBuf::from(format!("{}:/{sub}", d as char)));
        }
    }
    for r in roots {
        let Ok(rd) = fs::read_dir(&r) else { continue };
        for e in rd.flatten() {
            if e.path().is_dir() {
                out.push(Install { name: e.file_name().to_string_lossy().into_owned(), dir: e.path(), exe: None });
            }
        }
    }
}

/// The game's main program: the biggest .exe within two levels, skipping crash handlers, installers and the like.
fn main_exe(dir: &Path, game_key: &str) -> Option<PathBuf> {
    const SKIP: [&str; 10] = ["crash", "unins", "setup", "redist", "vc_", "dxsetup", "dotnet", "report", "helper", "eac"];
    let mut best: Option<(bool, u64, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0u32)];
    let mut seen = 0;
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > 600 {
                break;
            }
            let p = e.path();
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                if depth < 2 {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            if p.extension().and_then(|x| x.to_str()).map_or(true, |x| !x.eq_ignore_ascii_case("exe")) {
                continue;
            }
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if SKIP.iter().any(|s| stem.contains(s)) {
                continue;
            }
            let named = !game_key.is_empty() && norm(&stem).len() >= 3 && game_key.contains(&norm(&stem));
            let cand = (named, m.len(), p);
            if best.as_ref().map_or(true, |b| (cand.0, cand.1) > (b.0, b.1)) {
                best = Some(cand);
            }
        }
    }
    best.map(|b| b.2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_steam_keyvalues() {
        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"255710\"\n\t\"name\"\t\t\"Cities: Skylines\"\n\t\"installdir\"\t\t\"Cities_Skylines\"\n}";
        assert_eq!(vdf_values(acf, "name"), vec!["Cities: Skylines"]);
        assert_eq!(vdf_values(acf, "installdir"), vec!["Cities_Skylines"]);
        let lib = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t}\n}";
        assert_eq!(vdf_values(lib, "path"), vec!["D:\\SteamLibrary"]);
    }

    #[test]
    fn names_match_without_punctuation() {
        assert_eq!(norm("Cities: Skylines"), norm("Cities-Skylines"));
        assert_eq!(norm("Call of Duty®"), "callofduty");
    }
}

pub fn run(names: Vec<String>) {
    let mut installs = Vec::new();
    steam_installs(&mut installs);
    epic_installs(&mut installs);
    folder_installs(&mut installs);
    let keyed: Vec<(String, &Install)> = installs.iter().map(|i| (norm(&i.name), i)).collect();

    let (mut found, mut missing) = (Vec::new(), Vec::new());
    for game in names {
        let key = norm(&game);
        let hit = keyed
            .iter()
            .find(|(k, _)| !key.is_empty() && *k == key)
            .or_else(|| {
                // "Call of Duty" vs "Call of Duty: Black Ops": the shorter name inside the longer one, if it is long enough
                keyed
                    .iter()
                    .filter(|(k, _)| {
                        let (s, l) = if k.len() < key.len() { (k, &key) } else { (&key, k) };
                        s.len() >= 6 && l.contains(s.as_str())
                    })
                    .min_by_key(|(k, _)| k.len().abs_diff(key.len()))
            });
        let saved = hit.and_then(|(_, i)| {
            let exe = i.exe.clone().filter(|p| p.exists()).or_else(|| main_exe(&i.dir, &key))?;
            let bytes = crate::win::exe_icon_png(&exe.to_string_lossy())?;
            let png = icon_file(&game)?;
            fs::create_dir_all(png.parent()?).ok()?;
            fs::write(png, bytes).ok()
        });
        if saved.is_some() {
            found.push(game);
        } else {
            missing.push(game);
        }
    }
    println!("{}", serde_json::json!({ "found": found, "missing": missing }));
}
