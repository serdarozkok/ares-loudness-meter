import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../../lib/ipc";
import { isTauri } from "../../lib/env";
import type { LanInfo } from "../../lib/types";
import { IconClose } from "../icons";

interface Props {
  onClose: () => void;
}

export function LanModal({ onClose }: Props) {
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");

  useEffect(() => {
    let active = true;
    const init = async () => {
      if (!isTauri) {
        const mock: LanInfo = {
          running: true,
          url: "http://192.168.1.50:9876/",
          wsUrl: "ws://192.168.1.50:9876/ws",
          ip: "192.168.1.50",
          port: 9876,
          clients: 0,
        };
        setInfo(mock);
        const qr = await QRCode.toDataURL(mock.url, { width: 220, margin: 1 });
        if (active) setQrDataUrl(qr);
        return;
      }
      try {
        const res = await api.startLanServer();
        if (!active) return;
        setInfo(res);
        const qr = await QRCode.toDataURL(res.url, { width: 220, margin: 1 });
        if (active) setQrDataUrl(qr);
      } catch (err) {
        console.error("Failed to start LAN server", err);
      }
    };
    void init();

    const interval = window.setInterval(() => {
      if (!isTauri) return;
      void api.getLanInfo().then((r) => {
        if (active) setInfo(r);
      });
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const toggleServer = async () => {
    if (!isTauri || !info) return;
    if (info.running) {
      const next = await api.stopLanServer();
      setInfo(next);
    } else {
      const next = await api.startLanServer();
      setInfo(next);
      const qr = await QRCode.toDataURL(next.url, { width: 220, margin: 1 });
      setQrDataUrl(qr);
    }
  };

  return (
    <div
      onClick={onClose}
      className="lm-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card w-full max-w-[330px] rounded-2xl p-4 text-center"
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-extrabold tracking-wider text-fg uppercase">
            MOBILE LAN MIRROR (60 FPS)
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close LAN modal"
            className="rounded-md p-1 text-muted hover:bg-surface2 hover:text-fg"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-1.5 text-[11px] text-muted">
          Scan with your iPhone, iPad, or Android camera on the same Wi-Fi network.
        </p>

        <div className="my-3 flex justify-center">
          {qrDataUrl && info?.running ? (
            <img
              src={qrDataUrl}
              alt="LAN Mirror QR Code"
              className="h-[200px] w-[200px] rounded-xl border border-line bg-white p-2 shadow-md"
            />
          ) : (
            <div className="flex h-[200px] w-[200px] items-center justify-center rounded-xl border border-line bg-surface2 text-xs text-muted">
              {info?.running === false ? "Server Stopped" : "Generating QR..."}
            </div>
          )}
        </div>

        {info && (
          <div className="rounded-lg border border-line bg-surface2 px-3 py-2 text-left text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted uppercase">URL</span>
              <span className="num text-[11px] font-bold text-graph">{info.url}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold text-muted uppercase">CONNECTED DEVICES</span>
              <span className="num text-[11px] font-bold text-fg">{info.clients}</span>
            </div>
          </div>
        )}

        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={() => void toggleServer()}
            className={`flex-1 rounded-lg py-1.5 text-xs font-bold transition-colors ${
              info?.running
                ? "bg-warn/20 text-warn border border-warn/40 hover:bg-warn/30"
                : "bg-good/20 text-good border border-good/40 hover:bg-good/30"
            }`}
          >
            {info?.running ? "Stop Server" : "Start Server"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-line bg-surface2 py-1.5 text-xs font-bold text-fg hover:bg-surface"
          >
            Done
          </button>
        </div>

        <p className="mt-2.5 text-[10px] leading-relaxed text-muted/80">
          Strict Privacy: Only lightweight numeric & graph JSON telemetry is sent over your local LAN. Raw audio never leaves this PC.
        </p>
      </div>
    </div>
  );
}
