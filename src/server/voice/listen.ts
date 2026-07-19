/**
 * Voice input: microphone capture and transcription.
 *
 * Two processes, both long-lived where it matters:
 *
 *   - **ffmpeg** captures from the mic via avfoundation. It is already a dependency, so there is
 *     no reason to add a recorder.
 *   - **`whisperkit-cli serve`** transcribes. The `transcribe` subcommand loads its model on every
 *     invocation and took **6.4s warm** for a 2.6s clip; the server loads once and answered the
 *     same clip in **0.13s** over an OpenAI-compatible endpoint. Fifty times faster, and the
 *     difference between push-to-talk feeling instant and feeling broken.
 *
 * The server is started on demand and reused, including one the user already had running.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Default port for `whisperkit-cli serve`. */
export const WHISPER_PORT = 50060;

/**
 * Bound to `localhost`, not `127.0.0.1`.
 *
 * The server binds to `::1`, so the IPv4 literal fails to connect while the hostname resolves to
 * either family.
 */
const WHISPER_URL = `http://localhost:${WHISPER_PORT}`;

/**
 * Hard cap on one recording.
 *
 * A push-to-talk key that gets stuck, or a wake word that never hears an end, would otherwise
 * record until the disk filled.
 */
export const MAX_RECORD_SEC = 60;

/** tiny.en is the fast one and was accurate on test phrases. base.en is available if wanted. */
const MODEL = process.env.RASPUTIN_WHISPER_MODEL ?? "tiny.en";

/** avfoundation input index. `ffmpeg -f avfoundation -list_devices true -i ""` lists them. */
const MIC_INDEX = process.env.RASPUTIN_MIC_INDEX ?? "0";

/**
 * Below this the capture is room noise, not speech.
 *
 * Measured: a quiet room with speech playing across the room reads about −51 dBFS RMS and
 * transcribes to nothing. Reporting the level turns a silent "nothing transcribed" into an
 * actionable "the microphone heard nothing", which is the difference between a mystery and a
 * muted input.
 */
const SILENCE_RMS_DB = -45;

const run = promisify(execFile);

export interface ListenEvents {
    log: (message: string) => void;
}

export class VoiceInput {
    private recorder: ChildProcess | null = null;
    private server: ChildProcess | null = null;
    private dir: string | null = null;
    private wav: string | null = null;
    private serverReady: Promise<boolean> | null = null;

    constructor(private readonly events: ListenEvents) {}

    get isRecording(): boolean {
        return this.recorder !== null;
    }

    private async serverUp(): Promise<boolean> {
        try {
            const res = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(1000) });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Ensures a transcription server is running.
     *
     * Adopts one that is already up rather than starting a second — the model is large and two
     * copies would compete for the Neural Engine.
     */
    async ensureServer(): Promise<boolean> {
        if (this.serverReady) return this.serverReady;
        this.serverReady = (async () => {
            if (await this.serverUp()) {
                this.events.log("whisper server already running");
                return true;
            }
            this.events.log(`starting whisper server (${MODEL})…`);
            this.server = spawn("whisperkit-cli", ["serve", "--model", MODEL], {
                stdio: ["ignore", "pipe", "pipe"],
            });
            this.server.on("error", (e) => this.events.log(`whisper server failed: ${String(e)}`));

            // Model load takes tens of seconds on a cold cache, so poll rather than guess a delay.
            for (let i = 0; i < 90; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                if (await this.serverUp()) {
                    this.events.log("whisper server ready");
                    return true;
                }
            }
            this.events.log("whisper server did not come up");
            return false;
        })();
        return this.serverReady;
    }

    /** Begins capturing. Returns false if a recording is already running. */
    async start(): Promise<boolean> {
        if (this.recorder) return false;
        this.dir = await mkdtemp(join(tmpdir(), "rasputin-mic-"));
        this.wav = join(this.dir, "input.wav");

        // 16 kHz mono is what the model wants; capturing at device rate and resampling later would
        // just move the work.
        this.recorder = spawn(
            "ffmpeg",
            ["-y", "-loglevel", "error", "-f", "avfoundation", "-i", `:${MIC_INDEX}`,
             "-ac", "1", "-ar", "16000", "-t", String(MAX_RECORD_SEC), this.wav],
            { stdio: ["pipe", "ignore", "pipe"] },
        );
        this.recorder.on("error", (e) => this.events.log(`recorder failed: ${String(e)}`));
        return true;
    }

    /**
     * Stops capturing and returns the transcript, or null.
     *
     * ffmpeg is stopped with SIGINT rather than SIGKILL: it finalises the WAV header on the way
     * out, and a killed process leaves a file whose header claims zero length, which every decoder
     * then reads as an empty clip.
     */
    async stop(): Promise<string | null> {
        const proc = this.recorder;
        const wav = this.wav;
        this.recorder = null;
        if (!proc || !wav) return null;

        await new Promise<void>((resolve) => {
            const done = (): void => resolve();
            proc.once("close", done);
            proc.kill("SIGINT");
            // If it ignores SIGINT, do not hang forever waiting for a clean exit.
            setTimeout(() => {
                proc.kill("SIGKILL");
                resolve();
            }, 2000);
        });

        try {
            const text = await this.transcribe(wav);
            return text;
        } finally {
            if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
            this.dir = null;
            this.wav = null;
        }
    }

    /** Cancels without transcribing — for a press that turned out not to be speech. */
    async cancel(): Promise<void> {
        const proc = this.recorder;
        this.recorder = null;
        proc?.kill("SIGKILL");
        if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
        this.dir = null;
        this.wav = null;
    }

    private async transcribe(wav: string): Promise<string | null> {
        if (!(await this.ensureServer())) return null;

        let audio: Buffer;
        try {
            audio = await readFile(wav);
        } catch {
            this.events.log("no audio captured");
            return null;
        }
        // A WAV header alone is ~44 bytes; anything near that is a key tapped, not speech.
        if (audio.byteLength < 4000) {
            this.events.log("recording too short to transcribe");
            return null;
        }

        const rms = await this.levelDb(wav);
        if (rms !== null && rms < SILENCE_RMS_DB) {
            this.events.log(
                `microphone heard nothing (${rms.toFixed(1)} dBFS) — check the input device or that ` +
                    `Rasputin has microphone access`,
            );
            return null;
        }

        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "input.wav");
        form.append("model", MODEL);

        try {
            const res = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
                method: "POST",
                body: form,
                signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) {
                this.events.log(`transcription failed: HTTP ${res.status}`);
                return null;
            }
            const body = (await res.json()) as { text?: string; segments?: { text?: string }[] };
            const text = (body.text ?? body.segments?.map((s) => s.text ?? "").join(" ") ?? "").trim();
            return text || null;
        } catch (err) {
            this.events.log(`transcription failed: ${String(err)}`);
            return null;
        }
    }

    /** RMS level of a capture, or null if it cannot be measured. */
    private async levelDb(wav: string): Promise<number | null> {
        try {
            // astats reports at info level, so `-v error` would silently print nothing.
            const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", wav, "-af", "astats=metadata=1", "-f", "null", "-"]);
            const match = stderr.match(/RMS level dB:\s*(-?[\d.]+)/);
            return match ? Number(match[1]) : null;
        } catch {
            return null;
        }
    }

    /** Stops the server if we started it. One the user was already running is left alone. */
    shutdown(): void {
        this.server?.kill();
        this.server = null;
        this.serverReady = null;
    }
}
