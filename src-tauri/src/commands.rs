//! Tauri IPC commands and multi-window anchoring / magnetic edge-snapping.

use crate::audio_capture::{
    enumerate_audio_sessions, get_system_info as query_sys_info, list_output_devices, AudioSessionInfo, CaptureStatus,
    DeviceInfo, SystemInfo,
};
use crate::dsp::offline_analyzer::{self, OfflineResult};
use crate::lan_server::{LanInfo, LanMirrorServer};
use crate::settings::{save_settings, sync_autostart, Settings};
use base64::Engine as _;
use crossbeam_channel::Sender;
use parking_lot::Mutex;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State};

pub enum EngineCommand {
    Reset,
    ApplySettings(Settings),
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub capture_status: Mutex<CaptureStatus>,
    pub engine_tx: Sender<EngineCommand>,
    pub lan: Arc<LanMirrorServer>,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().clone()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Settings {
    {
        let mut guard = state.settings.lock();
        *guard = settings.clone();
    }
    save_settings(&settings);
    sync_autostart(settings.auto_start);
    let _ = state.engine_tx.send(EngineCommand::ApplySettings(settings.clone()));
    if let Some(win) = app.get_webview_window("inspector") {
        let _ = win.set_always_on_top(settings.pinned);
    }
    let _ = app.emit("settings-changed", &settings);
    settings
}

#[tauri::command]
pub fn reset_meters(app: AppHandle, state: State<'_, AppState>) {
    let _ = state.engine_tx.send(EngineCommand::Reset);
    let _ = app.emit("meters-reset", ());
}

#[tauri::command]
pub fn list_devices() -> Vec<DeviceInfo> {
    list_output_devices()
}

#[tauri::command]
pub fn list_audio_sessions() -> Vec<AudioSessionInfo> {
    enumerate_audio_sessions()
}

#[tauri::command]
pub fn get_capture_status(state: State<'_, AppState>) -> CaptureStatus {
    state.capture_status.lock().clone()
}

#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    query_sys_info()
}

