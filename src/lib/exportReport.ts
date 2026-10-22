import { toPng } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "./ipc";
import { isTauri } from "./env";
import { fmtCorr, fmtDateTime, fmtDelta, fmtDuration, fmtFileStamp, fmtLufs, fmtSampleRate } from "./format";
import { computePlatforms } from "./platforms";
import { targetLabel, targetLufs, type OfflineResult, type Settings, type Telemetry } from "./types";
import { graphRing } from "../state/telemetry";
import type { SessionReportData } from "../components/report/SessionReportCard";
import { pushToast } from "../components/Toast";

export function buildReportData(
  settings: Settings,
  telemetry: Telemetry | null,
  offline: OfflineResult | null,
): SessionReportData {
  const now = new Date();
  const tgtName = targetLabel(settings);
  const tgtLufs = targetLufs(settings);

  if (offline) {
    return {
      title: offline.fileName,
      subtitle: `Offline Analysis · ${offline.format} · ${fmtSampleRate(offline.sampleRate)} · ${offline.channels} ch · ${fmtDuration(offline.duration)}`,
      timestamp: now,
      integrated: offline.integrated,
      tpMax: offline.tpMax,
      shortTermMax: offline.shortTermMax,
      momentaryMax: offline.momentaryMax,
      lra: offline.lra,
      psr: offline.psr,
      plr: offline.plr,
      correlation: offline.correlation,
      targetName: tgtName,
      targetLufs: tgtLufs,
      contour: offline.contour,
      platforms: offline.platforms,
    };
  }

  const pts = graphRing.toPoints();
  const integ = telemetry?.integrated ?? null;
  const tp = telemetry?.tpMax ?? null;
  return {
    title: `Live Session · ${telemetry?.deviceName ?? "System Output"}`,
    subtitle: `${fmtSampleRate(telemetry?.sampleRate ?? 48000)} · Measured ${fmtDuration(telemetry?.elapsed ?? 0)}`,
    timestamp: now,
    integrated: integ,
    tpMax: tp,
    shortTermMax: telemetry?.shortTermMax ?? null,
    momentaryMax: telemetry?.momentaryMax ?? null,
    lra: telemetry?.lra ?? null,
    psr: telemetry?.psr ?? null,
    plr: telemetry?.plr ?? null,
    correlation: telemetry?.correlation ?? 0,
    targetName: tgtName,
    targetLufs: tgtLufs,
    contour: pts.map((p) => ({ t: p.t * 0.1, m: p.m, s: p.s })),
    platforms: computePlatforms(integ ?? -14, tp ?? -1),
  };
}

export function buildMarkdownSummary(
  settings: Settings,
  telemetry: Telemetry | null,
  offline: OfflineResult | null,
): string {
  const data = buildReportData(settings, telemetry, offline);
  const delta = data.integrated !== null ? data.integrated - data.targetLufs : null;
  return [
    `ARES LOUDNESS METER — Session Report (${fmtDateTime(data.timestamp)})`,
    `Source: ${data.title} (${data.subtitle})`,
    `Integrated: ${fmtLufs(data.integrated)} LUFS`,
    `True Peak (max): ${fmtLufs(data.tpMax)} dBTP`,
    `Short-Term Max: ${fmtLufs(data.shortTermMax)} LUFS`,
    `Momentary Max: ${fmtLufs(data.momentaryMax)} LUFS`,
    `LRA: ${fmtLufs(data.lra)} LU`,
    `PSR: ${fmtLufs(data.psr)} LU | PLR: ${fmtLufs(data.plr)} LU`,
    `Stereo Correlation: ${fmtCorr(data.correlation)}`,
    `Target: ${data.targetName} ${data.targetLufs.toFixed(1)} LUFS (${delta !== null ? `Δ ${fmtDelta(delta)}` : "—"})`,
  ].join("\n");
}

export async function copySummaryToClipboard(
  settings: Settings,
  telemetry: Telemetry | null,
  offline: OfflineResult | null,
): Promise<void> {
  const text = buildMarkdownSummary(settings, telemetry, offline);
  try {
    if (isTauri) {
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    pushToast("Copied session metrics to clipboard", "good");
  } catch (err) {
    console.error("Clipboard copy failed", err);
    pushToast("Failed to copy values to clipboard", "error");
  }
}

export async function exportSessionReportPng(cardElement: HTMLElement | null): Promise<void> {
  if (!cardElement) {
    pushToast("Report card is not ready", "error");
    return;
  }
  try {
    const dataUrl = await toPng(cardElement, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: "#111215",
    });
    const defaultName = `ARES-Loudness-Meter-Report-${fmtFileStamp(new Date())}.png`;

    if (!isTauri) {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = defaultName;
      a.click();
      pushToast(`Downloaded ${defaultName}`, "good");
      return;
    }

    const savePath = await save({
      defaultPath: defaultName,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (!savePath) return;

    const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    await api.saveFileBytes(savePath, base64);
    pushToast("Saved Session Report PNG", "good");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushToast(`Export PNG failed: ${msg}`, "error");
  }
}
