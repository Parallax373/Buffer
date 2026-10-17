//! Fans tab backend. The always-on recorder owns the helper and the control loop (crates/ml-recorder/src/fans.rs), so the
//! fans keep following their curves when this window closes; everything here is a thin pass-through to its control
//! commands, except the one-time install (download or local build, verify, one elevated step), which lives in ml-fans.
//! Nothing happens until the user clicks Enable.

use serde_json::{json, Value};

/// One recorder command; `{ok:false,error}` replies become errors.
async fn send(cmd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let v: Value = serde_json::from_str(&crate::recorder_send(&cmd)?).map_err(|e| e.to_string())?;
        if v["ok"] == false {
            return Err(v["error"].as_str().unwrap_or("fans failed").to_string());
        }
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Everything the page draws: install state, sensors with live values, the setup. Without a recorder only the install
/// state is known.
#[tauri::command]
pub async fn fans_status() -> Value {
    match send("fans-status".into()).await {
        Ok(v) => v,
        Err(_) => json!({
            "installed": tauri::async_runtime::spawn_blocking(ml_fans::install::installed).await.unwrap_or(false),
            "enabled": false, "connected": false, "downloadable": ml_fans::install::downloadable(),
            "dev_build": ml_fans::install::local_zip().is_some(),
        }),
    }
}

/// Installs the fan helper (and the PawnIO driver if it is missing) in one elevated step: one Windows permission prompt.
#[tauri::command]
pub async fn fans_install() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| ml_fans::install::install(&crate::local_dir().join("fans")))
        .await
        .map_err(|e| e.to_string())??;
    Ok(fans_status().await)
}

/// Hands every fan back, stops the helper and removes it (one prompt). The PawnIO driver stays.
#[tauri::command]
pub async fn fans_uninstall() -> Result<Value, String> {
    let _ = send("fans-disable".into()).await;
    tauri::async_runtime::spawn_blocking(ml_fans::install::uninstall).await.map_err(|e| e.to_string())??;
    Ok(fans_status().await)
}

#[tauri::command]
pub async fn fans_enable() -> Result<(), String> {
    send("fans-enable".into()).await.map(|_| ())
}

/// Turns control off: every fan goes back to the BIOS / the card and the helper stops.
#[tauri::command]
pub async fn fans_disable() -> Result<(), String> {
    send("fans-disable".into()).await.map(|_| ())
}

/// Replaces the whole setup (curves, controls, mixes); the recorder saves it and applies it within a second.
#[tauri::command]
pub async fn fans_setup_set(setup: Value) -> Result<(), String> {
    send(format!("fans-setup-set {}", serde_json::to_string(&setup).map_err(|e| e.to_string())?)).await.map(|_| ())
}

/// Saves, loads or deletes a named copy of the whole setup (`action` is save, load or delete).
#[tauri::command]
pub async fn fans_profile(action: String, name: String) -> Result<(), String> {
    send(format!("fans-profile {action} {name}")).await.map(|_| ())
}

/// Ends a conflict with another fan program (one prompt). FanControl only: its service keeps driving the fans with the
/// tray window closed, so the window is closed, the service stopped and set to start by hand (it would be back after a
/// reboot otherwise). FanControl itself stays installed and starts again whenever it is opened. The recorder sees the
/// processes gone within seconds and takes the fans.
#[tauri::command]
pub async fn fans_close_conflict(name: String) -> Result<(), String> {
    if name != "FanControl" {
        return Err(format!("{name} cannot be closed from Buffer"));
    }
    let script = "$ErrorActionPreference = 'Stop'
try {
  Get-Process -Name FanControl -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Get-Service -Name 'FanControl.Service' -ErrorAction SilentlyContinue) {
    Set-Service -Name 'FanControl.Service' -StartupType Manual
    Stop-Service -Name 'FanControl.Service' -Force
  }
  exit 0
} catch { exit 1 }";
    let code = tauri::async_runtime::spawn_blocking(move || ml_core::elevate::elevated(script)).await.map_err(|e| e.to_string())??;
    match code {
        0 => Ok(()),
        99 => Err("the Windows prompt was declined".into()),
        c => Err(format!("FanControl could not be stopped (exit {c})")),
    }
}

/// Starts the pairing probe: each board fan is spun up for a few seconds and paired with the speed sensor that answers.
/// Progress is in `fans_status().probe`.
#[tauri::command]
pub async fn fans_probe() -> Result<(), String> {
    send("fans-probe-start".into()).await.map(|_| ())
}

/// Holds one control at `pct` for `secs` (at most 15 s; the recorder ends it by itself), or ends a boost with `id` = None.
/// The setup wizard spins a fan this way so the user can see which one it is.
#[tauri::command]
pub async fn fans_boost(id: Option<String>, pct: Option<f32>, secs: Option<f32>) -> Result<(), String> {
    let arg = match id {
        Some(id) => format!("{id} {} {}", pct.unwrap_or(100.0), secs.unwrap_or(6.0)),
        None => "off".into(),
    };
    send(format!("fans-boost {arg}")).await.map(|_| ())
}

/// Where a FanControl configuration was found on this PC.
#[tauri::command]
pub async fn fans_import_find() -> Result<Value, String> {
    Ok(send("fans-import-find".into()).await?["paths"].clone())
}

/// What importing that FanControl configuration would give: `{controls, curves, mixes, hidden, notes, setup}`. Nothing is
/// changed until the page sends the setup back with `fans_setup_set`.
#[tauri::command]
pub async fn fans_import(path: String) -> Result<Value, String> {
    send(format!("fans-import {path}")).await
}

/// Looks for controls the setup does not know yet; returns how many were added or paired.
#[tauri::command]
pub async fn fans_detect() -> Result<u64, String> {
    Ok(send("fans-detect".into()).await?["added"].as_u64().unwrap_or(0))
}
