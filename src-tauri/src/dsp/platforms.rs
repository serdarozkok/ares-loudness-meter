//! Streaming-platform normalization simulator.
//!
//! For every platform the simulator derives the *effective* playback gain a
//! listener hears, honouring both the loudness target and each platform's
//! policy for quiet material (some never turn up, some only up to a true-peak
//! ceiling, broadcast specs require full compliance either way).

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoostPolicy {
    /// Positive gain allowed only until the true peak reaches the ceiling.
    PeakLimited,
    /// Quiet tracks are never turned up.
    Never,
    /// Delivery spec: full correction in both directions.
    Compliance,
}

pub struct Platform {
    pub id: &'static str,
    pub name: &'static str,
    pub target: f64,
    pub ceiling: f64,
    pub policy: BoostPolicy,
}

pub const PLATFORMS: &[Platform] = &[
    Platform { id: "spotify", name: "Spotify", target: -14.0, ceiling: -1.0, policy: BoostPolicy::PeakLimited },
    Platform { id: "apple", name: "Apple Music", target: -16.0, ceiling: -1.0, policy: BoostPolicy::PeakLimited },
    Platform { id: "youtube", name: "YouTube", target: -14.0, ceiling: -1.0, policy: BoostPolicy::Never },
    Platform { id: "amazon", name: "Amazon Music", target: -14.0, ceiling: -2.0, policy: BoostPolicy::Never },
    Platform { id: "tidal", name: "Tidal", target: -14.0, ceiling: -1.0, policy: BoostPolicy::Never },
    Platform { id: "deezer", name: "Deezer", target: -15.0, ceiling: -1.0, policy: BoostPolicy::Never },
    Platform { id: "ebu", name: "EBU R128", target: -23.0, ceiling: -1.0, policy: BoostPolicy::Compliance },
    Platform { id: "netflix", name: "Netflix", target: -27.0, ceiling: -2.0, policy: BoostPolicy::Compliance },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformResult {
    pub id: String,
    pub name: String,
    pub target_lufs: f64,
    pub tp_ceiling: f64,
    pub delta: f64,
    pub gain: f64,
    pub resulting_lufs: f64,
    pub resulting_tp: f64,
    pub status: &'static str,
    pub note: String,
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

pub fn simulate(integrated: f64, true_peak: f64) -> Vec<PlatformResult> {
    PLATFORMS
        .iter()
        .map(|p| {
            let delta = integrated - p.target;
            let wanted = p.target - integrated;
            let (gain, note) = if wanted <= 0.0 {
                if wanted.abs() < 0.05 {
                    (0.0, "On target – played back unchanged".to_string())
                } else {
                    (wanted, format!("Turned down {:.1} dB", -wanted))
                }
            } else {
                match p.policy {
                    BoostPolicy::Never => (0.0, "Platform never turns up quiet tracks".to_string()),
                    BoostPolicy::PeakLimited => {
                        let headroom = (p.ceiling - true_peak).max(0.0);
                        if headroom + 1e-9 < wanted {
                            (headroom, format!("Boost limited by {:.1} dBTP ceiling", p.ceiling))
                        } else {
                            (wanted, format!("Turned up {:.1} dB", wanted))
                        }
                    }
                    BoostPolicy::Compliance => (wanted, format!("Needs +{:.1} dB to comply", wanted)),
                }
            };
            let resulting_lufs = integrated + gain;
            let resulting_tp = true_peak + gain;
            let off_target = (resulting_lufs - p.target).abs();
            let status = if resulting_tp > p.ceiling || (p.policy == BoostPolicy::Compliance && delta.abs() > 6.0) {
                "red"
            } else if off_target > 1.0 || delta.abs() > 1.0 {
                "yellow"
            } else {
                "green"
            };
            let note = if resulting_tp > p.ceiling {
                format!("{note}; peaks {:.1} dBTP exceed {:.1} dBTP ceiling", resulting_tp, p.ceiling)
            } else {
                note
            };
            PlatformResult {
                id: p.id.to_string(),
                name: p.name.to_string(),
                target_lufs: p.target,
                tp_ceiling: p.ceiling,
                delta: r1(delta),
                gain: r1(gain),
                resulting_lufs: r1(resulting_lufs),
                resulting_tp: r1(resulting_tp),
                status,
                note,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loud_master_is_turned_down_on_spotify() {
        let r = simulate(-8.8, -0.4);
        let s = r.iter().find(|p| p.id == "spotify").unwrap();
        assert!((s.delta - 5.2).abs() < 1e-9);
        assert!((s.gain + 5.2).abs() < 1e-9);
        assert_eq!(s.status, "yellow");
    }

    #[test]
    fn quiet_master_boost_is_peak_limited() {
        let r = simulate(-18.0, -2.0);
        let s = r.iter().find(|p| p.id == "spotify").unwrap();
        assert!((s.gain - 1.0).abs() < 1e-9);
        let y = r.iter().find(|p| p.id == "youtube").unwrap();
        assert_eq!(y.gain, 0.0);
    }
}
