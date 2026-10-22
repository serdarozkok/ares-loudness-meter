//! ITU-R BS.1770-5 K-weighting filter.
//!
//! Two cascaded biquads:
//!  * Stage 1 – high-shelf "pre-filter" (+4 dB above ~1.5 kHz) modelling the
//!    acoustic effect of the head as a rigid sphere.
//!  * Stage 2 – "RLB" (revised low-frequency B-curve) 2nd-order high-pass.
//!
//! BS.1770 publishes coefficients only for 48 kHz. To support every device
//! rate (44.1, 48, 88.2, 96, 176.4, 192 kHz …) the analogue prototypes are
//! re-derived through the bilinear transform from the canonical design
//! parameters (f0, Q, gain) that reproduce the 48 kHz reference coefficients
//! to better than 1e-9. See `tests::matches_bs1770_reference_at_48k`.

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BiquadCoeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

/// Transposed direct-form II biquad (numerically robust in f64).
#[derive(Clone, Copy, Debug, Default)]
pub struct Biquad {
    c: BiquadCoeffs,
    z1: f64,
    z2: f64,
}

impl Biquad {
    pub fn new(c: BiquadCoeffs) -> Self {
        Self { c, z1: 0.0, z2: 0.0 }
    }

    #[inline(always)]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.c.b0 * x + self.z1;
        self.z1 = self.c.b1 * x - self.c.a1 * y + self.z2;
        self.z2 = self.c.b2 * x - self.c.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

// Canonical analogue design parameters (derived from the BS.1770 48 kHz table).
const SHELF_F0: f64 = 1681.974_450_955_533;
const SHELF_GAIN_DB: f64 = 3.999_843_853_973_347;
const SHELF_Q: f64 = 0.707_175_236_955_419_6;
const SHELF_VB_EXP: f64 = 0.499_666_774_154_541_6;
const HP_F0: f64 = 38.135_470_876_024_44;
const HP_Q: f64 = 0.500_327_037_323_877_3;

/// Stage 1 (high shelf) coefficients for a sample rate.
pub fn shelf_coeffs(sample_rate: f64) -> BiquadCoeffs {
    let k = (PI * SHELF_F0 / sample_rate).tan();
    let vh = 10f64.powf(SHELF_GAIN_DB / 20.0);
    let vb = vh.powf(SHELF_VB_EXP);
    let a0 = 1.0 + k / SHELF_Q + k * k;
    BiquadCoeffs {
        b0: (vh + vb * k / SHELF_Q + k * k) / a0,
        b1: 2.0 * (k * k - vh) / a0,
        b2: (vh - vb * k / SHELF_Q + k * k) / a0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / SHELF_Q + k * k) / a0,
    }
}

/// Stage 2 (RLB high-pass) coefficients for a sample rate.
pub fn highpass_coeffs(sample_rate: f64) -> BiquadCoeffs {
    let k = (PI * HP_F0 / sample_rate).tan();
    let a0 = 1.0 + k / HP_Q + k * k;
    BiquadCoeffs {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / HP_Q + k * k) / a0,
    }
}

/// Complete per-channel K-weighting cascade.
#[derive(Clone, Copy, Debug)]
pub struct KWeighting {
    shelf: Biquad,
    hp: Biquad,
    sample_rate: f64,
}

impl KWeighting {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            shelf: Biquad::new(shelf_coeffs(sample_rate)),
            hp: Biquad::new(highpass_coeffs(sample_rate)),
            sample_rate,
        }
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// Recalculates coefficients (and clears state) for a new device rate.
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        *self = Self::new(sample_rate);
    }

    #[inline(always)]
    pub fn process(&mut self, x: f64) -> f64 {
        self.hp.process(self.shelf.process(x))
    }

    pub fn reset(&mut self) {
        self.shelf.reset();
        self.hp.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_bs1770_reference_at_48k() {
        // ITU-R BS.1770-5, Table 1 & Table 2.
        let s = shelf_coeffs(48_000.0);
        assert!((s.b0 - 1.535_124_859_586_97).abs() < 1e-9);
        assert!((s.b1 - -2.691_696_189_406_38).abs() < 1e-9);
        assert!((s.b2 - 1.198_392_810_852_85).abs() < 1e-9);
        assert!((s.a1 - -1.690_659_293_182_41).abs() < 1e-9);
        assert!((s.a2 - 0.732_480_774_215_85).abs() < 1e-9);
        let h = highpass_coeffs(48_000.0);
        assert!((h.a1 - -1.990_047_454_833_98).abs() < 1e-9);
        assert!((h.a2 - 0.990_072_250_366_21).abs() < 1e-9);
    }

    #[test]
    fn k_weighting_gain_at_1khz_is_near_zero_db() {
        // A 997 Hz sine through K-weighting gains ~ +0.69 dB, which is exactly
        // what the −0.691 constant in the loudness formula compensates.
        for &fs in &[44_100.0, 48_000.0, 96_000.0, 192_000.0] {
            let mut k = KWeighting::new(fs);
            let n = (fs as usize) * 2;
            let mut acc = 0.0;
            for i in 0..n {
                let x = (2.0 * PI * 997.0 * i as f64 / fs).sin();
                let y = k.process(x);
                if i >= n / 2 {
                    acc += y * y;
                }
            }
            let ms = acc / (n / 2) as f64;
            let gain_db = 10.0 * (ms / 0.5).log10();
            assert!((gain_db - 0.691).abs() < 0.03, "fs={fs} gain={gain_db}");
        }
    }
}
