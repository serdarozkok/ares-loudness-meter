//! Loudmeter Pro – Tauri v2 Core, High-Priority Real-Time Audio/DSP Thread,
//! System Tray, and Multi-Window Lifecycle Coordinator.

pub mod alerts;
pub mod audio_capture;
pub mod commands;
pub mod dsp;
pub mod ipc_bridge;
pub mod lan_server;
pub mod settings;

use alerts::AlertEngine;
#[cfg(windows)]
use audio_capture::AudioCaptureController;
use audio_capture::CaptureStatus;
use commands::{AppState, EngineCommand};
use crossbeam_channel::unbounded;
use dsp::{CaptureMode, DspProcessor};
use lan_server::LanMirrorServer;
use parking_lot::Mutex;
use settings::{load_settings, Settings};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition,
};

fn build_tray_icon() -> Image<'static> {
    let size = 32usize;
    let mut rgba = vec![0u8; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            let idx = (y * size + x) * 4;
            let cx = x as f32 - 15.5;
            let cy = y as f32 - 15.5;
            let r = (cx * cx + cy * cy).sqrt();
            if r <= 14.5 {
                // Sleek obsidian circle with emerald/coral meter bars
                let bar1 = (8..=11).contains(&x) && (12..=24).contains(&y);
                let bar2 = (14..=17).contains(&x) && (7..=24).contains(&y);
                let bar3 = (20..=23).contains(&x) && (10..=24).contains(&y);
                if bar2 {
                    rgba[idx] = 0xFF;
                    rgba[idx + 1] = 0x3B;
                    rgba[idx + 2] = 0x5C;
                    rgba[idx + 3] = 0xFF;
                } else if bar1 || bar3 {
                    rgba[idx] = 0x10;
                    rgba[idx + 1] = 0xB9;
                    rgba[idx + 2] = 0x81;
                    rgba[idx + 3] = 0xFF;
                } else {
                    rgba[idx] = 0x18;
                    rgba[idx + 1] = 0x1A;
                    rgba[idx + 2] = 0x20;
                    rgba[idx + 3] = 0xFF;
                }
            }
        }
    }
    Image::new_owned(rgba, size as u32, size as u32)
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "toggle", "Toggle Inspector Panel", true, None::<&str>)?;
    let reset_item = MenuItem::with_id(app, "reset", "Reset All Meters", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit ARES Loudness Meter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &reset_item, &quit_item])?;

    let _ = TrayIconBuilder::new()
        .icon(build_tray_icon())
        .tooltip("ARES Loudness Meter · Real-Time Loudness & Phase Meter")
        .menu(&menu)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "toggle" => {
                if let Some(state) = app.try_state::<AppState>() {
                    commands::toggle_inspector(app.clone(), state);
                }
            }
            "reset" => {
                if let Some(state) = app.try_state::<AppState>() {
                    commands::reset_meters(app.clone(), state);
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                let app = tray.app_handle();
                if let Some(state) = app.try_state::<AppState>() {
                    commands::toggle_inspector(app.clone(), state);
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn spawn_minibar_window(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(350));
        if app.get_webview_window("minibar").is_none() {
            let _ = tauri::WebviewWindowBuilder::new(
                &app,
                "minibar",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("ARES Loudness Meter Mini-Bar")
            .inner_size(460.0, 28.0)
            .min_inner_size(120.0, 28.0)
            .max_inner_size(960.0, 28.0)
            .decorations(false)
            .shadow(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .focused(false)
            .visible(true)
            .build();
        }
        if let Some(mini) = app.get_webview_window("minibar") {
            let _ = mini.show();
            let _ = mini.set_always_on_top(true);
            if let (Ok(size), Some(mon)) = (mini.outer_size(), mini.current_monitor().ok().flatten()) {
                let mp = mon.position();
                let ms = mon.size();
                let x = mp.x + (ms.width as i32 - size.width as i32) / 2;
                let y = mp.y + 4;
                let _ = mini.set_position(PhysicalPosition::new(x, y));
            }
        }
    });
}

#[cfg(windows)]
fn elevate_audio_thread_priority() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
    };
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

#[cfg(not(windows))]
fn elevate_audio_thread_priority() {}

fn spawn_audio_dsp_engine(
    app: AppHandle,
    initial_settings: Settings,
    cmd_rx: crossbeam_channel::Receiver<EngineCommand>,
    lan: Arc<LanMirrorServer>,
) {
    std::thread::Builder::new()
        .name("loudmeter-dsp-engine".into())
        .spawn(move || {
            elevate_audio_thread_priority();

            let mut settings = initial_settings;
            #[cfg(windows)]
            let mut capture = AudioCaptureController::new(
                settings.input_source.clone(),
                settings.device_id.clone(),
                settings.channel_pair,
                settings.ignored_apps.clone(),
            );
            #[cfg(windows)]
            let initial_sr = capture.status().sample_rate;
            #[cfg(not(windows))]
            let initial_sr = 48_000u32;

            let mut dsp = DspProcessor::new(
                initial_sr,
                settings.ballistics_enum(),
                settings.tp_ceiling,
                settings.silence_reset,
            );
            let mut alerts = AlertEngine::new();
            #[cfg(windows)]
            let mut stereo_buf: Vec<f32> = Vec::with_capacity(4096);
            let mut last_emit = Instant::now();
            let mut last_status_sig = String::new();
            let emit_interval = Duration::from_micros(16_667); // 60 fps

            loop {
                while let Ok(cmd) = cmd_rx.try_recv() {
                    match cmd {
                        EngineCommand::Reset => {
                            dsp.reset();
                            alerts.reset();
                        }
                        EngineCommand::ApplySettings(new_s) => {
                            dsp.set_ballistics(new_s.ballistics_enum());
                            dsp.set_tp_ceiling_db(new_s.tp_ceiling);
                            dsp.set_silence_reset(new_s.silence_reset);
                            #[cfg(windows)]
                            capture.apply_config(
                                new_s.input_source.clone(),
                                new_s.device_id.clone(),
                                new_s.channel_pair,
                                new_s.ignored_apps.clone(),
                            );
                            settings = new_s;
                        }
                    }
                }

                #[cfg(windows)]
                {
                    capture.periodic_maintenance();
                    let st = capture.status();
                    if st.sample_rate > 0 {
                        dsp.set_sample_rate(st.sample_rate);
                    }
                    capture.read_stereo(&mut stereo_buf);
                    if !stereo_buf.is_empty() && dsp.process_interleaved(&stereo_buf) {
                        alerts.reset();
                        let _ = app.emit("meters-reset", ());
                    }
                }

                if last_emit.elapsed() >= emit_interval {
                    last_emit = Instant::now();
                    #[cfg(windows)]
                    let st = capture.status();
                    #[cfg(not(windows))]
                    let st = CaptureStatus {
                        mode: CaptureMode::None,
                        device_name: "CoreAudio / System Audio".into(),
                        sample_rate: 48_000,
                        message: None,
                    };

                    let sig = format!("{:?}:{}:{}:{:?}", st.mode, st.device_name, st.sample_rate, st.message);
                    if sig != last_status_sig {
                        last_status_sig = sig;
                        if let Some(state) = app.try_state::<AppState>() {
                            *state.capture_status.lock() = st.clone();
                        }
                        let _ = app.emit("capture-status", &st);
                    }

                    let telemetry = dsp.snapshot(st.mode, st.device_name, st.message);
                    alerts.evaluate(&app, &telemetry, &settings.alerts, settings.tp_ceiling);
                    if let Ok(json) = serde_json::to_string(&telemetry) {
                        lan.broadcast_telemetry(json);
                    }
                    let _ = app.emit("telemetry", &telemetry);
                }

                std::thread::sleep(Duration::from_millis(4));
            }
        })
        .expect("Failed to spawn real-time audio/DSP thread");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(appdata) = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("APPDATA")) {
        let wv_dir = std::path::PathBuf::from(appdata).join("LoudmeterPro").join("WebView2");
        let _ = std::fs::create_dir_all(&wv_dir);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &wv_dir);
    }

    let initial_settings = load_settings();
    settings::sync_autostart(initial_settings.auto_start);
    let (engine_tx, engine_rx) = unbounded();
    let lan = Arc::new(LanMirrorServer::new());

    let app_state = AppState {
        settings: Mutex::new(initial_settings.clone()),
        capture_status: Mutex::new(CaptureStatus {
            mode: CaptureMode::EndpointLoopback,
            device_name: "Default Output".to_string(),
            sample_rate: 48_000,
            message: None,
        }),
        engine_tx,
        lan: lan.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = setup_tray(&handle);
            spawn_minibar_window(handle.clone());
            spawn_audio_dsp_engine(handle, initial_settings, engine_rx, lan);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::reset_meters,
            commands::list_devices,
            commands::list_audio_sessions,
            commands::get_capture_status,
            commands::get_system_info,
            commands::analyze_file,
            commands::save_file_bytes,
            commands::start_lan_server,
            commands::stop_lan_server,
            commands::get_lan_info,
            commands::toggle_inspector,
            commands::show_inspector,
            commands::hide_inspector,
            commands::set_pinned,
            commands::snap_minibar,
            commands::set_minibar_width,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Loudmeter Pro");
}
