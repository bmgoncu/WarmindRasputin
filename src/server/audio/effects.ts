/**
 * Sample-level effects applied after the ffmpeg chain: buffer-stutter glitch and ring modulation.
 *
 * Both live here rather than in the filtergraph because ffmpeg has no native stutter and no ring
 * modulator, and because doing them on the sample buffer gives exact control over grain size and
 * placement. Running them BEFORE feature extraction matters — the orb should react to the
 * glitches, so they have to be in the signal the analyzer sees.
 *
 * Everything is seeded, so a given text renders identically every time and stays cacheable.
 */

/** mulberry32 — small, fast, and reproducible across runs. */
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export interface GlitchOptions {
    /** Glitch events per second of audio. */
    rate: number;
    /** Grain length in ms — the "stuck buffer" size. 15-45 reads as a digital stutter. */
    grainMsMin: number;
    grainMsMax: number;
    /** How many times a grain repeats. 2 is a blip; 5+ is a full "brrr". */
    repeatsMin: number;
    repeatsMax: number;
    seed: number;
    /**
     * Where glitches are allowed to land.
     *
     * `energy`   — anywhere loud enough. Maximum character, but grains land mid-word and eat
     *              phonemes, which is what costs intelligibility.
     * `boundary` — only on the tail of a phrase, immediately before a pause. The speech has
     *              already delivered its information by then, so the stutter reads as the
     *              machine hanging on the last syllable rather than as a damaged word.
     *              Pauses correspond to punctuation, so this is "glitch on the commas".
     * `hybrid`   — boundary glitches, plus a sparse scatter of energy-placed ones at
     *              `sprinkleRate`. Punctuation carries the rhythm; the scatter stops it sounding
     *              mechanical and metronomic without costing much intelligibility.
     */
    placement: "energy" | "boundary" | "hybrid";
    /** Events/sec for the scattered pass in `hybrid`. Independent of `rate`. */
    sprinkleRate: number;
    /**
     * 0–1. Randomly promotes some boundary glitches toward full strength, so a run of commas
     * doesn't produce an identical light tick every time — occasionally one hangs like a full
     * stop. This is how you get heavier glitches mixed into lighter ones WITHOUT scattering
     * grains mid-word, which is what actually damages speech.
     */
    weightJitter: number;
}

export const DEFAULT_GLITCH: GlitchOptions = {
    // Tuned by ear against the reference — the "medium" rung of `npm run audition`.
    rate: 2.0,
    grainMsMin: 14,
    grainMsMax: 42,
    repeatsMin: 2,
    repeatsMax: 6,
    seed: 0x9e3779b9,
    placement: "energy",
    sprinkleRate: 0.7,
    weightJitter: 0,
};

/** A punctuation mark found in the source text, with how hard it should glitch. */
export interface PunctuationMark {
    mark: string;
    /** 0–1. Scales grain length and repeat count, so a full stop hangs longer than a comma. */
    weight: number;
    /** Character position in the source text, normalized 0–1. Used to locate the mark in time. */
    pos: number;
}

const MARK_WEIGHTS: Record<string, number> = {
    ".": 1.0,
    "!": 1.0,
    "?": 1.0,
    ";": 0.7,
    ":": 0.7,
    ",": 0.45,
    "—": 0.6,
    "–": 0.6,
};

/**
 * Extracts glitch-triggering punctuation from the source text, in order.
 *
 * Driving intensity from the TEXT rather than from the audio alone means a full stop can hang
 * longer than a comma — the audio envelope alone can't distinguish them, since both are just
 * gaps of similar length. Positions still come from the audio (see `findPhraseEnds`); this
 * supplies only the ordered weights, which are then zipped onto those positions.
 *
 * Decimal points and abbreviations are excluded: a period between two digits ("3.14") or
 * mid-token is not a pause and `say` does not pause there.
 */
