/**
 * Plays an utterance and reports the level the orb should be at RIGHT NOW.
 *
 * Playback lives here, in the renderer, rather than in the daemon. `AudioContext.currentTime` is a
 * sample-accurate clock in the same process as the render loop; driving the orb from a Node-side
 * `afplay` would leave it guessing from `Date.now()` with 30-60ms of unmeasurable drift. For a
 * visual meant to read as a mouth, 50ms is the difference between talking and badly dubbed.
 *
 * Two details carry most of the perceived sync quality:
 *
 *   - **Lookahead.** The orb is driven from `elapsed + LOOKAHEAD`, so it starts opening slightly
 *     BEFORE each consonant. Human audio-visual tolerance is asymmetric — roughly 125ms is
 *     acceptable when the visual leads but only ~45ms when it lags — so erring early reads as
 *     tight and erring late reads as dubbed.
 *   - **Output latency.** `currentTime` is when a sample was handed to the device, not when it
 *     left the speaker. Subtracting `outputLatency` is what keeps the two in agreement on
 *     hardware with a deep buffer, e.g. Bluetooth.
 */

import type { SpeakMsg } from "../../shared/protocol.js";
import type { TimelineWire } from "../../server/audio/timeline.js";

/** Seconds the visual leads the audio. See the asymmetry note above. */
export const LOOKAHEAD = 0.045;

interface Playing {
    id: string;
    source: AudioBufferSourceNode;
    timeline: TimelineWire;
    /** ctx.currentTime at which playback was scheduled to begin. */
    startedAt: number;
    endsAt: number;
}

export class SpeechPlayer {
    private ctx: AudioContext | null = null;
    private playing: Playing | null = null;
    private buffers = new Map<string, AudioBuffer>();
    private onsetCursor = 0;

    /** Fired when audio actually starts and when it ends — the authoritative speaking signal. */
    onPhase: ((id: string, phase: "started" | "ended", latency: number) => void) | null = null;
    /** Fired as each onset in the timeline is crossed, for one-shot impulses. */
    onOnset: ((strength: number) => void) | null = null;
    /** Non-fatal problems worth surfacing in the daemon log. */
    onWarning: ((message: string) => void) | null = null;

    /**
     * Browsers refuse to start an AudioContext without a user gesture, and one created too early
     * lands in "suspended" where currentTime does not advance — which reads as the orb ignoring
     * speech entirely. Created lazily and resumed on every play attempt.
     */
    private context(): AudioContext {
        if (!this.ctx) this.ctx = new AudioContext({ latencyHint: "interactive" });
        return this.ctx;
    }

    get unlocked(): boolean {
        return this.ctx !== null && this.ctx.state === "running";
    }

    async unlock(): Promise<void> {
        await this.context().resume();
    }

    get speaking(): boolean {
        return this.playing !== null;
    }

    get currentText(): string {
        return this.lastText;
    }
    private lastText = "";

    private async load(url: string, base: string): Promise<AudioBuffer> {
        const cached = this.buffers.get(url);
        if (cached) return cached;
        const res = await fetch(new URL(url, base).href);
        if (!res.ok) throw new Error(`audio fetch failed: ${res.status} ${url}`);
        const buf = await this.context().decodeAudioData(await res.arrayBuffer());
        this.buffers.set(url, buf);
        return buf;
    }

    /** Fetches, decodes and schedules an utterance. Any current one is cut off. */
    async play(msg: SpeakMsg, base: string): Promise<void> {
        const ctx = this.context();
        if (ctx.state !== "running") {
            // A rejected resume must NOT abort playback. Without a user gesture the context stays
            // suspended, and letting that throw meant the whole utterance was dropped — including
            // the subtitle, which does not need audio at all. Schedule anyway: the buffer plays as
            // soon as the context is unlocked, and the visuals run regardless.
            try {
                await ctx.resume();
            } catch (err) {
                this.onWarning?.(`audio context suspended (needs a user gesture): ${String(err)}`);
            }
        }

        const buffer = await this.load(msg.audioUrl, base);
        this.stop();

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        // A small lead-in rather than start(0): scheduling in the past makes the browser drop the
        // head of the buffer, so the first phoneme is clipped and the orb's first frame is late.
        const startedAt = ctx.currentTime + 0.02;
        source.start(startedAt);

        this.onsetCursor = 0;
        this.lastText = msg.text;
        this.playing = { id: msg.id, source, timeline: msg.timeline, startedAt, endsAt: startedAt + buffer.duration };

        source.onended = (): void => {
            if (this.playing?.id === msg.id) {
                this.playing = null;
                this.onPhase?.(msg.id, "ended", ctx.outputLatency ?? 0);
            }
        };
        this.onPhase?.(msg.id, "started", ctx.outputLatency ?? 0);
        if (ctx.state !== "running") {
            this.onWarning?.(`scheduled while context is "${ctx.state}" — visuals run, audio is silent`);
        }
    }

    stop(): void {
        if (!this.playing) return;
        // onended would otherwise fire for the utterance we are replacing and null out the new one.
        this.playing.source.onended = null;
        try {
            this.playing.source.stop();
        } catch {
            // Already stopped; harmless.
        }
        this.playing = null;
    }

    /**
     * Level for the current frame, 0-1, or null when nothing is playing.
     *
     * Linearly interpolated between timeline frames. The timeline runs at 86 fps and the display
     * at 60-120, so this is genuinely resampling rather than nearest-neighbour lookup — steps
     * would be visible on transients at 120 Hz.
     */
    sample(): number | null {
        const p = this.playing;
        if (!p || !this.ctx) return null;

        const elapsed = this.ctx.currentTime - p.startedAt - (this.ctx.outputLatency ?? 0) + LOOKAHEAD;
        if (elapsed < 0) return 0;

        const env = p.timeline.env;
        const pos = elapsed * p.timeline.fps;
        if (pos >= env.length - 1) return env.length ? env[env.length - 1] : 0;

        const i = Math.floor(pos);
        const frac = pos - i;
        const level = env[i] + (env[i + 1] - env[i]) * frac;

        // Onsets are consumed in order against the same clock, so a slow frame fires every onset
        // it skipped over rather than silently dropping them.
        while (this.onsetCursor < p.timeline.onsets.length && p.timeline.onsets[this.onsetCursor] <= elapsed) {
            this.onsetCursor++;
            this.onOnset?.(level);
        }
        return level;
    }

    /** Fraction of the current utterance elapsed, 0-1. Drives progress UI only. */
    get progress(): number {
        const p = this.playing;
        if (!p || !this.ctx) return 0;
        const total = p.endsAt - p.startedAt;
        return total > 0 ? Math.min(1, Math.max(0, (this.ctx.currentTime - p.startedAt) / total)) : 0;
    }
}
