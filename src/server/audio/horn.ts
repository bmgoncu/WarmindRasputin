/**
 * The attention horn — sounded when Claude is waiting on you.
 *
 * Synthesised rather than sampled, for the same reason the arcs are: it ships with the app, has no
 * licensing question, and can be tuned by ear without hunting for a new file.
 *
 * Tuned to the Destiny reference (the opening swell of Rasputin's speech highlight): a broadband,
 * low-dominant, *saturated* roar — not a clean tone. Measured band tilt of the reference, relative
 * to its 20-150 Hz peak: −8 dB across 150 Hz-2 kHz, −15 dB by 6 kHz, −26 dB by 15 kHz. Three things
 * carry that character, and the earlier clean-sine version had none of them:
 *
 *   1. **Saturation.** The detuned partial stack is driven through a tanh waveshaper, which folds
 *      harmonics up into the 2-15 kHz band the reference occupies. Pure sines rolled off an octave
 *      up and read thin and synthetic.
 *   2. **A broadband noise bed, tilted low.** Rumble + body + air in three bands, so the roar has a
 *      floor of energy everywhere rather than only at the harmonics.
 *   3. **A long swell.** A ~1.6 s raised-cosine attack into a sustain — the reference ramps for
 *      seconds. A fast attack reads as an alert chime; the swell reads as something vast powering up.
 *
 * It must not mask the voice: most energy sits below 150 Hz, so the horn and a spoken line can sound
 * together without the speech band (500 Hz-2.5 kHz) being buried.
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
    /** Fundamental in Hz. Around 50-65 reads as huge; above ~110 it starts to sound like a horn section. */
    baseHz: number;
    /** Detune between the paired oscillators, in cents. The beating is the character. */
    detuneCents: number;
    /** Seconds to reach full level. Long on purpose — see the note above. */
    attackSec: number;
    /** Seconds of decay after the peak. */
    releaseSec: number;
    /** 0-1 amount of sub-octave. */
    sub: number;
    /**
     * Saturation drive. The partial sum is pushed through `tanh(x*drive)`, which generates the
     * upper-harmonic roar. 1 is nearly clean; 3-4 is a full metallic snarl.
     */
    drive: number;
    /** 0-1 broadband noise bed, tilted low (rumble + body + air). A little is texture; a lot is a jet. */
    breath: number;
    /** Normalised peak. */
    peak: number;
    seed: number;
}

export const DEFAULT_HORN: HornOptions = {
    durationSec: 4.6,
    baseHz: 58,
    detuneCents: 18,
    attackSec: 1.6,
    releaseSec: 1.5,
    sub: 0.42,
    drive: 2.2,
    breath: 0.6,
    peak: 0.92,
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
    // A fuller stack than the old odd-only set — the reference has real low-mid body, and the tanh
    // drive below multiplies these into the highs. The 0.5 and 1.5 mults are the sub and a growling
    // fifth that keep it from sounding like a tuned note.
    const partials = [
        { mult: 0.5, gain: 0.85 },
        { mult: 1, gain: 1.0 },
        { mult: 1.5, gain: 0.3 },
        { mult: 2, gain: 0.55 },
        { mult: 3, gain: 0.4 },
        { mult: 4, gain: 0.26 },
        { mult: 5, gain: 0.18 },
        { mult: 6, gain: 0.12 },
        { mult: 7, gain: 0.08 },
    ];

    // Five noise bands, cut by differencing cascaded low-passes, then weighted to the reference's
    // tilt (≈ 0 / −8 / −8 / −15 / −26 dB from the low band). A single tilted noise could not hold
    // that shape — the reference is broadband, not just rumble.
    const white = new Float32Array(n);
    for (let i = 0; i < n; i++) white[i] = rand() * 2 - 1;
    const lpA = lowpass4(white, rate, 150);
    const lpB = lowpass4(white, rate, 500);
    const lpC = lowpass4(white, rate, 2000);
    const lpD = lowpass4(white, rate, 6000);

    const norm = Math.tanh(o.drive);
    const attack = Math.max(1, Math.floor(o.attackSec * rate));
    const release = Math.max(1, Math.floor(o.releaseSec * rate));
    const hold = Math.max(0, n - attack - release);

    for (let i = 0; i < n; i++) {
        const t = i / rate;

        let tone = 0;
        for (const p of partials) {
            const f = o.baseHz * p.mult;
            // The pair, one detuned — their beat frequency is what unsettles.
            tone += Math.sin(2 * Math.PI * f * t) * p.gain;
            tone += Math.sin(2 * Math.PI * f * detune * t) * p.gain * 0.7;
        }
        // Saturate: fold the partials up into the broadband roar. Normalised so drive changes timbre,
        // not level.
        tone = Math.tanh(tone * o.drive) / norm;
        tone += Math.sin(2 * Math.PI * (o.baseHz / 2) * t) * o.sub;

        const low = lpA[i];
        const lowmid = lpB[i] - lpA[i];
        const mid = lpC[i] - lpB[i];
        const himid = lpD[i] - lpC[i];
        const air = white[i] - lpD[i];
        const bed = low * 1.0 + lowmid * 1.3 + mid * 1.6 + himid * 1.1 + air * 0.5;
        let sample = tone * 0.6 + bed * o.breath;

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