export function parsePunctuation(text: string): PunctuationMark[] {
    const out: PunctuationMark[] = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const weight = MARK_WEIGHTS[ch];
        if (weight === undefined) continue;
        if (ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
        // Collapse runs like "?!" or "..." into one event.
        if (out.length > 0 && MARK_WEIGHTS[text[i - 1] ?? ""] !== undefined) {
            out[out.length - 1].weight = Math.max(out[out.length - 1].weight, weight);
            continue;
        }
        out.push({ mark: ch, weight, pos: i / Math.max(1, text.length - 1) });
    }
    return out;
}

/**
 * Finds phrase boundaries: the sample index at which each run of speech ends before a pause.
 *
 * `say` inserts real pauses at punctuation, so these indices are effectively the commas and full
 * stops. Detection is on a short-term RMS envelope rather than raw samples, since individual
 * samples cross zero constantly even mid-vowel.
 */
export interface PhraseEnd {
    /** Sample index where speech stops and the pause begins. */
    at: number;
    /** Length of the pause in ms. Longer pauses correspond to stronger punctuation. */
    gapMs: number;
}

export function findPhraseEnds(
    samples: Float32Array,
    sampleRate: number,
    opts: { silenceThreshold?: number; minGapMs?: number } = {},
): PhraseEnd[] {
    // Deliberately sensitive. Over-detection is recoverable — callers rank by gap length and
    // keep the longest N — whereas a missed comma cannot be recovered at all. Measured on
    // Tom (Enhanced): at 70ms only the sentence-final pause registers, so commas were invisible.
    const threshold = opts.silenceThreshold ?? 0.02;
    const minGap = Math.floor(((opts.minGapMs ?? 25) / 1000) * sampleRate);
    const hop = Math.floor(sampleRate * 0.01);

    // Envelope first — one RMS value per 10 ms.
    const env: number[] = [];
    for (let i = 0; i + hop <= samples.length; i += hop) {
        let e = 0;
        for (let k = i; k < i + hop; k++) e += samples[k] * samples[k];
        env.push(Math.sqrt(e / hop));
    }

    const ends: PhraseEnd[] = [];
    let runStart = -1;
    const push = (start: number, end: number): void => {
        if ((end - start) * hop >= minGap && start > 0) {
            ends.push({ at: start * hop, gapMs: ((end - start) * hop * 1000) / sampleRate });
        }
    };
    for (let i = 0; i < env.length; i++) {
        const quiet = env[i] < threshold;
        if (quiet && runStart < 0) runStart = i;
        if (!quiet && runStart >= 0) {
            push(runStart, i);
            runStart = -1;
        }
    }
    // A trailing pause counts too — the final full stop.
    if (runStart > 0) push(runStart, env.length);

    // Merge gaps separated by only a sliver of speech. The long trailing silence in particular
    // fluctuates around the threshold and gets reported as several adjacent gaps, which then
    // compete for marks and pull two of them within ~140ms of each other.
    const mergeWithin = (60 / 1000) * sampleRate;
    const merged: PhraseEnd[] = [];
    for (const g of ends) {
        const prev = merged[merged.length - 1];
        const prevEnd = prev ? prev.at + (prev.gapMs / 1000) * sampleRate : -Infinity;
        if (prev && g.at - prevEnd < mergeWithin) {
            prev.gapMs = ((g.at + (g.gapMs / 1000) * sampleRate - prev.at) * 1000) / sampleRate;
        } else {
            merged.push({ ...g });
        }
    }
    return merged;
}

/**
 * Matches each punctuation mark to the pause it most likely caused, by RELATIVE POSITION.
 *
 * Ranking candidate gaps by length was tried first and is wrong: the trailing silence at the end
 * of a clip is the longest gap by far and gets split into several pieces, so the "longest N"
 * were all clustered at the end. Two commas seconds apart in the text both landed within 140ms
 * of each other.
 *
 * Speech duration is roughly linear in character count, so a mark at 40% through the text falls
 * near 40% through the speech. Matching is greedy and forward-only, which keeps marks in reading
 * order and stops a later mark from stealing an earlier gap.
 */
