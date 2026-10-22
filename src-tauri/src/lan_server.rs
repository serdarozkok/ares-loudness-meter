//! Zero-Install iPhone / iPad / Android LAN Mirroring Server (`axum` + WebSocket).
//!
//! Serves a self-contained, full-screen responsive Web/PWA replica of Loudmeter
//! Pro at `http://<local-ip>:9876/` and streams 60fps JSON telemetry over
//! `ws://<local-ip>:9876/ws`. Raw audio never leaves the PC.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::{broadcast, oneshot};

pub const DEFAULT_LAN_PORT: u16 = 9876;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanInfo {
    pub running: bool,
    pub url: String,
    pub ws_url: String,
    pub ip: String,
    pub port: u16,
    pub clients: usize,
}

#[derive(Clone)]
struct ServerState {
    tx: broadcast::Sender<String>,
    clients: Arc<AtomicUsize>,
}

pub struct LanMirrorServer {
    tx: broadcast::Sender<String>,
    clients: Arc<AtomicUsize>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    port: Mutex<u16>,
}

impl LanMirrorServer {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            tx,
            clients: Arc::new(AtomicUsize::new(0)),
            shutdown: Mutex::new(None),
            port: Mutex::new(DEFAULT_LAN_PORT),
        }
    }

    pub fn broadcast_telemetry(&self, json: String) {
        if self.clients.load(Ordering::Relaxed) > 0 {
            let _ = self.tx.send(json);
        }
    }

    pub fn info(&self) -> LanInfo {
        let running = self.shutdown.lock().is_some();
        let ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = *self.port.lock();
        LanInfo {
            running,
            url: format!("http://{ip}:{port}/"),
            ws_url: format!("ws://{ip}:{port}/ws"),
            ip,
            port,
            clients: self.clients.load(Ordering::Relaxed),
        }
    }

    pub fn start(&self) -> LanInfo {
        if self.shutdown.lock().is_some() {
            return self.info();
        }
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let state = ServerState {
            tx: self.tx.clone(),
            clients: self.clients.clone(),
        };

        let (port_tx, port_rx) = std::sync::mpsc::channel::<u16>();
        std::thread::Builder::new()
            .name("loudmeter-lan-server".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                rt.block_on(async move {
                    let app = Router::new()
                        .route("/", get(index_handler))
                        .route("/ws", get(ws_handler))
                        .with_state(state);

                    let mut bound = None;
                    for p in [DEFAULT_LAN_PORT, 9877, 9878, 0] {
                        if let Ok(l) = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], p))).await {
                            bound = Some(l);
                            break;
                        }
                    }
                    let Some(listener) = bound else {
                        let _ = port_tx.send(DEFAULT_LAN_PORT);
                        return;
                    };
                    let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(DEFAULT_LAN_PORT);
                    let _ = port_tx.send(actual_port);

                    let _ = axum::serve(listener, app)
                        .with_graceful_shutdown(async move {
                            let _ = stop_rx.await;
                        })
                        .await;
                });
            })
            .ok();

        if let Ok(p) = port_rx.recv_timeout(std::time::Duration::from_millis(800)) {
            *self.port.lock() = p;
        }
        *self.shutdown.lock() = Some(stop_tx);
        self.info()
    }

    pub fn stop(&self) -> LanInfo {
        if let Some(tx) = self.shutdown.lock().take() {
            let _ = tx.send(());
        }
        self.clients.store(0, Ordering::Relaxed);
        self.info()
    }
}

async fn index_handler() -> Html<&'static str> {
    Html(MOBILE_MIRROR_HTML)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<ServerState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_client(socket, state))
}

async fn handle_ws_client(mut socket: WebSocket, state: ServerState) {
    state.clients.fetch_add(1, Ordering::Relaxed);
    let mut rx = state.tx.subscribe();
    while let Ok(msg) = rx.recv().await {
        if socket.send(Message::Text(msg.into())).await.is_err() {
            break;
        }
    }
    state.clients.fetch_sub(1, Ordering::Relaxed);
}