#[tauri::command]
pub async fn analyze_file(path: String) -> Result<OfflineResult, String> {
    tauri::async_runtime::spawn_blocking(move || offline_analyzer::analyze_file(Path::new(&path)))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub fn save_file_bytes(path: String, base64: String) -> Result<(), String> {
    let payload = base64
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(base64.as_str());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("Invalid base64 payload: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub fn start_lan_server(state: State<'_, AppState>) -> LanInfo {
    state.lan.start()
}

#[tauri::command]
pub fn stop_lan_server(state: State<'_, AppState>) -> LanInfo {
    state.lan.stop()
}

#[tauri::command]
pub fn get_lan_info(state: State<'_, AppState>) -> LanInfo {
    state.lan.info()
}

/// Anchors the Inspector window directly below (or above, if near the bottom
/// taskbar) the Mini-Bar pill, clamped to the current monitor bounds.
pub fn anchor_inspector_to_minibar(app: &AppHandle) {
    let (Some(mini), Some(insp)) = (
        app.get_webview_window("minibar"),
        app.get_webview_window("inspector"),
    ) else {
        return;
    };
    let (Ok(mini_pos), Ok(mini_size), Ok(insp_size)) = (
        mini.outer_position(),
        mini.outer_size(),
        insp.outer_size(),
    ) else {
        return;
    };

    let mon = mini.current_monitor().ok().flatten();
    let (mon_x, mon_y, mon_w, mon_h) = if let Some(m) = mon {
        let p = m.position();
        let s = m.size();
        (p.x, p.y, s.width as i32, s.height as i32)
    } else {
        (0, 0, 1920, 1080)
    };

    let gap = 6;
    let mut x = mini_pos.x + (mini_size.width as i32 - insp_size.width as i32) / 2;
    x = x.clamp(mon_x + 8, (mon_x + mon_w - insp_size.width as i32 - 8).max(mon_x + 8));

    let below_y = mini_pos.y + mini_size.height as i32 + gap;
    let above_y = mini_pos.y - insp_size.height as i32 - gap;
    let y = if below_y + (insp_size.height as i32) <= mon_y + mon_h - 40 {
        below_y
    } else {
        above_y.max(mon_y + 8)
    };

    let _ = insp.set_position(PhysicalPosition::new(x, y));
}

#[tauri::command]
pub fn toggle_inspector(app: AppHandle, state: State<'_, AppState>) -> bool {
    let Some(insp) = app.get_webview_window("inspector") else {
        return false;
    };
    let vis = insp.is_visible().unwrap_or(false);
    if vis {
        let _ = insp.hide();
        let _ = app.emit("inspector-visibility", false);
        false
    } else {
        anchor_inspector_to_minibar(&app);
        let pinned = state.settings.lock().pinned;
        let _ = insp.set_always_on_top(pinned);
        let _ = insp.show();
        let _ = insp.set_focus();
        let _ = app.emit("inspector-visibility", true);
        true
    }
}

#[tauri::command]
pub fn show_inspector(app: AppHandle, state: State<'_, AppState>) {
    if let Some(insp) = app.get_webview_window("inspector") {
        anchor_inspector_to_minibar(&app);
        let pinned = state.settings.lock().pinned;
        let _ = insp.set_always_on_top(pinned);
        let _ = insp.show();
        let _ = insp.set_focus();
        let _ = app.emit("inspector-visibility", true);
    }
}

#[tauri::command]
pub fn hide_inspector(app: AppHandle) {
    if let Some(insp) = app.get_webview_window("inspector") {
        let _ = insp.hide();
        let _ = app.emit("inspector-visibility", false);
    }
}

#[tauri::command]
pub fn set_pinned(app: AppHandle, state: State<'_, AppState>, pinned: bool) {
    {
        let mut s = state.settings.lock();
        s.pinned = pinned;
        save_settings(&s);
    }
    if let Some(insp) = app.get_webview_window("inspector") {
        let _ = insp.set_always_on_top(pinned);
    }
    let current = state.settings.lock().clone();
    let _ = app.emit("settings-changed", &current);
}

/// Magnetic edge-snapping for the Mini-Bar: snaps to top screen edge, bottom
/// taskbar edge (48px reserve), or left/right edges when dragged within 22 px.
#[tauri::command]
pub fn snap_minibar(app: AppHandle) {
    let Some(mini) = app.get_webview_window("minibar") else {
        return;
    };
    let (Ok(pos), Ok(size)) = (mini.outer_position(), mini.outer_size()) else {
        return;
    };
    let Some(mon) = mini.current_monitor().ok().flatten() else {
        return;
    };
    let mp = mon.position();
    let ms = mon.size();
    let mon_x = mp.x;
    let mon_y = mp.y;
    let mon_w = ms.width as i32;
    let mon_h = ms.height as i32;
    let w = size.width as i32;
    let h = size.height as i32;
    let snap = 22;
    let taskbar_reserve = 48;

    let mut x = pos.x.clamp(mon_x, (mon_x + mon_w - w).max(mon_x));
    let mut y = pos.y.clamp(mon_y, (mon_y + mon_h - h).max(mon_y));

    if (y - mon_y).abs() <= snap {
        y = mon_y;
    } else if ((mon_y + mon_h - taskbar_reserve - h) - y).abs() <= snap {
        y = mon_y + mon_h - taskbar_reserve - h;
    } else if ((mon_y + mon_h - h) - y).abs() <= snap {
        y = mon_y + mon_h - h;
    }

    if (x - mon_x).abs() <= snap {
        x = mon_x + 6;
    } else if ((mon_x + mon_w - w) - x).abs() <= snap {
        x = mon_x + mon_w - w - 6;
    }

    if x != pos.x || y != pos.y {
        let _ = mini.set_position(PhysicalPosition::new(x, y));
    }
}

#[tauri::command]
pub fn set_minibar_width(app: AppHandle, width: f64) {
    let Some(mini) = app.get_webview_window("minibar") else {
        return;
    };
    let w = width.clamp(120.0, 960.0);
    let _ = mini.set_size(LogicalSize::new(w, 28.0));
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
