import { fft, stft, averageSpectrumDb, bandTilt, levelStats, FFT_SIZE, HOP, frameRate } from "../src/server/audio/analyze.js";

/** Generates `seconds` of a sine at `hz`, amplitude 1. */
function sine(hz: number, seconds: number, rate = 22050): Float32Array {
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
    return out;
}

/** Deterministic broadband noise (mulberry32) — every band gets real energy, and tests repeat. */
function noise(seconds: number, rate = 22050, seed = 0x9e3779b9): Float32Array {
    const out = new Float32Array(Math.round(seconds * rate));
    let s = seed;
    for (let i = 0; i < out.length; i++) {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
    }
    return out;
}

describe("fft", () => {
    it("puts a pure tone in the expected bin", () => {
        const n = 1024;
        const rate = 22050;
        const hz = (rate / n) * 64; // exactly bin 64, so there is no spectral leakage to argue about
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * hz * i) / rate);

        fft(re, im);

        const mags = Array.from({ length: n / 2 + 1 }, (_, b) => Math.hypot(re[b], im[b]));
        const peak = mags.indexOf(Math.max(...mags));
        expect(peak).toBe(64);
    });

    it("rejects non-power-of-two lengths rather than silently producing garbage", () => {
        expect(() => fft(new Float64Array(1000), new Float64Array(1000))).toThrow(/power of two/);
    });
});

describe("stft", () => {
    it("produces frames at the documented rate", () => {
        // 86.13 fps is load-bearing: it must stay above 60 so the renderer interpolates down.
        expect(frameRate(22050)).toBeGreaterThan(60);
        expect(frameRate(22050)).toBeCloseTo(22050 / HOP, 5);
    });

    it("emits one frame per hop once the window fits", () => {
        const samples = sine(440, 1);
        const frames = stft(samples);
        expect(frames.length).toBe(Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
        expect(frames[0].length).toBe(FFT_SIZE / 2 + 1);
    });

    it("returns no frames for a signal shorter than one window", () => {
        expect(stft(new Float32Array(FFT_SIZE - 1))).toHaveLength(0);
    });
});

describe("bandTilt", () => {
    it("is zero in the reference band and level-independent", () => {
        // Level independence is the whole point: it lets us compare a quiet render against a
        // loud reference and still answer "is the EQ shape right?".
        //
        // Broadband noise, not a sine: the property only holds where a band actually contains
        // signal. In a band that is effectively empty (a 1 kHz sine has ~-76 dB at 20-150 Hz)
        // the 1e-12 epsilon guarding log(0) dominates, and scaling the input changes the
        // measured tilt by ~0.5 dB. That is the epsilon showing through, not a real dependence.
        const loud = noise(1);
        const quiet = new Float32Array(loud.map((s) => s * 0.1));

        const tiltLoud = bandTilt(averageSpectrumDb(loud), 22050);
        const tiltQuiet = bandTilt(averageSpectrumDb(quiet), 22050);

        expect(tiltLoud[2]).toBeCloseTo(0, 6); // the 500-2500 reference band
        tiltLoud.forEach((t, i) => expect(t).toBeCloseTo(tiltQuiet[i], 4));
    });

    it("reports more energy in the band containing the tone", () => {
        const tilt = bandTilt(averageSpectrumDb(sine(80, 1)), 22050);
        // 20-150 Hz should dominate 2500-5000 Hz for an 80 Hz tone.
        expect(tilt[0]).toBeGreaterThan(tilt[3]);
    });
});

describe("levelStats", () => {
    it("computes crest factor for a sine as ~sqrt(2)", () => {
        const stats = levelStats(sine(440, 1));
        expect(stats.crestFactor).toBeCloseTo(Math.SQRT2, 2);
        expect(stats.peakDb).toBeCloseTo(0, 1);
    });

    it("reports a higher crest factor when silence is added", () => {
        // This is why analyze-ref compares duration-matched windows: padding with silence
        // inflates crest without the signal itself changing at all.
        const tone = sine(440, 1);
        const padded = new Float32Array(tone.length * 4);
        padded.set(tone, 0);
        expect(levelStats(padded).crestFactor).toBeGreaterThan(levelStats(tone).crestFactor * 1.5);
    });
});
