import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AudioSessionInfo,
  CaptureStatus,
  DeviceInfo,
  LanInfo,
  OfflineResult,
  Settings,
  SystemInfo,
  Telemetry,
} from "./types";
import { EVENTS } from "./types";

/** Typed wrappers around every `#[tauri::command]` exposed by src-tauri/src/commands.rs. */
export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  /** Persists settings, re-configures capture/engine as required and broadcasts `settings-changed`. */
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  resetMeters: () => invoke<void>("reset_meters"),
  listDevices: () => invoke<DeviceInfo[]>("list_devices"),
  listAudioSessions: () => invoke<AudioSessionInfo[]>("list_audio_sessions"),
  getCaptureStatus: () => invoke<CaptureStatus>("get_capture_status"),
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),
  analyzeFile: (path: string) => invoke<OfflineResult>("analyze_file", { path }),
  /** Writes base64-encoded bytes (no data: prefix) to an absolute path. */
  saveFileBytes: (path: string, base64: string) => invoke<void>("save_file_bytes", { path, base64 }),
  startLanServer: () => invoke<LanInfo>("start_lan_server"),
  stopLanServer: () => invoke<LanInfo>("stop_lan_server"),
  getLanInfo: () => invoke<LanInfo>("get_lan_info"),
  /** Shows/hides the inspector anchored to the Mini-Bar. Returns the new visibility. */
  toggleInspector: () => invoke<boolean>("toggle_inspector"),
  showInspector: () => invoke<void>("show_inspector"),
  hideInspector: () => invoke<void>("hide_inspector"),
  setPinned: (pinned: boolean) => invoke<void>("set_pinned", { pinned }),
  /** Re-applies magnetic edge snapping to the Mini-Bar after a drag. */
  snapMiniBar: () => invoke<void>("snap_minibar"),
  /** Resizes the Mini-Bar to the given logical width (height fixed at 28 px). */
  setMiniBarWidth: (width: number) => invoke<void>("set_minibar_width", { width }),
  quitApp: () => invoke<void>("quit_app"),
};

export const events = {
  onTelemetry: (cb: (t: Telemetry) => void): Promise<UnlistenFn> =>
    listen<Telemetry>(EVENTS.telemetry, (e) => cb(e.payload)),
  onSettingsChanged: (cb: (s: Settings) => void): Promise<UnlistenFn> =>
    listen<Settings>(EVENTS.settingsChanged, (e) => cb(e.payload)),
  onCaptureStatus: (cb: (s: CaptureStatus) => void): Promise<UnlistenFn> =>
    listen<CaptureStatus>(EVENTS.captureStatus, (e) => cb(e.payload)),
  onMetersReset: (cb: () => void): Promise<UnlistenFn> => listen<null>(EVENTS.metersReset, () => cb()),
  onInspectorVisibility: (cb: (visible: boolean) => void): Promise<UnlistenFn> =>
    listen<boolean>(EVENTS.inspectorVisibility, (e) => cb(e.payload)),
};
