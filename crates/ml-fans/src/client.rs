//! Blocking client for `buffer-fans.exe` on its named pipe (line-delimited JSON, user-only ACL).

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};

pub const PIPE: &str = r"\\.\pipe\buffer-fans";

pub struct Client {
    r: BufReader<File>,
    w: File,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct SensorInfo {
    pub id: String,
    pub name: String,
    pub hw: String,
    #[serde(rename = "hwType")]
    pub hw_type: String,
    /// `temperature`, `fan`, `control` or `load`
    #[serde(rename = "type")]
    pub kind: String,
    pub value: Option<f32>,
    pub control: bool,
}

pub struct Reading {
    pub values: HashMap<String, f32>,
    /// controls the helper holds right now
    pub taken: Vec<String>,
    /// the helper's watchdog fired (it has not heard from us for a while)
    pub failed: bool,
}

impl Client {
    pub fn connect() -> Result<Client, String> {
        let f = OpenOptions::new().read(true).write(true).open(PIPE).map_err(|e| e.to_string())?;
        let w = f.try_clone().map_err(|e| e.to_string())?;
        Ok(Client { r: BufReader::new(f), w })
    }

    pub fn call(&mut self, q: Value) -> Result<Value, String> {
        let mut line = serde_json::to_string(&q).map_err(|e| e.to_string())?;
        line.push('\n');
        self.w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        let mut reply = String::new();
        if self.r.read_line(&mut reply).map_err(|e| e.to_string())? == 0 {
            return Err("the fan helper closed the connection".into());
        }
        let v: Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
        if v["ok"] == false {
            return Err(v["error"].as_str().unwrap_or("the fan helper failed").to_string());
        }
        Ok(v)
    }

    /// `(version, running elevated)`
    pub fn hello(&mut self) -> Result<(String, bool), String> {
        let v = self.call(json!({ "cmd": "hello" }))?;
        Ok((v["version"].as_str().unwrap_or("").to_string(), v["admin"].as_bool().unwrap_or(false)))
    }

    pub fn list(&mut self) -> Result<Vec<SensorInfo>, String> {
        let v = self.call(json!({ "cmd": "list" }))?;
        serde_json::from_value(v["sensors"].clone()).map_err(|e| e.to_string())
    }

    pub fn read(&mut self) -> Result<Reading, String> {
        let v = self.call(json!({ "cmd": "read" }))?;
        let values = v["values"].as_object().map(|o| o.iter().filter_map(|(k, x)| Some((k.clone(), x.as_f64()? as f32))).collect()).unwrap_or_default();
        let taken = v["taken"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        Ok(Reading { values, taken, failed: v["failed"].as_bool().unwrap_or(false) })
    }

    pub fn set(&mut self, items: &[(String, f32)]) -> Result<(), String> {
        let items: Vec<Value> = items.iter().map(|(id, p)| json!([id, p])).collect();
        self.call(json!({ "cmd": "set", "items": items })).map(|_| ())
    }

    pub fn release(&mut self, ids: &[String]) -> Result<(), String> {
        self.call(json!({ "cmd": "release", "ids": ids })).map(|_| ())
    }

    /// What the helper does on its own when we go quiet for `grace` seconds.
    pub fn failsafe(&mut self, pct: f32, grace: f32) -> Result<(), String> {
        self.call(json!({ "cmd": "failsafe", "pct": pct, "grace": grace })).map(|_| ())
    }

    /// Hands every control back (SetDefault) and ends the helper.
    pub fn quit(&mut self) -> Result<(), String> {
        let _ = self.call(json!({ "cmd": "quit" }));
        Ok(())
    }
}

/// The helper process is alive. (Opening the pipe to find out would take its only connection.)
pub fn running() -> bool {
    ml_core::elevate::run("tasklist", &["/FI", "IMAGENAME eq buffer-fans.exe", "/NH"])
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("buffer-fans.exe"))
        .unwrap_or(false)
}
