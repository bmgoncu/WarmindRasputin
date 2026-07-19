/**
 * Feature timeline — the signal the orb actually animates from.
 *
 * Extracted from the POST-CHAIN samples, not the raw `say` output, so the features describe
 * exactly the audio that plays. The chain changes the envelope substantially (glitch grains cut
 * holes in it, the crusher flattens peaks), and animating from the pre-chain signal would drift
 * out of agreement with what is heard.
 *
 * Frame rate is `sampleRate / HOP` — 86.13 fps at 22050. Deliberately above 60 so the renderer
 * interpolates DOWN to its frame rate rather than up; upsampling a 30 fps envelope to 120 fps
 * display produces visible steps on transients.
 *
 * `env` is the primary driver and everything else is extracted but weighted zero by default —
 * see the mapping table in the plan. They cost one pass over data already in memory, so having
 * them available is nearly free, and the alternative is re-rendering to answer "would centroid
 * have explained that?".
 */

import { FFT_SIZE, HOP, stft, frameRate, DEFAULT_BANDS, type Band } from "./analyze.js";

/** Floor for the dB mapping. Below this reads as silence. */
export const ENV_FLOOR_DB = -48;

export interface FeatureTimeline {
    fps: number;
    durationSec: number;
    /**
     * 0-1 dB-mapped RMS — the primary driver.
     *
     * dB, not linear. Linear RMS makes quiet speech nearly invisible: a passage 20 dB down sits
     * at 0.1 and the orb barely moves, while the ear hears it as clearly present.
     */
    env: Float32Array;
    /** 0-1 spectral flux. Feeds onset detection; also available as a secondary driver. */
    flux: Float32Array;
    /** Onset times in seconds, peak-picked from flux. */
    onsets: number[];
    /** 0-1 normalized spectral centroid — brightness. */
    centroid: Float32Array;
    /** Per-band 0-1 energy, one array per DEFAULT_BANDS entry. */
    bands: Float32Array[];
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Peak-picks onsets from a flux curve.
 *
 * Threshold is a local mean plus a margin rather than a global constant: speech level varies
 * across an utterance, and a fixed threshold either misses the quiet phrases or fires constantly
 * during the loud ones.
 */
export function pickOnsets(flux: Float32Array, fps: number, windowFrames = 12, margin = 1.4): number[] {
    const out: number[] = [];
    let lastFrame = -Infinity;
    // Minimum spacing. Speech runs 4-7 syllables/s, so real onsets are at least ~140ms apart;
    // anything closer is one event detected twice, and the orb could not show them separately
    // anyway. At 50ms a single 100ms burst was being detected twice.
    const minGap = Math.round(fps * 0.08);

    for (let i = 1; i < flux.length - 1; i++) {
        const lo = Math.max(0, i - windowFrames);
        const hi = Math.min(flux.length, i + windowFrames + 1);
        let sum = 0;
        for (let k = lo; k < hi; k++) sum += flux[k];
        const local = sum / (hi - lo);

        const isPeak = flux[i] > flux[i - 1] && flux[i] >= flux[i + 1];
        if (isPeak && flux[i] > local * margin && flux[i] > 0.02 && i - lastFrame >= minGap) {
            out.push(i / fps);
            lastFrame = i;
        }
    }
    return out;
}

export function extractTimeline(
    samples: Float32Array,
    sampleRate: number,
    bands: Band[] = DEFAULT_BANDS,
): FeatureTimeline {
    const fps = frameRate(sampleRate);
    const frames = stft(samples);
    const n = frames.length;
    const binCount = FFT_SIZE / 2 + 1;
    const binHz = sampleRate / FFT_SIZE;

    const env = new Float32Array(n);
    const flux = new Float32Array(n);
    const centroid = new Float32Array(n);
    const bandOut = bands.map(() => new Float32Array(n));

    // Band bin ranges, resolved once rather than per frame.
    const bandBins = bands.map((b) => ({
        lo: Math.max(0, Math.floor(b.lo / binHz)),
        hi: Math.min(binCount - 1, Math.ceil(b.hi / binHz)),
    }));

    // Mean total magnitude across the utterance — a stable scale to measure flux against.
    //
    // Normalizing flux by its own peak looks equivalent and is not: on a signal with no strong
    // attack the peak IS the noise, so dividing by it amplifies frame-to-frame spectral leakage
    // to full scale. A steady 440 Hz tone produced 27 "onsets" that way, because 440 is not
    // bin-aligned at this FFT size and the leakage wobbles with each frame's start phase.
    let magSumTotal = 0;
    for (let i = 0; i < n; i++) {
        let s2 = 0;
        for (let b = 0; b < binCount; b++) s2 += frames[i][b];
        magSumTotal += s2;
    }
    const magScale = n > 0 && magSumTotal > 0 ? magSumTotal / n : 1;

    let prev: Float64Array | null = null;
    let fluxPeak = 0;
    const bandPeak = new Float64Array(bands.length);

    for (let i = 0; i < n; i++) {
        const mag = frames[i];

        // Envelope from the time domain over the same window the frame covers, rather than from
        // the spectrum. Parseval would make them equivalent for an unwindowed frame, but the Hann
        // window attenuates the edges, so a spectral sum reads systematically low on transients
        // that land near a frame boundary.
        const start = i * HOP;
        let sumSq = 0;
        for (let k = 0; k < FFT_SIZE; k++) {
            const s = samples[start + k];
            sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / FFT_SIZE);
        const db = 20 * Math.log10(rms + 1e-9);
        env[i] = clamp01((db - ENV_FLOOR_DB) / -ENV_FLOOR_DB);

        // Half-wave rectified spectral flux: only INCREASES count. Energy falling away is the
        // tail of the previous event, not a new one, and counting it doubles every onset.
        let f = 0;
        if (prev) {
            for (let b = 0; b < binCount; b++) {
                const d = mag[b] - prev[b];
                if (d > 0) f += d;
            }
        }
        flux[i] = f / magScale;
        if (flux[i] > fluxPeak) fluxPeak = flux[i];

        let num = 0;
        let den = 0;
        for (let b = 0; b < binCount; b++) {
            num += b * binHz * mag[b];
            den += mag[b];
        }
        centroid[i] = den > 0 ? clamp01(num / den / (sampleRate / 2)) : 0;

        for (let bi = 0; bi < bandBins.length; bi++) {
            let e = 0;
            for (let b = bandBins[bi].lo; b <= bandBins[bi].hi; b++) e += mag[b] * mag[b];
            bandOut[bi][i] = e;
            if (e > bandPeak[bi]) bandPeak[bi] = e;
        }

        prev = mag;
    }

    // Onsets are picked BEFORE the 0-1 rescale, on the magScale-relative values, so the absolute
    // threshold inside pickOnsets means the same thing on every utterance.
    const onsets = pickOnsets(flux, fps);

    // Bands are shape descriptors, not absolute levels — `env` carries loudness and loudnorm has
    // already fixed that upstream. Flux is rescaled last, for the wire format's 0-1 contract.
    if (fluxPeak > 1) for (let i = 0; i < n; i++) flux[i] /= fluxPeak;
    for (let bi = 0; bi < bandOut.length; bi++) {
        const pk = bandPeak[bi];
        if (pk > 0) for (let i = 0; i < n; i++) bandOut[bi][i] /= pk;
    }

    return {
        fps,
        durationSec: samples.length / sampleRate,
        env,
        flux,
        onsets,
        centroid,
        bands: bandOut,
    };
}

/** Wire form: Float32Array does not survive JSON, and the renderer wants plain arrays anyway. */
export interface TimelineWire {
    fps: number;
    durationSec: number;
    env: number[];
    flux: number[];
    onsets: number[];
    centroid: number[];
    bands: number[][];
}

/** Rounded to 3 decimals — the difference is invisible and it cuts the payload by roughly half. */
export function toWire(t: FeatureTimeline): TimelineWire {
    const r = (a: Float32Array): number[] => Array.from(a, (v) => Math.round(v * 1000) / 1000);
    return {
        fps: t.fps,
        durationSec: t.durationSec,
        env: r(t.env),
        flux: r(t.flux),
        onsets: t.onsets.map((v) => Math.round(v * 1000) / 1000),
        centroid: r(t.centroid),
        bands: t.bands.map(r),
    };
}
