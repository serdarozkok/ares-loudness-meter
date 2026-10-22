import {
  fmtCorr,
  fmtDeltaWords,
  fmtDuration,
  fmtLufs,
  fmtSampleRate,
  fmtSigned,
} from "../../lib/format";
import { targetLabel, targetLufs, type OfflineContourPoint, type OfflineResult, type Settings } from "../../lib/types";
import { useOffline } from "../../state/offline";

interface Props {
  result: OfflineResult;
  settings: Settings;
}

function buildContourSvgPath(
  pts: OfflineContourPoint[],
  pick: (p: OfflineContourPoint) => number | null,
  w: number,
  h: number,
  yMin: number,
  yMax: number,
): string {
  if (pts.length === 0) return "";
  const n = pts.length;
  const parts: string[] = [];
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = pick(pts[i]);
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = n === 1 ? w * 0.5 : (i / (n - 1)) * w;
    const clamped = Math.max(yMin, Math.min(yMax, v));
    const y = h - ((clamped - yMin) / (yMax - yMin)) * (h - 20) - 10;
    parts.push(`${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`);
    pen = true;
  }
  return parts.join(" ");
}

export function OfflineView({ result, settings }: Props) {
  const clear = useOffline((s) => s.clear);
  const tgtLufs = targetLufs(settings);
  const tgtName = targetLabel(settings);

  const svgW = 340;
  const svgH = 120;
  const yMin = -42;
  const yMax = 0;
  const stPath = buildContourSvgPath(result.contour, (p) => p.s ?? p.m, svgW, svgH, yMin, yMax);
  const mPath = buildContourSvgPath(result.contour, (p) => p.m, svgW, svgH, yMin, yMax);
  const tgtY =
    svgH - ((Math.max(yMin, Math.min(yMax, tgtLufs)) - yMin) / (yMax - yMin)) * (svgH - 20) - 10;

  return (
    <div className="lm-fade-in flex flex-col gap-2.5">
      {/* File Info Banner */}
      <div className="card rounded-xl p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold text-fg" title={result.path}>
              {result.fileName}
            </div>
            <div className="num mt-0.5 text-[11px] text-muted">
              {result.format} · {fmtSampleRate(result.sampleRate)} · {result.channels} ch ·{" "}
              {fmtDuration(result.duration)}
            </div>
            <div className="num mt-0.5 text-[10px] text-good">
              Analyzed in {result.decodeMs + result.analysisMs} ms (decode {result.decodeMs} ms · DSP{" "}
              {result.analysisMs} ms)
            </div>
          </div>
          <button
            type="button"
            onClick={clear}
            className="shrink-0 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11px] font-bold text-fg hover:border-graph/50 hover:text-graph"
          >
            Back to Live
          </button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 gap-2">
        <div className="card rounded-xl p-2.5">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">INTEGRATED</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="num text-[24px] leading-none font-extrabold text-lufs">
              {fmtLufs(result.integrated)}
            </span>
            <span className="text-xs font-semibold text-muted">LUFS</span>
          </div>
        </div>

        <div className="card rounded-xl p-2.5">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">TRUE PEAK MAX</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="num text-[24px] leading-none font-extrabold text-tp">
              {fmtLufs(result.tpMax)}
            </span>
            <span className="text-xs font-semibold text-muted">dBTP</span>
          </div>
        </div>

        <div className="card rounded-xl p-2.5">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">SHORT-TERM MAX</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="num text-[20px] leading-none font-extrabold text-lufs">
              {fmtLufs(result.shortTermMax)}
            </span>
            <span className="text-xs font-semibold text-muted">LUFS</span>
          </div>
        </div>

        <div className="card rounded-xl p-2.5">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">MOMENTARY MAX</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="num text-[20px] leading-none font-extrabold text-lufs">
              {fmtLufs(result.momentaryMax)}
            </span>
            <span className="text-xs font-semibold text-muted">LUFS</span>
          </div>
        </div>

        <div className="card rounded-xl p-2.5">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">LRA / CORR</div>
          <div className="num mt-1 text-[16px] font-extrabold text-graph">
            {fmtLufs(result.lra)} <span className="text-[11px] text-muted">LU</span> ·{" "}
            {fmtCorr(result.correlation)}
          </div>
        </div>

        <div className="card rounded-xl p-2.5">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">PSR / PLR</div>
          <div className="num mt-1 text-[16px] font-extrabold text-graph">
            {fmtLufs(result.psr)} <span className="text-[11px] text-muted">LU</span> /{" "}
            {fmtLufs(result.plr)} <span className="text-[11px] text-muted">LU</span>
          </div>
        </div>
      </div>

      {/* Full-Track Loudness Contour */}
      <div className="card overflow-hidden rounded-xl p-2.5">
        <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold tracking-wider text-muted uppercase">
          <span>FULL-TRACK LOUDNESS CONTOUR</span>
          <span>
            {tgtName} ({tgtLufs.toFixed(1)} LUFS)
          </span>
        </div>
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="block h-[120px] w-full rounded-lg bg-bg/60"
          preserveAspectRatio="none"
        >
          {[-6, -14, -23, -32].map((db) => {
            const y = svgH - ((db - yMin) / (yMax - yMin)) * (svgH - 20) - 10;
            return (
              <line
                key={db}
                x1={0}
                y1={y}
                x2={svgW}
                y2={y}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth={1}
              />
            );
          })}
          <line
            x1={0}
            y1={tgtY}
            x2={svgW}
            y2={tgtY}
            stroke="#10B981"
            strokeWidth={1.3}
            strokeDasharray="4 3"
          />
          {mPath && <path d={mPath} fill="none" stroke="rgba(16,185,129,0.45)" strokeWidth={1.2} />}
          {stPath && <path d={stPath} fill="none" stroke="#FF3B5C" strokeWidth={2} />}
        </svg>
      </div>

      {/* Platform Targets & Normalization Simulator Table */}
      <div className="card overflow-hidden rounded-xl p-2.5">
        <div className="mb-1.5 text-[10px] font-bold tracking-wider text-muted uppercase">
          PLATFORM TARGETS & NORMALIZATION SIMULATOR
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[11px]">
            <thead>
              <tr className="border-b border-line text-[10px] text-muted">
                <th className="py-1 pr-2">Platform</th>
                <th className="py-1 px-1.5">Target</th>
                <th className="py-1 px-1.5">Delta</th>
                <th className="py-1 px-1.5">Eff. Gain</th>
                <th className="py-1 pl-1.5 text-right">Result TP</th>
              </tr>
            </thead>
            <tbody>
              {result.platforms.map((p) => {
                const dot =
                  p.status === "green"
                    ? "bg-good"
                    : p.status === "yellow"
                      ? "bg-amber"
                      : "bg-warn";
                return (
                  <tr
                    key={p.id}
                    title={p.note}
                    className="border-b border-line/50 last:border-none hover:bg-surface2/40"
                  >
                    <td className="py-1.5 pr-2 font-semibold text-fg">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${dot}`} />
                        <span>{p.name}</span>
                      </span>
                    </td>
                    <td className="num py-1.5 px-1.5 text-muted">{p.targetLufs}</td>
                    <td className="num py-1.5 px-1.5 font-medium">{fmtDeltaWords(p.delta)}</td>
                    <td className="num py-1.5 px-1.5 font-bold text-graph">
                      {fmtSigned(p.gain)} dB
                    </td>
                    <td className="num py-1.5 pl-1.5 text-right font-semibold text-tp">
                      {Number.isFinite(p.resultingTp) ? `${p.resultingTp.toFixed(1)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
