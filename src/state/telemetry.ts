import { create } from "zustand";
import { events } from "../lib/ipc";
import { isTauri } from "../lib/env";
import { startDemo } from "../lib/demo";
import type { GraphPoint, Telemetry } from "../lib/types";

/** 120 s of 100 ms steps (spec minimum is 70 s). */
const RING_CAPACITY = 1200;

/**
 * Mutable, allocation-free ring buffer of graph points. Canvases read it directly in
 * their requestAnimationFrame loops; it never triggers React renders.
 * Null loudness values are stored as NaN.
 */
export class GraphRing {
  readonly capacity: number;
  readonly t: Float64Array;
  readonly l: Float64Array;
  readonly m: Float64Array;
  readonly s: Float64Array;
  private start = 0;
  private count = 0;
  /** performance.now() at the arrival of the most recent point batch. */
  lastPointArrival = 0;
  /** Incremented on every mutation so consumers can cheaply detect changes. */
  version = 0;
  private listeners = new Set<() => void>();

  constructor(capacity: number) {
    this.capacity = capacity;
    this.t = new Float64Array(capacity);
    this.l = new Float64Array(capacity);
    this.m = new Float64Array(capacity);
    this.s = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Physical index of the i-th oldest point. */
  index(i: number): number {
    return (this.start + i) % this.capacity;
  }

  get lastT(): number {
    return this.count > 0 ? this.t[this.index(this.count - 1)] : 0;
  }

  get firstT(): number {
    return this.count > 0 ? this.t[this.start] : 0;
  }

  append(points: readonly GraphPoint[]) {
    if (points.length === 0) return;
    for (const p of points) {
      if (this.count > 0) {
        const last = this.lastT;
        if (p.t < last) this.reset(false);
        else if (p.t === last) continue;
      }
      let idx: number;
      if (this.count < this.capacity) {
        idx = this.index(this.count);
        this.count += 1;
      } else {
        idx = this.start;
        this.start = (this.start + 1) % this.capacity;
      }
      this.t[idx] = p.t;
      this.l[idx] = p.l ?? Number.NaN;
      this.m[idx] = p.m ?? Number.NaN;
      this.s[idx] = p.s ?? Number.NaN;
    }
    this.lastPointArrival = performance.now();
    this.version += 1;
    this.emit();
  }

  clear() {
    this.reset(true);
  }

  private reset(notify: boolean) {
    this.start = 0;
    this.count = 0;
    this.version += 1;
    if (notify) this.emit();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    for (const cb of this.listeners) cb();
  }

  /** Snapshot as plain points (oldest → newest), e.g. for SVG reports. */
  toPoints(): GraphPoint[] {
    const out: GraphPoint[] = [];
    for (let i = 0; i < this.count; i++) {
      const k = this.index(i);
      const n = (v: number) => (Number.isNaN(v) ? null : v);
      out.push({ t: this.t[k], l: n(this.l[k]), m: n(this.m[k]), s: n(this.s[k]) });
    }
    return out;
  }
}

export const graphRing = new GraphRing(RING_CAPACITY);

/** Latest telemetry, readable synchronously by animation loops without subscribing. */
export const telemetryRef: { current: Telemetry | null } = { current: null };

interface TelemetryState {
  telemetry: Telemetry | null;
}

export const useTelemetry = create<TelemetryState>(() => ({ telemetry: null }));

export function ingestTelemetry(t: Telemetry) {
  graphRing.append(t.graph);
  telemetryRef.current = t;
  useTelemetry.setState({ telemetry: t });
}

export function handleMetersReset() {
  graphRing.clear();
}

/** Connects the store to the backend (or the demo generator in a plain browser). */
export async function initTelemetry(): Promise<() => void> {
  if (!isTauri) {
    return startDemo({ onTelemetry: ingestTelemetry, onReset: handleMetersReset });
  }
  const un1 = await events.onTelemetry(ingestTelemetry);
  const un2 = await events.onMetersReset(handleMetersReset);
  return () => {
    un1();
    un2();
  };
}
