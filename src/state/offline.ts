import { create } from "zustand";
import { api } from "../lib/ipc";
import type { OfflineResult } from "../lib/types";
import { pushToast } from "../components/Toast";

interface OfflineState {
  result: OfflineResult | null;
  analyzing: boolean;
  error: string | null;
  analyzePath: (path: string) => Promise<void>;
  clear: () => void;
}

export const useOffline = create<OfflineState>((set) => ({
  result: null,
  analyzing: false,
  error: null,

  analyzePath: async (path: string) => {
    set({ analyzing: true, error: null });
    try {
      const res = await api.analyzeFile(path);
      set({ result: res, analyzing: false, error: null });
      pushToast(`Analyzed ${res.fileName} in ${res.decodeMs + res.analysisMs} ms`, "good");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ analyzing: false, error: msg });
      pushToast(`Offline analysis failed: ${msg}`, "error");
    }
  },

  clear: () => set({ result: null, error: null }),
}));
