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

/// The Dark Project keyboard follows its Simple look (on) or is given back with its own profile (off).
#[tauri::command]
pub async fn rgb_keyboard(on: bool) -> Result<(), String> {
    send(format!("rgb-keyboard {}", if on { "on" } else { "off" })).await.map(|_| ())
}

/// One device's Simple look `{name, nth, hue, sat, br, on}`: saved, shown at once, switches to Simple mode.
#[tauri::command]
pub async fn rgb_look(look: Value) -> Result<(), String> {
    send(format!("rgb-look {}", serde_json::to_string(&look).map_err(|e| e.to_string())?)).await.map(|_| ())
}
