//! Inter-sample true-peak detector (ITU-R BS.1770-5 Annex 2).
//!
//! The signal is up-sampled with a polyphase windowed-sinc interpolator and the
//! absolute maximum of the interpolated stream is reported in dBTP.
//!  * fs ≤ 48 kHz  → 8× oversampling, 16 taps / phase (128-tap prototype)
//!  * fs ≤ 96 kHz  → 4× oversampling, 12 taps / phase  (48-tap prototype)
//!  * fs  > 96 kHz → 4× oversampling, 12 taps / phase (spec minimum)
//!
//! Each polyphase branch is normalised to unity DC gain so the interpolator
//! never over-reads static signals, and the Kaiser-windowed prototype keeps
//! pass-band ripple below ±0.02 dB up to 0.9·Nyquist.

#[derive(Clone, Debug)]
pub struct Polyphase {
    pub factor: usize,
    pub taps: usize,
    /// `coeffs[phase * taps + k]`
    coeffs: Vec<f32>,
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..64 {
        term *= (half / k as f64) * (half / k as f64);
        sum += term;
        if term < 1e-14 * sum {
            break;
        }
    }
    sum
}

impl Polyphase {
    pub fn for_sample_rate(sample_rate: f64) -> Self {
        if sample_rate <= 48_000.0 {
            Self::design(8, 16, 8.0)
        } else {
            Self::design(4, 12, 7.0)
        }
    }

    pub fn design(factor: usize, taps: usize, kaiser_beta: f64) -> Self {
        let n = factor * taps;
        let center = (n as f64 - 1.0) / 2.0;
        let i0_beta = bessel_i0(kaiser_beta);
        let mut proto = vec![0.0f64; n];
        for (i, h) in proto.iter_mut().enumerate() {
            let t = (i as f64 - center) / factor as f64;
            let sinc = if t.abs() < 1e-12 {
                1.0
            } else {
                (std::f64::consts::PI * t).sin() / (std::f64::consts::PI * t)
            };
            let r = (i as f64 - center) / (n as f64 / 2.0);
            let w = bessel_i0(kaiser_beta * (1.0 - r * r).max(0.0).sqrt()) / i0_beta;
            *h = sinc * w;
        }
        let mut coeffs = vec![0.0f32; n];
        for p in 0..factor {
            let sum: f64 = (0..taps).map(|k| proto[p + factor * k]).sum();
            for k in 0..taps {
                coeffs[p * taps + k] = (proto[p + factor * k] / sum) as f32;
            }
        }
        Self { factor, taps, coeffs }
    }
}

/// Streaming single-channel true-peak interpolator.
#[derive(Clone, Debug)]
pub struct TruePeakChannel {
    poly: std::sync::Arc<Polyphase>,
    /// Double-length history so the newest `taps` samples are always contiguous.
    hist: Vec<f32>,
    pos: usize,
}

impl TruePeakChannel {
    pub fn new(poly: std::sync::Arc<Polyphase>) -> Self {
        let taps = poly.taps;
        Self { poly, hist: vec![0.0; taps * 2], pos: 0 }
    }

    pub fn reset(&mut self) {
        self.hist.iter_mut().for_each(|v| *v = 0.0);
        self.pos = 0;
    }

    /// Pushes one sample; returns the absolute peak of all interpolated points
    /// produced for this input sample.
    #[inline]
    pub fn push(&mut self, x: f32) -> f32 {
        let taps = self.poly.taps;
        self.hist[self.pos] = x;
        self.hist[self.pos + taps] = x;
        // Newest sample at index (pos + taps), oldest at (pos + 1).
        let window = &self.hist[self.pos + 1..self.pos + 1 + taps];
        self.pos = (self.pos + 1) % taps;
        let mut peak = 0.0f32;
        for p in 0..self.poly.factor {
            let c = &self.poly.coeffs[p * taps..(p + 1) * taps];
            // c[k] multiplies x[m - k]; window[taps-1-k] == x[m - k].
            let mut acc = 0.0f32;
            for k in 0..taps {
                acc += c[k] * window[taps - 1 - k];
            }
            peak = peak.max(acc.abs());
        }
        peak.max(x.abs())
    }
}

/// Stereo streaming true-peak meter.
#[derive(Clone, Debug)]
pub struct TruePeakMeter {
    l: TruePeakChannel,
    r: TruePeakChannel,
}

impl TruePeakMeter {
    pub fn new(sample_rate: f64) -> Self {
        let poly = std::sync::Arc::new(Polyphase::for_sample_rate(sample_rate));
        Self { l: TruePeakChannel::new(poly.clone()), r: TruePeakChannel::new(poly) }
    }

    pub fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }

    /// Returns the linear inter-sample peak of this stereo frame.
    #[inline]
    pub fn push(&mut self, l: f32, r: f32) -> f32 {
        self.l.push(l).max(self.r.push(r))
    }
}

/// Offline helper: linear true peak of a mono slice, primed with `preroll`
/// samples (the tail of the previous chunk) so chunks can run in parallel.
pub fn true_peak_chunk(poly: &std::sync::Arc<Polyphase>, preroll: &[f32], chunk: &[f32]) -> f32 {
    let mut ch = TruePeakChannel::new(poly.clone());
    for &x in preroll {
        ch.push(x);
    }
    let mut peak = 0.0f32;
    for &x in chunk {
        peak = peak.max(ch.push(x));
    }
    peak
}

#[inline]
pub fn lin_to_db(x: f32) -> Option<f32> {
    if x > 1e-9 {
        Some(20.0 * x.log10())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_intersample_peak_of_fs_over_4_sine() {
        // Sine at fs/4 with 45° phase: samples hit ±0.7071, true peak is 1.0 (0 dBTP).
        let fs = 48_000.0;
        let mut m = TruePeakMeter::new(fs);
        let mut peak = 0.0f32;
        for i in 0..4800 {
            let x = (std::f64::consts::FRAC_PI_2 * i as f64 + std::f64::consts::FRAC_PI_4).sin() as f32;
            peak = peak.max(m.push(x, x));
        }
        let db = lin_to_db(peak).unwrap();
        assert!(db > -0.1 && db < 0.1, "true peak {db} dBTP");
    }

    #[test]
    fn passes_dc_and_low_freq_at_unity() {
        let mut m = TruePeakMeter::new(44_100.0);
        let mut peak = 0.0f32;
        for i in 0..44_100 {
            let x = 0.5 * (2.0 * std::f64::consts::PI * 100.0 * i as f64 / 44_100.0).sin() as f32;
            peak = peak.max(m.push(x, x));
        }
        assert!((peak - 0.5).abs() < 0.002, "peak {peak}");
    }
}
