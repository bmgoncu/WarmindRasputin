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
    /**
     * Session to narrate, or null/undefined to follow whichever was most recently active.
     *
     * Persisted, so a chosen session survives a daemon restart — it is a deliberate decision, not
     * a transient view state.
     */
    focusSessionId?: string | null;
    /**
     * Narrate delegated subagent work as well as the session's own replies. Off by default.
     *
     * Their output is a different voice reporting internal progress, and it buries the answers
     * most listeners are waiting for.
     */
    narrateSubagents?: boolean;
    /**
     * How much of a long reply to speak.
     *
     * "full" splits it into several utterances and speaks all of it; "brief" speaks only the
     * opening. Full by default — detail is not sacrificed for brevity.
     */
    speechDetail?: "brief" | "full";
    /**
     * Where a dictated instruction goes.
     *
     * "agent" runs it in Rasputin's own Claude session and speaks the answer. "type" types it into
     * the terminal actually running the session you selected, as though you had typed it there.
     * Agent by default — typing moves the keyboard, and that should be chosen deliberately.
     */
    /**
     * Speak driven answers in the Warmind register.
     *
     * Off by default: it changes how an agent phrases everything it tells you, and that should be
     * chosen rather than arrive as a surprise. Applies only to sessions Rasputin drives — narration
     * reads someone else's words, and rewriting those would misreport what they said.
     */
    persona?: boolean;
    dictateMode?: "agent" | "type";
    /** Send Return after typing. Off leaves the line in the prompt for you to review. */
    dictateSubmit?: boolean;
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
    /** Registry session name, e.g. "LiveOps" — the only thing telling two sessions apart. */
    name?: string;
    cwd?: string;
    sessionId?: string;
    /** How many live sessions are reporting, so several can be distinguished from one. */
    sessions: number;
    /** True when the user pinned this session rather than it being the most recently active. */
    pinned?: boolean;
    /** Where dictation would go. Undefined until voice input exists (M6). */
    dictateTo?: string;
}

/** Shows a subtitle without speaking it — used to preview dictation before it is typed. */
export interface CaptionMsg {
    type: "caption";
    text: string;
    /** Seconds to hold it before fading. */
    holdSec?: number;
}

export type ServerMsg = SpeakMsg | StateMsg | StopMsg | PulseMsg | ConfigMsg | FocusMsg | CaptionMsg;

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

/** Typed instruction from the renderer's text field — spoken verbatim, not sent to Claude. */
export interface SayMsg {
    type: "say";
    text: string;
    chain?: string;
}

/**
 * A request for Claude to actually do something, answered aloud.
 *
 * Distinct from `say`, which is Rasputin reading a line back. This one runs an agent.
 */
export interface AskMsg {
    type: "ask";
    text: string;
    /** Working directory for the driven session. Defaults to the daemon's own. */
    cwd?: string;
}

/** Stop the driven session mid-answer. */
export interface InterruptMsg {
    type: "interrupt";
}

/**
 * Push-to-talk. `down` starts capturing, `up` transcribes and sends the result to Claude.
 *
 * Two messages rather than one with a duration, because the whole point of push-to-talk is that
 * the speaker decides when they have finished.
 */
export interface ListenMsg {
    type: "listen";
    phase: "down" | "up" | "cancel";
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

export type ClientMsg =
    | HelloMsg
    | PlaybackMsg
    | SayMsg
    | AskMsg
    | InterruptMsg
    | ListenMsg
    | SetConfigMsg
    | GetConfigMsg
    | LogMsg;

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
        t === "speak" ||
        t === "state" ||
        t === "stop" ||
        t === "pulse" ||
        t === "config" ||
        t === "focus" ||
        t === "caption"
    );
}

export function isClientMsg(v: unknown): v is ClientMsg {
    if (typeof v !== "object" || v === null) return false;
    const t = (v as { type?: unknown }).type;
    return (
        t === "hello" ||
        t === "playback" ||
        t === "say" ||
        t === "ask" ||
        t === "interrupt" ||
        t === "listen" ||
        t === "set-config" ||
        t === "get-config" ||
        t === "log"
    );
}
