import { extractTimeline, pickOnsets, toWire, ENV_FLOOR_DB } from "../src/server/audio/timeline.js";
import { frameRate, HOP, FFT_SIZE } from "../src/server/audio/analyze.js";

const RATE = 22050;

/** Sine at `hz`, amplitude `amp`, for `sec` seconds. */
function tone(hz: number, amp: number, sec: number, rate = RATE): Float32Array {
    const out = new Float32Array(Math.floor(sec * rate));
    for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amp;
    return out;
}

/**
 * A tone with raised-cosine edges — one "syllable".
 *
 * The ramps are load-bearing in these tests: an un-ramped burst is a rectangular window, whose
 * edges are step discontinuities, and the detector correctly reports each as a click.
 *
 * 25ms is not arbitrary. The analysis window is FFT_SIZE/rate = 46ms, and a ramp much shorter
 * than that still looks like a step to it — measured, a 12ms ramp leaves release clicks firing at
 * flux 0.3, while 25ms removes them entirely and yields exactly one onset per burst.
 */
function burst(hz = 500, amp = 0.85, sec = 0.1, edge = 0.025): Float32Array {
    const out = tone(hz, amp, sec);
    const e = Math.floor(edge * RATE);
    for (let i = 0; i < e && i < out.length; i++) {
        const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / e);
        out[i] *= w;
        out[out.length - 1 - i] *= w;
    }
    return out;
}

