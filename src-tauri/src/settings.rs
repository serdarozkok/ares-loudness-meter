//! Persistent user settings matching the TypeScript `Settings` interface.

use crate::dsp::spectral_phase::Ballistics;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertSettings {
    pub clipping: bool,
    pub over_compression: bool,
    pub phase: bool,
}

impl Default for AlertSettings {
    fn default() -> Self {
        Self {
            clipping: true,
            over_compression: false,
            phase: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub mini_bar_text_color: String,
    pub mini_bar_metrics: Vec<String>,
    pub hold_mode: String,
    pub show_plr: bool,
    pub target: String,
    pub custom_target: f64,
    pub graph_span: u32,
    pub ballistics: String,
    pub tp_ceiling: f64,
    pub alerts: AlertSettings,
    pub silence_reset: u32,
    pub input_source: String,
    pub device_id: Option<String>,
    pub channel_pair: usize,
    pub ignored_apps: Vec<String>,
    pub card_order: Vec<String>,
    pub section_order: Vec<String>,
    pub pinned: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            mini_bar_text_color: "auto".to_string(),
            mini_bar_metrics: vec![
                "tp".into(),
                "int".into(),
                "live".into(),
                "shrt".into(),
                "momn".into(),
                "lra".into(),
                "psr".into(),
            ],
            hold_mode: "max".to_string(),
            show_plr: false,
            target: "spotify".to_string(),
            custom_target: -8.0,
            graph_span: 10,
            ballistics: "fast".to_string(),
            tp_ceiling: 0.0,
            alerts: AlertSettings::default(),
            silence_reset: 0,
            input_source: "wasapi".to_string(),
            device_id: None,
            channel_pair: 0,
            ignored_apps: Vec::new(),
            card_order: vec![
                "truePeak".into(),
                "integrated".into(),
                "instantLufs".into(),
                "shortTerm".into(),
                "momentary".into(),
                "lra".into(),
                "psr".into(),
            ],
            section_order: vec!["cards".into(), "graph".into(), "phase".into()],
            pinned: false,
        }
    }
}

impl Settings {
    pub fn ballistics_enum(&self) -> Ballistics {
        if self.ballistics.eq_ignore_ascii_case("slow") {
            Ballistics::Slow
        } else {
            Ballistics::Fast
        }
    }
}

fn config_path() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("LoudmeterPro");
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

pub fn load_settings() -> Settings {
    let path = config_path();
    let mut s = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default();
    if !s.card_order.iter().any(|c| c == "instantLufs") {
        if let Some(pos) = s.card_order.iter().position(|c| c == "integrated") {
            s.card_order.insert(pos + 1, "instantLufs".to_string());
        } else {
            s.card_order.push("instantLufs".to_string());
        }
    }
    if !s.mini_bar_metrics.iter().any(|m| m == "live")
        && s.mini_bar_metrics
            == vec![
                "tp".to_string(),
                "int".to_string(),
                "shrt".to_string(),
                "momn".to_string(),
                "lra".to_string(),
                "psr".to_string(),
            ]
    {
        s.mini_bar_metrics.insert(2, "live".to_string());
    }
    s
}

pub fn save_settings(s: &Settings) {
    let path = config_path();
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = fs::write(path, json);
    }
}
