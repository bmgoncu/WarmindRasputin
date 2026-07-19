/**
 * Speech synthesis. Five stages:
 *
 *   1. `say -v Yuri`      Russian MALE voice reading English -> genuine accent, F0 ~97 Hz
 *   2. ffmpeg asetrate    small formant drop
 *   3. rubberband -F      pitch drop with formants HELD
 *   4. ffmpeg chain       the Warmind character (reverse-reverb, comb, crush, room)
 *   5. TS effects         buffer-stutter glitch + ring modulation
 *
 * Stages 2 and 3 are separate on purpose. asetrate moves pitch and formants together, so using
 * it for the whole drop makes the vocal tract read as enormous and the voice sounds like tape
 * running slow rather than like a man. Formants move ~2-3 semitones between male and female
 * speakers; F0 moves ~12. rubberband is the only tool here that can decouple them.
 *
 * Effects run before feature extraction so the orb reacts to the glitches. Everything is cached
 * on sha256 of every input that affects the output.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import {
    applyGlitch,
    applyRingMod,
    parsePunctuation,
    normalizePeak,
    DEFAULT_GLITCH,
    DEFAULT_RINGMOD,
    type GlitchOptions,
    type RingModOptions,
} from "../audio/effects.js";
import { getChain, type ChainTuning } from "./chains.js";
import { loadCurve, toFirequalizer } from "./eq-curve.js";

export interface SynthOptions {
    text: string;
    chain?: string;
    voice?: string;
    wpm?: number;
    cacheDir?: string;
    /**
     * Apply the fitted matching EQ. Default true. `npm run fit-eq` passes false so it can
     * measure the chain's own response rather than an already-matched one.
     */
    matchEq?: boolean;
    /** Apply sample-level glitch + ring modulation. Defaults on for `warmind` only. */
    effects?: boolean;
    /** Override the chain's pitch drop, in semitones. Used by the audition ladder. */
    pitchSemitones?: number;
    /** Override the chain's formant drop, in semitones. */
    formantSemitones?: number;
    /** Partial override of glitch parameters. */
    glitch?: Partial<GlitchOptions>;
    /** Partial override of ring-modulation parameters. */
    ringMod?: Partial<RingModOptions>;
    /** Per-render chain tuning (echo stages). Changes the graph, so the cache invalidates. */
    tuning?: ChainTuning;
}

export interface SynthResult {
    /** Playable 16-bit mono wav. */
    wavPath: string;
    /** Post-chain samples for feature extraction. */
    samples: Float32Array;
    sampleRate: number;
    cached: boolean;
}

