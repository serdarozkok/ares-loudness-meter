import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** True when running inside a Tauri webview (false in a plain browser via `npm run dev`). */
export const isTauri: boolean =
  typeof window !== "undefined" &&
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

export type WindowKind = "minibar" | "inspector";

export function currentWindowKind(): WindowKind {
  if (!isTauri) return "inspector";
  try {
    return getCurrentWebviewWindow().label === "minibar" ? "minibar" : "inspector";
  } catch {
    return "inspector";
  }
}
