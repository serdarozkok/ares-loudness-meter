import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { currentWindowKind } from "./lib/env";
import { useSettings } from "./state/settings";
import { initTelemetry } from "./state/telemetry";
import { MiniBar } from "./components/minibar/MiniBar";
import { Inspector } from "./components/inspector/Inspector";

function AppRoot() {
  const kind = currentWindowKind();
  const theme = useSettings((s) => s.settings.theme);
  const initSettings = useSettings((s) => s.init);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    let cleanupSettings: (() => void) | undefined;
    let cleanupTelemetry: (() => void) | undefined;

    void initSettings().then((fn) => {
      cleanupSettings = fn;
    });
    void initTelemetry().then((fn) => {
      cleanupTelemetry = fn;
    });

    return () => {
      if (cleanupSettings) cleanupSettings();
      if (cleanupTelemetry) cleanupTelemetry();
    };
  }, [initSettings]);

  return kind === "minibar" ? <MiniBar /> : <Inspector />;
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
}
