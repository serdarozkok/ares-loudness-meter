# ARES Loudness Meter

**ARES Loudness Meter** is an ultra-low-CPU, standalone real-time loudness (`ITU-R BS.1770-5` / `EBU R128`), inter-sample True Peak (`dBTP`), and stereo/spectral phase metering application for **Windows 10/11** and **macOS**.

## Features

- **Synchronized Two-Window Architecture:**
  - **Mini-Bar:** Always-on-top, frameless 28px magnetic pill readout (`TP | INT | SHRT | MOMN | LRA | PSR`). Single-click toggles the Inspector; double-click resets all meters.
  - **Main Inspector Panel:** Draggable & pinnable vertical panel with sortable metric cards, 60fps real-time loudness history canvas, streaming platform target presets (`Spotify -14`, `Apple -16`, `YouTube -14`, `EBU R128 -23`, `Netflix -27`, `My Target`), and 31-band ISO 1/3-octave spectral phase correlation analyzer.
- **Strict Broadcast & Mastering DSP Engine (Rust):**
  - Exact sample-rate-adaptive `ITU-R BS.1770-5` K-weighting cascade (`44.1 kHz` – `192 kHz`).
  - Momentary (`400 ms`), Short-Term (`3000 ms`), Dual-Gated Integrated (`-70 LUFS` absolute / `-10 LU` relative), and Loudness Range (`EBU Tech 3342`).
  - `8x` / `4x` Kaiser-windowed polyphase FIR sinc oversampling True Peak detector (`dBTP`) with persistent Clip Counter.
  - `2048`-point Hann-windowed STFT spectral phase correlation (`20 Hz` – `20 kHz`) and broadband Pearson correlation (`Fast` / `Slow` ballistics).
- **Per-Application Audio Exclusion ("Ignore Apps"):**
  - Exclude individual applications (e.g., Chrome, Discord, Notification sounds) from system loopback measurement on Windows 10/11 (`20348+`).
- **ASIO Shared-Memory IPC Bridge (`Local\LoudmeterIPCBuffer`):**
  - Optional shared-memory receiver for exclusive-mode ASIO DAW workflows.
- **Ultra-Fast Multithreaded Offline File Analyzer & Session Report PNG:**
  - Drag and drop `WAV`, `MP3`, `FLAC`, `AIFF`, `M4A`, or `OGG` files to analyze full-track loudness contours and streaming normalization deltas in milliseconds, or export a high-DPI **Session Report PNG** card.
- **LAN Mobile WebSocket Mirror:**
  - Scan a local QR code to mirror live 20 Hz telemetry on any phone or tablet over Wi-Fi.

## Building from Source

```bash
npm install
npm run app:build
```
