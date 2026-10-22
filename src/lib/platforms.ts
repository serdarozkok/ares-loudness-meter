import type { PlatformResult } from "./types";

export type GainPolicy = "peakLimited" | "never" | "compliance";

export interface PlatformSpec {
  id: string;
  name: string;
  targetLufs: number;
  tpCeiling: number;
  policy: GainPolicy;
}

/** Streaming / broadcast normalisation rules (mirrors the backend implementation). */
export const PLATFORMS: readonly PlatformSpec[] = [
  { id: "spotify", name: "Spotify", targetLufs: -14, tpCeiling: -1, policy: "peakLimited" },
  { id: "apple", name: "Apple Music", targetLufs: -16, tpCeiling: -1, policy: "peakLimited" },
  { id: "youtube", name: "YouTube", targetLufs: -14, tpCeiling: -1, policy: "never" },
  { id: "amazon", name: "Amazon Music", targetLufs: -14, tpCeiling: -2, policy: "never" },
  { id: "tidal", name: "Tidal", targetLufs: -14, tpCeiling: -1, policy: "never" },
  { id: "deezer", name: "Deezer", targetLufs: -15, tpCeiling: -1, policy: "never" },
  { id: "ebu", name: "EBU R128", targetLufs: -23, tpCeiling: -1, policy: "compliance" },
  { id: "netflix", name: "Netflix", targetLufs: -27, tpCeiling: -2, policy: "compliance" },
];

const r1 = (v: number) => Math.round(v * 10) / 10;

function abs1(v: number): string {
  return Math.abs(v).toFixed(1);
}

export function computePlatform(spec: PlatformSpec, integrated: number, tp: number | null): PlatformResult {
  const peak = tp !== null && Number.isFinite(tp) ? tp : Number.NEGATIVE_INFINITY;
  const delta = integrated - spec.targetLufs;
  const wanted = spec.targetLufs - integrated;
  let gain = wanted;
  let limited = false;

  if (spec.policy === "never" && gain > 0) {
    gain = 0;
  } else if (spec.policy === "peakLimited" && gain > 0) {
    const headroom = Math.max(0, spec.tpCeiling - peak);
    if (headroom < gain) {
      gain = headroom;
      limited = true;
    }
  }

  const resultingLufs = integrated + gain;
  const resultingTp = peak + gain;
  const tpOver = resultingTp > spec.tpCeiling;

  let status: PlatformResult["status"] = "green";
  if (tpOver || (spec.policy === "compliance" && Math.abs(delta) > 6)) {
    status = "red";
  } else if (Math.abs(resultingLufs - spec.targetLufs) > 1 || Math.abs(delta) > 1) {
    status = "yellow";
  }

  let note: string;
  if (spec.policy === "compliance") {
    note = Math.abs(delta) <= 1 ? "Compliant with delivery spec" : `Needs ${wanted > 0 ? "+" : "-"}${abs1(wanted)} dB to comply`;
  } else if (spec.policy === "never" && wanted > 0) {
    note = "Platform never turns up quiet tracks";
  } else if (limited) {
    note = gain > 0.05 ? `Boost limited by TP ceiling (+${abs1(gain)} dB)` : "Boost limited by TP ceiling";
  } else if (Math.abs(gain) < 0.05) {
    note = "No gain change";
  } else if (gain < 0) {
    note = `Turned down ${abs1(gain)} dB`;
  } else {
    note = `Turned up ${abs1(gain)} dB`;
  }
  if (tpOver) note += ` · TP exceeds ${spec.tpCeiling} dBTP`;

  return {
    id: spec.id,
    name: spec.name,
    targetLufs: spec.targetLufs,
    tpCeiling: spec.tpCeiling,
    delta: r1(delta),
    gain: r1(gain),
    resultingLufs: r1(resultingLufs),
    resultingTp: Number.isFinite(resultingTp) ? r1(resultingTp) : resultingTp,
    status,
    note,
  };
}

/** Platform rows for an integrated loudness / true-peak pair. Empty when loudness is undefined. */
export function computePlatforms(integrated: number | null, tp: number | null): PlatformResult[] {
  if (integrated === null || !Number.isFinite(integrated)) return [];
  return PLATFORMS.map((p) => computePlatform(p, integrated, tp));
}
