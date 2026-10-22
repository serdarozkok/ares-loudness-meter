import { useEffect, useState } from "react";
import { api } from "../../lib/ipc";
import { isTauri } from "../../lib/env";
import type {
  AudioSessionInfo,
  CaptureStatus,
  DeviceInfo,
  MiniBarTextColor,
  MiniMetric,
  Settings,
  SilenceReset,
  SystemInfo,
  ThemeName,
} from "../../lib/types";
import { updateSettings } from "../../state/settings";
import { IconChevronDown, IconChevronUp, IconClose } from "../icons";

interface Props {
  settings: Settings;
  onClose: () => void;
}

const ALL_MINI_METRICS: ReadonlyArray<{ id: MiniMetric; label: string }> = [
  { id: "tp", label: "TP (True Peak Max)" },
  { id: "int", label: "INT (Integrated LUFS)" },
  { id: "shrt", label: "SHRT (Short-Term)" },
  { id: "momn", label: "MOMN (Momentary)" },
  { id: "lra", label: "LRA (Loudness Range)" },
  { id: "psr", label: "PSR (Peak-to-Short-Term)" },
  { id: "plr", label: "PLR (Peak-to-Loudness)" },
];

const MINI_COLORS: ReadonlyArray<{ id: MiniBarTextColor; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "white", label: "White" },
  { id: "black", label: "Black" },
  { id: "green", label: "Green" },
  { id: "orange", label: "Orange" },
  { id: "cyan", label: "Cyan" },
];

const SILENCE_OPTIONS: ReadonlyArray<{ v: SilenceReset; label: string }> = [
  { v: 0, label: "Never" },
  { v: 3, label: "3s" },
  { v: 5, label: "5s" },
  { v: 10, label: "10s" },
  { v: 30, label: "30s" },
];

