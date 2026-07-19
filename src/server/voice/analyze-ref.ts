/**
 * Compares rendered chains against the reference recording and prints the correction needed.
 *
 *   npm run analyze-ref -- [refPath] [text]
 *
 * The two numbers that matter:
 *   - Band tilt, relative to the 500-2500 Hz intelligibility band. Level-independent, so it
 *     answers "is the EQ SHAPE right?" rather than "is it the same volume?".
 *   - Crest factor, measured over a window matching the rendered clip's DURATION. This matters:
 *     crest is dominated by how much silence a clip contains, so the full 90s reference measures
 *     ~10.2 purely because of its long inter-phrase gaps, while comparable 4s windows of the same
 *     recording measure 3.7-5.5. Comparing a 4s render against the 90s figure invents a problem
 *     that isn't there.
 */

import { DEFAULT_BANDS, averageSpectrumDb, bandTilt, levelStats } from "../audio/analyze.js";
import { CHAINS } from "./chains.js";
import { decodeToF32, synthesize } from "./synth.js";

const DEFAULT_REF = "assets/refs/rasputin_voice.wav";
const DEFAULT_TEXT = "From this day forward, I will defend humanity on my own terms.";

function fmt(n: number, width = 7, digits = 1): string {
    return (n >= 0 ? "+" : "") + n.toFixed(digits).padStart(width - 1);
}

async function main(): Promise<void> {
    const refPath = process.argv[2] ?? DEFAULT_REF;
    const text = process.argv[3] ?? DEFAULT_TEXT;
    const rate = 22050;

    let refSamples: Float32Array;
    try {
        refSamples = await decodeToF32(refPath, rate);
    } catch {
        console.error(`Could not read reference audio at ${refPath}`);
        console.error(`Pass a path, or drop a clip at ${DEFAULT_REF}. See CLAUDE.md -> Voice chain.`);
        process.exitCode = 1;
        return;
    }

    const refTilt = bandTilt(averageSpectrumDb(refSamples), rate);

    // Synthesize once per chain — synthesize() caches, but calling it twice is still noise.
    const rendered = await Promise.all(
        Object.keys(CHAINS).map(async (name) => {
            const { samples } = await synthesize({ text, chain: name });
            return { name, samples, tilt: bandTilt(averageSpectrumDb(samples), rate), levels: levelStats(samples) };
        }),
    );

    // Crest is dominated by silence content, so compare against reference windows of the SAME
    // duration as the render rather than the whole file. See the header comment.
    const winSamples = Math.round(rendered[0].samples.length);
    const refCrests: number[] = [];
    for (let i = 0; i + winSamples <= refSamples.length; i += winSamples) {
        refCrests.push(levelStats(refSamples.subarray(i, i + winSamples)).crestFactor);
    }
    refCrests.sort((a, b) => a - b);
    const refCrestLo = refCrests[Math.floor(refCrests.length * 0.1)] ?? 0;
    const refCrestHi = refCrests[Math.floor(refCrests.length * 0.9)] ?? 0;

    const bandLabels = DEFAULT_BANDS.map((b) => `${b.lo}-${b.hi}`);
    const header = ["chain".padEnd(10), ...bandLabels.map((l) => l.padStart(11)), "crest".padStart(8)].join("");

    console.log(`\nReference: ${refPath}  (${(refSamples.length / rate).toFixed(1)}s)`);
    console.log(`Text:      "${text}"  (${(winSamples / rate).toFixed(1)}s rendered)\n`);
    console.log("Band tilt in dB, relative to each signal's own 500-2500 Hz band — match the REFERENCE row.");
    console.log(
        `Reference crest over ${(winSamples / rate).toFixed(1)}s windows: ${refCrestLo.toFixed(2)}-${refCrestHi.toFixed(2)} ` +
            `(whole-file figure is ${levelStats(refSamples).crestFactor.toFixed(2)}, inflated by inter-phrase silence).\n`,
    );
    console.log(header);
    console.log("-".repeat(header.length));
    console.log(
        ["REFERENCE".padEnd(10), ...refTilt.map((t) => fmt(t, 11)),
            `${refCrestLo.toFixed(1)}-${refCrestHi.toFixed(1)}`.padStart(8)].join(""),
    );
    for (const r of rendered) {
        console.log(
            [r.name.padEnd(10), ...r.tilt.map((t) => fmt(t, 11)), r.levels.crestFactor.toFixed(2).padStart(8)].join(""),
        );
    }

    console.log("\nDelta = reference minus chain. Positive means that band needs boosting.\n");
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of rendered) {
        const note =
            r.levels.crestFactor < refCrestLo * 0.8
                ? "  <- over-compressed"
                : r.levels.crestFactor > refCrestHi * 1.25
                  ? "  <- too dynamic"
                  : "";
        const worst = Math.max(...refTilt.map((t, i) => Math.abs(t - r.tilt[i])));
        console.log(
            [r.name.padEnd(10), ...refTilt.map((t, i) => fmt(t - r.tilt[i], 11)),
                `${worst.toFixed(1)} max`.padStart(8)].join("") + note,
        );
    }
    console.log("");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
