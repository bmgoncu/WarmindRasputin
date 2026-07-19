/**
 * ffmpeg filter chains for the Rasputin voice.
 *
 * Each stage maps to one identifiable trait of the Destiny 2 Warmind voice and is individually
 * tunable. The source is `say -v Milena`, which renders English text with genuine Russian
 * phonetics — the accent is real, so nothing here needs to fake it.
 *
 * The one thing we deliberately do NOT copy: the game's voice is Russian played *backwards*
 * through a vocoder, which is why it's unintelligible by design. We get the same "backwards"
 * impression from reverse-reverb (areverse → echo → areverse), which lays a swelling pre-echo
 * before each word while the word itself plays forward. See CLAUDE.md → Hard rules.
 *
 * Spectral targets measured from assets/refs (89s of extracted game audio):
 *   RMS -20.4 dBFS, peak -0.2, crest factor 10.2, dynamic range 96 dB.
 *   20-150 Hz dominant · 150-500 Hz strong · 500-2500 Hz present · sharp rolloff past 5 kHz.
 * Crest factor 10 means it is NOT heavily compressed — resist the urge to squash it.
 */

import type { GlitchOptions, RingModOptions } from "../audio/effects.js";

export interface ChainStage {
    /** Which trait of the reference voice this stage is responsible for. */
    trait: string;
    /** ffmpeg filter fragment, or a labelled sub-graph for anything needing split/mix. */
    filter: string;
    /** Set false to bypass while auditioning. */
    enabled?: boolean;
}

/**
 * Per-render tuning of the stages most likely to need adjustment by ear.
 *
 * Echo is separated out because it is the stage that most damages intelligibility, and not for
 * the obvious reason: the reverse-reverb places a swelling PRE-echo before each word, and human
 * hearing has far stronger backward masking than forward masking. Sound arriving just before a
 * consonant masks it much more effectively than the same sound arriving just after. So the
 * "backwards" trick lands precisely where it costs the most word onsets.
 */
export interface ChainTuning {
    /** Serialized firequalizer from the fitted curve. */
    matchEq?: string;
    /** Reverse-reverb decay. 0 disables the stage entirely. */
    reverseDecay?: number;
    /** How much reverse-reverb is blended under the dry signal (amix weight). */
    reverseMix?: number;
    /** Room echo decays, near and far tap. */
    roomNear?: number;
    roomFar?: number;
    /**
     * Bit-crush depth. Lower = more digital degradation. 7 is heavily crushed, 11-12 is a hint.
     * Quantization noise sits on consonants — the quietest, most information-dense part of
     * speech — so this is a direct clarity lever.
     */
    crushBits?: number;
}

export const DEFAULT_TUNING: Required<Omit<ChainTuning, "matchEq">> = {
    // Reverse-reverb is OFF by default. It was the "backwards without reversing the words"
    // trick, but its pre-echo masks word onsets (backward masking is much stronger than
    // forward masking), and it measurably cost intelligibility in listening tests. The
    // backwards character now lives in the verbatim stingers and the orb's ignition, not here.
    reverseDecay: 0,
    reverseMix: 0.22,
    // Room only, kept light. The echo lands AFTER each word, where masking is weak, so it
    // buys space without eating consonants.
    roomNear: 0.12,
    roomFar: 0.06,
    crushBits: 7,
};

