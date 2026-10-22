import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "../../lib/ipc";
import { isTauri } from "../../lib/env";
import { fmtSampleRate } from "../../lib/format";
import {
  buildReportData,
  copySummaryToClipboard,
  exportSessionReportPng,
} from "../../lib/exportReport";
import type { SectionId } from "../../lib/types";
import { updateSettings, useSettings } from "../../state/settings";
import { useTelemetry } from "../../state/telemetry";
import { useOffline } from "../../state/offline";
import { MetricCardsGrid } from "./MetricCardsGrid";
import { LoudnessGraph } from "./LoudnessGraph";
import { PhaseSection } from "./PhaseSection";
import { OfflineView } from "./OfflineView";
import { LanModal } from "./LanModal";
import { SettingsPanel } from "../settings/SettingsPanel";
import { SessionReportCard } from "../report/SessionReportCard";
import { ToastHost, pushToast } from "../Toast";
import {
  IconClose,
  IconCopy,
  IconExport,
  IconFolder,
  IconGrip,
  IconPin,
  IconPower,
  IconQr,
  IconReset,
  IconSettings,
  IconWave,
} from "../icons";

const SUPPORTED_EXTS = new Set([
  "wav",
  "wave",
  "mp3",
  "flac",
  "aif",
  "aiff",
  "aifc",
  "m4a",
  "mp4",
  "aac",
  "ogg",
]);

function hasSupportedExt(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTS.has(path.slice(dot + 1).toLowerCase());
}

