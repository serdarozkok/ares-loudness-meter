//! Stereo phase analysis:
//!  * Broadband Pearson correlation over a sliding 1 s window with exponential
//!    ballistics (Fast τ = 150 ms, Slow τ = 600 ms).
//!  * Spectral phase correlation: 2048-point Hann-windowed STFT (50 % hop),
//!    exponentially averaged auto/cross spectra, grouped into ISO 1/3-octave
//!    bands from 20 Hz to 20 kHz:
//!        ρ_band = Σ Re(X_L·X_R*) / sqrt(Σ|X_L|² · Σ|X_R|²)

use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::collections::VecDeque;
use std::sync::Arc;

pub const FFT_SIZE: usize = 2048;
pub const HOP: usize = FFT_SIZE / 2;

pub const SPECTRAL_BANDS_HZ: [f32; 31] = [
    20.0, 25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0, 500.0, 630.0,
    800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0, 5000.0, 6300.0, 8000.0, 10000.0, 12500.0,
    16000.0, 20000.0,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ballistics {
    Fast,
    Slow,
}

impl Ballistics {
    pub fn tau_seconds(self) -> f64 {
        match self {
            Ballistics::Fast => 0.150,
            Ballistics::Slow => 0.600,
        }
    }
}

/// Sub-block (10 ms) running sums for the 1 s Pearson window.
#[derive(Clone, Copy, Default)]
struct Sums {
    n: f64,
    l: f64,
    r: f64,
    ll: f64,
    rr: f64,
    lr: f64,
}

impl Sums {
    fn add(&mut self, o: &Sums) {
        self.n += o.n;
        self.l += o.l;
        self.r += o.r;
        self.ll += o.ll;
        self.rr += o.rr;
        self.lr += o.lr;
    }
    fn sub(&mut self, o: &Sums) {
        self.n -= o.n;
        self.l -= o.l;
        self.r -= o.r;
        self.ll -= o.ll;
        self.rr -= o.rr;
        self.lr -= o.lr;
    }
}

pub struct CorrelationMeter {
    sub_len: usize,
    sub_pos: usize,
    cur: Sums,
    ring: VecDeque<Sums>,
    window: Sums,
    ring_cap: usize,
    smoothed: f64,
    alpha: f64,
    ballistics: Ballistics,
    sample_rate: f64,
    accum_rebuild: usize,
}

/// Silence floor for correlation: −70 dBFS RMS.
const SILENCE_MS: f64 = 1e-7;

impl CorrelationMeter {
    pub fn new(sample_rate: f64, ballistics: Ballistics) -> Self {
        let sub_len = ((sample_rate / 100.0).round() as usize).max(1);
        let mut m = Self {
            sub_len,
            sub_pos: 0,
            cur: Sums::default(),
            ring: VecDeque::with_capacity(101),
            window: Sums::default(),
            ring_cap: 100,
            smoothed: 0.0,
            alpha: 0.0,
            ballistics,
            sample_rate,
            accum_rebuild: 0,
        };
        m.set_ballistics(ballistics);
        m
    }

    pub fn set_ballistics(&mut self, b: Ballistics) {
        self.ballistics = b;
        let dt = self.sub_len as f64 / self.sample_rate;
        self.alpha = 1.0 - (-dt / b.tau_seconds()).exp();
    }

    pub fn reset(&mut self) {
        let b = self.ballistics;
        *self = Self::new(self.sample_rate, b);
    }

    #[inline]
    pub fn push(&mut self, l: f32, r: f32) {
        let (l, r) = (l as f64, r as f64);
        self.cur.n += 1.0;
        self.cur.l += l;
        self.cur.r += r;
        self.cur.ll += l * l;
        self.cur.rr += r * r;
        self.cur.lr += l * r;
        self.sub_pos += 1;
        if self.sub_pos >= self.sub_len {
            self.finish_sub_block();
        }
    }

    fn finish_sub_block(&mut self) {
        let block = self.cur;
        self.cur = Sums::default();
        self.sub_pos = 0;
        self.ring.push_back(block);
        self.window.add(&block);
        if self.ring.len() > self.ring_cap {
            if let Some(old) = self.ring.pop_front() {
                self.window.sub(&old);
            }
        }
        // Periodically rebuild the window sums to cancel floating-point drift.
        self.accum_rebuild += 1;
        if self.accum_rebuild >= 1000 {
            self.accum_rebuild = 0;
            let mut w = Sums::default();
            for s in &self.ring {
                w.add(s);
            }
            self.window = w;
        }
        let w = &self.window;
        let target = if w.n > 0.0 {
            let var_l = w.ll - w.l * w.l / w.n;
            let var_r = w.rr - w.r * w.r / w.n;
            let cov = w.lr - w.l * w.r / w.n;
            if var_l / w.n > SILENCE_MS && var_r / w.n > SILENCE_MS {
                (cov / (var_l * var_r).sqrt()).clamp(-1.0, 1.0)
            } else {
                // Silence or a one-sided signal has no phase relationship → neutral.
                0.0
            }
        } else {
            0.0
        };
        self.smoothed += self.alpha * (target - self.smoothed);
    }

    pub fn value(&self) -> f64 {
        self.smoothed
    }
}

/// Precomputed bin ranges per display band.
fn band_bins(sample_rate: f64) -> Vec<(usize, usize)> {
    let bin_hz = sample_rate / FFT_SIZE as f64;
    let max_bin = FFT_SIZE / 2;
    let k = 2f64.powf(1.0 / 6.0);
    SPECTRAL_BANDS_HZ
        .iter()
        .map(|&fc| {
            let fc = fc as f64;
            let lo = ((fc / k) / bin_hz).ceil() as usize;
            let hi = ((fc * k) / bin_hz).floor() as usize;
            let lo = lo.clamp(1, max_bin);
            let hi = hi.clamp(1, max_bin);
            if hi >= lo {
                (lo, hi)
            } else {
                let c = ((fc / bin_hz).round() as usize).clamp(1, max_bin);
                (c, c)
            }
        })
        .collect()
}

pub struct SpectralPhase {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    fill: usize,
    scratch_l: Vec<Complex32>,
    scratch_r: Vec<Complex32>,
    fft_scratch: Vec<Complex32>,
    sxx: Vec<f32>,
    syy: Vec<f32>,
    sxy: Vec<f32>,
    bands: Vec<(usize, usize)>,
    values: Vec<f32>,
    avg_alpha: f32,
    sample_rate: f64,
}

impl SpectralPhase {
    pub fn new(sample_rate: f64) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let window = (0..FFT_SIZE)
            .map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / FFT_SIZE as f64).cos()) as f32)
            .collect();
        let scratch_len = fft.get_inplace_scratch_len();
        // Spectral averaging time constant ≈ 300 ms regardless of sample rate.
        let frame_dt = HOP as f64 / sample_rate;
        let avg_alpha = (1.0 - (-frame_dt / 0.3).exp()) as f32;
        Self {
            fft,
            window,
            buf_l: vec![0.0; FFT_SIZE],
            buf_r: vec![0.0; FFT_SIZE],
            fill: 0,
            scratch_l: vec![Complex32::default(); FFT_SIZE],
            scratch_r: vec![Complex32::default(); FFT_SIZE],
            fft_scratch: vec![Complex32::default(); scratch_len],
            sxx: vec![0.0; FFT_SIZE / 2 + 1],
            syy: vec![0.0; FFT_SIZE / 2 + 1],
            sxy: vec![0.0; FFT_SIZE / 2 + 1],
            bands: band_bins(sample_rate),
            values: vec![0.0; SPECTRAL_BANDS_HZ.len()],
            avg_alpha,
            sample_rate,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.sample_rate);
    }

    #[inline]
    pub fn push(&mut self, l: f32, r: f32) {
        self.buf_l[self.fill] = l;
        self.buf_r[self.fill] = r;
        self.fill += 1;
        if self.fill == FFT_SIZE {
            self.analyze_frame();
            self.buf_l.copy_within(HOP.., 0);
            self.buf_r.copy_within(HOP.., 0);
            self.fill = FFT_SIZE - HOP;
        }
    }

    fn analyze_frame(&mut self) {
        for i in 0..FFT_SIZE {
            self.scratch_l[i] = Complex32::new(self.buf_l[i] * self.window[i], 0.0);
            self.scratch_r[i] = Complex32::new(self.buf_r[i] * self.window[i], 0.0);
        }
        self.fft.process_with_scratch(&mut self.scratch_l, &mut self.fft_scratch);
        self.fft.process_with_scratch(&mut self.scratch_r, &mut self.fft_scratch);
        let a = self.avg_alpha;
        for k in 0..=FFT_SIZE / 2 {
            let xl = self.scratch_l[k];
            let xr = self.scratch_r[k];
            let pxx = xl.norm_sqr();
            let pyy = xr.norm_sqr();
            let pxy = xl.re * xr.re + xl.im * xr.im; // Re(X_L · conj(X_R))
            self.sxx[k] += a * (pxx - self.sxx[k]);
            self.syy[k] += a * (pyy - self.syy[k]);
            self.sxy[k] += a * (pxy - self.sxy[k]);
        }
        // Energy floor ≈ −80 dBFS per bin (Hann-windowed 2048-pt FFT scaling).
        let floor = (FFT_SIZE as f32 * 0.25).powi(2) * 1e-8;
        for (bi, &(lo, hi)) in self.bands.iter().enumerate() {
            let (mut xx, mut yy, mut xy) = (0.0f32, 0.0f32, 0.0f32);
            for k in lo..=hi {
                xx += self.sxx[k];
                yy += self.syy[k];
                xy += self.sxy[k];
            }
            let bins = (hi - lo + 1) as f32;
            let target = if xx / bins > floor && yy / bins > floor {
                (xy / (xx * yy).sqrt()).clamp(-1.0, 1.0)
            } else {
                0.0
            };
            // Additional cross-frame smoothing for a calm, readable curve.
            self.values[bi] += 0.35 * (target - self.values[bi]);
        }
    }

    pub fn values(&self) -> &[f32] {
        &self.values
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_signal_correlates_plus_one_and_inverted_minus_one() {
        let fs = 48_000.0;
        let mut c = CorrelationMeter::new(fs, Ballistics::Fast);
        let mut c2 = CorrelationMeter::new(fs, Ballistics::Fast);
        let mut sp = SpectralPhase::new(fs);
        for i in 0..(fs as usize * 3) {
            let x = (2.0 * std::f64::consts::PI * 440.0 * i as f64 / fs).sin() as f32 * 0.5;
            c.push(x, x);
            c2.push(x, -x);
            sp.push(x, -x);
        }
        assert!(c.value() > 0.99);
        assert!(c2.value() < -0.99);
        let idx = SPECTRAL_BANDS_HZ.iter().position(|&f| f == 400.0).unwrap();
        assert!(sp.values()[idx] < -0.95, "band = {}", sp.values()[idx]);
    }
}