export interface VoiceChain {
    name: string;
    description: string;
    /** Playback sample rate. `say` renders Milena natively at 22050. */
    rate: number;
    /** Words per minute passed to `say -r`. Rasputin reads slow. */
    wpm: number;
    /**
     * Pitch drop in semitones, applied by `rubberband -F` (formant-PRESERVING).
     *
     * Split from formants deliberately. A male voice is not a female voice slowed down: F0
     * differs by roughly an octave while formants differ only ~2-3 semitones. Dragging both
     * down together via asetrate — which is all ffmpeg can do — makes the vocal tract read as
     * enormous and the result sounds like tape running slow, not like a man.
     */
    pitchSemitones: number;
    /**
     * Formant drop in semitones, applied by asetrate+atempo (shifts pitch and formants together;
     * the extra pitch drop is accounted for in pitchSemitones). Keep small — 2 to 4.
     */
    formantSemitones: number;
    /** Whether sample-level glitch + ring modulation apply to this chain. */
    effects: boolean;
    /**
     * `say -v` voice for this chain. Falls back to RASPUTIN_VOICE, then Tom (Enhanced).
     *
     * Per-chain rather than global because og-warmind needs a ru_RU voice while every other chain
     * wants the neural en-US one — the accent and the neural quality cannot both be had.
     */
    voice?: string;
    /**
     * Translate the source text into this language before speaking it. Undefined = speak as given.
     *
     * Carried on the chain rather than passed per-render so the mode is one selection, not a
     * setting the caller has to remember to pair with the right voice.
     */
    translateTo?: string;
    /** Chain-level tuning defaults. A per-render `tuning` merges on top of this. */
    tuning?: ChainTuning;
    /** Chain-level glitch defaults, merged over DEFAULT_GLITCH. */
    glitch?: Partial<GlitchOptions>;
    /** Chain-level ring-mod defaults, merged over DEFAULT_RINGMOD. */
    ringMod?: Partial<RingModOptions>;
    /**
     * Builds the full filter_complex. Returns a graph whose final two pads are
     * [out] (playable audio) and [an] (f32le analysis tap) — the tap comes off the *end* of the
     * chain so the feature timeline describes exactly the signal that reaches the speaker.
     *
     * `matchEq` is a serialized firequalizer from the fitted curve. Pass "" to render unmatched,
     * which is what the fitter needs in order to measure the chain's own response.
     */
    build(tuning?: ChainTuning): string;
}

/** Pitch shift that preserves duration: asetrate drops pitch and stretches, atempo restores. */
function pitchShift(rate: number, factor: number): string {
    return `asetrate=${rate}*${factor},aresample=${rate},atempo=${(1 / factor).toFixed(4)}`;
}

/**
 * The full Warmind chain. Stage numbering matches the trait table in CLAUDE.md → Voice chain.
 * `matchEq` is a serialized firequalizer from the fitted curve, or "" to render unmatched
 * (which is what the fitter itself needs, to measure the chain's own response).
 */
