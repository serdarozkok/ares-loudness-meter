//! Complete real-time DSP engine combining K-weighted loudness, polyphase True
//! Peak, stereo correlation, spectral phase correlation, silence auto-reset, and
//! 60fps telemetry frame generation.

pub mod k_weighting;
pub mod loudness_meter;
pub mod offline_analyzer;
pub mod platforms;
pub mod spectral_phase;
pub mod true_peak;

use loudness_meter::{energy_to_lufs, LoudnessMeter, SHORT_TERM_STEPS};
use serde::{Deserialize, Serialize};
use spectral_phase::{Ballistics, CorrelationMeter, SpectralPhase, SPECTRAL_BANDS_HZ};
use std::collections::VecDeque;
use true_peak::{lin_to_db, TruePeakMeter};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    EndpointLoopback,
    ProcessExclude,
    ProcessInclude,
    IpcBridge,
    None,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPoint {
    pub t: u64,
    pub l: Option<f64>,
    pub m: Option<f64>,
    pub s: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    pub seq: u64,
    pub capture_mode: CaptureMode,
    pub device_name: String,
    pub sample_rate: u32,
    pub active: bool,
    pub elapsed: f64,
    pub tp_max: Option<f64>,
    pub tp_current: Option<f64>,
    pub clip_count: u64,
    pub integrated: Option<f64>,
    pub momentary: Option<f64>,
    pub momentary_max: Option<f64>,
    pub short_term: Option<f64>,
    pub short_term_max: Option<f64>,
    pub lra: Option<f64>,
    pub psr: Option<f64>,
    pub plr: Option<f64>,
    pub correlation: f64,
    pub spectral: Vec<f32>,
    pub graph: Vec<GraphPoint>,
    pub status: Option<String>,
}

impl Default for Telemetry {
    fn default() -> Self {
        Self {
            seq: 0,
            capture_mode: CaptureMode::None,
            device_name: "Initializing...".to_string(),
            sample_rate: 48_000,
            active: false,
            elapsed: 0.0,
            tp_max: None,
            tp_current: None,
            clip_count: 0,
            integrated: None,
            momentary: None,
            momentary_max: None,
            short_term: None,
            short_term_max: None,
            lra: None,
            psr: None,
            plr: None,
            correlation: 0.0,
            spectral: vec![0.0; SPECTRAL_BANDS_HZ.len()],
            graph: Vec::new(),
            status: None,
        }
    }
}

fn r1(x: Option<f64>) -> Option<f64> {
    x.map(|v| (v * 10.0).round() / 10.0)
}

fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

pub struct DspProcessor {
    sample_rate: u32,
    loudness: LoudnessMeter,
    true_peak: TruePeakMeter,
    correlation: CorrelationMeter,
    spectral: SpectralPhase,
    tp_max_lin: f32,
    tp_step_max_lin: f32,
    tp_recent_steps: VecDeque<f32>,
    clip_ceiling_lin: f32,
    clip_count: u64,
    in_clip: bool,
    last_momentary: Option<f64>,
    last_short_term: Option<f64>,
    pending_graph: Vec<GraphPoint>,
    frames_measured: u64,
    silence_frames: u64,
    silence_reset_secs: u32,
    active_hold_frames: u64,
    seq: u64,
}

impl DspProcessor {
    pub fn new(sample_rate: u32, ballistics: Ballistics, tp_ceiling_db: f64, silence_reset_secs: u32) -> Self {
        let fs = sample_rate.max(8_000) as f64;
        Self {
            sample_rate,
            loudness: LoudnessMeter::new(fs),
            true_peak: TruePeakMeter::new(fs),
            correlation: CorrelationMeter::new(fs, ballistics),
            spectral: SpectralPhase::new(fs),
            tp_max_lin: 0.0,
            tp_step_max_lin: 0.0,
            tp_recent_steps: VecDeque::with_capacity(SHORT_TERM_STEPS + 1),
            clip_ceiling_lin: 10f32.powf((tp_ceiling_db as f32) / 20.0),
            clip_count: 0,
            in_clip: false,
            last_momentary: None,
            last_short_term: None,
            pending_graph: Vec::with_capacity(8),
            frames_measured: 0,
            silence_frames: 0,
            silence_reset_secs,
            active_hold_frames: 0,
            seq: 0,
        }
    }

    pub fn set_sample_rate(&mut self, sample_rate: u32) {
        if self.sample_rate == sample_rate || sample_rate == 0 {
            return;
        }
        self.sample_rate = sample_rate;
        let fs = sample_rate as f64;
        self.loudness.set_sample_rate(fs);
        self.true_peak = TruePeakMeter::new(fs);
        let b = Ballistics::Fast;
        self.correlation = CorrelationMeter::new(fs, b);
        self.spectral = SpectralPhase::new(fs);
    }

    pub fn set_ballistics(&mut self, b: Ballistics) {
        self.correlation.set_ballistics(b);
    }

    pub fn set_tp_ceiling_db(&mut self, db: f64) {
        self.clip_ceiling_lin = 10f32.powf((db as f32) / 20.0);
    }

    pub fn set_silence_reset(&mut self, secs: u32) {
        self.silence_reset_secs = secs;
    }

