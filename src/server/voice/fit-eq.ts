/**
 * Fits the matching EQ curve automatically instead of hand-tuning peaks and shelves.
 *
 *   npm run fit-eq -- [refPath]
 *
 * Hand-tuning parametric EQ against a measured target does not converge: a high-Q peak cannot
 * move a band average, a shelf wide enough to move it also flattens the neighbouring band, and
 * each fix trades one error for another. Since we can already measure both spectra, the honest
 * approach is to subtract them and hand the difference to `firequalizer`, which takes an
 * arbitrary frequency response.
 *
 * Writes assets/eq-curve.json, which chains.ts loads automatically on the next render.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { averageSpectrumDb, FFT_SIZE } from "../audio/analyze.js";
import { CURVE_PATH, type EqCurve } from "./eq-curve.js";
import { decodeToF32, synthesize } from "./synth.js";

const DEFAULT_REF = "assets/refs/rasputin_voice.wav";

/** Frequencies the curve is sampled at — log-spaced, dense where hearing is sensitive. */
const CONTROL_HZ = [40, 60, 90, 130, 190, 280, 400, 580, 850, 1200, 1800, 2600, 3800, 5500, 8000, 10500];

/** Sentences the fit averages over. One line overfits — measured spread across these was ~5 dB. */
const FIT_TEXTS = [
    "From this day forward, I will defend humanity on my own terms.",
    "Warning. Unauthorized access detected in sector seven.",
    "The build failed. Three tests are red in the authentication module.",
    "All systems nominal. Standing by for further instruction.",
];

/** Mean dB in a half-octave window around each control frequency. */
function sampleCurve(spectrumDb: Float64Array, sampleRate: number): number[] {
    const binHz = sampleRate / FFT_SIZE;
    return CONTROL_HZ.map((f) => {
        const lo = Math.max(1, Math.floor((f / 1.19) / binHz));
        const hi = Math.min(spectrumDb.length - 1, Math.ceil((f * 1.19) / binHz));
        let sum = 0;
        let n = 0;
        for (let b = lo; b <= hi; b++) {
            sum += spectrumDb[b];
            n++;
        }
        return n > 0 ? sum / n : -120;
    });
}

async function main(): Promise<void> {
    const refPath = process.argv[2] ?? DEFAULT_REF;
    const rate = 22050;

    const refSamples = await decodeToF32(refPath, rate);
    const refCurve = sampleCurve(averageSpectrumDb(refSamples), rate);

    // Render with matching disabled so we measure the chain's own response, not a fitted one.
    const chainCurves: number[][] = [];
    for (const text of FIT_TEXTS) {
        const { samples } = await synthesize({ text, chain: "warmind", matchEq: false });
        chainCurves.push(sampleCurve(averageSpectrumDb(samples), rate));
    }
    const chainCurve = CONTROL_HZ.map(
        (_, i) => chainCurves.reduce((a, c) => a + c[i], 0) / chainCurves.length,
    );

    // Normalize both to their 1200 Hz value so we fit SHAPE, not level — loudnorm sets level.
    const pivot = CONTROL_HZ.indexOf(1200);
    const refNorm = refCurve.map((v) => v - refCurve[pivot]);
    const chainNorm = chainCurve.map((v) => v - chainCurve[pivot]);

    // Clamp: a raw difference can demand 30 dB of correction where the chain has near-silence,
    // which produces howling resonance rather than a match.
    const gains = refNorm.map((r, i) => Math.max(-18, Math.min(18, r - chainNorm[i])));

    const curve: EqCurve = { fittedAt: new Date().toISOString(), ref: refPath, points: CONTROL_HZ.map((f, i) => ({ f, g: Number(gains[i].toFixed(2)) })) };

    await mkdir(dirname(CURVE_PATH), { recursive: true });
    await writeFile(CURVE_PATH, JSON.stringify(curve, null, 2) + "\n");

    console.log(`\nFitted against ${refPath} over ${FIT_TEXTS.length} sentences.\n`);
    console.log("   freq     ref    chain   correction");
    console.log("   ".padEnd(38, "-"));
    for (let i = 0; i < CONTROL_HZ.length; i++) {
        const bar = "#".repeat(Math.round(Math.abs(gains[i])));
        console.log(
            `${String(CONTROL_HZ[i]).padStart(7)}  ${refNorm[i].toFixed(1).padStart(6)}  ${chainNorm[i].toFixed(1).padStart(6)}  ` +
                `${(gains[i] >= 0 ? "+" : "") + gains[i].toFixed(1).padStart(5)}  ${bar}`,
        );
    }
    console.log(`\nWrote ${CURVE_PATH}. Re-run \`npm run analyze-ref\` to confirm the match.\n`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