function buildWarmind(rate: number, tuning: ChainTuning): string {
    const t = { ...DEFAULT_TUNING, ...tuning };
    const matchEq = tuning.matchEq ?? "";
    // With the reverse stage off there is nothing to blend, so collapse the split/mix away
    // rather than mixing in silence at some weight.
    const reverseStage = t.reverseDecay > 0
        ? [
            `asplit=2[dry][revin];`,
            `[revin]areverse,aecho=0.8:0.9:180:${t.reverseDecay},areverse[rev];`,
            `[dry][rev]amix=inputs=2:weights=1 ${t.reverseMix}:normalize=0,`,
          ].join("")
        : "";
    const roomStage = t.roomNear > 0 || t.roomFar > 0
        ? `aecho=0.7:0.75:340|520:${t.roomNear}|${t.roomFar},`
        : "";
    return [
        // 1. Pitch and formants are handled BEFORE this graph — see synth.ts. asetrate applies
        //    the small formant drop, then `rubberband -F` applies the large pitch drop with
        //    formants held. Doing it all with asetrate here produced the slow-motion artifact.

        // 2. Comms band. Reference rolls off above ~5 kHz but keeps real content to ~11 kHz —
        //    cutting at 5.5k measured 9 dB short in the top band and cost intelligibility.
        `[0:a]highpass=f=55,lowpass=f=7800,`,

        // 3. Spectral match to the reference — FITTED by `npm run fit-eq`, not hand-tuned.
        //    Hand-tuning this failed across five attempts and is worth recording so nobody
        //    repeats it: Milena is inherently low-mid heavy (raw `say` measures +18.8 dB at
        //    150-500 Hz against the reference's +6.3), a high-Q notch cannot shift a band
        //    average, and a shelf wide enough to shift it also flattens the 20-150 dominance
        //    that defines the Warmind rumble. Every fix traded one error for another.
        //    Measuring both spectra and subtracting converges immediately.
        //    Empty until the fitter has run — an unmatched render is the correct default.
        matchEq ? `${matchEq},` : "",
        `asubboost=dry=0.8:wet=0.45:decay=0.7:feedback=0.6:cutoff=120,`,

        // 4/5. Reverse-reverb — the "backwards" impression without reversing the words.
        //      Tunable, and disableable: pre-echo masks word onsets (backward masking), so this
        //      is the first stage to back off when intelligibility suffers.
        reverseStage,
        `asplit=2[mix][octin];`,

        // 6. Octave-down double for inhuman weight. Machines don't have one larynx.
        //    Keep it low: it dumps energy straight into 150-500 Hz, the band that most needs
        //    restraint. At volume 0.4 it undid most of the stage-3 cut.
        `[octin]${pitchShift(rate, 0.5)},volume=0.22[oct];`,
        `[mix][oct]amix=inputs=2:weights=1 0.35:normalize=0,`,

        // 7. Metallic comb — stands in for the vocoder's formant character.
        `chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.4:2|1.3,`,
        `flanger=delay=2:depth=3:regen=25:speed=0.3,`,

        // 7b. Recover the top end the comb notches and octave layer eat. The reference keeps
        //     real content to ~11 kHz; without this the voice measures 5-7 dB short up there
        //     and reads muffled rather than mechanical.
        `treble=g=7:f=3500,`,

        // 8. Digital degradation — the "hang". Reference shows broadband vertical striations.
        `acrusher=bits=${t.crushBits}:mode=log:aa=1,`,

        // 9. Bunker space. Two taps, not one, or it reads as a slapback rather than a room.
        roomStage,

        // 10. Level. loudnorm is load-bearing — `say` loudness varies per utterance, which would
        //     otherwise make the orb's response amplitude depend on sentence length.
        //     Do not add heavy compression: the reference crest factor is 10.2.
        `loudnorm=I=-18:TP=-1.5:LRA=11,`,
        `alimiter=limit=0.95,`,
        `anull[out]`,
    ].join("");
}

/**
 * Minimal chain — accent and a little weight, no glitch or vocoder character.
 * This is the intelligibility control in `npm run audition`: if the full chain is much harder to
 * transcribe than this, the full chain has gone too far.
 */
function buildClean(): string {
    return [
        `[0:a]highpass=f=60,lowpass=f=6500,`,
        `equalizer=f=110:t=q:w=0.8:g=5,`,
        `aecho=0.8:0.85:60:0.25,`,
        `loudnorm=I=-18:TP=-1.5:LRA=11,`,
        `anull[out]`,
    ].join("");
}

/** Raw `say` output, only levelled. The floor of the A/B. */
function buildDry(): string {
    return `[0:a]loudnorm=I=-18:TP=-1.5:LRA=11,anull[out]`;
}

const RATE = 22050;

