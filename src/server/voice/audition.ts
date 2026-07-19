/**
 * Renders a ladder of variants into samples/ for A/B listening.
 *
 *   npm run audition                 # default line
 *   npm run audition -- "some text"
 *
 * The ladder runs from most intelligible to most characterful. It backs off ring modulation
 * first and pitch last, because that is the order in which these stages damage intelligibility:
 *
 *   1. Ring modulation  — worst. Multiplies by a carrier, relocating the whole spectrum into sum
 *                         and difference frequencies. Formants carry vowel identity, so scattering
 *                         them makes words stop being words. 32% wet is already a lot.
 *   2. Bit crush        — quantization noise sits on top of consonants, which are the quietest
 *                         and most information-dense part of speech.
 *   3. Reverse-reverb   — the pre-echo smears word onsets, blurring where one word starts.
 *   4. Glitch stutter   — replaces real audio with repeats; damage scales with density.
 *   5. Pitch shift      — least damaging. rubberband -F holds the formants, so the words survive
 *                         a few semitones nearly intact.
 *
 * Pick a rung by ear, then set the winner's numbers as the chain defaults.
 */

import { mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateF0 } from "../audio/pitch.js";
import { synthesize, type SynthOptions } from "./synth.js";

const OUT_DIR = "samples";
const DEFAULT_TEXT =
    "From this day forward, I will defend humanity on my own terms. I am Rasputin. I have no equal.";

interface Rung {
    name: string;
    note: string;
    opts: Omit<SynthOptions, "text">;
}

/**
 * Everything except the stage under test is held at the settings that were liked: glitch between
 * the "mild" and "medium" rungs, pitch -2 semitones.
 */
const HELD: Omit<SynthOptions, "text"> = {
    chain: "warmind",
    pitchSemitones: -2,
    formantSemitones: -1,
    glitch: { rate: 2.0 },
    ringMod: { mix: 0.2 },
};