export function alignMarks(
    ends: PhraseEnd[],
    marks: PunctuationMark[],
    speechSamples: number,
): (PhraseEnd | undefined)[] {
    let cursor = 0;
    return marks.map((m, idx) => {
        let best: number | undefined;
        let bestDist = Infinity;
        // Leave one gap for every mark still to come, otherwise an early mark can take the last
        // gap by proximity and starve the ones after it — a sentence-final "?" got nothing
        // because the preceding comma claimed the closing pause.
        const limit = ends.length - (marks.length - 1 - idx);
        for (let i = cursor; i < limit; i++) {
            const dist = Math.abs(ends[i].at / speechSamples - m.pos);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        if (best === undefined) return undefined;
        cursor = best + 1;
        return ends[best];
    });
}

/**
 * Buffer-repeat stutter — the "audio driver is stuck" artifact.
 *
 * Grains are OVERWRITTEN rather than inserted, so total duration is unchanged. That keeps the
 * feature timeline aligned with playback; inserting would shift everything after each glitch and
 * desync the orb.
 *
 * Only fires on voiced/loud regions: a stutter in a silent gap is inaudible and wastes the effect.
 */
export function applyGlitch(
    input: Float32Array,
    sampleRate: number,
    opts: GlitchOptions = DEFAULT_GLITCH,
    marks: PunctuationMark[] = [],
): Float32Array {
    const out = Float32Array.from(input);
    const rand = rng(opts.seed);

    if (opts.placement === "boundary" || opts.placement === "hybrid") {
        // Stutter the tail of each phrase, running forward into the pause. The words have already
        // been delivered, so nothing is masked — it reads as the machine hanging rather than as a
        // corrupted word.
        //
        // Positions come from the audio (the pauses `say` actually produced); intensity comes
        // from the text punctuation. Neither alone is enough: the envelope can't tell a comma
        // from a full stop, and the text can't tell you where in time the pause landed.
        const detected = findPhraseEnds(input, sampleRate);
        // With marks, place each one at the pause nearest its relative position in the text.
        // Without marks, glitch every detected pause at mid weight.
        const chosen = marks.length > 0
            ? alignMarks(detected, marks, input.length).flatMap((e) => (e ? [e] : []))
            : detected;

        chosen.forEach(({ at: end }, idx) => {
            const base = marks[idx]?.weight ?? 0.7;
            // Promote upward only — jitter should add occasional emphasis, never mute a full stop.
            const weight = Math.min(1, base + rand() * opts.weightJitter);
            const grainMs = opts.grainMsMin + (opts.grainMsMax - opts.grainMsMin) * weight;
            const grainLen = Math.floor(grainMs * (sampleRate / 1000));
            const repeats = Math.max(
                1,
                Math.round(opts.repeatsMin + (opts.repeatsMax - opts.repeatsMin) * weight),
            );
            // Source grain is the last of the phrase; repeats run forward INTO the pause, so the
            // stutter occupies silence instead of overwriting the next phrase.
            const src = end - grainLen;
            if (src < 0) return;

            const fade = Math.min(48, Math.floor(grainLen * 0.1));
            for (let r = 0; r < repeats; r++) {
                const dst = end + r * grainLen;
                if (dst + grainLen >= out.length) break;
                // Each repeat quieter than the last — a decaying hang, not a machine-gun loop.
                const gain = 0.85 * Math.pow(0.72, r);
                for (let i = 0; i < grainLen; i++) {
                    const s = input[src + i] * gain;
                    out[dst + i] = i < fade ? out[dst + i] * (1 - i / fade) + s * (i / fade) : s;
                }
            }
        });
        if (opts.placement === "boundary") return out;
    }

    // Energy pass. In hybrid this runs at the lower `sprinkleRate` on top of the boundary pass.
    //
    // The source grain is always the CLEAN input, never `out`. Sourcing from the glitched buffer
    // let a scatter grain copy an already-stuttered region and repeat it — glitching a glitch,
    // which compounds into smeared damage rather than a clean stutter.
    const scatterRate = opts.placement === "hybrid" ? opts.sprinkleRate : opts.rate;
    const events2 = Math.max(0, Math.round((input.length / sampleRate) * scatterRate));
    const source = input;

    // Short-term energy, so glitches land on speech rather than silence.
    const win = Math.floor(sampleRate * 0.02);
    const energyAt = (i: number): number => {
        let e = 0;
        const start = Math.max(0, i - win);
        const end = Math.min(input.length, i + win);
        for (let k = start; k < end; k++) e += input[k] * input[k];
        return Math.sqrt(e / Math.max(1, end - start));
    };

    let placed = 0;
    let attempts = 0;
    while (placed < events2 && attempts < events2 * 40) {
        attempts++;
        const grainLen = Math.floor(
            (opts.grainMsMin + rand() * (opts.grainMsMax - opts.grainMsMin)) * (sampleRate / 1000),
        );
        const repeats = Math.floor(opts.repeatsMin + rand() * (opts.repeatsMax - opts.repeatsMin + 1));
        const span = grainLen * repeats;
        if (span >= input.length) continue;

        const at = Math.floor(rand() * (input.length - span));
        if (energyAt(at) < 0.02) continue; // silence — try elsewhere

        // Repeat the grain over the span. A short crossfade at each seam prevents the click that
        // would otherwise fire on every repeat boundary and read as damage rather than glitch.
        const fade = Math.min(48, Math.floor(grainLen * 0.1));
        for (let r = 1; r < repeats; r++) {
            const dst = at + r * grainLen;
            for (let i = 0; i < grainLen && dst + i < out.length; i++) {
                const s = source[at + i];
                if (i < fade) {
                    const t = i / fade;
                    out[dst + i] = out[dst + i] * (1 - t) + s * t;
                } else {
                    out[dst + i] = s;
                }
            }
        }
        placed++;
    }

    return out;
}

export interface RingModOptions {
    /** Carrier frequency in Hz. Low (40-120) reads as mechanical growl, not sci-fi laser. */
    carrierHz: number;
    /** Wet mix 0-1. Full wet destroys intelligibility; 0.25-0.45 reads robotic but legible. */
    mix: number;
}

/** 0.20 chosen by ear: reads authoritative and mechanical without scattering vowels. */
export const DEFAULT_RINGMOD: RingModOptions = { carrierHz: 62, mix: 0.2 };

/**
 * Ring modulation — multiply by a carrier sine. This is the classic robot-voice primitive and is
 * a large part of why the reference reads as a machine rather than a processed human.
 *
 * Mixed rather than fully wet: ring modulation is not a filter, it relocates the entire spectrum
 * into sum and difference frequencies, so at 100% wet the formants that carry vowel identity are
 * scattered and the words stop being words.
 */
export function applyRingMod(
    input: Float32Array,
    sampleRate: number,
    opts: RingModOptions = DEFAULT_RINGMOD,
): Float32Array {
    const out = new Float32Array(input.length);
    const step = (2 * Math.PI * opts.carrierHz) / sampleRate;
    for (let i = 0; i < input.length; i++) {
        const carrier = Math.sin(step * i);
        out[i] = input[i] * (1 - opts.mix) + input[i] * carrier * opts.mix;
    }
    return out;
}

/** Peak-normalizes to `target` (linear). Applied last so the effects can't clip the output. */
export function normalizePeak(input: Float32Array, target = 0.95): Float32Array {
    let peak = 0;
    for (const s of input) peak = Math.max(peak, Math.abs(s));
    if (peak === 0) return input;
    const g = target / peak;
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = input[i] * g;
    return out;
}
