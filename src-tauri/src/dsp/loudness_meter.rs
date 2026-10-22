//! ITU-R BS.1770-5 / EBU R128 / EBU Tech 3342 loudness measurement.
//!
//! All windows are built from exact 100 ms sub-blocks ("steps") of K-weighted
//! mean-square energy, which guarantees the required 100 ms update rate and
//! 75 % overlap of the 400 ms gating blocks:
//!  * Momentary  = mean of the last 4 steps  (400 ms, un-gated)
//!  * Short-term = mean of the last 30 steps (3 s,   un-gated)
//!  * Integrated = gated mean of all 400 ms blocks (abs −70 LUFS, rel −10 LU)
//!  * LRA        = P95 − P10 of 3 s blocks (abs −70 LUFS, rel −20 LU)

use super::k_weighting::KWeighting;
use std::collections::VecDeque;

pub const ABS_GATE_LUFS: f64 = -70.0;
pub const REL_GATE_INTEGRATED_LU: f64 = -10.0;
pub const REL_GATE_LRA_LU: f64 = -20.0;
pub const MOMENTARY_STEPS: usize = 4;
pub const SHORT_TERM_STEPS: usize = 30;

/// L = −0.691 + 10·log10(z)
#[inline]
pub fn energy_to_lufs(e: f64) -> Option<f64> {
    if e > 1e-20 {
        Some(-0.691 + 10.0 * e.log10())
    } else {
        None
    }
}

#[inline]
pub fn lufs_to_energy(l: f64) -> f64 {
    10f64.powf((l + 0.691) / 10.0)
}

