//! Smart Alerts engine with rate-limited Windows native toast notifications:
//!  * Clipping Alert: True Peak exceeds `tp_ceiling` (default `0.0 dBTP`).
//!  * Over-Compression Alert: LRA drops below `4.0 LU` during sustained playback.
//!  * Phase Alert: Broadband stereo correlation drops below `-0.3` for > 1 second.

use crate::dsp::Telemetry;
use crate::settings::AlertSettings;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

pub struct AlertEngine {
    last_clip_alert: Option<Instant>,
    last_lra_alert: Option<Instant>,
    last_phase_alert: Option<Instant>,
    last_clip_count: u64,
    phase_bad_since: Option<Instant>,
}

impl AlertEngine {
    pub fn new() -> Self {
        Self {
            last_clip_alert: None,
            last_lra_alert: None,
            last_phase_alert: None,
            last_clip_count: 0,
            phase_bad_since: None,
        }
    }

    pub fn reset(&mut self) {
        self.last_clip_count = 0;
        self.phase_bad_since = None;
    }

    pub fn evaluate(&mut self, app: &AppHandle, t: &Telemetry, alerts: &AlertSettings, tp_ceiling: f64) {
        let now = Instant::now();
        let cooldown = Duration::from_secs(20);

        // 1. Clipping Alert
        if t.clip_count == 0 {
            self.last_clip_count = 0;
        } else if alerts.clipping && t.clip_count > self.last_clip_count {
            self.last_clip_count = t.clip_count;
            let ready = self.last_clip_alert.map(|i| now.duration_since(i) >= cooldown).unwrap_or(true);
            if ready {
                self.last_clip_alert = Some(now);
                let tp = t.tp_max.unwrap_or(tp_ceiling);
                let _ = app
                    .notification()
                    .builder()
                    .title("True Peak Clipping Detected")
                    .body(format!(
                        "True Peak reached {:+.1} dBTP (ceiling {:+.1} dBTP) · {} clips.",
                        tp, tp_ceiling, t.clip_count
                    ))
                    .show();
            }
        }

        // 2. Over-Compression Alert (sustained playback ≥ 12s, LRA < 4.0 LU)
        if alerts.over_compression && t.active && t.elapsed >= 12.0 {
            if let Some(lra) = t.lra {
                if lra < 4.0 {
                    let ready = self
                        .last_lra_alert
                        .map(|i| now.duration_since(i) >= Duration::from_secs(45))
                        .unwrap_or(true);
                    if ready {
                        self.last_lra_alert = Some(now);
                        let _ = app
                            .notification()
                            .builder()
                            .title("Over-Compression Warning")
                            .body(format!(
                                "Loudness Range dropped to {:.1} LU (< 4.0 LU) during sustained playback.",
                                lra
                            ))
                            .show();
                    }
                }
            }
        }

        // 3. Phase Alert (correlation < -0.3 continuously for > 1.0 second)
        if t.active && t.correlation < -0.3 {
            let start = *self.phase_bad_since.get_or_insert(now);
            if alerts.phase && now.duration_since(start) >= Duration::from_secs(1) {
                let ready = self
                    .last_phase_alert
                    .map(|i| now.duration_since(i) >= cooldown)
                    .unwrap_or(true);
                if ready {
                    self.last_phase_alert = Some(now);
                    let _ = app
                        .notification()
                        .builder()
                        .title("Severe Phase Cancellation")
                        .body(format!(
                            "Stereo phase correlation dropped to {:+.2} (< -0.30) for over 1 second.",
                            t.correlation
                        ))
                        .show();
                }
            }
        } else {
            self.phase_bad_since = None;
        }
    }
}
