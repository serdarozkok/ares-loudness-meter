import { create } from "zustand";

export type ToastKind = "info" | "good" | "error";

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

interface ToastState {
  items: ToastItem[];
  push: (text: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
}

let seq = 1;

export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (text, kind = "info") => {
    const id = seq++;
    set((s) => ({ items: [...s.items.slice(-2), { id, text, kind }] }));
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    }, 3200);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

export function pushToast(text: string, kind: ToastKind = "info") {
  useToasts.getState().push(text, kind);
}

export function ToastHost() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-13 left-3 right-3 z-50 flex flex-col gap-1.5 pointer-events-none">
      {items.map((t) => {
        const border =
          t.kind === "good"
            ? "border-good/50 bg-surface2/95"
            : t.kind === "error"
              ? "border-warn/60 bg-surface2/95"
              : "border-line bg-surface2/95";
        const dot =
          t.kind === "good" ? "bg-good" : t.kind === "error" ? "bg-warn" : "bg-tp";
        return (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={`lm-toast-in pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-xs text-fg shadow-lg backdrop-blur ${border}`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
            <span className="truncate">{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}