    pub fn reset(&mut self) {
        self.loudness.reset();
        self.true_peak.reset();
        self.correlation.reset();
        self.spectral.reset();
        self.tp_max_lin = 0.0;
        self.tp_step_max_lin = 0.0;
        self.tp_recent_steps.clear();
        self.clip_count = 0;
        self.in_clip = false;
        self.last_momentary = None;
        self.last_short_term = None;
        self.pending_graph.clear();
        self.frames_measured = 0;
        self.silence_frames = 0;
        self.active_hold_frames = 0;
    }

    /// Processes interleaved stereo samples `[L0, R0, L1, R1, ...]`.
    /// Returns `true` if an automatic silence reset was triggered.
    pub fn process_interleaved(&mut self, stereo: &[f32]) -> bool {
        let mut auto_reset = false;
        // −70 dBFS linear amplitude threshold ≈ 0.0003162
        const SILENCE_LIN: f32 = 0.000_316_227_76;
        let hold_samples = (self.sample_rate as u64) / 2; // 500 ms activity hold

        for frame in stereo.chunks_exact(2) {
            let l = frame[0];
            let r = frame[1];
            let abs_max = l.abs().max(r.abs());

            if abs_max > SILENCE_LIN {
                self.silence_frames = 0;
                self.active_hold_frames = hold_samples;
                self.frames_measured += 1;
            } else {
                self.silence_frames += 1;
                self.active_hold_frames = self.active_hold_frames.saturating_sub(1);
                if self.silence_reset_secs > 0
                    && self.frames_measured > 0
                    && self.silence_frames >= (self.sample_rate as u64) * (self.silence_reset_secs as u64)
                {
                    self.reset();
                    auto_reset = true;
                    continue;
                }
            }

            let tp = self.true_peak.push(l, r);
            if tp > self.tp_max_lin {
                self.tp_max_lin = tp;
            }
            if tp > self.tp_step_max_lin {
                self.tp_step_max_lin = tp;
            }
            if tp > self.clip_ceiling_lin {
                if !self.in_clip {
                    self.clip_count += 1;
                    self.in_clip = true;
                }
            } else if tp < self.clip_ceiling_lin * 0.95 {
                self.in_clip = false;
            }

            self.correlation.push(l, r);
            self.spectral.push(l, r);

            if let Some(step) = self.loudness.push(l, r) {
                self.tp_recent_steps.push_back(self.tp_step_max_lin);
                if self.tp_recent_steps.len() > SHORT_TERM_STEPS {
                    self.tp_recent_steps.pop_front();
                }
                self.tp_step_max_lin = 0.0;

                let l_lufs = energy_to_lufs(step.block_energy);
                let m_lufs = energy_to_lufs(step.momentary_energy);
                let s_lufs = if step.index >= SHORT_TERM_STEPS as u64 {
                    energy_to_lufs(step.short_term_energy)
                } else {
                    m_lufs
                };
                self.last_momentary = m_lufs;
                self.last_short_term = s_lufs;

                self.pending_graph.push(GraphPoint {
                    t: step.index,
                    l: r1(l_lufs),
                    m: r1(m_lufs),
                    s: r1(s_lufs),
                });
            }
        }
        auto_reset
    }

    pub fn snapshot(
        &mut self,
        capture_mode: CaptureMode,
        device_name: String,
        status: Option<String>,
    ) -> Telemetry {
        self.seq = self.seq.wrapping_add(1);
        let tp_max = lin_to_db(self.tp_max_lin).map(|v| v as f64);
        let tp_cur_lin = self
            .tp_recent_steps
            .iter()
            .copied()
            .fold(self.tp_step_max_lin, f32::max);
        let tp_current = lin_to_db(tp_cur_lin).map(|v| v as f64);

        let integrated = self.loudness.integrated();
        let momentary = self.last_momentary;
        let short_term = self.last_short_term;
        let momentary_max = self.loudness.momentary_max();
        let short_term_max = self.loudness.short_term_max();
        let lra = self.loudness.lra();

        let psr = match (tp_current, short_term) {
            (Some(tp), Some(st)) => Some(tp - st),
            _ => None,
        };
        let plr = match (tp_max, integrated) {
            (Some(tp), Some(i)) => Some(tp - i),
            _ => None,
        };

        let active = self.active_hold_frames > 0;
        let elapsed = self.frames_measured as f64 / self.sample_rate.max(1) as f64;
        let spectral = self
            .spectral
            .values()
            .iter()
            .map(|&v| if active { (v * 100.0).round() / 100.0 } else { (v * 85.0).round() / 100.0 })
            .collect();

        Telemetry {
            seq: self.seq,
            capture_mode,
            device_name,
            sample_rate: self.sample_rate,
            active,
            elapsed: r2(elapsed),
            tp_max: r1(tp_max),
            tp_current: r1(tp_current),
            clip_count: self.clip_count,
            integrated: r1(integrated),
            momentary: r1(momentary),
            momentary_max: r1(momentary_max),
            short_term: r1(short_term),
            short_term_max: r1(short_term_max),
            lra: r1(lra),
            psr: r1(psr),
            plr: r1(plr),
            correlation: r2(self.correlation.value()),
            spectral,
            graph: std::mem::take(&mut self.pending_graph),
            status,
        }
    }
}