export const CHAINS: Record<string, VoiceChain> = {
    warmind: {
        name: "warmind",
        description: "Full Rasputin character — reverse-reverb, octave double, comb, bit-crush, bunker space.",
        rate: RATE,
        wpm: 150,
        pitchSemitones: -2,
        formantSemitones: -1,
        effects: true,
        build: (tuning = {}) => buildWarmind(RATE, tuning),
    },
    /**
     * The original article: a Russian voice speaking Russian, degraded hard.
     *
     * Every other chain is an en-US neural voice wearing an accent. This one translates first and
     * uses Yuri, so the phonetics are genuinely Russian rather than approximated. Intelligibility
     * is not a goal here in the way it is elsewhere — the listener is not expected to parse the
     * Russian, so the degradation can run at full warmind strength.
     *
     * Pitch is -3 rather than warmind's -2: Yuri measures F0 96.8 Hz against Tom's ~109 after
     * shifting, and -3 lands Yuri at 81.4 Hz, essentially on the reference's 80.5.
     */
    "og-warmind": {
        name: "og-warmind",
        description: "Yuri speaking Russian, full warmind degradation. Input is translated first.",
        rate: RATE,
        wpm: 145,
        pitchSemitones: -3,
        formantSemitones: -1,
        effects: true,
        voice: "Yuri (Enhanced)",
        translateTo: "Russian",
        build: (tuning = {}) => buildWarmind(RATE, tuning),
    },
    measured: {
        name: "measured",
        description: "Roleplay character, but glitches land only on phrase endings — every word "
            + "stays legible while the machine still audibly hangs.",
        rate: RATE,
        wpm: 155,
        pitchSemitones: -2,
        formantSemitones: -1,
        effects: true,
        // Crush and room sit between warmind and plain.
        // Pulled toward `plain` for clarity — crush, room and ring all closer to that end.
        tuning: { crushBits: 10, roomNear: 0.07, roomFar: 0.04 },
        // `hybrid`: punctuation drives the main glitches (a full stop hangs longer than a comma),
        // plus a sparse scatter so the rhythm doesn't become metronomic. `rate` is unused here;
        // `sprinkleRate` controls the scatter.
        // Hybrid: punctuation drives the main glitches (a full stop hangs longer than a comma),
        // plus a sparse mid-word scatter for texture.
        //
        // The scatter was briefly blamed for a bad-sounding render and removed. That was wrong.
        // The real cause was a bug in the scatter pass: it sourced grains from the ALREADY
        // GLITCHED buffer, so it could copy a stuttered region and stutter it again, compounding
        // into smear. With grains sourced from clean audio the scatter sounds good and is
        // preferred — chosen by ear over both the boundary-only and jittered variants.
        glitch: {
            placement: "hybrid",
            sprinkleRate: 0.55,
            weightJitter: 0,
            grainMsMin: 18,
            grainMsMax: 38,
            repeatsMin: 2,
            repeatsMax: 5,
        },
        ringMod: { mix: 0.11 },
        build: (tuning = {}) => buildWarmind(RATE, tuning),
    },
    plain: {
        name: "plain",
        description: "Speak-plainly mode. Same Rasputin identity and pitch, but far less glitch, "
            + "crush and room — for reports you actually need to parse.",
        rate: RATE,
        wpm: 165,
        // Pitch and formants are UNCHANGED from warmind on purpose: this is the same character
        // speaking clearly, not a different voice. Clarity comes from backing off the
        // degradation stages, which is where intelligibility is actually lost.
        pitchSemitones: -2,
        formantSemitones: -1,
        effects: true,
        tuning: { crushBits: 11, roomNear: 0.06, roomFar: 0.03 },
        glitch: { rate: 0.6, grainMsMax: 26, repeatsMax: 3 },
        ringMod: { mix: 0.08 },
        build: (tuning = {}) => buildWarmind(RATE, tuning),
    },
    clean: {
        name: "clean",
        description: "Accent and weight only. Intelligibility control for A/B.",
        rate: RATE,
        wpm: 160,
        pitchSemitones: -2,
        formantSemitones: 0,
        effects: false,
        build: () => buildClean(),
    },
    dry: {
        name: "dry",
        description: "Raw say output, levelled. The floor of the comparison.",
        rate: RATE,
        wpm: 175,
        pitchSemitones: 0,
        formantSemitones: 0,
        effects: false,
        build: () => buildDry(),
    },
};

export function getChain(name: string): VoiceChain {
    const chain = CHAINS[name];
    if (!chain) {
        throw new Error(`Unknown chain "${name}". Known: ${Object.keys(CHAINS).join(", ")}`);
    }
    return chain;
}