function concat(...parts: Float32Array[]): Float32Array {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

describe("extractTimeline", () => {
    it("reports the analysis frame rate and duration", () => {
        const t = extractTimeline(tone(220, 0.5, 1), RATE);
        expect(t.fps).toBeCloseTo(frameRate(RATE), 5);
        expect(t.fps).toBeGreaterThan(60); // must exceed display rate — we interpolate down
        expect(t.durationSec).toBeCloseTo(1, 2);
        expect(t.env.length).toBe(Math.floor((RATE - FFT_SIZE) / HOP) + 1);
    });

    it("maps a loud tone near 1 and silence to 0", () => {
        const loud = extractTimeline(tone(220, 0.9, 0.5), RATE);
        const quiet = extractTimeline(new Float32Array(RATE / 2), RATE);
        expect(Math.max(...loud.env)).toBeGreaterThan(0.85);
        expect(Math.max(...quiet.env)).toBe(0);
    });

    it("is dB-mapped, so a -20 dB signal still reads well above zero", () => {
        // The whole point of the dB mapping: linear RMS would put this at ~0.1 and the orb would
        // barely move on speech the ear hears as clearly present.
        const quiet = extractTimeline(tone(220, 0.09, 0.5), RATE);
        const peak = Math.max(...quiet.env);
        expect(peak).toBeGreaterThan(0.4);
        expect(peak).toBeLessThan(0.8);
    });

    it("puts the envelope floor at ENV_FLOOR_DB", () => {
        // -48 dBFS is amplitude 10^(-48/20) ~= 0.004. A sine at that amplitude has RMS below it,
        // so it must clamp to 0.
        const atFloor = extractTimeline(tone(220, 10 ** (ENV_FLOOR_DB / 20), 0.4), RATE);
        expect(Math.max(...atFloor.env)).toBeLessThan(0.05);
    });

    it("tracks an amplitude step in the envelope", () => {
        const t = extractTimeline(concat(tone(220, 0.08, 0.4), tone(220, 0.9, 0.4)), RATE);
        const third = Math.floor(t.env.length / 3);
        const early = t.env[Math.floor(third * 0.5)];
        const late = t.env[Math.floor(t.env.length * 0.85)];
        expect(late).toBeGreaterThan(early + 0.2);
    });

    it("normalizes flux and bands to 0-1", () => {
        const t = extractTimeline(concat(tone(200, 0.6, 0.3), tone(2000, 0.6, 0.3)), RATE);
        expect(Math.max(...t.flux)).toBeCloseTo(1, 5);
        for (const b of t.bands) {
            expect(Math.max(...b)).toBeLessThanOrEqual(1.00001);
            expect(Math.min(...b)).toBeGreaterThanOrEqual(0);
        }
    });

    it("puts a high tone above a low tone on the centroid", () => {
        const low = extractTimeline(tone(150, 0.6, 0.4), RATE);
        const high = extractTimeline(tone(5000, 0.6, 0.4), RATE);
        const mid = (a: Float32Array): number => a[Math.floor(a.length / 2)];
        expect(mid(high.centroid)).toBeGreaterThan(mid(low.centroid));
    });

    it("finds an onset at a silence-to-tone transition", () => {
        const silence = new Float32Array(Math.floor(0.3 * RATE));
        const t = extractTimeline(concat(silence, tone(440, 0.8, 0.4)), RATE);
        expect(t.onsets.length).toBeGreaterThanOrEqual(1);
        // The transition is at 0.3s; allow a couple of frames of detection latency.
        expect(t.onsets.some((o) => Math.abs(o - 0.3) < 0.06)).toBe(true);
    });

    it("does not fire onsets on steady tone", () => {
        // Regression: normalizing flux by its own peak made this produce 27 onsets. With no real
        // attack anywhere, the peak was itself spectral-leakage noise, so the division scaled that
        // noise to full range. Flux is measured against mean magnitude instead.
        const t = extractTimeline(tone(440, 0.8, 1.5), RATE);
        expect(t.onsets.length).toBeLessThanOrEqual(2); // the initial ramp-in only
    });

    it("finds one onset per burst in a train of four", () => {
        const gap = (): Float32Array => new Float32Array(Math.floor(0.12 * RATE));
        const t = extractTimeline(
            concat(gap(), burst(), gap(), burst(), gap(), burst(), gap(), burst()),
            RATE,
        );
        expect(t.onsets.length).toBeGreaterThanOrEqual(4);
        expect(t.onsets.length).toBeLessThanOrEqual(5);
        // Bursts start at 0.120 / 0.340 / 0.560 / 0.780. Detection lands within one window.
        for (const expected of [0.12, 0.34, 0.56, 0.78]) {
            expect(t.onsets.some((o) => Math.abs(o - expected) < 0.05)).toBe(true);
        }
    });

    it("also fires on a hard cutoff, because a hard cutoff is a click", () => {
        // Not a defect. A rectangular edge is a step discontinuity, so energy appears across the
        // whole spectrum and half-wave rectified flux correctly sees bins RISING. Un-ramped bursts
        // therefore register twice, at onset and at release — which is what we want here, since
        // the voice chain deliberately injects grain cuts and crusher clicks, and the orb should
        // spark on them.
        const gap = (): Float32Array => new Float32Array(Math.floor(0.12 * RATE));
        const square = (): Float32Array => tone(500, 0.85, 0.1);
        const hard = extractTimeline(concat(gap(), square(), gap(), square()), RATE);
        const ramped = extractTimeline(concat(gap(), burst(), gap(), burst()), RATE);
        expect(hard.onsets.length).toBeGreaterThan(ramped.onsets.length);
    });
});

describe("pickOnsets", () => {
    it("enforces minimum spacing so one event is not detected twice", () => {
        const fps = 86;
        const flux = new Float32Array(200);
        // Two spikes 2 frames apart — well inside the 50ms guard.
        flux[50] = 1;
        flux[52] = 1;
        const on = pickOnsets(flux, fps);
        expect(on.length).toBe(1);
    });

    it("adapts to local level rather than using a global threshold", () => {
        const fps = 86;
        const flux = new Float32Array(400);
        // A quiet region with a small peak, then a loud region with a proportional peak. A global
        // threshold would catch only the second; both are real onsets in their own context.
        for (let i = 0; i < 200; i++) flux[i] = 0.05;
        for (let i = 200; i < 400; i++) flux[i] = 0.5;
        flux[100] = 0.2;
        flux[300] = 2.0;
        const on = pickOnsets(flux, fps);
        expect(on.some((t) => Math.abs(t - 100 / fps) < 0.02)).toBe(true);
        expect(on.some((t) => Math.abs(t - 300 / fps) < 0.02)).toBe(true);
    });
});

describe("toWire", () => {
    it("round-trips through JSON and keeps 3 decimals", () => {
        const t = extractTimeline(tone(300, 0.7, 0.3), RATE);
        const wire = JSON.parse(JSON.stringify(toWire(t)));
        expect(wire.env.length).toBe(t.env.length);
        expect(wire.fps).toBeCloseTo(t.fps, 5);
        expect(wire.bands.length).toBe(t.bands.length);
        for (const v of wire.env) expect(Math.round(v * 1000)).toBe(v * 1000);
    });
});