const MOBILE_MIRROR_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<title>ARES LOUDNESS METER · Live Mirror</title>
<style>
  :root {
    --bg: #111215;
    --card: #1A1C20;
    --border: #26282E;
    --text: #E8E9EC;
    --muted: #8A8F98;
    --orange: #FF7A00;
    --coral: #FF3B5C;
    --emerald: #10B981;
    --red: #EF4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
    font-variant-numeric: tabular-nums;
    padding: 14px;
    max-width: 560px;
    margin: 0 auto;
    user-select: none;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px;
  }
  .logo { font-weight: 800; letter-spacing: 0.08em; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--emerald); box-shadow: 0 0 8px var(--emerald); }
  .sr { font-size: 12px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px;
  }
  .full { grid-column: 1 / -1; }
  .lbl { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; display: flex; justify-content: space-between; }
  .val { font-size: 30px; font-weight: 800; margin-top: 4px; letter-spacing: -0.02em; }
  .unit { font-size: 12px; font-weight: 600; color: var(--muted); margin-left: 4px; }
  .tp { color: var(--orange); }
  .lufs { color: var(--coral); }
  .lu { color: var(--emerald); }
  .clip { padding: 2px 7px; border-radius: 99px; font-size: 10px; background: #26282E; color: var(--muted); }
  .clip.hot { background: var(--red); color: #fff; }
  canvas { width: 100%; height: 150px; display: block; border-radius: 8px; background: #14161A; margin-top: 8px; }
</style>
</head>
<body>
  <header>
    <div class="logo"><span class="dot" id="dot"></span>ARES LOUDNESS MIRROR</div>
    <div class="sr" id="sr">Connecting...</div>
  </header>
  <div class="grid">
    <div class="card full">
      <div class="lbl"><span>TRUE PEAK (MAX)</span><span class="clip" id="clips">0 CLIPS</span></div>
      <div class="val tp"><span id="tp">—</span><span class="unit">dBTP</span></div>
    </div>
    <div class="card full">
      <div class="lbl"><span>INTEGRATED LOUDNESS</span><span id="elapsed">0.0s</span></div>
      <div class="val lufs"><span id="int">—</span><span class="unit">LUFS</span></div>
    </div>
    <div class="card">
      <div class="lbl"><span>SHORT-TERM MAX</span></div>
      <div class="val lufs"><span id="shrt">—</span><span class="unit">LUFS</span></div>
    </div>
    <div class="card">
      <div class="lbl"><span>MOMENTARY MAX</span></div>
      <div class="val lufs"><span id="momn">—</span><span class="unit">LUFS</span></div>
    </div>
    <div class="card">
      <div class="lbl"><span>LRA</span></div>
      <div class="val lu"><span id="lra">—</span><span class="unit">LU</span></div>
    </div>
    <div class="card">
      <div class="lbl"><span>PSR</span></div>
      <div class="val lu"><span id="psr">—</span><span class="unit">LU</span></div>
    </div>
    <div class="card full">
      <div class="lbl"><span>REAL-TIME LOUDNESS (10s)</span></div>
      <canvas id="lgraph"></canvas>
    </div>
    <div class="card full">
      <div class="lbl"><span>SPECTRAL PHASE CORRELATION</span><span id="corr">+0.00</span></div>
      <canvas id="pgraph"></canvas>
    </div>
  </div>
<script>
const fmt = (v) => (v === null || v === undefined) ? '—' : Number(v).toFixed(1);
const hist = [];
let spectral = new Array(31).fill(0);
const lc = document.getElementById('lgraph');
const pc = document.getElementById('pgraph');

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onmessage = (ev) => {
    const t = JSON.parse(ev.data);
    document.getElementById('sr').textContent = (t.sampleRate / 1000).toFixed(3) + ' kHz · ' + t.deviceName;
    document.getElementById('tp').textContent = fmt(t.tpMax);
    document.getElementById('int').textContent = fmt(t.integrated);
    document.getElementById('shrt').textContent = fmt(t.shortTermMax ?? t.shortTerm);
    document.getElementById('momn').textContent = fmt(t.momentaryMax ?? t.momentary);
    document.getElementById('lra').textContent = fmt(t.lra);
    document.getElementById('psr').textContent = fmt(t.psr);
    document.getElementById('elapsed').textContent = (t.elapsed || 0).toFixed(1) + 's';
    const c = (t.correlation >= 0 ? '+' : '') + Number(t.correlation || 0).toFixed(2);
    document.getElementById('corr').textContent = c;
    const clipEl = document.getElementById('clips');
    clipEl.textContent = (t.clipCount || 0) + ' CLIPS';
    clipEl.className = t.clipCount > 0 ? 'clip hot' : 'clip';
    if (Array.isArray(t.graph)) {
      for (const p of t.graph) {
        if (hist.length && p.t < hist[hist.length - 1].t) hist.length = 0;
        hist.push(p);
      }
      while (hist.length > 120) hist.shift();
    }
    if (Array.isArray(t.spectral)) spectral = t.spectral;
  };
  ws.onclose = () => {
    document.getElementById('sr').textContent = 'Reconnecting...';
    setTimeout(connect, 1000);
  };
}
connect();

function draw() {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [lc, pc]) {
    const w = c.clientWidth * dpr, h = c.clientHeight * dpr;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }
  // Loudness graph
  const ctx = lc.getContext('2d');
  const w = lc.width, h = lc.height;
  ctx.clearRect(0, 0, w, h);
  if (hist.length > 1) {
    ctx.beginPath();
    const n = hist.length;
    for (let i = 0; i < n; i++) {
      const x = (i / Math.max(1, n - 1)) * w;
      const v = hist[i].l ?? hist[i].m ?? -60;
      const y = h - ((Math.max(-50, Math.min(0, v)) + 50) / 50) * (h - 16) - 8;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }
  // Phase graph
  const pctx = pc.getContext('2d');
  const pw = pc.width, ph = pc.height;
  pctx.clearRect(0, 0, pw, ph);
  pctx.strokeStyle = '#26282E';
  pctx.beginPath(); pctx.moveTo(0, ph / 2); pctx.lineTo(pw, ph / 2); pctx.stroke();
  pctx.beginPath();
  for (let i = 0; i < spectral.length; i++) {
    const x = (i / (spectral.length - 1)) * pw;
    const y = (ph / 2) - spectral[i] * (ph * 0.42);
    if (i === 0) pctx.moveTo(x, y); else pctx.lineTo(x, y);
  }
  pctx.strokeStyle = '#10B981';
  pctx.lineWidth = 2 * dpr;
  pctx.stroke();
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script>
</body>
</html>
"#;
