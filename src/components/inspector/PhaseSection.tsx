import { useEffect, useRef } from "react";
import { fmtCorr } from "../../lib/format";
import { SPECTRAL_BANDS_HZ, type Ballistics, type Settings, type Telemetry } from "../../lib/types";
import { updateSettings } from "../../state/settings";
import { telemetryRef } from "../../state/telemetry";
import { IconGrip } from "../icons";

interface Props {
  settings: Settings;
  telemetry: Telemetry | null;
  dragHandleProps?: Record<string, unknown>;
}

const FREQ_LABELS: ReadonlyArray<{ hz: number; text: string }> = [
  { hz: 50, text: "50Hz" },
  { hz: 100, text: "100Hz" },
  { hz: 200, text: "200Hz" },
  { hz: 500, text: "500Hz" },
  { hz: 1000, text: "1kHz" },
  { hz: 2000, text: "2kHz" },
  { hz: 5000, text: "5kHz" },
  { hz: 10000, text: "10kHz+" },
];

const LOG_MIN = Math.log10(20);
const LOG_MAX = Math.log10(20000);

function freqToX(hz: number, width: number): number {
  const t = (Math.log10(Math.max(20, Math.min(20000, hz))) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return t * width;
}

export function PhaseSection({ settings, telemetry, dragHandleProps }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const smoothedRef = useRef<Float32Array>(new Float32Array(SPECTRAL_BANDS_HZ.length));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let rafId = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext("2d");
      if (ctx && w > 0 && h > 0) {
        const styles = getComputedStyle(document.documentElement);
        const colGood = styles.getPropertyValue("--lm-graph").trim() || "#10b981";
        const colWarn = styles.getPropertyValue("--lm-warn").trim() || "#ef4444";
        const colGrid = styles.getPropertyValue("--lm-grid").trim() || "rgba(255,255,255,0.06)";
        const colGridText =
          styles.getPropertyValue("--lm-grid-text").trim() || "rgba(232,233,236,0.42)";

        ctx.clearRect(0, 0, w, h);

        const padTop = 8 * dpr;
        const padBottom = 18 * dpr;
        const plotH = Math.max(1, h - padTop - padBottom);
        const midY = padTop + plotH * 0.5;
        const yOf = (c: number) => midY - Math.max(-1, Math.min(1, c)) * (plotH * 0.45);

        // Horizontal reference lines (+1, 0, -1) and vertical log-frequency grid
        ctx.strokeStyle = colGrid;
        ctx.lineWidth = 1;
        for (const c of [1, 0, -1]) {
          const y = Math.round(yOf(c)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }

        ctx.font = `${Math.round(9 * dpr)}px "JetBrains Mono", Consolas, monospace`;
        ctx.fillStyle = colGridText;
        ctx.textAlign = "center";
        for (const f of FREQ_LABELS) {
          const x = Math.round(freqToX(f.hz, w)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, padTop);
          ctx.lineTo(x, padTop + plotH);
          ctx.stroke();
          ctx.fillText(f.text, Math.min(w - 18 * dpr, Math.max(14 * dpr, x)), h - 4 * dpr);
        }

        // Update smoothed spectral array from latest telemetry
        const live = telemetryRef.current;
        const raw = live?.spectral;
        const n = SPECTRAL_BANDS_HZ.length;
        const sm = smoothedRef.current;
        for (let i = 0; i < n; i++) {
          const target = raw && i < raw.length ? raw[i] : 0;
          sm[i] += (target - sm[i]) * 0.25;
        }

        const xs: number[] = new Array(n);
        const ys: number[] = new Array(n);
        for (let i = 0; i < n; i++) {
          xs[i] = freqToX(SPECTRAL_BANDS_HZ[i], w);
          ys[i] = yOf(sm[i]);
        }

        const buildCurvePath = () => {
          ctx.beginPath();
          ctx.moveTo(xs[0], ys[0]);
          for (let i = 0; i < n - 1; i++) {
            const mx = (xs[i] + xs[i + 1]) * 0.5;
            const my = (ys[i] + ys[i + 1]) * 0.5;
            ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
          }
          ctx.lineTo(xs[n - 1], ys[n - 1]);
        };

        // Positive region fill (above 0 line -> emerald)
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, midY);
        ctx.clip();
        buildCurvePath();
        ctx.lineTo(xs[n - 1], midY);
        ctx.lineTo(xs[0], midY);
        ctx.closePath();
        const posGrad = ctx.createLinearGradient(0, padTop, 0, midY);
        posGrad.addColorStop(0, "rgba(16, 185, 129, 0.34)");
        posGrad.addColorStop(1, "rgba(16, 185, 129, 0.03)");
        ctx.fillStyle = posGrad;
        ctx.fill();
        ctx.restore();

        // Negative region fill (below 0 line -> warning red)
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, midY, w, h - midY);
        ctx.clip();
        buildCurvePath();
        ctx.lineTo(xs[n - 1], midY);
        ctx.lineTo(xs[0], midY);
        ctx.closePath();
        const negGrad = ctx.createLinearGradient(0, midY, 0, padTop + plotH);
        negGrad.addColorStop(0, "rgba(239, 68, 68, 0.05)");
        negGrad.addColorStop(1, "rgba(239, 68, 68, 0.42)");
        ctx.fillStyle = negGrad;
        ctx.fill();
        ctx.restore();

        // Stroke positive curve in emerald, negative in red
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, w, midY);
        ctx.clip();
        buildCurvePath();
        ctx.strokeStyle = colGood;
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, midY, w, h - midY);
        ctx.clip();
        buildCurvePath();
        ctx.strokeStyle = colWarn;
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
        ctx.restore();
      }
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const corr = telemetry?.correlation ?? 0;
  const active = telemetry?.active ?? false;
  const phaseDanger = active && corr < -0.3;
  const corrColor = !active
    ? "text-inactive"
    : corr >= 0.3
      ? "text-good"
      : corr >= 0
        ? "text-amber"
        : "text-warn";

  const needlePct = Math.max(0, Math.min(100, ((corr + 1) / 2) * 100));

  return (
    <div
      className={`card overflow-hidden rounded-xl transition-shadow duration-300 ${
        phaseDanger
          ? "border-warn shadow-[0_0_18px_rgba(239,68,68,0.42)]"
          : ""
      }`}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1.5">
          {dragHandleProps && (
            <button
              type="button"
              aria-label="Drag section"
              title="Drag to reorder section"
              {...dragHandleProps}
              className="text-muted/45 hover:text-fg active:cursor-grabbing"
            >
              <IconGrip className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="text-[10px] font-bold tracking-wider text-muted uppercase">
            STEREO & SPECTRAL PHASE CORRELATION
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md bg-surface2 p-0.5 text-[10px] font-semibold">
            {(["fast", "slow"] as Ballistics[]).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => updateSettings({ ballistics: b })}
                className={`rounded px-1.5 py-0.5 uppercase transition-colors ${
                  settings.ballistics === b ? "bg-surface text-fg shadow-xs" : "text-muted hover:text-fg"
                }`}
              >
                {b}
              </button>
            ))}
          </div>
          <span className={`num text-base font-extrabold ${corrColor}`}>{fmtCorr(corr)}</span>
        </div>
      </div>

      {/* Broadband correlation bar (-1 ... 0 ... +1) */}
      <div className="px-3 pb-2">
        <div className="relative h-2 w-full rounded-full bg-surface2">
          <div className="absolute top-0 bottom-0 left-1/2 w-[1px] bg-muted/40" />
          <div
            style={{
              left: `${Math.min(50, needlePct)}%`,
              width: `${Math.abs(needlePct - 50)}%`,
            }}
            className={`absolute top-0 bottom-0 rounded-full transition-all duration-100 ${
              corr < 0 ? "bg-warn" : "bg-good"
            }`}
          />
          <div
            style={{ left: `calc(${needlePct}% - 4px)` }}
            className="absolute -top-0.5 h-3 w-2 rounded-xs bg-fg shadow"
          />
        </div>
        <div className="num mt-1 flex justify-between text-[9px] text-muted/75">
          <span>-1.00 (OUT OF PHASE)</span>
          <span>0.00</span>
          <span>+1.00 (MONO)</span>
        </div>
      </div>

      {/* Edge-to-Edge Spectral Phase Correlation Curve (20Hz - 20kHz log axis) */}
      <canvas ref={canvasRef} className="block h-[112px] w-full border-t border-line bg-bg/55" />
    </div>
  );
}
