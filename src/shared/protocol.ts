/**
 * The daemon/renderer message contract.
 *
 * Imported by BOTH halves, which is the whole point: a message type added on one side and not the
 * other is a compile error rather than a silent no-op at runtime. Extending it means adding a
 * variant to the union and handling it in the switch on the other side — TypeScript's
 * exhaustiveness check on `never` will point at every place that needs updating.
 *
 * Two rules that are easy to get wrong and expensive to debug:
 *
 *   1. The RENDERER owns the `speaking` state, not the server. The server sends `speak` and the
 *      renderer answers `playback` when audio actually starts. A server that declares "speaking"
 *      on send has the orb animating while the audio is still decoding and fetching, against
 *      silence.
 *   2. Timing is carried as a feature timeline plus a duration, never as a stream of per-frame
 *      level messages. WebSocket delivery is not sample-accurate and would jitter the orb; the
 *      renderer schedules everything against `AudioContext.currentTime` instead.
 */

import type { TimelineWire } from "../server/audio/timeline.js";

export const DAEMON_PORT = 7331;

/**
 * Orb states.
 *
 * `thinking` exists specifically to cover first-sound latency — synthesis takes 300-800ms on a
 * cache miss, and without a state for it the orb sits idle looking like nothing was heard.
 */
export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "alert";

// --- server → renderer -------------------------------------------------------------------

/** Play this utterance, and animate from this timeline. */
export interface SpeakMsg {
    type: "speak";
    /** Correlates the renderer's `playback` reports back to this utterance. */
    id: string;
    /** Path on the daemon, e.g. /audio/<sha>.wav */
    audioUrl: string;
    timeline: TimelineWire;
    /** Source text, for a transcript panel and for debugging what was actually said. */
    text: string;
    /** Delivery mode — a chain name from voice/chains.ts. */
    chain: string;
}

/** Server-driven state change. Never used for `speaking`; see the rule above. */
export interface StateMsg {
    type: "state";
    state: Exclude<OrbState, "speaking">;
}

/** Abandon current and queued speech — an interrupt. */
export interface StopMsg {
    type: "stop";
}

/** One-shot visual impulse not tied to speech, e.g. a tool call firing. */
export interface PulseMsg {
    type: "pulse";
    strength: number;
}

/** Live tuning from the debug panel, mirrored to every connected renderer. */
export interface ConfigMsg {
    type: "config";
    idleFloor?: number;
    shakeScale?: number;
    outerRadius?: number;
    joltCount?: number;
    arcCount?: number;
}

export type ServerMsg = SpeakMsg | StateMsg | StopMsg | PulseMsg | ConfigMsg;

// --- renderer → server -------------------------------------------------------------------

/** Sent on connect so the daemon can log what attached and push initial state. */
export interface HelloMsg {
    type: "hello";
    /** Renderer's own description, e.g. "chrome-dev" or "tauri-overlay". */
    agent: string;
}

/**
 * Playback lifecycle, reported by the renderer because only it knows when sound started.
 *
 * `ctxLatency` is `AudioContext.outputLatency` — reported so the daemon can log real end-to-end
 * latency rather than guessing at it.
 */
export interface PlaybackMsg {
    type: "playback";
    id: string;
    phase: "started" | "ended";
    ctxLatency?: number;
}

/** Typed instruction from the renderer's text field. */
export interface SayMsg {
    type: "say";
    text: string;
    chain?: string;
}

export type ClientMsg = HelloMsg | PlaybackMsg | SayMsg;

/**
 * Narrows an unknown parsed JSON value to a ServerMsg.
 *
 * Deliberately structural rather than a schema library: the union is small, and a bad message
 * should be dropped with a log line, never throw inside the renderer's socket handler.
 */
export function isServerMsg(v: unknown): v is ServerMsg {
    if (typeof v !== "object" || v === null) return false;
    const t = (v as { type?: unknown }).type;
    return t === "speak" || t === "state" || t === "stop" || t === "pulse" || t === "config";
}

export function isClientMsg(v: unknown): v is ClientMsg {
    if (typeof v !== "object" || v === null) return false;
    const t = (v as { type?: unknown }).type;
    return t === "hello" || t === "playback" || t === "say";
}
