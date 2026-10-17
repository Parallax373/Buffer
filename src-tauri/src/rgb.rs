//! RGB tab backend. The always-on recorder owns OpenRGB and the effect loop (crates/ml-recorder/src/rgb.rs), so the
//! lights keep their scene when this window closes; everything here is a thin pass-through to its control commands,
//! except the one-time install (download, verify, one elevated step), which lives in ml-rgb and also runs from
//! `buffer-recorder rgb-install`. Nothing happens until the user clicks Enable.

use serde_json::{json, Value};

/// One recorder command; `{ok:false,error}` replies become errors.
async fn send(cmd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v: Value = serde_json::from_str(&crate::recorder_send(&cmd)?).map_err(|e| e.to_string())?;
        if v["ok"] == false {
            return Err(v["error"].as_str().unwrap_or("RGB failed").to_string());
        }
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `{installed, enabled, running, ...}`; without a recorder only the install state is known.
#[tauri::command]
pub async fn rgb_status() -> Value {
    match send("rgb-status".into()).await {
        Ok(v) => v,
        Err(_) => json!({ "installed": tauri::async_runtime::spawn_blocking(ml_rgb::install::installed).await.unwrap_or(false), "enabled": false, "running": false }),
    }
}

/// Downloads the pinned OpenRGB (and the PawnIO driver if it is missing), checks the hashes and installs both in one
/// elevated step (one Windows permission prompt). All or nothing.
#[tauri::command]
pub async fn rgb_install() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| ml_rgb::install::install(&crate::local_dir().join("rgb")))
        .await
        .map_err(|e| e.to_string())??;
    Ok(rgb_status().await)
}

/// Removes OpenRGB and its task (one prompt). The PawnIO driver stays.
#[tauri::command]
pub async fn rgb_uninstall() -> Result<Value, String> {
    let _ = send("rgb-disable".into()).await;
    tauri::async_runtime::spawn_blocking(ml_rgb::install::uninstall).await.map_err(|e| e.to_string())??;
    Ok(rgb_status().await)
}

/// Turns RGB on in the recorder and returns the devices (`[{index, name, vendor, led_names, ...}]`).
#[tauri::command]
pub async fn rgb_start() -> Result<Value, String> {
    send("rgb-enable".into()).await?;
    rgb_devices().await
}

/// Starts OpenRGB again so it looks for hardware from scratch, then returns the devices. A device that was asleep or
/// busy when OpenRGB started is missing from the list until then; "Scan again" uses this.
#[tauri::command]
pub async fn rgb_rescan() -> Result<Value, String> {
    Ok(send("rgb-rescan".into()).await?["devices"].clone())
}

/// Re-reads the device list.
#[tauri::command]
pub async fn rgb_devices() -> Result<Value, String> {
    Ok(send("rgb-devices".into()).await?["devices"].clone())
}

/// Turns RGB off: every device goes back to the mode it had, and the server stops.
#[tauri::command]
pub async fn rgb_stop() -> Result<(), String> {
    send("rgb-disable".into()).await.map(|_| ())
}

/// Raw colours for one device, one `[r,g,b]` per LED (not saved; the Simple page uses `rgb_look`).
#[tauri::command]
pub async fn rgb_set(index: u32, colors: Vec<[u8; 3]>) -> Result<(), String> {
    send(format!("rgb-set {index} {}", serde_json::to_string(&colors).map_err(|e| e.to_string())?)).await.map(|_| ())
}

/// The saved scene (RGB-SCENE.md).
#[tauri::command]
pub async fn rgb_scene_get() -> Result<Value, String> {
    Ok(send("rgb-scene-get".into()).await?["scene"].clone())
}

/// Replaces the scene; the recorder saves it and shows it at once.
#[tauri::command]
pub async fn rgb_scene_set(scene: Value) -> Result<(), String> {
    send(format!("rgb-scene-set {}", serde_json::to_string(&scene).map_err(|e| e.to_string())?)).await.map(|_| ())
}

