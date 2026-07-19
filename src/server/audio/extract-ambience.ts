/**
 * Extracts the ambient bed and arc one-shots from the Mindlab reference footage.
 *
 *   npm run extract-ambience -- [sourceVideo]
 *
 * Writes into assets/refs/ (gitignored), so this is how a fresh clone regenerates them from
 * source media rather than committing game audio.
 *
 * Two products:
 *   ambience-hum.wav   a seamlessly looping low bed, cut from the footage
 *   arcs/arc-NN.wav    electrical arcs, SYNTHESIZED (see arcs.ts for why they can't be sampled)
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arcVariants } from "./arcs.js";

const RATE = 44100;
const OUT_DIR = "assets/refs";
const DEFAULT_SOURCE =
    "/Users/bmgoncu/Downloads/Destiny 2- Mars Mindlab Rasputin Ambiance - xGUANO LOCOx (720p, h264).mp4";

/** Seconds of bed to keep. Long enough that the loop point isn't obvious. */
const LOOP_SECONDS = 24;
/** Crossfade length at the seam. */
const LOOP_FADE_SECONDS = 3;
/** Where to start the loop — chosen from the per-30s RMS survey as a steady stretch. */
const LOOP_START_SECONDS = 300;

const ARC_COUNT = 8;

function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => (err += d.toString()));
        p.on("error", reject);
        p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}\n${err.trim()}`))));
    });
}

function readF32(buf: Buffer): Float32Array {
    const out = new Float32Array(buf.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
}

async function decode(path: string, from?: number, dur?: number): Promise<Float32Array> {
    const tmp = join(process.env.TMPDIR ?? "/tmp", `rasputin-amb-${Date.now()}.f32`);
    const args = ["-hide_banner", "-v", "error"];
    if (from !== undefined) args.push("-ss", String(from));
    if (dur !== undefined) args.push("-t", String(dur));
    args.push("-i", path, "-vn", "-f", "f32le", "-ar", String(RATE), "-ac", "1", tmp, "-y");
    await run("ffmpeg", args);
    const { readFile } = await import("node:fs/promises");
    return readF32(await readFile(tmp));
}

/** Writes mono f32 samples out as a 16-bit wav via ffmpeg. */
async function writeWav(samples: Float32Array, path: string): Promise<void> {
    const tmp = join(process.env.TMPDIR ?? "/tmp", `rasputin-out-${Date.now()}-${Math.round(samples.length)}.f32`);
    await writeFile(tmp, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    await run("ffmpeg", [
        "-hide_banner", "-v", "error",
        "-f", "f32le", "-ar", String(RATE), "-ac", "1", "-i", tmp,
        "-c:a", "pcm_s16le", path, "-y",
    ]);
}

/**
 * Builds a seamless loop.
 *
 * Takes `len + fade` seconds, then crossfades the trailing `fade` over the head. The result is
 * `len` long and its end already contains the beginning, so playback wraps without a click.
 * Equal-power (cosine) rather than linear, because two decorrelated noise-like signals at 0.5
 * gain sum to −3 dB and produce an audible dip at the seam.
 */
function makeSeamlessLoop(input: Float32Array, lenSamples: number, fadeSamples: number): Float32Array {
    const out = input.slice(0, lenSamples);
    for (let i = 0; i < fadeSamples; i++) {
        const t = i / fadeSamples;
        const a = Math.cos((t * Math.PI) / 2);
        const b = Math.sin((t * Math.PI) / 2);
        out[i] = out[i] * b + input[lenSamples + i] * a;
    }
    return out;
}

async function main(): Promise<void> {
    const source = process.argv[2] ?? DEFAULT_SOURCE;
    await mkdir(join(OUT_DIR, "arcs"), { recursive: true });

    // ---- ambient bed -------------------------------------------------------------------
    console.log(`\nSource: ${source}\n`);
    const bedRaw = await decode(source, LOOP_START_SECONDS, LOOP_SECONDS + LOOP_FADE_SECONDS + 1);
    const loop = makeSeamlessLoop(
        bedRaw,
        Math.floor(LOOP_SECONDS * RATE),
        Math.floor(LOOP_FADE_SECONDS * RATE),
    );
    const humPath = join(OUT_DIR, "ambience-hum.wav");
    await writeWav(loop, humPath);
    console.log(`  ${humPath}  ${LOOP_SECONDS}s seamless loop (${LOOP_FADE_SECONDS}s equal-power crossfade)`);

    // ---- arc one-shots ------------------------------------------------------------------
    // SYNTHESIZED, not sampled. Neither reference contains discrete arcs — measured crest factor
    // maxes at 4.32 (ambiance) and 6.57 (voice) where a sharp arc reads above 8. Cutting clips
    // from them yielded flat chunks of bed. See arcs.ts.
    // Feed the ambient bed in as raw material — every third arc is built from it, so the set
    // mixes synthetic sparks with arcs that carry the Mindlab recording's own timbre.
    const arcs = arcVariants(RATE, ARC_COUNT, 1, bedRaw);
    for (let n = 0; n < arcs.length; n++) {
        const p = join(OUT_DIR, "arcs", `arc-${String(n + 1).padStart(2, "0")}.wav`);
        await writeWav(arcs[n], p);
        let peak = 0;
        let e = 0;
        for (const v of arcs[n]) {
            peak = Math.max(peak, Math.abs(v));
            e += v * v;
        }
        const crest = peak / Math.sqrt(e / arcs[n].length);
        console.log(`  ${p}  ${(arcs[n].length / RATE).toFixed(2)}s  crest ${crest.toFixed(1)}  peak ${peak.toFixed(2)}  ${n % 3 === 2 ? "[from source]" : "[synthetic]"}`);
    }
    console.log("");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
