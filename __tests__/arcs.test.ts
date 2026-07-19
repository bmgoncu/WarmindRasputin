import { synthArc, arcVariants, DEFAULT_ARC } from "../src/server/audio/arcs.js";
import { stft, FFT_SIZE } from "../src/server/audio/analyze.js";

const RATE = 44100;

/** Brightness. The single number that distinguishes a thud from a scratch. */
function spectralCentroid(x: Float32Array, rate = RATE): number {
    const binHz = rate / FFT_SIZE;
    let num = 0;
    let den = 0;
    for (const f of stft(x)) {
        for (let b = 1; b < f.length; b++) {
            num += b * binHz * f[b];
            den += f[b];
        }
    }
    return den > 0 ? num / den : 0;
}

function pctEnergyBelow(x: Float32Array, hz: number, rate = RATE): number {
    const cut = Math.floor(hz / (rate / FFT_SIZE));
    let lo = 0;
    let tot = 0;
    for (const f of stft(x)) {
        for (let b = 1; b < f.length; b++) {
            tot += f[b];
            if (b <= cut) lo += f[b];
        }
    }
    return tot > 0 ? (100 * lo) / tot : 0;
}

function stats(x: Float32Array): { peak: number; rms: number; crest: number } {
    let peak = 0;
    let e = 0;
    for (const s of x) {
        peak = Math.max(peak, Math.abs(s));
        e += s * s;
    }
    const rms = Math.sqrt(e / x.length);
    return { peak, rms, crest: peak / (rms + 1e-12) };
}

describe("synthArc", () => {
    it("produces a genuine transient, not a flat burst", () => {
        // The sampled "arcs" cut from the reference had an attack/decay ratio of 1.0 — flat
        // chunks of ambient bed. A struck body reads well above that.
        expect(stats(synthArc(RATE)).crest).toBeGreaterThan(2.5);
    });

    it("is LOW — this is a thud, not a scratch", () => {
        // The original noise-based implementation measured a 7235 Hz centroid with 3% of energy
        // below 300 Hz, against the Mindlab reference's 774 Hz and 51%. This is the assertion
        // that stops anything drifting back toward electrical scratch.
        const a = synthArc(RATE);
        expect(spectralCentroid(a)).toBeLessThan(900);
        expect(pctEnergyBelow(a, 300)).toBeGreaterThan(45);
    });

    it("decays — energy in the first quarter exceeds the last", () => {
        const a = synthArc(RATE);
        const q = Math.floor(a.length / 4);
        expect(stats(a.subarray(0, q)).rms).toBeGreaterThan(stats(a.subarray(a.length - q)).rms * 2);
    });

    it("honours the requested duration", () => {
        const a = synthArc(RATE, { durationSec: 0.25 });
        expect(a.length).toBe(Math.floor(0.25 * RATE));
    });

    it("normalizes peak so playback gain is predictable", () => {
        for (const seed of [1, 2, 99]) {
            expect(stats(synthArc(RATE, { seed })).peak).toBeCloseTo(DEFAULT_ARC.peak, 2);
        }
    });

    it("sits well below unity — arcs are texture under the bed, not events", () => {
        expect(DEFAULT_ARC.peak).toBeLessThan(0.7);
    });

    it("every variant stays low — none drifts bright", () => {
        for (const a of arcVariants(RATE, 8)) {
            expect(spectralCentroid(a)).toBeLessThan(1100);
        }
    });

    it("builds an arc from source material while still producing a transient", () => {
        // The source has no transient of its own. The envelope supplies it, so a source-derived
        // thud must still read as an event rather than a chunk of bed.
        const source = new Float32Array(RATE);
        for (let i = 0; i < source.length; i++) {
            source[i] = 0.3 * Math.sin((2 * Math.PI * 180 * i) / RATE) + 0.1 * Math.sin((2 * Math.PI * 2600 * i) / RATE);
        }
        const arc = synthArc(RATE, { source, seed: 5 });
        const q = Math.floor(arc.length / 4);
        expect(stats(arc.subarray(0, q)).rms).toBeGreaterThan(stats(arc.subarray(arc.length - q)).rms);
    });

    it("falls back to noise when the source is too short to slice", () => {
        const tiny = new Float32Array(10);
        expect(() => synthArc(RATE, { source: tiny })).not.toThrow();
        expect(stats(synthArc(RATE, { source: tiny })).peak).toBeCloseTo(DEFAULT_ARC.peak, 2);
    });

    it("is deterministic for a given seed", () => {
        expect(Array.from(synthArc(RATE, { seed: 42 }))).toEqual(Array.from(synthArc(RATE, { seed: 42 })));
    });

    it("differs between seeds — an idle layer must not audibly repeat", () => {
        expect(Array.from(synthArc(RATE, { seed: 1 }))).not.toEqual(Array.from(synthArc(RATE, { seed: 2 })));
    });

    it("never clips", () => {
        for (let seed = 1; seed <= 20; seed++) {
            expect(stats(synthArc(RATE, { seed })).peak).toBeLessThanOrEqual(1);
        }
    });

    it("starts and ends near silence, so triggering does not click", () => {
        const a = synthArc(RATE, { seed: 7 });
        expect(Math.abs(a[0])).toBeLessThan(0.05);
        expect(Math.abs(a[a.length - 1])).toBeLessThan(0.05);
    });
});

describe("arcVariants", () => {
    it("returns the requested count, all distinct", () => {
        const set = arcVariants(RATE, 8);
        expect(set).toHaveLength(8);
        const fingerprints = new Set(set.map((a) => `${a.length}:${a[100]}:${a[500]}`));
        expect(fingerprints.size).toBe(8);
    });

    it("spans a range of durations", () => {
        const lens = arcVariants(RATE, 8).map((a) => a.length);
        expect(Math.max(...lens)).toBeGreaterThan(Math.min(...lens) * 1.5);
    });

    it("uses the documented defaults as its base", () => {
        // baseHz in the thud register — above ~200 it stops reading as a knock and becomes a tone.
        expect(DEFAULT_ARC.baseHz).toBeGreaterThan(40);
        expect(DEFAULT_ARC.baseHz).toBeLessThan(200);
        // Texture is a garnish. Push this past ~0.3 and the noise takes over as scratch.
        expect(DEFAULT_ARC.texture).toBeLessThan(0.3);
    });
});