/// Gated integrated loudness from 400 ms block energies (BS.1770-5 §2.8).
pub fn integrated_from_blocks(blocks: &[f64]) -> Option<f64> {
    let abs_e = lufs_to_energy(ABS_GATE_LUFS);
    let (mut sum, mut n) = (0.0f64, 0usize);
    for &e in blocks {
        if e > abs_e {
            sum += e;
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }
    let rel_lufs = energy_to_lufs(sum / n as f64)? + REL_GATE_INTEGRATED_LU;
    let gate_e = lufs_to_energy(rel_lufs).max(abs_e);
    let (mut sum2, mut n2) = (0.0f64, 0usize);
    for &e in blocks {
        if e > gate_e {
            sum2 += e;
            n2 += 1;
        }
    }
    if n2 == 0 {
        return None;
    }
    energy_to_lufs(sum2 / n2 as f64)
}

fn percentile_sorted(sorted: &[f64], p: f64) -> f64 {
    let pos = p * (sorted.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    let frac = pos - lo as f64;
    sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

/// Loudness range from short-term (3 s) block energies (EBU Tech 3342).
pub fn lra_from_short_term(st_energies: &[f64]) -> Option<f64> {
    let abs_e = lufs_to_energy(ABS_GATE_LUFS);
    let gated: Vec<f64> = st_energies.iter().copied().filter(|&e| e > abs_e).collect();
    if gated.len() < 2 {
        return None;
    }
    let mean = gated.iter().sum::<f64>() / gated.len() as f64;
    let rel_e = lufs_to_energy(energy_to_lufs(mean)? + REL_GATE_LRA_LU);
    let mut l: Vec<f64> = gated.into_iter().filter(|&e| e > rel_e).filter_map(energy_to_lufs).collect();
    if l.len() < 2 {
        return None;
    }
    l.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(percentile_sorted(&l, 0.95) - percentile_sorted(&l, 0.10))
}

/// Number of samples in one 100 ms step at a sample rate.
#[inline]
pub fn step_len(sample_rate: f64) -> usize {
    ((sample_rate / 10.0).round() as usize).max(1)
}

/// Result emitted every completed 100 ms step.
#[derive(Clone, Copy, Debug)]
pub struct StepResult {
    pub index: u64,
    /// Energy of this single 100 ms block.
    pub block_energy: f64,
    pub momentary_energy: f64,
    pub short_term_energy: f64,
}

/// Streaming stereo loudness meter.
pub struct LoudnessMeter {
    kw: [KWeighting; 2],
    step_len: usize,
    step_pos: usize,
    step_acc: f64,
    steps: VecDeque<f64>,
    step_index: u64,
    blocks: Vec<f64>,
    st_blocks: Vec<f64>,
    momentary_max: f64,
    short_term_max: f64,
    integrated_cache: Option<f64>,
    lra_cache: Option<f64>,
    lra_dirty_steps: usize,
}

impl LoudnessMeter {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            kw: [KWeighting::new(sample_rate), KWeighting::new(sample_rate)],
            step_len: step_len(sample_rate),
            step_pos: 0,
            step_acc: 0.0,
            steps: VecDeque::with_capacity(SHORT_TERM_STEPS + 1),
            step_index: 0,
            blocks: Vec::with_capacity(36_000),
            st_blocks: Vec::with_capacity(36_000),
            momentary_max: 0.0,
            short_term_max: 0.0,
            integrated_cache: None,
            lra_cache: None,
            lra_dirty_steps: 0,
        }
    }

    /// Re-derives the K-weighting coefficients for a new device rate while
    /// preserving all accumulated statistics (integrated, LRA, max holds).
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        self.kw = [KWeighting::new(sample_rate), KWeighting::new(sample_rate)];
        self.step_len = step_len(sample_rate);
        self.step_pos = 0;
        self.step_acc = 0.0;
    }

    pub fn reset(&mut self) {
        self.kw.iter_mut().for_each(|k| k.reset());
        self.step_pos = 0;
        self.step_acc = 0.0;
        self.steps.clear();
        self.step_index = 0;
        self.blocks.clear();
        self.st_blocks.clear();
        self.momentary_max = 0.0;
        self.short_term_max = 0.0;
        self.integrated_cache = None;
        self.lra_cache = None;
        self.lra_dirty_steps = 0;
    }

    /// Feeds one stereo frame. Returns `Some` whenever a 100 ms step completes.
    #[inline]
    pub fn push(&mut self, l: f32, r: f32) -> Option<StepResult> {
        let yl = self.kw[0].process(l as f64);
        let yr = self.kw[1].process(r as f64);
        self.step_acc += yl * yl + yr * yr;
        self.step_pos += 1;
        if self.step_pos < self.step_len {
            return None;
        }
        let e = self.step_acc / self.step_len as f64;
        self.step_acc = 0.0;
        self.step_pos = 0;
        Some(self.complete_step(e))
    }

    fn complete_step(&mut self, e: f64) -> StepResult {
        self.steps.push_back(e);
        if self.steps.len() > SHORT_TERM_STEPS {
            self.steps.pop_front();
        }
        self.step_index += 1;
        let n = self.steps.len();
        let m_e = self.steps.iter().skip(n.saturating_sub(MOMENTARY_STEPS)).sum::<f64>() / MOMENTARY_STEPS as f64;
        let s_e = self.steps.iter().sum::<f64>() / SHORT_TERM_STEPS as f64;

        if self.step_index >= MOMENTARY_STEPS as u64 {
            self.blocks.push(m_e);
            self.integrated_cache = integrated_from_blocks(&self.blocks);
        }
        if self.step_index >= SHORT_TERM_STEPS as u64 {
            self.st_blocks.push(s_e);
            self.lra_dirty_steps += 1;
            if self.lra_dirty_steps >= 10 || self.lra_cache.is_none() {
                self.lra_cache = lra_from_short_term(&self.st_blocks);
                self.lra_dirty_steps = 0;
            }
        }
        self.momentary_max = self.momentary_max.max(m_e);
        self.short_term_max = self.short_term_max.max(s_e);
        StepResult { index: self.step_index, block_energy: e, momentary_energy: m_e, short_term_energy: s_e }
    }

    pub fn step_index(&self) -> u64 {
        self.step_index
    }

    pub fn integrated(&self) -> Option<f64> {
        self.integrated_cache
    }

    pub fn lra(&self) -> Option<f64> {
        self.lra_cache
    }

    pub fn momentary_max(&self) -> Option<f64> {
        energy_to_lufs(self.momentary_max)
    }

    pub fn short_term_max(&self) -> Option<f64> {
        energy_to_lufs(self.short_term_max)
    }

    pub fn blocks(&self) -> &[f64] {
        &self.blocks
    }

    pub fn short_term_blocks(&self) -> &[f64] {
        &self.st_blocks
    }
}

