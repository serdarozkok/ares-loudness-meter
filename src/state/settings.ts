import { create } from "zustand";
import { api, events } from "../lib/ipc";
import { isTauri } from "../lib/env";
import type { CardId, SectionId, Settings } from "../lib/types";

export const ALL_CARDS: readonly CardId[] = [
  "truePeak",
  "integrated",
  "instantLufs",
  "shortTerm",
  "momentary",
  "lra",
  "psr",
];
export const ALL_SECTIONS: readonly SectionId[] = ["cards", "graph", "phase"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  miniBarTextColor: "auto",
  miniBarMetrics: ["tp", "int", "shrt", "momn", "lra", "psr"],
  holdMode: "max",
  showPlr: false,
  target: "spotify",
  customTarget: -8,
  graphSpan: 10,
  ballistics: "slow",
  tpCeiling: 0,
  alerts: { clipping: true, overCompression: true, phase: true },
  silenceReset: 0,
  inputSource: "wasapi",
  deviceId: null,
  channelPair: 0,
  ignoredApps: [],
  cardOrder: [...ALL_CARDS],
  sectionOrder: [...ALL_SECTIONS],
  pinned: false,
};

/** Ensures order arrays contain every known id exactly once (robust against older persisted files). */
function normalizeOrder<T extends string>(order: readonly T[] | undefined, all: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const id of order ?? []) {
    if (all.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (let i = 0; i < all.length; i++) {
    const id = all[i];
    if (!seen.has(id)) {
      seen.add(id);
      if (i > 0) {
        const prevIdx = out.indexOf(all[i - 1]);
        if (prevIdx >= 0) {
          out.splice(prevIdx + 1, 0, id);
          continue;
        }
      }
      out.push(id);
    }
  }
  return out;
}

export function normalizeSettings(s: Partial<Settings> | null | undefined): Settings {
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...(s ?? {}),
    alerts: { ...DEFAULT_SETTINGS.alerts, ...(s?.alerts ?? {}) },
  };
  merged.cardOrder = normalizeOrder(merged.cardOrder, ALL_CARDS);
  merged.sectionOrder = normalizeOrder(merged.sectionOrder, ALL_SECTIONS);
  return merged;
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<() => void>;
  update: (partial: Partial<Settings>) => void;
}

/** Monotonic id of the most recent optimistic update; stale backend echoes are ignored. */
let updateRevision = 0;
let inFlight = 0;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  init: async () => {
    if (!isTauri) {
      set({ loaded: true });
      return () => undefined;
    }
    const unlisten = await events.onSettingsChanged((s) => {
      if (inFlight > 0) return;
      set({ settings: normalizeSettings(s) });
    });
    try {
      const s = await api.getSettings();
      set({ settings: normalizeSettings(s), loaded: true });
    } catch (err) {
      console.error("get_settings failed", err);
      set({ loaded: true });
    }
    return unlisten;
  },

  update: (partial) => {
    const next = normalizeSettings({ ...get().settings, ...partial });
    set({ settings: next });
    if (!isTauri) return;
    const rev = ++updateRevision;
    inFlight += 1;
    api
      .updateSettings(next)
      .then((saved) => {
        if (rev === updateRevision) set({ settings: normalizeSettings(saved) });
      })
      .catch((err) => console.error("update_settings failed", err))
      .finally(() => {
        inFlight = Math.max(0, inFlight - 1);
      });
  },
}));

export const updateSettings = (partial: Partial<Settings>) => useSettings.getState().update(partial);
