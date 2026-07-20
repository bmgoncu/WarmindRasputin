/**
 * The attention horn — sounded when Claude is waiting on you.
 *
 * Synthesised rather than sampled, for the same reason the arcs are: it ships with the app, has no
 * licensing question, and can be tuned by ear without hunting for a new file.
 *
 * Built to be *menacing* rather than loud. Three things do that work:
 *
 *   1. **Detuned stacked partials.** Two oscillators a few cents apart beat slowly against each
 *      other, which is what makes a horn sound mechanical and unwell rather than musical.
 *   2. **A slow swell.** The attack is nearly a second. A fast attack reads as an alert chime; a
 *      swell reads as something large powering up, which is the Warmind register.
 *   3. **A sub-octave underneath.** Most of the menace lives below 80 Hz, matching the reference's
 *      dominant 20-150 Hz band.
 *
 * It must also not collide with the voice: the horn sits low and the speech band (500 Hz-2.5 kHz)
 * is deliberately left empty, so one can sound under the other without masking it.
 */

/** mulberry32, matching effects.ts and arcs.ts — deterministic per seed. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface HornOptions {
    durationSec: number;
    /** Fundamental in Hz. Around 55-70 reads as huge; above ~110 it starts to sound like a horn section. */
    baseHz: number;
    /** Detune between the paired oscillators, in cents. The beating is the character. */
    detuneCents: number;
    /** Seconds to reach full level. Long on purpose — see the note above. */
    attackSec: number;
    /** Seconds of decay after the peak. */
    releaseSec: number;
    /** 0-1 amount of sub-octave. */
    sub: number;
    /** 0-1 breath noise, low-passed. A little makes it organic; a lot makes it a jet. */
    breath: number;
    /** Normalised peak. */
    peak: number;
    seed: number;
}

export const DEFAULT_HORN: HornOptions = {
    durationSec: 2.4,
    baseHz: 62,
    detuneCents: 14,
    attackSec: 0.85,
    releaseSec: 1.3,
    sub: 0.45,
    breath: 0.06,
    peak: 0.55,
    seed: 7,
};

/** Cascaded one-pole low-pass, 4 poles — 24 dB/octave. One pole leaves far too much top. */
function lowpass4(x: Float32Array, rate: number, hz: number): Float32Array {
    const a = Math.exp((-2 * Math.PI * hz) / rate);
    const out = Float32Array.from(x);
    for (let stage = 0; stage < 4; stage++) {
        let z = 0;
        for (let i = 0; i < out.length; i++) {
            z = out[i] * (1 - a) + z * a;
            out[i] = z;
        }
    }
    return out;
}

export function synthHorn(rate: number, opts: Partial<HornOptions> = {}): Float32Array {
    const o = { ...DEFAULT_HORN, ...opts };
    const rand = rng(o.seed);
    const n = Math.floor(o.durationSec * rate);
    const out = new Float32Array(n);

    const detune = 2 ** (o.detuneCents / 1200);
    // Odd harmonics only, falling steeply. Even harmonics would read as brass; odd ones read as
    // something industrial.
    const partials = [
        { mult: 1, gain: 1.0 },
        { mult: 2, gain: 0.32 },
        { mult: 3, gain: 0.2 },
        { mult: 5, gain: 0.09 },
        { mult: 7, gain: 0.04 },
    ];

    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) noise[i] = rand() * 2 - 1;
    const breath = lowpass4(noise, rate, o.baseHz * 8);

    const attack = Math.max(1, Math.floor(o.attackSec * rate));
    const release = Math.max(1, Math.floor(o.releaseSec * rate));
    const hold = Math.max(0, n - attack - release);

    for (let i = 0; i < n; i++) {
        const t = i / rate;

        let sample = 0;
        for (const p of partials) {
            const f = o.baseHz * p.mult;
            // The pair, one detuned — their beat frequency is what unsettles.
            sample += Math.sin(2 * Math.PI * f * t) * p.gain;
            sample += Math.sin(2 * Math.PI * f * detune * t) * p.gain;
        }
        sample /= 2;
        sample += Math.sin(2 * Math.PI * (o.baseHz / 2) * t) * o.sub;
        sample += breath[i] * o.breath;

        // Raised-cosine attack: a linear ramp leaves a corner at the top that reads as a click.
        let env: number;
        if (i < attack) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
        else if (i < attack + hold) env = 1;
        else {
            const k = (i - attack - hold) / release;
            env = Math.max(0, 1 - k) ** 1.6;
        }

        // A slow wobble across the whole note — a perfectly steady tone reads as a test signal.
        const wobble = 1 + 0.05 * Math.sin(2 * Math.PI * 0.7 * t);
        out[i] = sample * env * wobble;
    }

    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * o.peak;
    return out;
}
