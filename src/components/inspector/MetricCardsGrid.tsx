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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "../../lib/ipc";
import { fmtDelta, fmtLufs, fmtPeak } from "../../lib/format";
import { targetLabel, targetLufs, type CardId, type Settings, type Telemetry } from "../../lib/types";
import { updateSettings } from "../../state/settings";
import { IconGrip } from "../icons";

interface Props {
  settings: Settings;
  telemetry: Telemetry | null;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function SortableCard({
  id,
  fullWidth,
  children,
}: {
  id: CardId;
  fullWidth: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : 1,
    opacity: isDragging ? 0.88 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card relative rounded-xl p-3 transition-colors ${fullWidth ? "col-span-2" : "col-span-1"}`}
    >
      <button
        type="button"
        aria-label="Drag to reorder card"
        title="Drag to reorder card"
        {...attributes}
        {...listeners}
        className="absolute top-2.5 right-2.5 p-0.5 text-muted/45 hover:text-fg active:cursor-grabbing"
      >
        <IconGrip className="h-3.5 w-3.5" />
      </button>
      {children}
    </div>
  );
}

export function MetricCardsGrid({ settings, telemetry }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (ev: DragEndEvent) => {
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const oldIdx = settings.cardOrder.indexOf(active.id as CardId);
    const newIdx = settings.cardOrder.indexOf(over.id as CardId);
    if (oldIdx < 0 || newIdx < 0) return;
    updateSettings({ cardOrder: arrayMove(settings.cardOrder, oldIdx, newIdx) });
  };

  const active = telemetry?.active ?? false;
  const holdMax = settings.holdMode === "max";
  const tgtLufs = targetLufs(settings);
  const tgtName = targetLabel(settings);

  const renderCard = (id: CardId) => {
    switch (id) {
      case "truePeak": {
        const tp = telemetry?.tpMax ?? null;
        const clips = telemetry?.clipCount ?? 0;
        const pct = tp !== null ? clamp01((tp + 30) / 33) * 100 : 0;
        const ceilPct = clamp01((settings.tpCeiling + 30) / 33) * 100;
        const overCeil = tp !== null && tp > settings.tpCeiling;
        return (
          <SortableCard key={id} id={id} fullWidth>
            <div className="flex items-center justify-between pr-5">
              <span className="text-[10px] font-bold tracking-wider text-muted uppercase">
                TRUE PEAK (MAX HOLD)
              </span>
              <button
                type="button"
                onClick={() => void api.resetMeters()}
                title="Click to reset clip counter and max holds"
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider transition-colors ${
                  clips > 0
                    ? "bg-warn text-white shadow-[0_0_10px_rgba(239,68,68,0.55)]"
                    : "bg-surface2 text-muted hover:text-fg"
                }`}
              >
                {clips} {clips === 1 ? "CLIP" : "CLIPS"}
              </button>
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span
                className={`num text-[28px] leading-none font-extrabold transition-colors duration-300 ${
                  clips > 0 ? "text-warn" : active ? "text-tp" : "text-inactive"
                }`}
              >
                {fmtPeak(tp)}
              </span>
              <span className="text-xs font-semibold text-muted">dBTP</span>
            </div>
            <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-surface2">
              <div
                style={{ width: `${pct}%` }}
                className={`h-full rounded-full transition-all duration-150 ${
                  overCeil || clips > 0 ? "bg-warn" : "bg-tp"
                }`}
              />
              <div
                style={{ left: `${ceilPct}%` }}
                title={`Ceiling ${settings.tpCeiling.toFixed(1)} dBTP`}
                className="absolute top-0 bottom-0 w-[2px] bg-fg/80"
              />
            </div>
          </SortableCard>
        );
      }

      case "integrated": {
        const integ = telemetry?.integrated ?? null;
        const delta = integ !== null ? integ - tgtLufs : null;
        const pct = integ !== null ? clamp01((integ + 40) / 40) * 100 : 0;
        const tgtPct = clamp01((tgtLufs + 40) / 40) * 100;
        const deltaBadgeClass =
          delta === null
            ? "bg-surface2 text-muted"
            : Math.abs(delta) <= 1.0
              ? "bg-good/15 text-good border border-good/30"
              : Math.abs(delta) <= 3.0
                ? "bg-amber/15 text-amber border border-amber/30"
                : "bg-warn/15 text-warn border border-warn/30";
        return (
          <SortableCard key={id} id={id} fullWidth>
            <div className="flex items-center justify-between pr-5">
              <span className="text-[10px] font-bold tracking-wider text-muted uppercase">
                INTEGRATED LOUDNESS
              </span>
              <span className={`num rounded-full px-2 py-0.5 text-[10px] font-semibold ${deltaBadgeClass}`}>
                {delta !== null ? `${fmtDelta(delta)} vs ${tgtName}` : `Target ${tgtLufs.toFixed(1)} LUFS`}
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span
                className={`num text-[28px] leading-none font-extrabold transition-colors duration-300 ${
                  active ? "text-lufs" : "text-inactive"
                }`}
              >
                {fmtLufs(integ)}
              </span>
              <span className="text-xs font-semibold text-muted">LUFS</span>
            </div>
            <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-surface2">
              <div
                style={{ width: `${pct}%` }}
                className="h-full rounded-full bg-lufs transition-all duration-150"
              />
              <div
                style={{ left: `${tgtPct}%` }}
                title={`Target ${tgtLufs.toFixed(1)} LUFS`}
                className="absolute top-0 bottom-0 w-[2px] bg-good"
              />
            </div>
          </SortableCard>
        );
      }

      case "instantLufs": {
        const momLive = telemetry?.momentary ?? null;
        const shrtLive = telemetry?.shortTerm ?? null;
        const liveVal = momLive ?? shrtLive;
        const liveDelta = liveVal !== null ? liveVal - tgtLufs : null;
        const momPct = momLive !== null ? clamp01((momLive + 40) / 40) * 100 : 0;
        const shrtPct = shrtLive !== null ? clamp01((shrtLive + 40) / 40) * 100 : 0;
        const tgtPct = clamp01((tgtLufs + 40) / 40) * 100;
        return (
          <SortableCard key={id} id={id} fullWidth>
            <div className="flex items-center justify-between pr-5">
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full transition-colors ${
                    active ? "bg-graph shadow-[0_0_6px_rgba(16,185,129,0.8)]" : "bg-inactive"
                  }`}
                />
                <span className="text-[10px] font-bold tracking-wider text-muted uppercase">
                  INSTANT LOUDNESS (LIVE)
                </span>
              </div>
              <span className="num rounded-full bg-surface2 px-2 py-0.5 text-[10px] font-semibold text-muted">
                SHRT 3s:{" "}
                <strong className={active ? "text-fg" : "text-inactive"}>{fmtLufs(shrtLive)}</strong> LUFS
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`num text-[26px] leading-none font-extrabold transition-colors duration-150 ${
                    active ? "text-graph" : "text-inactive"
                  }`}
                >
                  {fmtLufs(momLive)}
                </span>
                <span className="text-xs font-semibold text-muted">LUFS</span>
                <span className="ml-1 text-[10px] text-muted/70">(400 ms live)</span>
              </div>
              {liveDelta !== null && (
                <span className="num text-[11px] font-semibold text-muted">
                  {fmtDelta(liveDelta)} vs {tgtName}
                </span>
              )}
            </div>
            <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-surface2">
              <div
                style={{ width: `${momPct}%` }}
                className="h-full rounded-full bg-graph transition-all duration-75"
              />
              {shrtLive !== null && (
                <div
                  style={{ left: `${shrtPct}%` }}
                  title={`Short-Term Live: ${shrtLive.toFixed(1)} LUFS`}
                  className="absolute top-0 bottom-0 w-[2px] bg-lufs"
                />
              )}
              <div
                style={{ left: `${tgtPct}%` }}
                title={`Target ${tgtLufs.toFixed(1)} LUFS`}
                className="absolute top-0 bottom-0 w-[2px] bg-fg/75"
              />
            </div>
          </SortableCard>
        );
      }

      case "shortTerm": {
        const val = holdMax ? telemetry?.shortTermMax ?? null : telemetry?.shortTerm ?? null;
        return (
          <SortableCard key={id} id={id} fullWidth={false}>
            <button
              type="button"
              onClick={() => updateSettings({ holdMode: holdMax ? "live" : "max" })}
              title="Click to toggle between Max Hold and Live Instant readout"
              className="text-left text-[10px] font-bold tracking-wider text-muted uppercase hover:text-fg"
            >
              {holdMax ? "SHORT-TERM MAX" : "SHORT-TERM LIVE"}
            </button>
            <div className="mt-1.5 flex items-baseline gap-1">
              <span
                className={`num text-[22px] leading-none font-extrabold transition-colors duration-300 ${
                  active ? "text-lufs" : "text-inactive"
                }`}
              >
                {fmtLufs(val)}
              </span>
              <span className="text-[11px] font-semibold text-muted">LUFS</span>
            </div>
            <div className="mt-1 text-[10px] text-muted/70">3.0 s window</div>
          </SortableCard>
        );
      }

      case "momentary": {
        const val = holdMax ? telemetry?.momentaryMax ?? null : telemetry?.momentary ?? null;
        return (
          <SortableCard key={id} id={id} fullWidth={false}>
            <button
              type="button"
              onClick={() => updateSettings({ holdMode: holdMax ? "live" : "max" })}
              title="Click to toggle between Max Hold and Live Instant readout"
              className="text-left text-[10px] font-bold tracking-wider text-muted uppercase hover:text-fg"
            >
              {holdMax ? "MOMENTARY MAX" : "MOMENTARY LIVE"}
            </button>
            <div className="mt-1.5 flex items-baseline gap-1">
              <span
                className={`num text-[22px] leading-none font-extrabold transition-colors duration-300 ${
                  active ? "text-lufs" : "text-inactive"
                }`}
              >
                {fmtLufs(val)}
              </span>
              <span className="text-[11px] font-semibold text-muted">LUFS</span>
            </div>
            <div className="mt-1 text-[10px] text-muted/70">400 ms window</div>
          </SortableCard>
        );
      }

      case "lra": {
        const lra = telemetry?.lra ?? null;
        return (
          <SortableCard key={id} id={id} fullWidth={false}>
            <div className="text-[10px] font-bold tracking-wider text-muted uppercase">
              LRA (RANGE)
            </div>
            <div className="mt-1.5 flex items-baseline gap-1">
              <span
                className={`num text-[22px] leading-none font-extrabold transition-colors duration-300 ${
                  active ? "text-graph" : "text-inactive"
                }`}
              >
                {fmtLufs(lra)}
              </span>
              <span className="text-[11px] font-semibold text-muted">LU</span>
            </div>
            <div className="mt-1 text-[10px] text-muted/70">EBU Tech 3342</div>
          </SortableCard>
        );
      }

      case "psr": {
        const showPlr = settings.showPlr;
        const val = showPlr ? telemetry?.plr ?? null : telemetry?.psr ?? null;
        return (
          <SortableCard key={id} id={id} fullWidth={false}>
            <button
              type="button"
              onClick={() => updateSettings({ showPlr: !showPlr })}
              title="Click to toggle between PSR (Peak-to-Short-Term) and PLR (Peak-to-Loudness)"
              className="text-left text-[10px] font-bold tracking-wider text-muted uppercase hover:text-fg"
            >
              {showPlr ? "PLR (CREST)" : "PSR (DYNAMICS)"}
            </button>
            <div className="mt-1.5 flex items-baseline gap-1">
              <span
                className={`num text-[22px] leading-none font-extrabold transition-colors duration-300 ${
                  active ? "text-graph" : "text-inactive"
                }`}
              >
                {fmtLufs(val)}
              </span>
              <span className="text-[11px] font-semibold text-muted">LU</span>
            </div>
            <div className="mt-1 text-[10px] text-muted/70">
              {showPlr ? "TP max − Integrated" : "TP − Short-Term"}
            </div>
          </SortableCard>
        );
      }
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={settings.cardOrder} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-2 gap-2">
          {settings.cardOrder.map((id) => renderCard(id))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