function SortableSection({
  id,
  children,
}: {
  id: SectionId;
  children: (dragHandleProps: Record<string, unknown>) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 35 : 1,
    opacity: isDragging ? 0.9 : 1,
  };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

export function Inspector() {
  const settings = useSettings((s) => s.settings);
  const telemetry = useTelemetry((s) => s.telemetry);
  const offlineResult = useOffline((s) => s.result);
  const analyzing = useOffline((s) => s.analyzing);
  const analyzePath = useOffline((s) => s.analyzePath);

  const [dragHover, setDragHover] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lanOpen, setLanOpen] = useState(false);
  const [quitArmed, setQuitArmed] = useState(false);
  const reportRef = useRef<HTMLDivElement | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Tauri native drag-and-drop file listener
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragHover(true);
        } else if (p.type === "leave") {
          setDragHover(false);
        } else if (p.type === "drop") {
          setDragHover(false);
          const candidate = p.paths.find(hasSupportedExt) ?? p.paths[0];
          if (candidate) {
            void analyzePath(candidate);
          } else {
            pushToast("Unsupported file format. Drop WAV, MP3, FLAC, AIFF, or M4A.", "error");
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, [analyzePath]);

  // Keyboard shortcuts (`R` reset meters, `Escape` close drawers/hide inspector)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        void api.resetMeters();
        pushToast("Meters reset", "info");
      } else if (e.key === "Escape") {
        if (lanOpen) setLanOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (isTauri) void api.hideInspector();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lanOpen, settingsOpen]);

  const handleSectionDragEnd = (ev: DragEndEvent) => {
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const oldIdx = settings.sectionOrder.indexOf(active.id as SectionId);
    const newIdx = settings.sectionOrder.indexOf(over.id as SectionId);
    if (oldIdx < 0 || newIdx < 0) return;
    updateSettings({ sectionOrder: arrayMove(settings.sectionOrder, oldIdx, newIdx) });
  };

  const handleOpenAudioFile = async () => {
    if (!isTauri) {
      pushToast("Offline file analysis runs inside the native Windows app", "info");
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Audio Files",
          extensions: ["wav", "wave", "mp3", "flac", "aif", "aiff", "m4a", "mp4", "aac", "ogg"],
        },
      ],
    });
    if (typeof selected === "string" && selected.length > 0) {
      await analyzePath(selected);
    }
  };

  const handleQuit = () => {
    if (!quitArmed) {
      setQuitArmed(true);
      pushToast("Click Quit again to exit ARES Loudness Meter", "info");
      window.setTimeout(() => setQuitArmed(false), 2600);
      return;
    }
    void api.quitApp();
  };

  const isOfflineMode = offlineResult !== null;
  const activeSr = isOfflineMode
    ? offlineResult.sampleRate
    : telemetry?.sampleRate ?? 48000;
  const reportData = buildReportData(settings, telemetry, offlineResult);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden border border-line bg-bg select-none">
      {/* 1. Header Bar (Draggable) */}
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between border-b border-line bg-surface/85 px-3 py-2 backdrop-blur-md"
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <span
            data-tauri-drag-region
            className="flex h-6 w-6 items-center justify-center rounded-lg bg-lufs/15 text-lufs"
          >
            <IconWave className="pointer-events-none h-4 w-4" />
          </span>
          <span
            data-tauri-drag-region
            className="text-xs font-extrabold tracking-widest text-fg"
          >
            ARES LOUDNESS
          </span>
          <span
            data-tauri-drag-region
            title={
              isOfflineMode
                ? `Offline File: ${offlineResult.fileName}`
                : `${telemetry?.deviceName ?? "Default Output"}`
            }
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-extrabold tracking-wider uppercase ${
              isOfflineMode
                ? "bg-tp/20 text-tp border border-tp/40"
                : "bg-good/15 text-good border border-good/35"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isOfflineMode
                  ? "bg-tp"
                  : telemetry?.active
                    ? "lm-pulse bg-good"
                    : "bg-muted"
              }`}
            />
            {isOfflineMode ? "OFFLINE" : "LIVE"}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span
            data-tauri-drag-region
            title={telemetry?.deviceName ?? "Active Sample Rate"}
            className="num rounded-md bg-surface2 px-2 py-0.5 text-[11px] font-semibold text-muted"
          >
            {fmtSampleRate(activeSr)}
          </span>
          <button
            type="button"
            onClick={() => void handleOpenAudioFile()}
            title="Analyze Offline Audio File (or drag & drop anywhere)"
            aria-label="Analyze Audio File"
            className="rounded-lg p-1.5 text-muted hover:bg-surface2 hover:text-fg"
          >
            <IconFolder className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !settings.pinned;
              updateSettings({ pinned: next });
              if (isTauri) void api.setPinned(next);
            }}
            title={settings.pinned ? "Unpin Inspector (Always-on-Top ON)" : "Pin Inspector above DAW"}
            aria-label="Pin window"
            className={`rounded-lg p-1.5 transition-colors ${
              settings.pinned
                ? "bg-graph/20 text-graph"
                : "text-muted hover:bg-surface2 hover:text-fg"
            }`}
          >
            <IconPin pinned={settings.pinned} className="h-4 w-4" />
          </button>
          {isTauri && (
            <button
              type="button"
              onClick={() => void api.hideInspector()}
              title="Close Inspector (Mini-Bar stays active)"
              aria-label="Close Inspector"
              className="rounded-lg p-1.5 text-muted hover:bg-surface2 hover:text-fg"
            >
              <IconClose className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* 2. Scrollable Body: either Offline Analysis View or Sortable Live Sections */}
      <main className="thin-scroll flex-1 space-y-2.5 overflow-y-auto p-2.5">
        {analyzing ? (
          <div className="card flex h-64 flex-col items-center justify-center gap-3 rounded-xl p-6 text-center">
            <div className="lm-spin h-7 w-7 rounded-full border-2 border-graph border-t-transparent" />
            <div className="text-xs font-bold text-fg">
              Decoding & running multithreaded BS.1770-5 / True Peak analysis...
            </div>
          </div>
        ) : offlineResult ? (
          <OfflineView result={offlineResult} settings={settings} />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleSectionDragEnd}
          >
            <SortableContext
              items={settings.sectionOrder}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2.5">
                {settings.sectionOrder.map((sec) => (
                  <SortableSection key={sec} id={sec}>
                    {(dragHandleProps) => {
                      if (sec === "cards") {
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between px-1">
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  aria-label="Drag metric cards section"
                                  title="Drag to reorder section"
                                  {...dragHandleProps}
                                  className="text-muted/45 hover:text-fg active:cursor-grabbing"
                                >
                                  <IconGrip className="h-3.5 w-3.5" />
                                </button>
                                <span className="text-[9px] font-bold tracking-wider text-muted/80 uppercase">
                                  LOUDNESS & DYNAMICS METRICS
                                </span>
                              </div>
                              <span className="num text-[10px] text-muted/75">
                                {telemetry?.deviceName ?? "System Audio"}
                              </span>
                            </div>
                            <MetricCardsGrid settings={settings} telemetry={telemetry} />
                          </div>
                        );
                      }
                      if (sec === "graph") {
                        return (
                          <LoudnessGraph
                            settings={settings}
                            dragHandleProps={dragHandleProps}
                          />
                        );
                      }
                      return (
                        <PhaseSection
                          settings={settings}
                          telemetry={telemetry}
                          dragHandleProps={dragHandleProps}
                        />
                      );
                    }}
                  </SortableSection>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </main>

      {/* 3. Bottom Action Toolbar */}
      <footer className="flex shrink-0 items-center justify-between border-t border-line bg-surface/90 px-2.5 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void api.resetMeters();
              pushToast("All meters & clip counters reset", "info");
            }}
            title="Reset Meters (Shortcut: R)"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-xs font-bold text-fg hover:border-graph/50 hover:text-graph"
          >
            <IconReset className="h-3.5 w-3.5" />
            <span>Reset</span>
          </button>

          <button
            type="button"
            onClick={() => void copySummaryToClipboard(settings, telemetry, offlineResult)}
            title="Copy formatted Session Summary to Clipboard"
            className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface2 px-2 py-1.5 text-xs font-semibold text-fg hover:border-graph/50"
          >
            <IconCopy className="h-3.5 w-3.5" />
            <span>Copy</span>
          </button>

          <button
            type="button"
            onClick={() => void exportSessionReportPng(reportRef.current)}
            title="Export High-Resolution Session Report PNG Card"
            className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface2 px-2 py-1.5 text-xs font-semibold text-fg hover:border-graph/50"
          >
            <IconExport className="h-3.5 w-3.5" />
            <span>PNG</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLanOpen(true)}
            title="LAN QR Mobile Mirror (iPhone / iPad / Android)"
            aria-label="LAN Mobile Mirror"
            className="rounded-lg border border-line bg-surface2 p-1.5 text-muted hover:text-fg"
          >
            <IconQr className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="Settings, Audio Routing & Ignore Apps"
            aria-label="Settings"
            className="rounded-lg border border-line bg-surface2 p-1.5 text-muted hover:text-fg"
          >
            <IconSettings className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={handleQuit}
            title={quitArmed ? "Click again to confirm Quit" : "Quit Loudmeter Pro"}
            aria-label="Quit application"
            className={`rounded-lg border p-1.5 transition-colors ${
              quitArmed
                ? "border-warn bg-warn text-white"
                : "border-line bg-surface2 text-muted hover:text-warn"
            }`}
          >
            <IconPower className="h-4 w-4" />
          </button>
        </div>
      </footer>

      {/* Drag & Drop Full-Window Overlay */}
      {dragHover && (
        <div className="lm-fade-in pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg/90 p-6 text-center backdrop-blur-sm">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-dashed border-graph bg-graph/10 text-graph">
            <IconFolder className="h-10 w-10" />
          </div>
          <div className="mt-3 text-sm font-extrabold tracking-wide text-fg">
            DROP AUDIO FILE FOR INSTANT OFFLINE ANALYSIS
          </div>
          <div className="mt-1 text-xs text-muted">
            WAV · MP3 · FLAC · AIFF · M4A · AAC · OGG (Multithreaded Symphonia + Rayon)
          </div>
        </div>
      )}

      {/* Slide-over Settings Drawer */}
      {settingsOpen && (
        <SettingsPanel settings={settings} onClose={() => setSettingsOpen(false)} />
      )}

      {/* LAN QR Code Modal */}
      {lanOpen && <LanModal onClose={() => setLanOpen(false)} />}

      {/* Off-screen 960px Session Report Card for crisp PNG export */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          left: "-10000px",
          top: "0",
          pointerEvents: "none",
          zIndex: -1,
        }}
      >
        <SessionReportCard ref={reportRef} data={reportData} />
      </div>

      <ToastHost />
    </div>
  );
}
