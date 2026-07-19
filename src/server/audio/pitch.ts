/**
 * Fundamental-frequency estimation, used to answer "does this read as male or female?"
 * objectively rather than by ear.
 *
 * Typical speaking F0: adult male 85-155 Hz, adult female 165-255 Hz. Rasputin should land in
 * the male range or below — matching the reference is the actual target, and this measures it.
 *
 * Method is autocorrelation with a parabolic-interpolated peak. Not the most accurate estimator
 * in the literature (YIN and pYIN are better on noisy signals), but the voice we are measuring is
 * clean synthesized speech, and this is ~50 lines with no dependency.
 */

const MIN_F0 = 55;
const MAX_F0 = 400;

/** Autocorrelation F0 for one frame, or 0 when the frame is unvoiced or too quiet. */
function frameF0(frame: Float32Array, sampleRate: number): number {
    const minLag = Math.floor(sampleRate / MAX_F0);
    const maxLag = Math.min(Math.floor(sampleRate / MIN_F0), frame.length - 1);
    if (maxLag <= minLag) return 0;

    // Energy gate: silence autocorrelates into nonsense peaks that drag the median around.
    let energy = 0;
    for (const s of frame) energy += s * s;
    if (Math.sqrt(energy / frame.length) < 0.01) return 0;

    let bestLag = 0;
    let bestCorr = 0;
    let zeroLagCorr = 0;
    for (let i = 0; i < frame.length; i++) zeroLagCorr += frame[i] * frame[i];

    for (let lag = minLag; lag <= maxLag; lag++) {
        let corr = 0;
        for (let i = 0; i < frame.length - lag; i++) corr += frame[i] * frame[i + lag];
        if (corr > bestCorr) {
            bestCorr = corr;
            bestLag = lag;
        }
    }

    // Below ~30% of zero-lag correlation the frame is unvoiced (fricative, noise, silence).
    if (bestLag === 0 || bestCorr < 0.3 * zeroLagCorr) return 0;

    // Parabolic interpolation around the peak — without it the estimate quantizes to integer
    // lags, which at 22050 Hz is a ~5 Hz step near 200 Hz and visibly bands the histogram.
    const y0 = autocorrAt(frame, bestLag - 1);
    const y1 = bestCorr;
    const y2 = autocorrAt(frame, bestLag + 1);
    const denom = 2 * (2 * y1 - y0 - y2);
    const shift = denom !== 0 ? (y2 - y0) / denom : 0;

    return sampleRate / (bestLag + shift);
}

function autocorrAt(frame: Float32Array, lag: number): number {
    if (lag < 1 || lag >= frame.length) return 0;
    let corr = 0;
    for (let i = 0; i < frame.length - lag; i++) corr += frame[i] * frame[i + lag];
    return corr;
}

export interface F0Estimate {
    /** Median F0 over voiced frames, in Hz. 0 if nothing voiced was found. */
    medianHz: number;
    /** Fraction of frames that were voiced — sanity check on the median. */
    voicedFraction: number;
    /** Rough gendering of the median, for reporting. */
    register: "male" | "female" | "sub-male" | "unknown";
}

export function estimateF0(samples: Float32Array, sampleRate: number): F0Estimate {
    const frameSize = Math.floor(sampleRate * 0.045);
    const hop = Math.floor(frameSize / 2);
    const voiced: number[] = [];
    let frames = 0;

    for (let start = 0; start + frameSize <= samples.length; start += hop) {
        frames++;
        const f0 = frameF0(samples.subarray(start, start + frameSize), sampleRate);
        if (f0 >= MIN_F0 && f0 <= MAX_F0) voiced.push(f0);
    }

    if (voiced.length === 0) return { medianHz: 0, voicedFraction: 0, register: "unknown" };

    voiced.sort((a, b) => a - b);
    const medianHz = voiced[Math.floor(voiced.length / 2)];

    return {
        medianHz,
        voicedFraction: voiced.length / Math.max(1, frames),
        register: medianHz < 85 ? "sub-male" : medianHz < 160 ? "male" : "female",
    };
}
