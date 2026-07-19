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
    /** What is actually SPOKEN. For og-warmind this is the Russian, not what was typed. */
    text: string;
    /**
     * What was originally asked for, before any translation. Undefined when nothing was translated.
     *
     * Subtitles show this in preference to `text`, matching the game: Rasputin's speech is
     * deliberately unintelligible and the subtitle is what carries the meaning. Showing the
     * Russian that is playing would be accurate and useless.
     */
    sourceText?: string;
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

/**
 * Live tuning, mirrored to every connected renderer.
 *
 * Settings travel renderer → daemon → all renderers rather than window-to-window through Tauri.
 * The preferences window and the overlay are separate webviews with no shared memory, and routing
 * through the daemon means the same path works in Chrome during development, survives either
 * window reloading, and gives one place to persist from.
 */
export interface OrbConfig {
    idleFloor?: number;
    shakeScale?: number;
    outerRadius?: number;
    joltCount?: number;
    arcCount?: number;
    /** Opaque black behind the orb instead of desktop show-through. */
    opaqueBackground?: boolean;
    subtitles?: boolean;
    /** Delivery mode used when the daemon speaks without being told one. */
    chain?: string;
}

export interface ConfigMsg extends OrbConfig {
    type: "config";
}

/**
 * Which Claude session Rasputin is currently attached to.
 *
 * Shown beside the tray icon, because with a global hook every session on the machine reports in
 * and there is otherwise no way to tell whose output is being narrated — or, once voice input
 * lands, which session a dictation would reach.
 */
export interface FocusMsg {
    type: "focus";
    /** Last path component of the cwd — what a person calls the project. */
    project?: string;
    cwd?: string;
    sessionId?: string;
    /** How many live sessions are reporting, so several can be distinguished from one. */
    sessions: number;
    /** Where dictation would go. Undefined until voice input exists (M6). */
    dictateTo?: string;
}

export type ServerMsg = SpeakMsg | StateMsg | StopMsg | PulseMsg | ConfigMsg | FocusMsg;

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

/** A settings change from the preferences window. The daemon persists it and rebroadcasts. */
export interface SetConfigMsg extends OrbConfig {
    type: "set-config";
}

/** Asks the daemon to send back the current config — how a freshly opened window initialises. */
export interface GetConfigMsg {
    type: "get-config";
}

/**
 * Renderer diagnostics, surfaced in the daemon log.
 *
 * The overlay is a WKWebView with no devtools reachable in a release build, so without this a
 * renderer-side failure is completely invisible — the window simply does nothing and there is
 * nowhere to look. Two overlay-only bugs were diagnosed from the daemon log alone.
 */
export interface LogMsg {
    type: "log";
    level: "info" | "warn" | "error";
    message: string;
}

export type ClientMsg = HelloMsg | PlaybackMsg | SayMsg | SetConfigMsg | GetConfigMsg | LogMsg;

/**
 * Narrows an unknown parsed JSON value to a ServerMsg.
 *
 * Deliberately structural rather than a schema library: the union is small, and a bad message
 * should be dropped with a log line, never throw inside the renderer's socket handler.
 */
export function isServerMsg(v: unknown): v is ServerMsg {
    if (typeof v !== "object" || v === null) return false;
    const t = (v as { type?: unknown }).type;
    return (
        t === "speak" || t === "state" || t === "stop" || t === "pulse" || t === "config" || t === "focus"
    );
}

export function isClientMsg(v: unknown): v is ClientMsg {
    if (typeof v !== "object" || v === null) return false;
    const t = (v as { type?: unknown }).type;
    return (
        t === "hello" || t === "playback" || t === "say" || t === "set-config" || t === "get-config" || t === "log"
    );
}