/// Gives a device back: its Simple look is dropped and it shows its own lighting again.
#[tauri::command]
pub async fn rgb_unlook(name: String, nth: u32) -> Result<(), String> {
    send(format!("rgb-unlook {nth} {name}")).await.map(|_| ())
}

/// A device follows the scene's effect again: its own look goes, it is not given back.
#[tauri::command]
pub async fn rgb_follow(name: String, nth: u32) -> Result<(), String> {
    send(format!("rgb-follow {nth} {name}")).await.map(|_| ())
}

/// Lights one device for 3 s so it can be told apart: dim white, LED 0 flashing, LED 1 lime (the direction).
#[tauri::command]
pub async fn rgb_blink(name: String, nth: u32) -> Result<(), String> {
    send(format!("rgb-blink {nth} {name}")).await.map(|_| ())
}

/// A device's colour calibration (`key` "name#n", percent r, g, b; None removes it). Applies in every mode.
#[tauri::command]
pub async fn rgb_calib(key: String, value: Option<[f32; 3]>) -> Result<(), String> {
    send(format!("rgb-calib {key} {}", serde_json::to_string(&value).map_err(|e| e.to_string())?)).await.map(|_| ())
}

/// The calibration test pattern: every shown device in `color` (calibrated); None ends it and the scene comes back.
#[tauri::command]
pub async fn rgb_test(color: Option<[u8; 3]>) -> Result<(), String> {
    let arg = match color { Some(c) => serde_json::to_string(&c).map_err(|e| e.to_string())?, None => "off".into() };
    send(format!("rgb-test {arg}")).await.map(|_| ())
}

/// One device's Simple look `{name, nth, hue, sat, br, on}`: saved, shown at once, switches to Simple mode.
#[tauri::command]
pub async fn rgb_look(look: Value) -> Result<(), String> {
    send(format!("rgb-look {}", serde_json::to_string(&look).map_err(|e| e.to_string())?)).await.map(|_| ())
}

/// Sets the number of LEDs of an addressable zone (`zone` is its index inside the device); returns the device list again.
#[tauri::command]
pub async fn rgb_zone(index: u32, zone: u32, leds: u32) -> Result<Value, String> {
    Ok(send(format!("rgb-zone {index} {zone} {leds}")).await?["devices"].clone())
}

/// When the lights go out by themselves `{lock, idle_min, schedule, from, to}`.
#[tauri::command]
pub async fn rgb_power(power: Value) -> Result<(), String> {
    send(format!("rgb-power {}", serde_json::to_string(&power).map_err(|e| e.to_string())?)).await.map(|_| ())
}

/// Saves the scene in use under `name` (also overwrites), loads one, or deletes one.
#[tauri::command]
pub async fn rgb_profile(action: String, name: String) -> Result<(), String> {
    let cmd = match action.as_str() {
        "save" => "rgb-profile-save",
        "load" => "rgb-profile-load",
        "delete" => "rgb-profile-delete",
        _ => return Err("unknown profile action".into()),
    };
    send(format!("{cmd} {name}")).await.map(|_| ())
}

/// Switches to a profile while a game is in front (`profile` "-" removes the binding).
#[tauri::command]
pub async fn rgb_game_profile(game: String, profile: String) -> Result<(), String> {
    send(format!("rgb-game-profile {game} {profile}")).await.map(|_| ())
}

/// Hides a device (`key` = "name#n"): it disappears from the page and Buffer stops driving it. `on` false shows it again.
#[tauri::command]
pub async fn rgb_hide(key: String, on: bool) -> Result<(), String> {
    send(format!("rgb-hide {} {key}", if on { "on" } else { "off" })).await.map(|_| ())
}

/// Gives a device a name of the user's own (`key` = "name#n"); an empty name takes the original back.
#[tauri::command]
pub async fn rgb_rename(key: String, name: String) -> Result<(), String> {
    send(format!("rgb-rename {key}\t{name}")).await.map(|_| ())
}