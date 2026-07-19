/**
 * STFT analysis: turns the f32le tap coming off the end of the voice chain into the feature
 * timeline that drives the orb, and into band energies used to match the reference spectrum.
 *
 * Hop is 256 at 22050 Hz -> 86.13 frames/sec, deliberately ABOVE 60 so the renderer always
 * interpolates down to its frame rate rather than up. Window is 1024 (46.4 ms) Hann.
 *
 * Amplitude is the primary driver (see CLAUDE.md -> Orb visual). The other features are extracted
 * because they are nearly free once the FFT is running, and are exposed as zero-weight sliders.
 */

export const FFT_SIZE = 1024;
export const HOP = 256;

/** Frames per second of the feature timeline. */
export function frameRate(sampleRate: number): number {
    return sampleRate / HOP;
}

/**
 * In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must be power-of-two length.
 * Small enough to keep here rather than take a dependency for ~40 lines.
 */
export function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    if ((n & (n - 1)) !== 0) throw new Error(`FFT length must be a power of two, got ${n}`);

    // Bit-reversal permutation.
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let curRe = 1;
            let curIm = 0;
            for (let k = 0; k < len / 2; k++) {
                const aRe = re[i + k];
                const aIm = im[i + k];
                const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
                const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
                re[i + k] = aRe + bRe;
                im[i + k] = aIm + bIm;
                re[i + k + len / 2] = aRe - bRe;
                im[i + k + len / 2] = aIm - bIm;
                const nextRe = curRe * wRe - curIm * wIm;
                curIm = curRe * wIm + curIm * wRe;
                curRe = nextRe;
            }
        }
    }
}

function hannWindow(size: number): Float64Array {
    const w = new Float64Array(size);
    for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    return w;
}

/** Magnitude spectra for every hop. Returns `frames[frame][bin]`, bins = FFT_SIZE/2 + 1. */
export function stft(samples: Float32Array): Float64Array[] {
    const win = hannWindow(FFT_SIZE);
    const bins = FFT_SIZE / 2 + 1;
    const frames: Float64Array[] = [];

    for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP) {
        const re = new Float64Array(FFT_SIZE);
        const im = new Float64Array(FFT_SIZE);
        for (let i = 0; i < FFT_SIZE; i++) re[i] = samples[start + i] * win[i];
        fft(re, im);
        const mag = new Float64Array(bins);
        for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
        frames.push(mag);
    }
    return frames;
}

/**
 * Long-term average spectrum in dB per bin — the basis for the firequalizer matching curve.
 * Averaging magnitude (not dB) first, then converting, keeps loud frames dominant, which is what
 * we want: silence between phrases should not drag the average toward the noise floor.
 */
export function averageSpectrumDb(samples: Float32Array): Float64Array {
    const frames = stft(samples);
    if (frames.length === 0) throw new Error("Signal too short for a single FFT frame");
    const bins = frames[0].length;
    const acc = new Float64Array(bins);
    for (const f of frames) for (let b = 0; b < bins; b++) acc[b] += f[b];
    const out = new Float64Array(bins);
    for (let b = 0; b < bins; b++) out[b] = 20 * Math.log10(acc[b] / frames.length + 1e-12);
    return out;
}

export interface Band {
    lo: number;
    hi: number;
}

/** Default bands: sub / body / intelligibility / presence / air. */
export const DEFAULT_BANDS: Band[] = [
    { lo: 20, hi: 150 },
    { lo: 150, hi: 500 },
    { lo: 500, hi: 2500 },
    { lo: 2500, hi: 5000 },
    { lo: 5000, hi: 11000 },
];

/** Mean dB energy within each band, from a per-bin dB spectrum. */
export function bandEnergiesDb(spectrumDb: Float64Array, sampleRate: number, bands = DEFAULT_BANDS): number[] {
    const binHz = sampleRate / FFT_SIZE;
    return bands.map(({ lo, hi }) => {
        const b0 = Math.max(1, Math.floor(lo / binHz));
        const b1 = Math.min(spectrumDb.length - 1, Math.ceil(hi / binHz));
        let sum = 0;
        let n = 0;
        for (let b = b0; b <= b1; b++) {
            sum += spectrumDb[b];
            n++;
        }
        return n > 0 ? sum / n : -Infinity;
    });
}

/**
 * Band tilt relative to the 500-2500 Hz intelligibility band. Level-independent, so two signals at
 * different loudness are directly comparable — this is the number that says whether the EQ shape
 * matches, as opposed to just the volume.
 */
export function bandTilt(spectrumDb: Float64Array, sampleRate: number, bands = DEFAULT_BANDS): number[] {
    const energies = bandEnergiesDb(spectrumDb, sampleRate, bands);
    const refIndex = bands.findIndex((b) => b.lo === 500);
    const ref = energies[refIndex >= 0 ? refIndex : Math.floor(bands.length / 2)];
    return energies.map((e) => e - ref);
}

export interface LevelStats {
    peakDb: number;
    rmsDb: number;
    /** peak/rms as a linear ratio. The reference sits at ~10.2 — do not compress below ~8. */
    crestFactor: number;
}

export function levelStats(samples: Float32Array): LevelStats {
    let peak = 0;
    let sumSq = 0;
    for (const s of samples) {
        const a = Math.abs(s);
        if (a > peak) peak = a;
        sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / samples.length);
    return {
        peakDb: 20 * Math.log10(peak + 1e-12),
        rmsDb: 20 * Math.log10(rms + 1e-12),
        crestFactor: peak / (rms + 1e-12),
    };
}
