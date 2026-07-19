/**
 * Measures the fundamental of the reference against the rendered voice, and reports the pitch
 * shift needed to match it.
 *
 *   npm run check-pitch
 *
 * Exists because "does it sound male?" is otherwise an argument. It's a number.
 */

import { estimateF0 } from "../audio/pitch.js";
import { decodeToF32, synthesize } from "./synth.js";

const REF = "assets/refs/rasputin_voice.wav";
const TEXT = "From this day forward, I will defend humanity on my own terms.";
const RATE = 22050;

/** Semitones between two frequencies. */
function semitones(from: number, to: number): number {
    return 12 * Math.log2(to / from);
}

async function main(): Promise<void> {
    const ref = estimateF0(await decodeToF32(process.argv[2] ?? REF, RATE), RATE);
    console.log(`\nreference          F0 ${ref.medianHz.toFixed(1).padStart(6)} Hz  (${ref.register}, ${(ref.voicedFraction * 100).toFixed(0)}% voiced)`);

    for (const chain of ["dry", "warmind"]) {
        const { samples } = await synthesize({ text: TEXT, chain });
        const est = estimateF0(samples, RATE);
        const delta = ref.medianHz > 0 && est.medianHz > 0 ? semitones(est.medianHz, ref.medianHz) : 0;
        console.log(
            `${chain.padEnd(18)} F0 ${est.medianHz.toFixed(1).padStart(6)} Hz  (${est.register}, ${(est.voicedFraction * 100).toFixed(0)}% voiced)` +
                `  -> needs ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} semitones` +
                `  (asetrate factor ${Math.pow(2, delta / 12).toFixed(3)})`,
        );
    }
    console.log("");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