function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        p.stderr.on("data", (d) => (stderr += d.toString()));
        p.on("error", reject);
        p.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${stderr.trim()}`)),
        );
    });
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** Reads raw f32le into a Float32Array, copying so the view owns aligned memory. */
async function readF32(path: string): Promise<Float32Array> {
    const buf = await readFile(path);
    const out = new Float32Array(buf.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
}

export async function synthesize(opts: SynthOptions): Promise<SynthResult> {
    const chainName = opts.chain ?? process.env.RASPUTIN_CHAIN ?? "warmind";
    const voice = opts.voice ?? process.env.RASPUTIN_VOICE ?? "Tom (Enhanced)";
    const chain = getChain(chainName);
    const wpm = opts.wpm ?? Number(process.env.RASPUTIN_RATE ?? chain.wpm);
    const cacheDir = opts.cacheDir ?? process.env.RASPUTIN_CACHE_DIR ?? "cache";

    const curve = (opts.matchEq ?? true) ? loadCurve() : null;
    const graph = chain.build({ ...chain.tuning, ...opts.tuning, matchEq: curve ? toFirequalizer(curve) : "" });
    const effects = opts.effects ?? chain.effects;
    const pitchSemitones = opts.pitchSemitones ?? chain.pitchSemitones;
    const formantSemitones = opts.formantSemitones ?? chain.formantSemitones;
    const glitch: GlitchOptions = { ...DEFAULT_GLITCH, ...chain.glitch, ...opts.glitch };
    const ringMod: RingModOptions = { ...DEFAULT_RINGMOD, ...chain.ringMod, ...opts.ringMod };

    // Every input that changes the OUTPUT must be in the key. Keying on the rendered graph means
    // a refitted EQ curve invalidates automatically; `effects` has to be here too, or an
    // effects-off render silently returns the effects-on file from cache.
    const key = createHash("sha256")
        .update(
            JSON.stringify({
                text: opts.text, chain: chainName, voice, wpm, graph, effects,
                // Not in `graph` — pitch and formants have their own passes, and the audition
                // ladder overrides all four of these per variant.
                pitchSemitones, formantSemitones, glitch, ringMod,
            }),
        )
        .digest("hex")
        .slice(0, 16);

    await mkdir(cacheDir, { recursive: true });
    const wavPath = join(cacheDir, `${key}.wav`);
    const f32Path = join(cacheDir, `${key}.f32`);

    if (await exists(wavPath)) {
        if (await exists(f32Path)) {
            return { wavPath, samples: await readF32(f32Path), sampleRate: chain.rate, cached: true };
        }
    }

    // `say` writes WAVE/lpcm directly — no AIFF intermediate needed.
    const srcPath = join(cacheDir, `${key}.src.wav`);
    await run("say", [
        "-v", voice,
        "-r", String(wpm),
        "--file-format=WAVE",
        `--data-format=LEI16@${chain.rate}`,
        "-o", srcPath,
        opts.text,
    ]);

    // Pass 1 — formant shift. asetrate moves pitch and formants together; we want only a small
    // move here, with the big pitch drop handled separately in pass 2. Doing the whole drop with
    // asetrate is what made the voice sound like tape running slow instead of like a man.
    let stagePath = srcPath;
    if (formantSemitones !== 0) {
        const factor = Math.pow(2, formantSemitones / 12);
        const formantPath = join(cacheDir, `${key}.formant.wav`);
        await run("ffmpeg", [
            "-hide_banner", "-v", "error",
            "-i", stagePath,
            "-af", `asetrate=${chain.rate}*${factor.toFixed(4)},aresample=${chain.rate},atempo=${(1 / factor).toFixed(4)}`,
            "-c:a", "pcm_s16le", formantPath, "-y",
        ]);
        stagePath = formantPath;
    }

    // Pass 2 — the large pitch drop, formants held (`-F`). This is the step that makes it read
    // as male rather than as slowed-down. rubberband is a separate binary; ~15ms for a sentence.
    if (pitchSemitones !== 0) {
        const pitchedPath = join(cacheDir, `${key}.pitched.wav`);
        await run("rubberband", ["-p", String(pitchSemitones), "-F", "-q", stagePath, pitchedPath]);
        stagePath = pitchedPath;
    }

    // Pass 3b — the character chain, to raw f32.
    await run("ffmpeg", [
        "-hide_banner", "-v", "error",
        "-i", stagePath,
        "-filter_complex", graph,
        "-map", "[out]", "-f", "f32le", "-ar", String(chain.rate), "-ac", "1", f32Path,
        "-y",
    ]);

    // Pass 4 — sample-level effects ffmpeg has no filters for. These run BEFORE the wav is
    // written and before features are extracted, so the orb reacts to the glitches rather than
    // animating against a signal that doesn't contain them.
    let samples = await readF32(f32Path);
    if (effects) {
        // Punctuation from the SOURCE TEXT scales each boundary glitch: a full stop hangs
        // longer than a comma. The audio envelope alone cannot tell those apart.
        samples = applyGlitch(samples, chain.rate, glitch, parsePunctuation(opts.text));
        samples = applyRingMod(samples, chain.rate, ringMod);
        samples = normalizePeak(samples);
        await writeFile(f32Path, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    }

    // Pass 5 — f32 to playable wav.
    await run("ffmpeg", [
        "-hide_banner", "-v", "error",
        "-f", "f32le", "-ar", String(chain.rate), "-ac", "1", "-i", f32Path,
        "-c:a", "pcm_s16le", wavPath,
        "-y",
    ]);

    return { wavPath, samples, sampleRate: chain.rate, cached: false };
}

/** Decodes any audio file to mono f32 at `rate` — used to load reference clips for comparison. */
export async function decodeToF32(path: string, rate: number): Promise<Float32Array> {
    const tmp = join(process.env.TMPDIR ?? "/tmp", `rasputin-decode-${Date.now()}.f32`);
    await run("ffmpeg", [
        "-hide_banner", "-v", "error",
        "-i", path,
        "-f", "f32le", "-ar", String(rate), "-ac", "1", tmp,
        "-y",
    ]);
    const samples = await readF32(tmp);
    await writeFile(tmp, "").catch(() => {});
    return samples;
}