const LADDERS: Record<string, Rung[]> = {
    /** Isolates echo. Reverse-reverb comes off first — pre-echo masks word onsets. */
    echo: [
        {
            name: "e0-dry",
            note: "no reverse-reverb, no room — the intelligibility ceiling for this glitch level",
            opts: { ...HELD, tuning: { reverseDecay: 0, roomNear: 0, roomFar: 0 } },
        },
        {
            name: "e1-room-only",
            note: "no reverse-reverb, light room only",
            opts: { ...HELD, tuning: { reverseDecay: 0, roomNear: 0.12, roomFar: 0.06 } },
        },
        {
            name: "e2-room-more",
            note: "no reverse-reverb, fuller room",
            opts: { ...HELD, tuning: { reverseDecay: 0, roomNear: 0.2, roomFar: 0.12 } },
        },
        {
            name: "e3-hint-reverse",
            note: "a hint of reverse-reverb (short, quiet) + light room",
            opts: { ...HELD, tuning: { reverseDecay: 0.15, reverseMix: 0.22, roomNear: 0.12, roomFar: 0.06 } },
        },
        {
            name: "e4-current",
            note: "current echo settings — full reverse-reverb + room",
            opts: { ...HELD, tuning: {} },
        },
    ],
    /**
     * Base-voice A/B: same chain, same settings, only the source voice differs.
     *
     * Caveat worth knowing when judging these: Yuri is an *Enhanced* (neural) voice while the
     * English ones here are the older compact synths. So this compares voice QUALITY as much as
     * accent. Installing an Enhanced English male voice makes it a fair fight.
     */
    voices: [
        { name: "v1-yuri-ru", note: "Yuri (Enhanced, ru_RU) — current base, Russian accent", opts: { chain: "warmind", voice: "Yuri" } },
        { name: "v2-evan-us", note: "Evan (Enhanced, en-US) — neural, no accent", opts: { chain: "warmind", voice: "Evan (Enhanced)" } },
        { name: "v3-tom-us", note: "Tom (Enhanced, en-US) — neural, no accent", opts: { chain: "warmind", voice: "Tom (Enhanced)" } },
        { name: "v4-daniel-gb", note: "Daniel (en_GB) — compact synth, for contrast", opts: { chain: "warmind", voice: "Daniel" } },
        { name: "v5-evan-measured", note: "Evan through MEASURED mode", opts: { chain: "measured", voice: "Evan (Enhanced)" } },
        { name: "v6-tom-measured", note: "Tom through MEASURED mode", opts: { chain: "measured", voice: "Tom (Enhanced)" } },
    ],

    /**
     * Isolates the glitch SOUND in measured mode. Everything else held constant per rung except
     * where noted, so a preference here is about the glitch and nothing else.
     */
    glitch: [
        {
            name: "w1-boundary-jitter",
            note: "boundary only + weight jitter (current fix) — some commas hang like full stops",
            opts: { chain: "measured" },
        },
        {
            name: "w2-boundary-flat",
            note: "boundary only, NO jitter — every mark glitches at its own weight, uniformly",
            opts: { chain: "measured", glitch: { weightJitter: 0 } },
        },
        {
            name: "w3-old-t2",
            note: "the earlier T2 settings you preferred — heavier crush/room/ring, no jitter",
            opts: {
                chain: "measured",
                glitch: { weightJitter: 0 },
                ringMod: { mix: 0.16 },
                tuning: { crushBits: 9, roomNear: 0.1, roomFar: 0.05 },
            },
        },
        {
            name: "w4-broken-hybrid",
            note: "the U2 version you disliked — mid-word scatter. For confirming the diagnosis.",
            opts: { chain: "measured", glitch: { placement: "hybrid", sprinkleRate: 0.55, weightJitter: 0 } },
        },
    ],

    /** The earlier glitch/ringmod/pitch ladder, kept for reference. */
    character: [
        { name: "c1-plain", note: "no glitch, no ringmod, native pitch", opts: { chain: "warmind", effects: false, pitchSemitones: 0, formantSemitones: 0 } },
        { name: "c2-light", note: "sparse glitch, no ringmod, -1st", opts: { chain: "warmind", pitchSemitones: -1, formantSemitones: 0, glitch: { rate: 1.2, grainMsMax: 30, repeatsMax: 3 }, ringMod: { mix: 0 } } },
        { name: "c3-mild", note: "some glitch, light ringmod, -1st", opts: { chain: "warmind", pitchSemitones: -1, formantSemitones: 0, glitch: { rate: 1.6, grainMsMax: 34, repeatsMax: 4 }, ringMod: { mix: 0.12 } } },
        { name: "c4-medium", note: "moderate glitch + ringmod, -2st", opts: { chain: "warmind", pitchSemitones: -2, formantSemitones: -1, glitch: { rate: 2.0 }, ringMod: { mix: 0.2 } } },
    ],
};

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const which = args.find((a) => a.startsWith("--ladder="))?.split("=")[1] ?? "echo";
    const ladder = LADDERS[which];
    if (!ladder) {
        console.error(`Unknown ladder "${which}". Known: ${Object.keys(LADDERS).join(", ")}`);
        process.exitCode = 1;
        return;
    }
    const text = args.filter((a) => !a.startsWith("--")).join(" ") || DEFAULT_TEXT;
    await mkdir(OUT_DIR, { recursive: true });

    console.log(`\n"${text}"   [ladder: ${which}]\n`);
    console.log("  file                    F0    note");
    console.log("  " + "-".repeat(90));

    for (const rung of ladder) {
        const res = await synthesize({ text, ...rung.opts });
        const dest = join(OUT_DIR, `${rung.name}.wav`);
        await copyFile(res.wavPath, dest);

        const f0 = estimateF0(res.samples, res.sampleRate);
        console.log(`  ${(rung.name + ".wav").padEnd(20)} ${f0.medianHz.toFixed(0).padStart(4)} Hz  ${rung.note}`);
    }

    console.log("\n  Reference for comparison: samples/00-REFERENCE.wav\n");
    console.log("  afplay samples/00-REFERENCE.wav");
    for (const r of ladder) console.log(`  afplay samples/${r.name}.wav`);
    console.log("");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
