// ─────────────────────────────────────────────────────────────────────────────
// Shared IPC contract between the Rust engine (src-tauri) and the React UI.
// Every interface here mirrors a serde struct (camelCase) in src-tauri/src.
// Loudness values are `null` when undefined (−∞ / not yet measurable).
// ─────────────────────────────────────────────────────────────────────────────

export type ThemeName = "dark" | "color" | "light";
export type MiniBarTextColor = "auto" | "white" | "black" | "green" | "orange" | "cyan";
export type MiniMetric = "tp" | "int" | "shrt" | "momn" | "lra" | "psr" | "plr";
export type HoldMode = "max" | "live";
export type Ballistics = "fast" | "slow";
export type GraphSpan = 5 | 10 | 30 | 60;
export type SilenceReset = 0 | 3 | 5 | 10 | 30; // 0 = never
export type InputSource = "wasapi" | "ipc";
export type TargetId = "spotify" | "apple" | "youtube" | "ebu" | "netflix" | "custom";
export type CardId = "truePeak" | "integrated" | "instantLufs" | "shortTerm" | "momentary" | "lra" | "psr";
export type SectionId = "cards" | "graph" | "phase";

export interface AlertSettings {
  clipping: boolean;
  overCompression: boolean;
  phase: boolean;
}

export interface Settings {
  theme: ThemeName;
  miniBarTextColor: MiniBarTextColor;
  miniBarMetrics: MiniMetric[]; // ordered, visible metrics in the Mini-Bar
  holdMode: HoldMode; // Short-Term / Momentary cards: max hold or live instant
  showPlr: boolean; // PSR card shows PLR instead
  target: TargetId;
  customTarget: number; // LUFS, default −8.0
  graphSpan: GraphSpan;
  ballistics: Ballistics;
  tpCeiling: number; // dBTP, default 0.0
  alerts: AlertSettings;
  silenceReset: SilenceReset;
  inputSource: InputSource;
  deviceId: string | null; // null = Automatic (follow default output)
  channelPair: number; // 0 = Out 1-2, 1 = Out 3-4, ...
  ignoredApps: string[]; // lower-case executable names, e.g. "discord.exe"
  cardOrder: CardId[];
  sectionOrder: SectionId[];
  pinned: boolean;
}

export interface GraphPoint {
  /** Monotonic 100 ms step index since the last reset. */
  t: number;
  /** Loudness of this single 100 ms block (LUFS). */
  l: number | null;
  /** Momentary (400 ms) loudness at this step. */
  m: number | null;
  /** Short-term (3 s) loudness at this step. */
  s: number | null;
}

export type CaptureMode = "endpointLoopback" | "processExclude" | "processInclude" | "ipcBridge" | "none";

export interface Telemetry {
  seq: number;
  captureMode: CaptureMode;
  deviceName: string;
  sampleRate: number;
  /** True while the signal is above −70 dBFS. Drives accent-vs-gray dimming. */
  active: boolean;
  elapsed: number; // seconds of audio measured since last reset
  tpMax: number | null; // dBTP max hold
  tpCurrent: number | null; // dBTP over the last 3 s (used by PSR)
  clipCount: number;
  integrated: number | null;
  momentary: number | null;
  momentaryMax: number | null;
  shortTerm: number | null;
  shortTermMax: number | null;
  lra: number | null; // LU
  psr: number | null; // LU, tpCurrent − shortTerm
  plr: number | null; // LU, tpMax − integrated
  correlation: number; // −1 … +1 smoothed broadband
  /** Per-band spectral correlation (−1 … +1), aligned to SPECTRAL_BANDS_HZ. */
  spectral: number[];
  /** New 100 ms graph points produced since the previous telemetry frame. */
  graph: GraphPoint[];
  status: string | null; // human-readable capture warning/error
}

export interface DeviceInfo {
  id: string;
  name: string;
  channels: number;
  sampleRate: number;
  isDefault: boolean;
}

export interface AudioSessionInfo {
  pid: number;
  exeName: string; // lower-case, e.g. "chrome.exe"
  displayName: string; // e.g. "Google Chrome"
  icon: string | null; // data:image/png;base64,…
  active: boolean; // currently rendering audio
}

export interface SystemInfo {
  windowsBuild: number;
  processLoopbackSupported: boolean; // Windows build ≥ 20348
  appVersion: string;
}

export interface CaptureStatus {
  mode: CaptureMode;
  deviceName: string;
  sampleRate: number;
  message: string | null;
}

export interface PlatformResult {
  id: string;
  name: string;
  targetLufs: number;
  tpCeiling: number;
  delta: number; // integrated − target (positive = over)
  gain: number; // effective playback gain applied by the platform (dB)
  resultingLufs: number;
  resultingTp: number;
  status: "green" | "yellow" | "red";
  note: string;
}

export interface OfflineContourPoint {
  t: number; // seconds
  m: number | null;
  s: number | null;
}

export interface OfflineResult {
  path: string;
  fileName: string;
  format: string;
  sampleRate: number;
  channels: number;
  duration: number; // seconds
  integrated: number | null;
  tpMax: number | null;
  samplePeak: number | null;
  shortTermMax: number | null;
  momentaryMax: number | null;
  lra: number | null;
  psr: number | null;
  plr: number | null;
  correlation: number;
  contour: OfflineContourPoint[];
  platforms: PlatformResult[];
  decodeMs: number;
  analysisMs: number;
}

export interface LanInfo {
  running: boolean;
  url: string; // http://<ip>:9876/
  wsUrl: string; // ws://<ip>:9876/ws
  ip: string;
  port: number;
  clients: number;
}

/** Event names emitted by the Rust side. */
export const EVENTS = {
  telemetry: "telemetry",
  settingsChanged: "settings-changed",
  captureStatus: "capture-status",
  metersReset: "meters-reset",
  inspectorVisibility: "inspector-visibility",
  sessionsChanged: "sessions-changed",
} as const;

/** ISO 1/3-octave band centres used by the spectral phase correlation (31 bands). */
export const SPECTRAL_BANDS_HZ: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

export interface TargetPreset {
  id: TargetId;
  label: string;
  lufs: number;
}

export const TARGET_PRESETS: readonly TargetPreset[] = [
  { id: "spotify", label: "Spotify", lufs: -14 },
  { id: "apple", label: "Apple", lufs: -16 },
  { id: "youtube", label: "YouTube", lufs: -14 },
  { id: "ebu", label: "EBU R128", lufs: -23 },
  { id: "netflix", label: "Netflix", lufs: -27 },
  { id: "custom", label: "My Target", lufs: -8 },
];

export function targetLufs(settings: Pick<Settings, "target" | "customTarget">): number {
  if (settings.target === "custom") return settings.customTarget;
  return TARGET_PRESETS.find((p) => p.id === settings.target)?.lufs ?? -14;
}

export function targetLabel(settings: Pick<Settings, "target" | "customTarget">): string {
  return TARGET_PRESETS.find((p) => p.id === settings.target)?.label ?? "Target";
}
