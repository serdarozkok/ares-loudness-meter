import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../../lib/ipc";
import { isTauri } from "../../lib/env";
import { fmtLufs, fmtPeak } from "../../lib/format";
import type { MiniBarTextColor, MiniMetric, Telemetry } from "../../lib/types";
import { useSettings } from "../../state/settings";
import { useTelemetry } from "../../state/telemetry";

const LABELS: Record<MiniMetric, string> = {
  tp: "TP",
  int: "INT",
  shrt: "SHRT",
  momn: "MOMN",
  lra: "LRA",
  psr: "PSR",
  plr: "PLR",
};

function readMetric(m: MiniMetric, t: Telemetry | null, holdMax: boolean): number | null {
  if (!t) return null;
  switch (m) {
    case "tp":
      return t.tpMax;
    case "int":
      return t.integrated;
    case "shrt":
      return holdMax ? t.shortTermMax : t.shortTerm;
    case "momn":
      return holdMax ? t.momentaryMax : t.momentary;
    case "lra":
      return t.lra;
    case "psr":
      return t.psr;
    case "plr":
      return t.plr;
  }
}

function metricColor(
  m: MiniMetric,
  colorSetting: MiniBarTextColor,
  active: boolean,
  clipped: boolean,
): string {
  if (m === "tp" && clipped) return "#EF4444";
  if (!active) return "var(--lm-inactive)";
  switch (colorSetting) {
    case "white":
      return "#F4F6F9";
    case "black":
      return "#14161B";
    case "green":
      return "#10B981";
    case "orange":
      return "#FF7A00";
    case "cyan":
      return "#06B6D4";
    case "auto":
    default:
      if (m === "tp") return "var(--lm-tp)";
      if (m === "int" || m === "shrt" || m === "momn") return "var(--lm-lufs)";
      return "var(--lm-graph)";
  }
}

export function MiniBar() {
  const settings = useSettings((s) => s.settings);
  const telemetry = useTelemetry((s) => s.telemetry);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const lastWidthRef = useRef<number>(0);
  const clickTimerRef = useRef<number | null>(null);
  const downPosRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const [resetFlash, setResetFlash] = useState(false);

  // Mark root element transparent for the frameless pill
  useEffect(() => {
    document.documentElement.classList.add("minibar-root");
    return () => document.documentElement.classList.remove("minibar-root");
  }, []);

  // Measure content width & dynamically resize the Mini-Bar window
  useEffect(() => {
    if (!isTauri || !rowRef.current) return;
    let timer: number | null = null;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.ceil(entry.contentRect.width) + 28;
      if (Math.abs(w - lastWidthRef.current) < 2) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        lastWidthRef.current = w;
        void api.setMiniBarWidth(w);
      }, 80);
    });
    ro.observe(rowRef.current);
    return () => {
      if (timer) window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [settings.miniBarMetrics]);

  // Magnetic edge-snapping after window move settles
  useEffect(() => {
    if (!isTauri) return;
    let moveTimer: number | null = null;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onMoved(() => {
        if (moveTimer) window.clearTimeout(moveTimer);
        moveTimer = window.setTimeout(() => {
          void api.snapMiniBar();
        }, 240);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      if (moveTimer) window.clearTimeout(moveTimer);
      if (unlisten) unlisten();
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      void api.showInspector();
      return;
    }
    if (e.button !== 0) return;
    downPosRef.current = { x: e.screenX, y: e.screenY, dragging: false };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const down = downPosRef.current;
    if (!down || down.dragging || (e.buttons & 1) === 0) return;
    const dx = Math.abs(e.screenX - down.x);
    const dy = Math.abs(e.screenY - down.y);
    if (dx > 3 || dy > 3) {
      down.dragging = true;
      if (isTauri) {
        void getCurrentWindow()
          .startDragging()
          .finally(() => {
            void api.snapMiniBar();
          });
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    const down = downPosRef.current;
    downPosRef.current = null;
    if (!down || down.dragging || e.button !== 0) return;

    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      // Double-click -> instant meter reset
      void api.resetMeters();
      setResetFlash(true);
      window.setTimeout(() => setResetFlash(false), 650);
    } else {
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        void api.toggleInspector();
      }, 220);
    }
  };

  const active = telemetry?.active ?? false;
  const clipped = (telemetry?.clipCount ?? 0) > 0;
  const holdMax = settings.holdMode === "max";
  const metrics = settings.miniBarMetrics.length > 0 ? settings.miniBarMetrics : (["tp", "int", "shrt"] as MiniMetric[]);

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => {
        e.preventDefault();
        void api.showInspector();
      }}
      title="Single-click: Toggle Inspector · Double-click: Reset Meters · Drag to reposition"
      style={{
        background: "var(--lm-mini-bg)",
        borderColor: clipped ? "rgba(239, 68, 68, 0.65)" : "var(--lm-mini-border)",
      }}
      className="h-[28px] w-full flex items-center justify-center rounded-full border px-3 backdrop-blur-md transition-colors duration-200"
    >
      {resetFlash ? (
        <span className="lm-flash text-[11px] font-bold tracking-widest text-good">
          METERS RESET
        </span>
      ) : (
        <div ref={rowRef} className="inline-flex items-center gap-2 whitespace-nowrap">
          <span
            className="h-1.5 w-1.5 rounded-full transition-colors duration-300"
            style={{
              backgroundColor: clipped ? "#EF4444" : active ? "#10B981" : "#6B7280",
              boxShadow: active ? "0 0 6px rgba(16,185,129,0.7)" : "none",
            }}
          />
          {metrics.map((m, idx) => {
            const val = readMetric(m, telemetry, holdMax);
            const color = metricColor(m, settings.miniBarTextColor, active, clipped);
            return (
              <div key={m} className="inline-flex items-center gap-1">
                {idx > 0 && <span className="text-[10px] text-muted/45 select-none">|</span>}
                <span className="text-[10px] font-semibold tracking-wider text-muted">
                  {LABELS[m]}
                </span>
                <span
                  style={{ color }}
                  className="num text-[12px] font-bold transition-colors duration-300"
                >
                  {m === "tp" ? fmtPeak(val) : fmtLufs(val)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
