import type { GraphPoint, Telemetry } from "./types";
import { SPECTRAL_BANDS_HZ } from "./types";

/**
 * Browser-only telemetry simulator used when the UI runs outside Tauri (`npm run dev`).
 * Produces musically plausible loudness contours (verses / choruses / breakdowns),
 * computes momentary, short-term, gated integrated loudness and LRA the same way the
 * real engine reports them, and emits frames at ~30 Hz with 100 ms graph points.
 */

const FRAME_MS = 33;
const BLOCK_MS = 100;

interface DemoHandlers {
  onTelemetry: (t: Telemetry) => void;
  onReset: () => void;
}

const toPower = (lufs: number) => Math.pow(10, (lufs + 0.691) / 10);
const toLufs = (p: number) => (p > 0 ? -0.691 + 10 * Math.log10(p) : null);

function meanLufs(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += toPower(v);
  return toLufs(sum / values.length);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

class DemoEngine {
  private handlers: DemoHandlers;
  private timer: number | null = null;
  private seq = 0;
  private step = 0;
  private blocks: number[] = [];
  private gatedBlocks: number[] = [];
  private shortTerms: number[] = [];
  private pending: GraphPoint[] = [];
  private lastBlockAt = 0;
  private tpMax: number | null = null;
  private peaks: number[] = [];
  private clipCount = 0;
  private stMax: number | null = null;
  private mMax: number | null = null;
  private corr = 0.8;
  private spectral: number[] = SPECTRAL_BANDS_HZ.map(() => 0.8);
  private phaseEvent = 0;

  constructor(handlers: DemoHandlers) {
    this.handlers = handlers;
  }

  start() {
    this.lastBlockAt = performance.now();
    this.timer = window.setInterval(() => this.tick(), FRAME_MS);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  reset() {
    this.step = 0;
    this.blocks = [];
    this.gatedBlocks = [];
    this.shortTerms = [];
    this.pending = [];
    this.tpMax = null;
    this.peaks = [];
    this.clipCount = 0;
    this.stMax = null;
    this.mMax = null;
    this.lastBlockAt = performance.now();
    this.handlers.onReset();
  }

  /** Loudness of one 100 ms block for the current step: song-like envelope + transients. */
  private blockLoudness(step: number): number | null {
    const sec = step / 10;
    const cycle = sec % 48;
    if (cycle > 46.5) return null; // short gap between "songs"
    let base: number;
    if (cycle < 8) base = -14 + cycle * 0.4; // intro build
    else if (cycle < 20) base = -10.5; // verse
    else if (cycle < 32) base = -7.6; // chorus
    else if (cycle < 38) base = -17; // breakdown
    else base = -7.2; // final chorus
    const beat = Math.sin(sec * Math.PI * 4) * 1.3 + Math.sin(sec * Math.PI * 1.1) * 0.7;
    const noise = (Math.random() - 0.5) * 2.4;
    return base + beat + noise;
  }

  private produceBlock() {
    const l = this.blockLoudness(this.step);
    if (l !== null) {
      this.blocks.push(l);
      if (l > -70) this.gatedBlocks.push(l);
    } else {
      this.blocks.push(-120);
    }
    if (this.blocks.length > 30) this.blocks.shift();

    const m = meanLufs(this.blocks.slice(-4).filter((v) => v > -100));
    const s = meanLufs(this.blocks.slice(-30).filter((v) => v > -100));
    if (s !== null) {
      this.shortTerms.push(s);
      if (this.shortTerms.length > 6000) this.shortTerms.shift();
    }
    if (m !== null) this.mMax = this.mMax === null ? m : Math.max(this.mMax, m);
    if (s !== null && this.step >= 30) this.stMax = this.stMax === null ? s : Math.max(this.stMax, s);

    if (l !== null) {
      const peak = Math.min(1.2, l + 7.5 + Math.random() * 1.6);
      this.peaks.push(peak);
      if (this.peaks.length > 30) this.peaks.shift();
      this.tpMax = this.tpMax === null ? peak : Math.max(this.tpMax, peak);
      if (peak > 0) this.clipCount += 1;
    } else {
      this.peaks.push(-120);
      if (this.peaks.length > 30) this.peaks.shift();
    }

    this.pending.push({ t: this.step, l, m, s });
    this.step += 1;
  }

  private integrated(): number | null {
    if (this.gatedBlocks.length < 4) return null;
    const ungated = meanLufs(this.gatedBlocks);
    if (ungated === null) return null;
    const rel = ungated - 10;
    return meanLufs(this.gatedBlocks.filter((v) => v > rel));
  }

  private lra(): number | null {
    if (this.shortTerms.length < 30) return null;
    const abs = this.shortTerms.filter((v) => v > -70);
    const ung = meanLufs(abs);
    if (ung === null) return null;
    const gated = abs.filter((v) => v > ung - 20).sort((a, b) => a - b);
    if (gated.length < 2) return null;
    return percentile(gated, 0.95) - percentile(gated, 0.1);
  }

  private tick() {
    const now = performance.now();
    while (now - this.lastBlockAt >= BLOCK_MS) {
      this.produceBlock();
      this.lastBlockAt += BLOCK_MS;
    }

    const lastBlock = this.blocks[this.blocks.length - 1];
    const active = lastBlock !== undefined && lastBlock > -70;
    const m = meanLufs(this.blocks.slice(-4).filter((v) => v > -100));
    const s = meanLufs(this.blocks.slice(-30).filter((v) => v > -100));
    const integrated = this.integrated();
    const livePeaks = this.peaks.filter((v) => v > -100);
    const tpCurrent = livePeaks.length ? Math.max(...livePeaks) : null;

    const t = now / 1000;
    if (Math.random() < 0.002) this.phaseEvent = 2.2;
    this.phaseEvent = Math.max(0, this.phaseEvent - FRAME_MS / 1000);
    const corrTarget = active ? (this.phaseEvent > 0 ? -0.55 : 0.72 + Math.sin(t * 0.7) * 0.15) : 0;
    this.corr += (corrTarget - this.corr) * 0.08;
    this.spectral = this.spectral.map((prev, i) => {
      const frac = i / (SPECTRAL_BANDS_HZ.length - 1);
      const base = active ? 0.97 - frac * 0.75 + Math.sin(t * 1.3 + i * 0.6) * 0.12 : 0;
      const target = this.phaseEvent > 0 && frac > 0.35 ? -0.6 + Math.sin(i) * 0.2 : base;
      const noisy = target + (Math.random() - 0.5) * 0.12;
      return Math.max(-1, Math.min(1, prev + (noisy - prev) * 0.2));
    });

    const telemetry: Telemetry = {
      seq: this.seq++,
      captureMode: "endpointLoopback",
      deviceName: "Speakers (Demo Signal)",
      sampleRate: 48000,
      active,
      elapsed: this.step / 10,
      tpMax: this.tpMax,
      tpCurrent,
      clipCount: this.clipCount,
      integrated,
      momentary: m,
      momentaryMax: this.mMax,
      shortTerm: s,
      shortTermMax: this.stMax,
      lra: this.lra(),
      psr: tpCurrent !== null && s !== null ? tpCurrent - s : null,
      plr: this.tpMax !== null && integrated !== null ? this.tpMax - integrated : null,
      correlation: this.corr,
      spectral: this.spectral.slice(),
      graph: this.pending,
      status: null,
    };
    this.pending = [];
    this.handlers.onTelemetry(telemetry);
  }
}

let engine: DemoEngine | null = null;

export function startDemo(handlers: DemoHandlers): () => void {
  engine?.stop();
  engine = new DemoEngine(handlers);
  engine.start();
  return () => {
    engine?.stop();
    engine = null;
  };
}

export function resetDemo() {
  engine?.reset();
}