/// Offline helper: K-weights one channel and returns the per-step sum of squares.
pub fn channel_step_sums(samples: impl Iterator<Item = f32>, sample_rate: f64) -> Vec<f64> {
    let len = step_len(sample_rate);
    let mut kw = KWeighting::new(sample_rate);
    let mut out = Vec::new();
    let (mut acc, mut pos) = (0.0f64, 0usize);
    for x in samples {
        let y = kw.process(x as f64);
        acc += y * y;
        pos += 1;
        if pos == len {
            out.push(acc);
            acc = 0.0;
            pos = 0;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn sine(fs: f64, f: f64, amp_db: f64, secs: f64) -> Vec<f32> {
        let a = 10f64.powf(amp_db / 20.0);
        (0..(fs * secs) as usize).map(|i| (a * (2.0 * PI * f * i as f64 / fs).sin()) as f32).collect()
    }

    #[test]
    fn ebu_tech3341_case1_stereo_1khz_minus23() {
        // EBU Tech 3341 test 1: 1 kHz sine at −23 dBFS in both channels → −23.0 LUFS (M, S, I).
        let fs = 48_000.0;
        let s = sine(fs, 1000.0, -23.0, 20.0);
        let mut m = LoudnessMeter::new(fs);
        let mut last = None;
        for &x in &s {
            if let Some(r) = m.push(x, x) {
                last = Some(r);
            }
        }
        let r = last.unwrap();
        assert!((energy_to_lufs(r.momentary_energy).unwrap() + 23.0).abs() < 0.1);
        assert!((energy_to_lufs(r.short_term_energy).unwrap() + 23.0).abs() < 0.1);
        assert!((m.integrated().unwrap() + 23.0).abs() < 0.1);
    }

    #[test]
    fn ebu_tech3341_case3_gating() {
        // 10 s @ −36, 60 s @ −23, 10 s @ −36 dBFS → −23.0 LUFS integrated.
        for &fs in &[44_100.0, 48_000.0, 96_000.0] {
            let mut sig = sine(fs, 1000.0, -36.0, 10.0);
            sig.extend(sine(fs, 1000.0, -23.0, 60.0));
            sig.extend(sine(fs, 1000.0, -36.0, 10.0));
            let mut m = LoudnessMeter::new(fs);
            for &x in &sig {
                m.push(x, x);
            }
            assert!((m.integrated().unwrap() + 23.0).abs() < 0.1, "fs={fs} I={:?}", m.integrated());
        }
    }

    #[test]
    fn ebu_tech3342_lra_case1() {
        // 20 s @ −20 dBFS followed by 20 s @ −30 dBFS → LRA = 10 LU (±1).
        let fs = 48_000.0;
        let mut sig = sine(fs, 1000.0, -20.0, 20.0);
        sig.extend(sine(fs, 1000.0, -30.0, 20.0));
        let mut m = LoudnessMeter::new(fs);
        for &x in &sig {
            m.push(x, x);
        }
        let st = m.short_term_blocks().to_vec();
        let lra = lra_from_short_term(&st).unwrap();
        assert!((lra - 10.0).abs() < 1.0, "LRA={lra}");
    }
}
