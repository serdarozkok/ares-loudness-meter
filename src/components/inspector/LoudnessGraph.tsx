import { useEffect, useRef, useState } from "react";
import {
  TARGET_PRESETS,
  targetLabel,
  targetLufs,
  type GraphSpan,
  type Settings,
  type TargetId,
} from "../../lib/types";
import { updateSettings } from "../../state/settings";
import { graphRing } from "../../state/telemetry";
import { IconGrip } from "../icons";

interface Props {
  settings: Settings;
  dragHandleProps?: Record<string, unknown>;
}

const SPANS: readonly GraphSpan[] = [5, 10, 30, 60];

export function LoudnessGraph({ settings, dragHandleProps }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rangeRef = useRef<{ min: number; max: number }>({ min: -36, max: 0 });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [editingCustom, setEditingCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState(() => settings.customTarget.toFixed(1));

  useEffect(() => {
    setCustomDraft(settings.customTarget.toFixed(1));
  }, [settings.customTarget]);

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
      const s = settingsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext("2d");
      if (ctx && w > 0 && h > 0) {
        const styles = getComputedStyle(document.documentElement);
        const colGraph = styles.getPropertyValue("--lm-graph").trim() || "#10b981";
        const colLufs = styles.getPropertyValue("--lm-lufs").trim() || "#ff3b5c";
        const colGrid = styles.getPropertyValue("--lm-grid").trim() || "rgba(255,255,255,0.06)";
        const colGridText =
          styles.getPropertyValue("--lm-grid-text").trim() || "rgba(232,233,236,0.4)";

        ctx.clearRect(0, 0, w, h);

        const spanSteps = s.graphSpan * 10; // 10 steps per second (100ms window)
        const count = graphRing.size;
        const lastT = graphRing.lastT;
        const elapsedSinceLast = Math.min(
          1.2,
          Math.max(0, (performance.now() - graphRing.lastPointArrival) / 100),
        );
        const nowT = count > 0 ? lastT + elapsedSinceLast : spanSteps;
        const minT = nowT - spanSteps;

        const tgt = targetLufs(s);
        let vMin = tgt - 4;
        let vMax = tgt + 4;

        for (let i = count - 1; i >= 0; i--) {
          const k = graphRing.index(i);
          const t = graphRing.t[k];
          if (t < minT - 2) break;
          for (const v of [graphRing.l[k], graphRing.s[k], graphRing.m[k]]) {
            if (!Number.isNaN(v) && v > -68) {
              if (v < vMin) vMin = v;
              if (v > vMax) vMax = v;
            }
          }
        }

        let targetMin = Math.max(-65, vMin - 3.5);
        let targetMax = Math.min(3, vMax + 2.5);
        if (targetMax - targetMin < 14) {
          const mid = (targetMax + targetMin) * 0.5;
          targetMin = mid - 7;
          targetMax = mid + 7;
        }

        // Smooth dynamic vertical scaling so quiet passages stay clearly visible
        rangeRef.current.min += (targetMin - rangeRef.current.min) * 0.08;
        rangeRef.current.max += (targetMax - rangeRef.current.max) * 0.08;
        const yMin = rangeRef.current.min;
        const yMax = rangeRef.current.max;
        const padTop = 8 * dpr;
        const padBottom = 8 * dpr;
        const plotH = Math.max(1, h - padTop - padBottom);

        const yOf = (lufs: number) =>
          padTop + (1 - (lufs - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;
        const xOf = (t: number) => ((t - minT) / spanSteps) * w;

        // Horizontal dB gridlines
        const stepDb = yMax - yMin > 28 ? 6 : 3;
        const firstGrid = Math.ceil(yMin / stepDb) * stepDb;
        ctx.lineWidth = 1;
        ctx.font = `${Math.round(9.5 * dpr)}px "JetBrains Mono", Consolas, monospace`;
        ctx.fillStyle = colGridText;
        ctx.strokeStyle = colGrid;

        for (let db = firstGrid; db <= yMax; db += stepDb) {
          const y = Math.round(yOf(db)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
          if (y > 12 * dpr && y < h - 6 * dpr) {
            ctx.fillText(`${db > 0 ? `+${db}` : db}`, 6 * dpr, y - 3 * dpr);
          }
        }

        // 1. Filled emerald 100 ms fast transient contour (`l`)
        if (count > 1) {
          let started = false;
          let firstX = 0;
          let lastX = 0;
          ctx.beginPath();
          for (let i = 0; i < count; i++) {
            const k = graphRing.index(i);
            const t = graphRing.t[k];
            if (t < minT - 2) continue;
            const lv = graphRing.l[k];
            if (Number.isNaN(lv)) continue;
            const x = xOf(t);
            const y = yOf(Math.max(yMin, Math.min(yMax, lv)));
            if (!started) {
              ctx.moveTo(x, y);
              firstX = x;
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
            lastX = x;
          }
          if (started) {
            ctx.strokeStyle = colGraph;
            ctx.lineWidth = 1.6 * dpr;
            ctx.stroke();

            ctx.lineTo(lastX, h);
            ctx.lineTo(firstX, h);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, "rgba(16, 185, 129, 0.30)");
            grad.addColorStop(1, "rgba(16, 185, 129, 0.02)");
            ctx.fillStyle = grad;
            ctx.fill();
          }

          // 2. Short-term (3 s) coral trace (`s`)
          ctx.beginPath();
          let sStarted = false;
          for (let i = 0; i < count; i++) {
            const k = graphRing.index(i);
            const t = graphRing.t[k];
            if (t < minT - 2) continue;
            const sv = graphRing.s[k];
            if (Number.isNaN(sv)) continue;
            const x = xOf(t);
            const y = yOf(Math.max(yMin, Math.min(yMax, sv)));
            if (!sStarted) {
              ctx.moveTo(x, y);
              sStarted = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          if (sStarted) {
            ctx.strokeStyle = colLufs;
            ctx.lineWidth = 1.9 * dpr;
            ctx.stroke();
          }
        }

        // 3. Dashed horizontal streaming target line
        const ty = yOf(tgt);
        if (ty >= 2 && ty <= h - 2) {
          ctx.save();
          ctx.setLineDash([5 * dpr, 4 * dpr]);
          ctx.strokeStyle = colLufs;
          ctx.lineWidth = 1.3 * dpr;
          ctx.beginPath();
          ctx.moveTo(0, ty);
          ctx.lineTo(w, ty);
          ctx.stroke();
          ctx.restore();

          const label = `${targetLabel(s)} ${tgt.toFixed(1)} LUFS`;
          ctx.font = `600 ${Math.round(9.5 * dpr)}px Inter, "Segoe UI", sans-serif`;
          const tw = ctx.measureText(label).width;
          const bx = w - tw - 14 * dpr;
          const by = Math.max(4 * dpr, Math.min(h - 18 * dpr, ty - 15 * dpr));
          ctx.fillStyle = "rgba(17, 18, 21, 0.84)";
          ctx.fillRect(bx, by, tw + 8 * dpr, 13 * dpr);
          ctx.fillStyle = colLufs;
          ctx.fillText(label, bx + 4 * dpr, by + 9.5 * dpr);
        }
      }
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const commitCustomTarget = () => {
    setEditingCustom(false);
    const parsed = Number.parseFloat(customDraft);
    if (Number.isFinite(parsed)) {
      const clamped = Math.max(-40, Math.min(0, Math.round(parsed * 10) / 10));
      updateSettings({ target: "custom", customTarget: clamped });
    }
  };

  return (
    <div className="card overflow-hidden rounded-xl">
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
            LOUDNESS HISTORY (100 MS CONTOUR)
          </span>
        </div>
        <div className="flex items-center gap-1">
          {SPANS.map((sp) => (
            <button
              key={sp}
              type="button"
              onClick={() => updateSettings({ graphSpan: sp })}
              className={`num rounded px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
                settings.graphSpan === sp
                  ? "bg-graph/20 text-graph border border-graph/40"
                  : "text-muted hover:text-fg"
              }`}
            >
              {sp}s
            </button>
          ))}
        </div>
      </div>

      {/* Edge-to-edge 60fps Canvas */}
      <canvas ref={canvasRef} className="block h-[142px] w-full bg-bg/55" />

      {/* Single-Row Target Strip directly beneath the graph */}
      <div className="no-scrollbar flex items-center justify-between gap-1 overflow-x-auto border-t border-line px-2 py-1.5">
        {TARGET_PRESETS.map((p) => {
          const selected = settings.target === p.id;
          const isCustom = p.id === "custom";
          const lufsVal = isCustom ? settings.customTarget : p.lufs;
          const shortLabel = p.id === "ebu" ? "EBU" : p.id === "custom" ? "My Target" : p.label;

          if (isCustom && editingCustom) {
            return (
              <div
                key={p.id}
                className="inline-flex items-center gap-1 rounded-md border border-lufs bg-surface2 px-1.5 py-0.5"
              >
                <span className="text-[9.5px] font-semibold text-fg">My:</span>
                <input
                  type="number"
                  step="0.1"
                  min="-40"
                  max="0"
                  autoFocus
                  value={customDraft}
                  onChange={(e) => setCustomDraft(e.target.value)}
                  onBlur={commitCustomTarget}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitCustomTarget();
                    if (e.key === "Escape") setEditingCustom(false);
                  }}
                  className="num w-11 bg-transparent text-[9.5px] font-bold text-fg outline-none"
                />
              </div>
            );
          }

          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                if (isCustom && selected) {
                  setEditingCustom(true);
                } else {
                  updateSettings({ target: p.id as TargetId });
                }
              }}
              title={
                isCustom
                  ? "Click to select My Target; click again to edit custom LUFS"
                  : `${p.label} (${p.lufs} LUFS)`
              }
              className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-semibold whitespace-nowrap transition-colors ${
                selected
                  ? "bg-lufs/20 text-lufs border border-lufs/45"
                  : "bg-surface2/70 text-muted hover:text-fg border border-transparent"
              }`}
            >
              <span>{shortLabel}</span>{" "}
              <span className="num opacity-85">{lufsVal}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
