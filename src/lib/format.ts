/** Display helpers. All numeric output uses an ASCII hyphen-minus for negatives. */

export const DASH = "—";

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** One-decimal number with negative-zero normalised. */
function fixed1(v: number): string {
  const s = v.toFixed(1);
  return s === "-0.0" ? "0.0" : s;
}

/** LUFS / dBTP / LU value with one decimal; `null` / −∞ render as an em dash. */
export function fmtLufs(v: number | null | undefined): string {
  return finite(v) ? fixed1(v) : DASH;
}

/** True Peak in dBTP: includes an explicit '+' when above 0.0 dBTP (e.g. "+1.0"). */
export function fmtPeak(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const s = fixed1(v);
  return v > 0 && s !== "0.0" ? `+${s}` : s;
}

/** Same as fmtLufs, with unit suffix when defined. */
export function fmtUnit(v: number | null | undefined, unit: string): string {
  return finite(v) ? `${fixed1(v)} ${unit}` : DASH;
}

/** Signed delta: "+5.2", "-1.1", "0.0". */
export function fmtSigned(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const s = fixed1(v);
  return v > 0 && s !== "0.0" ? `+${s}` : s;
}

/** Signed delta with unit: "+5.2 LU". */
export function fmtDelta(v: number | null | undefined, unit = "LU"): string {
  return finite(v) ? `${fmtSigned(v)} ${unit}` : DASH;
}

/** Correlation with explicit sign and two decimals: "+0.87". */
export function fmtCorr(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const c = Math.max(-1, Math.min(1, v));
  const s = c.toFixed(2);
  if (s === "-0.00" || s === "0.00") return "0.00";
  return c > 0 ? `+${s}` : s;
}

/** "48.000 kHz". */
export function fmtSampleRate(sr: number | null | undefined): string {
  if (!finite(sr) || sr <= 0) return DASH;
  return `${(sr / 1000).toFixed(3)} kHz`;
}

/** mm:ss (or h:mm:ss for long durations). */
export function fmtDuration(sec: number | null | undefined): string {
  if (!finite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-10-22 11:25". */
export function fmtDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "20261022-112530" for file names. */
export function fmtFileStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** Target delta in words: "+5.2 over", "-1.1 under", "on target". */
export function fmtDeltaWords(delta: number): string {
  if (!Number.isFinite(delta)) return DASH;
  if (Math.abs(delta) < 0.05) return "on target";
  return delta > 0 ? `${fmtSigned(delta)} over` : `${fmtSigned(delta)} under`;
}
