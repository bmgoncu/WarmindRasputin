/**
 * Low percussive "thud" one-shots for the idle ambience layer.
 *
 * These read as a subtle low knock in a large metal room, not as an electrical scratch.
 *
 * The first implementation was band-passed noise with a crackle gate — electrical arcing. It was
 * wrong, and measurement says so plainly: spectral centroid 7235 Hz with 3% of energy below
 * 300 Hz, against the Mindlab reference's 774 Hz and 51%. Nearly ten times too bright. A tuning
 * knob was then added to "blunt" it and moved the centroid from 7235 to 7418 Hz — no audible
 * change, because attack and gating don't govern character when the spectrum is that far off.
 *
 * Two lessons are baked into the design:
 *   1. A thud is a damped low-frequency RESONANCE, not filtered noise. Noise of any bandwidth
 *      reads as hiss or scratch; a decaying pitched body reads as a knock.
 *   2. One-pole filters roll off at 6 dB/octave, nowhere near enough to tame white noise — every
 *      octave above the cutoff still contributes, which is why the "band-passed" noise measured
 *      7 kHz. The low-pass here is a cascade of four, and noise is a garnish rather than the
 *      substance.
 */

/** mulberry32, matching effects.ts — deterministic per seed. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface ArcOptions {
    /** Total length in seconds. */
    durationSec: number;
    /** Where the body settles, Hz. 55–120 is a thud; above ~200 it starts to read as a tone. */
    baseHz: number;
    /**
     * How far above `baseHz` the pitch starts, as a multiplier. The downward sweep over the first
     * few tens of ms is what makes it read as a struck object rather than a beep.
     */
    pitchDrop: number;
    /** 0–1. Low-passed noise blended in for grit. Above ~0.3 it starts to sound like scratch. */
    texture: number;
    /**
     * 0–1. Amount of gated crackle layered over the body.
     *
     * The body alone is a pure damped resonance and reads as a drum. The crackle is what makes it
     * electrical. It is a separate layer rather than the substance — an earlier version made
     * crackle the whole sound and measured a 7 kHz centroid, which read as scratch.
     */
    crackle: number;
    /**
     * Low-pass cutoff for the crackle layer, Hz. This is the sharpness control that actually
     * works: it governs the spectrum, which is what the ear judges. Around 1200–2500 reads as
     * grit; push past ~4000 and it becomes scratch again.
     */
    crackleHz: number;
    /** Crackle ticks per second. */
    crackleRate: number;
    /** Normalized peak. Ambience texture, so kept well under unity. */
    peak: number;
    /** Decay in seconds — how long the body rings. */
    decaySec: number;
    /** Optional raw material; a low-passed slice replaces the synthetic noise texture. */
    source?: Float32Array;
    seed: number;
}

export const DEFAULT_ARC: ArcOptions = {
    durationSec: 0.55,
    baseHz: 72,
    pitchDrop: 2.4,
    texture: 0.14,
    crackle: 0.3,
    crackleHz: 1700,
    crackleRate: 70,
    peak: 0.4,
    decaySec: 0.22,
    seed: 1,
};

/**
 * Cascaded one-pole low-pass — 4 poles, so 24 dB/octave.
 *
 * A single one-pole (6 dB/oct) leaves so much high band that white noise still measures a ~7 kHz
 * centroid. That was the bug behind the "no audible change" tuning.
 */
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

/**
 * Generates one thud.
 *
 * A pitch-swept sine body carries the weight; a little low-passed noise gives it grit so it isn't
 * a pure tone. Amplitude decays exponentially and the attack is a short raised cosine — a linear
 * ramp leaves a corner at the top that reads as a click.
 */
export function synthArc(rate: number, opts: Partial<ArcOptions> = {}): Float32Array {
    const o = { ...DEFAULT_ARC, ...opts };
    const rand = rng(o.seed);
    const n = Math.floor(o.durationSec * rate);
    const out = new Float32Array(n);

    // Texture layer: low-passed noise, or a low-passed slice of the source when given.
    let grit: Float32Array;
    if (o.source && o.source.length > n) {
        const off = Math.floor(rand() * (o.source.length - n));
        grit = o.source.slice(off, off + n);
    } else {
        grit = new Float32Array(n);
        for (let i = 0; i < n; i++) grit[i] = rand() * 2 - 1;
    }
    grit = lowpass4(grit, rate, o.baseHz * 6);
    let gritPeak = 0;
    for (const v of grit) gritPeak = Math.max(gritPeak, Math.abs(v));
    if (gritPeak > 0) for (let i = 0; i < n; i++) grit[i] /= gritPeak;

    // Crackle layer: noise through a held-and-jumped gate, then low-passed hard. The gate is what
    // makes it read as electrical rather than as hiss; the low-pass is what keeps it from reading
    // as scratch. Both are needed.
    const crackleLayer = new Float32Array(n);
    if (o.crackle > 0) {
        const raw = new Float32Array(n);
        for (let i = 0; i < n; i++) raw[i] = rand() * 2 - 1;
        let g = 0;
        let hold = 0;
        for (let i = 0; i < n; i++) {
            if (hold <= 0) {
                hold = Math.max(1, Math.floor((rate / o.crackleRate) * (0.3 + rand() * 1.7)));
                g = rand() < 0.3 ? 0 : Math.pow(rand(), 0.6);
            }
            crackleLayer[i] = raw[i] * g;
            hold--;
        }
        const filtered = lowpass4(crackleLayer, rate, o.crackleHz);
        let cp = 0;
        for (const v of filtered) cp = Math.max(cp, Math.abs(v));
        if (cp > 0) for (let i = 0; i < n; i++) crackleLayer[i] = filtered[i] / cp;
    }

    // Pitch sweep: starts at baseHz * pitchDrop and settles to baseHz within ~40ms.
    const pitchTau = 0.04 * rate;
    const attack = Math.max(1, Math.floor(0.006 * rate));
    const decay = o.decaySec * rate;

    let phase = 0;
    for (let i = 0; i < n; i++) {
        const f = o.baseHz * (1 + (o.pitchDrop - 1) * Math.exp(-i / pitchTau));
        phase += (2 * Math.PI * f) / rate;

        const atk = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : 1;
        const env = atk * Math.exp(-i / decay);

        const body = Math.sin(phase) * (1 - o.texture) + grit[i] * o.texture;
        out[i] = env * (body * (1 - o.crackle) + crackleLayer[i] * o.crackle);
    }

    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * o.peak;
    return out;
}

/**
 * A varied set for an idle layer that shouldn't repeat audibly.
 *
 * When `source` is given, roughly a third of the set draws its texture from it.
 */
export function arcVariants(
    rate: number,
    count: number,
    baseSeed = 1,
    source?: Float32Array,
): Float32Array[] {
    return Array.from({ length: count }, (_, k) =>
        synthArc(rate, {
            seed: baseSeed + k * 7919,
            baseHz: 58 + (k % 5) * 17,
            pitchDrop: 1.9 + (k % 3) * 0.45,
            decaySec: 0.16 + (k % 4) * 0.07,
            durationSec: 0.4 + (k % 4) * 0.12,
            texture: 0.1 + (k % 3) * 0.06,
            // Centred tightly on the chosen setting (crackle 0.30 @ 1700 Hz) — enough spread to
            // avoid audible repetition, not enough to wander off the character.
            crackle: 0.27 + (k % 4) * 0.02,
            crackleHz: 1550 + (k % 3) * 150,
            crackleRate: 55 + (k % 4) * 25,
            source: source && k % 3 === 2 ? source : undefined,
        }),
    );
}
