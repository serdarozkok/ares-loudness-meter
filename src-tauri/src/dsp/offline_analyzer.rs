//! Ultra-fast multithreaded offline audio analyzer (`symphonia` + `rayon`).
//!
//! Decodes WAV, MP3, FLAC, AIFF, M4A/MP4, AAC, and OGG files into left/right
//! channels, then executes parallel K-weighting, parallel polyphase True Peak
//! detection, and BS.1770-5 / EBU R128 gating & LRA statistics.

use super::loudness_meter::{
    channel_step_sums, energy_to_lufs, integrated_from_blocks, lra_from_short_term, step_len, MOMENTARY_STEPS,
    SHORT_TERM_STEPS,
};
use super::platforms::{simulate, PlatformResult};
use super::true_peak::{lin_to_db, true_peak_chunk, Polyphase};
use rayon::prelude::*;
use serde::Serialize;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineContourPoint {
    pub t: f64,
    pub m: Option<f64>,
    pub s: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineResult {
    pub path: String,
    pub file_name: String,
    pub format: String,
    pub sample_rate: u32,
    pub channels: usize,
    pub duration: f64,
    pub integrated: Option<f64>,
    pub tp_max: Option<f64>,
    pub sample_peak: Option<f64>,
    pub short_term_max: Option<f64>,
    pub momentary_max: Option<f64>,
    pub lra: Option<f64>,
    pub psr: Option<f64>,
    pub plr: Option<f64>,
    pub correlation: f64,
    pub contour: Vec<OfflineContourPoint>,
    pub platforms: Vec<PlatformResult>,
    pub decode_ms: u64,
    pub analysis_ms: u64,
}

fn round1(x: Option<f64>) -> Option<f64> {
    x.map(|v| (v * 10.0).round() / 10.0)
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

struct DecodedAudio {
    left: Vec<f32>,
    right: Vec<f32>,
    sample_rate: u32,
    channels: usize,
    format_name: String,
}

fn decode_file(path: &Path) -> Result<DecodedAudio, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if !ext.is_empty() {
        hint.with_extension(&ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Unsupported or corrupted container format: {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "No supported audio track found in file".to_string())?;

    let track_id = track.id;
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(48_000);
    let mut channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
    let est_frames = track.codec_params.n_frames.unwrap_or(sample_rate as u64 * 240) as usize;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Failed to initialize codec decoder: {e}"))?;

    let mut left = Vec::with_capacity(est_frames.min(48_000 * 600));
    let mut right = Vec::with_capacity(est_frames.min(48_000 * 600));
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(ref err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                sample_rate = spec.rate;
                let ch = spec.channels.count().max(1);
                channels = ch;
                let frames = decoded.frames();
                if frames == 0 {
                    continue;
                }
                let buf = sample_buf.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                if buf.capacity() < frames * ch {
                    *buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                }
                buf.copy_interleaved_ref(decoded);
                let samples = buf.samples();
                if ch == 1 {
                    left.extend_from_slice(&samples[..frames]);
                    right.extend_from_slice(&samples[..frames]);
                } else {
                    for chunk in samples[..frames * ch].chunks_exact(ch) {
                        left.push(chunk[0]);
                        right.push(chunk[1]);
                    }
                }
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => break,
        }
    }

    if left.is_empty() {
        return Err("Audio file decoded 0 samples".to_string());
    }

    let format_name = if ext.is_empty() {
        "AUDIO".to_string()
    } else {
        ext.to_ascii_uppercase()
    };

    Ok(DecodedAudio { left, right, sample_rate, channels, format_name })
}

fn parallel_true_peak_mono(poly: &Arc<Polyphase>, samples: &[f32]) -> f32 {
    const CHUNK_LEN: usize = 65_536;
    let taps = poly.taps;
    let num_chunks = (samples.len() + CHUNK_LEN - 1) / CHUNK_LEN;
    (0..num_chunks)
        .into_par_iter()
        .map(|idx| {
            let start = idx * CHUNK_LEN;
            let end = (start + CHUNK_LEN).min(samples.len());
            let preroll_start = start.saturating_sub(taps);
            let preroll = &samples[preroll_start..start];
            let chunk = &samples[start..end];
            true_peak_chunk(poly, preroll, chunk)
        })
        .reduce(|| 0.0f32, f32::max)
}

pub fn analyze_samples(
    path_str: String,
    file_name: String,
    format_name: String,
    sample_rate: u32,
    channels: usize,
    left: &[f32],
    right: &[f32],
    decode_ms: u64,
) -> OfflineResult {
    let t0 = Instant::now();
    let fs = sample_rate as f64;
    let step = step_len(fs);
    let poly = Arc::new(Polyphase::for_sample_rate(fs));

    // Run left & right K-weighting and parallel true-peak & correlation concurrently.
    let ((sums_l, sums_r), (tp_lin, (sample_peak_lin, corr))) = rayon::join(
        || {
            rayon::join(
                || channel_step_sums(left.iter().copied(), fs),
                || channel_step_sums(right.iter().copied(), fs),
            )
        },
        || {
            rayon::join(
                || {
                    let (pl, pr) = rayon::join(
                        || parallel_true_peak_mono(&poly, left),
                        || parallel_true_peak_mono(&poly, right),
                    );
                    pl.max(pr)
                },
                || {
                    // Parallel sample peak + broadband Pearson correlation.
                    left.par_chunks(65_536)
                        .zip(right.par_chunks(65_536))
                        .map(|(cl, cr)| {
                            let mut sp = 0.0f32;
                            let (mut sl, mut sr, mut sll, mut srr, mut slr) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
                            for (&l, &r) in cl.iter().zip(cr.iter()) {
                                sp = sp.max(l.abs()).max(r.abs());
                                let (ld, rd) = (l as f64, r as f64);
                                sl += ld;
                                sr += rd;
                                sll += ld * ld;
                                srr += rd * rd;
                                slr += ld * rd;
                            }
                            (sp, (cl.len() as f64, sl, sr, sll, srr, slr))
                        })
                        .reduce(
                            || (0.0f32, (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)),
                            |a, b| {
                                (
                                    a.0.max(b.0),
                                    (
                                        a.1 .0 + b.1 .0,
                                        a.1 .1 + b.1 .1,
                                        a.1 .2 + b.1 .2,
                                        a.1 .3 + b.1 .3,
                                        a.1 .4 + b.1 .4,
                                        a.1 .5 + b.1 .5,
                                    ),
                                )
                            },
                        )
                },
            )
        },
    );

    let (n, sl, sr, sll, srr, slr) = corr;
    let correlation = if n > 0.0 {
        let vl = sll - sl * sl / n;
        let vr = srr - sr * sr / n;
        let cov = slr - sl * sr / n;
        if vl > 1e-12 && vr > 1e-12 {
            (cov / (vl * vr).sqrt()).clamp(-1.0, 1.0)
        } else {
            0.0
        }
    } else {
        0.0
    };

    let n_steps = sums_l.len().min(sums_r.len());
    let step_energies: Vec<f64> = (0..n_steps)
        .map(|i| (sums_l[i] + sums_r[i]) / step as f64)
        .collect();

    let mut blocks = Vec::with_capacity(n_steps);
    let mut st_blocks = Vec::with_capacity(n_steps);
    let mut m_max_e = 0.0f64;
    let mut s_max_e = 0.0f64;
    let mut raw_contour = Vec::with_capacity(n_steps);

    for i in 0..n_steps {
        let m_start = (i + 1).saturating_sub(MOMENTARY_STEPS);
        let m_e = step_energies[m_start..=i].iter().sum::<f64>() / MOMENTARY_STEPS as f64;
        let s_start = (i + 1).saturating_sub(SHORT_TERM_STEPS);
        let s_e = step_energies[s_start..=i].iter().sum::<f64>() / SHORT_TERM_STEPS as f64;

        if i + 1 >= MOMENTARY_STEPS {
            blocks.push(m_e);
            m_max_e = m_max_e.max(m_e);
        }
        if i + 1 >= SHORT_TERM_STEPS {
            st_blocks.push(s_e);
            s_max_e = s_max_e.max(s_e);
        }
        raw_contour.push(OfflineContourPoint {
            t: round2((i + 1) as f64 * 0.1),
            m: round1(energy_to_lufs(m_e)),
            s: if i + 1 >= SHORT_TERM_STEPS {
                round1(energy_to_lufs(s_e))
            } else {
                round1(energy_to_lufs(m_e))
            },
        });
    }

    // Downsample contour to at most 400 points for crisp SVG rendering.
    let max_pts = 400usize;
    let contour = if raw_contour.len() <= max_pts {
        raw_contour
    } else {
        let stride = (raw_contour.len() + max_pts - 1) / max_pts;
        raw_contour.into_iter().step_by(stride).collect()
    };

    let integrated = integrated_from_blocks(&blocks);
    let lra = lra_from_short_term(&st_blocks);
    let tp_max = lin_to_db(tp_lin).map(|v| v as f64);
    let sample_peak = lin_to_db(sample_peak_lin).map(|v| v as f64);
    let momentary_max = energy_to_lufs(m_max_e);
    let short_term_max = energy_to_lufs(s_max_e);

    let psr = match (tp_max, short_term_max) {
        (Some(tp), Some(st)) => Some(tp - st),
        _ => None,
    };
    let plr = match (tp_max, integrated) {
        (Some(tp), Some(i)) => Some(tp - i),
        _ => None,
    };

    let platforms = simulate(integrated.unwrap_or(-23.0), tp_max.unwrap_or(-1.0));
    let duration = left.len() as f64 / fs;
    let analysis_ms = t0.elapsed().as_millis() as u64;

    OfflineResult {
        path: path_str,
        file_name,
        format: format_name,
        sample_rate,
        channels,
        duration: round2(duration),
        integrated: round1(integrated),
        tp_max: round1(tp_max),
        sample_peak: round1(sample_peak),
        short_term_max: round1(short_term_max),
        momentary_max: round1(momentary_max),
        lra: round1(lra),
        psr: round1(psr),
        plr: round1(plr),
        correlation: round2(correlation),
        contour,
        platforms,
        decode_ms,
        analysis_ms,
    }
}

pub fn analyze_file(path: &Path) -> Result<OfflineResult, String> {
    let t_decode = Instant::now();
    let decoded = decode_file(path)?;
    let decode_ms = t_decode.elapsed().as_millis() as u64;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();
    Ok(analyze_samples(
        path.to_string_lossy().to_string(),
        file_name,
        decoded.format_name,
        decoded.sample_rate,
        decoded.channels,
        &decoded.left,
        &decoded.right,
        decode_ms,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn analyzes_4_minute_stereo_track_under_500ms() {
        let fs = 48_000u32;
        let len = fs as usize * 240; // 4 minutes @ 48 kHz
        let amp = 10f64.powf(-14.0 / 20.0) as f32;
        let left: Vec<f32> = (0..len)
            .map(|i| ((2.0 * PI * 997.0 * i as f64 / fs as f64).sin() as f32) * amp)
            .collect();
        let right = left.clone();

        let res = analyze_samples(
            "test.wav".into(),
            "test.wav".into(),
            "WAV".into(),
            fs,
            2,
            &left,
            &right,
            0,
        );
        assert!((res.integrated.unwrap() + 14.0).abs() < 0.2, "I={:?}", res.integrated);
        assert!(res.analysis_ms < 2500, "analysis took {} ms", res.analysis_ms);
    }
}