export function SettingsPanel({ settings, onClose }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [sessions, setSessions] = useState<AudioSessionInfo[]>([]);
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [capStatus, setCapStatus] = useState<CaptureStatus | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!isTauri) {
        setDevices([
          { id: "default", name: "Speakers (Realtek High Definition Audio)", channels: 2, sampleRate: 48000, isDefault: true },
        ]);
        setSessions([
          { pid: 1040, exeName: "chrome.exe", displayName: "Google Chrome", icon: null, active: true },
          { pid: 2180, exeName: "discord.exe", displayName: "Discord", icon: null, active: false },
          { pid: 3420, exeName: "spotify.exe", displayName: "Spotify", icon: null, active: true },
        ]);
        setSysInfo({ windowsBuild: 22631, processLoopbackSupported: true, appVersion: "1.0.0" });
        return;
      }
      try {
        const [d, s, sys, cs] = await Promise.all([
          api.listDevices(),
          api.listAudioSessions(),
          api.getSystemInfo(),
          api.getCaptureStatus(),
        ]);
        if (!active) return;
        setDevices(d);
        setSessions(s);
        setSysInfo(sys);
        setCapStatus(cs);
      } catch (err) {
        console.error("Settings poll failed", err);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const selectedDevice =
    devices.find((d) => d.id === settings.deviceId) ??
    devices.find((d) => d.isDefault) ??
    devices[0];
  const pairCount = Math.max(1, Math.floor((selectedDevice?.channels ?? 2) / 2));

  const toggleMiniMetric = (id: MiniMetric) => {
    const cur = settings.miniBarMetrics;
    if (cur.includes(id)) {
      if (cur.length <= 1) return;
      updateSettings({ miniBarMetrics: cur.filter((m) => m !== id) });
    } else {
      updateSettings({ miniBarMetrics: [...cur, id] });
    }
  };

  const moveMiniMetric = (id: MiniMetric, dir: -1 | 1) => {
    const cur = [...settings.miniBarMetrics];
    const idx = cur.indexOf(id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= cur.length) return;
    [cur[idx], cur[target]] = [cur[target], cur[idx]];
    updateSettings({ miniBarMetrics: cur });
  };

  const toggleIgnoredApp = (exeName: string) => {
    const norm = exeName.toLowerCase();
    const cur = settings.ignoredApps.map((a) => a.toLowerCase());
    if (cur.includes(norm)) {
      updateSettings({ ignoredApps: cur.filter((a) => a !== norm) });
    } else {
      updateSettings({ ignoredApps: [...cur, norm] });
    }
  };

  // Merge active/enumerated sessions with previously saved ignored apps not currently running
  const knownExes = new Set(sessions.map((s) => s.exeName.toLowerCase()));
  const offlineIgnored = settings.ignoredApps
    .map((a) => a.toLowerCase())
    .filter((a) => !knownExes.has(a));

  return (
    <div className="lm-slide-in fixed inset-0 z-40 flex flex-col bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <span className="text-xs font-extrabold tracking-wider text-fg uppercase">
          SETTINGS & ROUTING
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="rounded-lg p-1 text-muted hover:bg-surface2 hover:text-fg"
        >
          <IconClose className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="thin-scroll flex-1 space-y-3 overflow-y-auto p-3">
        {/* 1. Audio Input & Device Selection */}
        <section className="card space-y-2.5 rounded-xl p-3">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">
            AUDIO INPUT & ROUTING
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                { id: "wasapi", label: "WASAPI Loopback" },
                { id: "ipc", label: "ASIO IPC Bridge" },
              ] as const
            ).map((src) => (
              <button
                key={src.id}
                type="button"
                onClick={() => updateSettings({ inputSource: src.id })}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
                  settings.inputSource === src.id
                    ? "border-graph/50 bg-graph/15 text-graph"
                    : "border-line bg-surface2 text-muted hover:text-fg"
                }`}
              >
                {src.label}
              </button>
            ))}
          </div>

          {settings.inputSource === "wasapi" ? (
            <>
              <div>
                <label className="block text-[10px] font-semibold text-muted uppercase">
                  Output Endpoint
                </label>
                <select
                  value={settings.deviceId ?? ""}
                  onChange={(e) =>
                    updateSettings({
                      deviceId: e.target.value === "" ? null : e.target.value,
                      channelPair: 0,
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-xs text-fg outline-none"
                >
                  <option value="">Automatic (Follow Default Windows Output)</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({(d.sampleRate / 1000).toFixed(1)} kHz · {d.channels}ch)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-muted uppercase">
                  Stereo Channel Pair
                </label>
                <select
                  value={settings.channelPair}
                  onChange={(e) => updateSettings({ channelPair: Number(e.target.value) })}
                  className="mt-1 w-full rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-xs text-fg outline-none"
                >
                  {Array.from({ length: pairCount }, (_, idx) => (
                    <option key={idx} value={idx}>
                      Out {idx * 2 + 1}-{idx * 2 + 2}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <p className="rounded-lg border border-line bg-surface2 p-2 text-[11px] text-muted">
              Listening on Named Shared Memory{" "}
              <code className="num text-fg">Local\LoudmeterIPCBuffer</code> for hardware-exclusive ASIO DAWs.
            </p>
          )}

          {capStatus && (
            <div className="num text-[10px] text-muted">
              Active: <span className="text-fg">{capStatus.deviceName}</span> ·{" "}
              {(capStatus.sampleRate / 1000).toFixed(3)} kHz
            </div>
          )}
        </section>

        {/* 2. Ignore Apps (Per-Application Audio Exclusion) */}
        <section className="card space-y-2 rounded-xl p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-wider text-muted uppercase">
              IGNORE APPS (PER-APP AUDIO EXCLUSION)
            </span>
            <span className="text-[10px] text-muted">
              {settings.ignoredApps.length} excluded
            </span>
          </div>
          <p className="text-[11px] text-muted">
            Checked apps are excluded from Loudmeter measurement via Windows Process Loopback so notifications, calls, or reference players never pollute your DAW mix.
          </p>

          {sysInfo && !sysInfo.processLoopbackSupported && (
            <div className="rounded-lg border border-amber/40 bg-amber/10 p-2 text-[11px] text-amber">
              Windows build {sysInfo.windowsBuild} detected. Process Loopback exclusion requires Windows 10 build 20348+ or Windows 11.
            </div>
          )}

          <div className="max-h-44 space-y-1 overflow-y-auto pr-0.5">
            {sessions.length === 0 && offlineIgnored.length === 0 && (
              <div className="rounded-lg bg-surface2 px-2.5 py-3 text-center text-xs text-muted">
                No active audio-producing applications detected. Play audio in an app to see it here.
              </div>
            )}

            {sessions.map((s) => {
              const checked = settings.ignoredApps
                .map((a) => a.toLowerCase())
                .includes(s.exeName.toLowerCase());
              return (
                <label
                  key={s.exeName}
                  className="flex cursor-pointer items-center justify-between rounded-lg border border-line bg-surface2/70 px-2.5 py-1.5 hover:bg-surface2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleIgnoredApp(s.exeName)}
                      className="accent-emerald-500"
                    />
                    {s.icon ? (
                      <img src={s.icon} alt="" className="h-4 w-4 shrink-0 rounded-xs" />
                    ) : (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-xs bg-surface text-[9px] font-bold text-muted">
                        {s.displayName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-fg">{s.displayName}</div>
                      <div className="num truncate text-[10px] text-muted">{s.exeName}</div>
                    </div>
                  </div>
                  <span
                    title={s.active ? "Currently playing audio" : "Idle session"}
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      s.active ? "bg-good shadow-[0_0_6px_rgba(16,185,129,0.7)]" : "bg-muted/40"
                    }`}
                  />
                </label>
              );
            })}

            {offlineIgnored.map((exe) => (
              <label
                key={exe}
                className="flex cursor-pointer items-center justify-between rounded-lg border border-line/60 bg-surface2/40 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggleIgnoredApp(exe)}
                    className="accent-emerald-500"
                  />
                  <span className="num text-xs text-muted">{exe} (not running)</span>
                </div>
              </label>
            ))}
          </div>
        </section>

        {/* 3. Appearance & Mini-Bar Customization */}
        <section className="card space-y-2.5 rounded-xl p-3">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">
            APPEARANCE & MINI-BAR
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase">Theme</label>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {(["dark", "color", "light"] as ThemeName[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => updateSettings({ theme: t })}
                  className={`rounded-lg border py-1 text-xs font-bold capitalize transition-colors ${
                    settings.theme === t
                      ? "border-graph/50 bg-graph/15 text-graph"
                      : "border-line bg-surface2 text-muted hover:text-fg"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase">
              Mini-Bar Text Color
            </label>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {MINI_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => updateSettings({ miniBarTextColor: c.id })}
                  className={`rounded-lg border py-1 text-xs font-semibold transition-colors ${
                    settings.miniBarTextColor === c.id
                      ? "border-graph/50 bg-graph/15 text-graph"
                      : "border-line bg-surface2 text-muted hover:text-fg"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase">
              Mini-Bar Metrics & Order
            </label>
            <div className="mt-1 space-y-1">
              {ALL_MINI_METRICS.map((m) => {
                const enabled = settings.miniBarMetrics.includes(m.id);
                return (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-lg bg-surface2 px-2.5 py-1"
                  >
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-fg">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleMiniMetric(m.id)}
                        className="accent-emerald-500"
                      />
                      <span>{m.label}</span>
                    </label>
                    {enabled && (
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => moveMiniMetric(m.id, -1)}
                          aria-label="Move up"
                          className="rounded p-0.5 text-muted hover:text-fg"
                        >
                          <IconChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveMiniMetric(m.id, 1)}
                          aria-label="Move down"
                          className="rounded p-0.5 text-muted hover:text-fg"
                        >
                          <IconChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* 4. Metering & Silence Reset */}
        <section className="card space-y-2.5 rounded-xl p-3">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">
            METERING & AUTO SILENCE RESET
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-fg">True Peak Ceiling (dBTP)</span>
            <input
              type="number"
              step="0.1"
              min="-6"
              max="3"
              value={settings.tpCeiling}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) updateSettings({ tpCeiling: v });
              }}
              className="num w-20 rounded-lg border border-line bg-surface2 px-2 py-1 text-right text-xs font-bold text-fg outline-none"
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-fg">Short-Term & Momentary Cards</span>
            <div className="inline-flex rounded-lg bg-surface2 p-0.5 text-xs font-semibold">
              {(["max", "live"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => updateSettings({ holdMode: m })}
                  className={`rounded-md px-2 py-0.5 capitalize ${
                    settings.holdMode === m ? "bg-surface text-fg" : "text-muted"
                  }`}
                >
                  {m === "max" ? "Max Hold" : "Live"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-muted uppercase">
              Auto-Reset on Silence (&lt; -70 dBFS)
            </label>
            <div className="mt-1 grid grid-cols-5 gap-1">
              {SILENCE_OPTIONS.map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => updateSettings({ silenceReset: o.v })}
                  className={`rounded-lg border py-1 text-xs font-semibold ${
                    settings.silenceReset === o.v
                      ? "border-graph/50 bg-graph/15 text-graph"
                      : "border-line bg-surface2 text-muted hover:text-fg"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 5. Smart Alerts */}
        <section className="card space-y-2 rounded-xl p-3">
          <div className="text-[10px] font-bold tracking-wider text-muted uppercase">
            WINDOWS TOAST SMART ALERTS
          </div>
          {[
            {
              key: "clipping" as const,
              label: "Clipping Alert",
              desc: `Notify when True Peak exceeds ${settings.tpCeiling.toFixed(1)} dBTP`,
            },
            {
              key: "overCompression" as const,
              label: "Over-Compression Alert",
              desc: "Notify when LRA drops below 4.0 LU during sustained playback",
            },
            {
              key: "phase" as const,
              label: "Phase Cancellation Alert",
              desc: "Notify when stereo correlation drops below -0.30 for > 1 s",
            },
          ].map((item) => (
            <label
              key={item.key}
              className="flex cursor-pointer items-center justify-between rounded-lg bg-surface2 px-2.5 py-2"
            >
              <div>
                <div className="text-xs font-semibold text-fg">{item.label}</div>
                <div className="text-[10px] text-muted">{item.desc}</div>
              </div>
              <input
                type="checkbox"
                checked={settings.alerts[item.key]}
                onChange={(e) =>
                  updateSettings({
                    alerts: { ...settings.alerts, [item.key]: e.target.checked },
                  })
                }
                className="accent-emerald-500"
              />
            </label>
          ))}
        </section>
      </div>
    </div>
  );
}
