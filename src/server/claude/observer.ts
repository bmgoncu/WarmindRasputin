/**
 * Observing Claude Code sessions.
 *
 * Two inputs, deliberately kept separate:
 *
 *   - **Hooks** (`POST /event`) say what just happened and, crucially, hand over `transcript_path`.
 *     That path is the only reliable way to find a session's transcript: the on-disk project
 *     directory name is a LOSSY encoding of the cwd (both `/` and `_` become `-`, so
 *     `merge-mogul_2` and `merge-mogul-2` collide), and must never be reversed.
 *   - **The transcript tailer** supplies the actual words, because hook payloads do not contain
 *     the assistant's text.
 *
 * The session registry supplies a third signal — `busy → idle` — which neither of the above can
 * give: a pause between tool calls is indistinguishable from being finished if you only read the
 * transcript.
 */

import { TranscriptTailer, type TailEvent } from "./tailer.js";
import { SessionWatcher, type SessionChange } from "./sessions.js";
import { isToolActivity, speakableText, summarizeForSpeech } from "./transcript.js";

/** The subset of a hook payload we rely on. Claude Code sends more; none of it is required. */
export interface HookPayload {
    hook_event_name?: string;
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    tool_name?: string;
    message?: string;
}

export interface FocusInfo {
    project?: string;
    cwd?: string;
    sessionId?: string;
    sessions: number;
}

export interface ObserverEvents {
    /** Speak this. Already summarised and stripped of markdown. */
    say: (text: string) => void;
    /** Non-speech visual impulse — a tool call, a passing beat of activity. */
    pulse: (strength: number) => void;
    /** Server-driven orb state. Never "speaking"; the renderer owns that. */
    state: (state: "idle" | "listening" | "thinking" | "alert") => void;
    /** The session currently being narrated changed. */
    focus: (info: FocusInfo) => void;
}

/**
 * How much of an assistant turn to speak.
 *
 * Every text block would be unusable — a long answer read aloud in full is an audiobook, not a
 * status report. The cap is per BLOCK rather than per turn so a short aside is spoken whole.
 */
const SPEAK_MAX_CHARS = 320;

/** Ignore text shorter than this. Single words like "Done." add noise without adding information. */
const SPEAK_MIN_CHARS = 12;

export class SessionObserver {
    private readonly tailer = new TranscriptTailer();
    private readonly sessions = new SessionWatcher();
    /** sessionId → cwd, so completion announcements can name the project. */
    private readonly cwdBySession = new Map<string, string>();
    /** Guards against speaking the same block twice when a line is re-read. */
    private readonly spoken = new Set<string>();
    /** The session we are attached to — the most recent one to show activity. */
    private focused: { sessionId: string; cwd?: string } | null = null;
    private liveCount = 0;

    constructor(private readonly events: ObserverEvents) {
        this.tailer.onLines = (ev) => this.onTranscript(ev);
        this.sessions.onChange = (change) => this.onSessionChange(change);
        this.sessions.onCount = (n) => {
            this.liveCount = n;
        };
    }

    start(): void {
        this.tailer.start();
        this.sessions.start();
    }

    stop(): void {
        this.tailer.stop();
        this.sessions.stop();
    }

    get watching(): string[] {
        return this.tailer.watching;
    }

    /**
     * Handles one hook event.
     *
     * Unknown event names are ignored rather than rejected: Claude Code gains hook types over time,
     * and an observer that errors on one it does not recognise would break on an upgrade.
     */
    handleHook(payload: HookPayload): void {
        if (payload.session_id && payload.cwd) this.cwdBySession.set(payload.session_id, payload.cwd);
        // Most recent activity wins. With a global hook every session on the machine reports, and
        // "the one that just did something" is the only sensible reading of which is in focus.
        if (payload.session_id) this.setFocus(payload.session_id, payload.cwd);

        // Always start following, whatever the event was. The path only ever arrives this way.
        if (payload.transcript_path) void this.tailer.follow(payload.transcript_path);

        switch (payload.hook_event_name) {
            case "UserPromptSubmit":
                this.events.state("thinking");
                break;
            case "PreToolUse":
                // Tool activity is shown, never narrated — see the speech policy.
                this.events.pulse(0.5);
                break;
            case "Notification":
                this.events.state("alert");
                break;
            case "Stop":
            case "SubagentStop":
                this.events.state("idle");
                break;
            default:
                break;
        }
    }

    private onTranscript(ev: TailEvent): void {
        for (const line of ev.lines) {
            if (isToolActivity(line)) this.events.pulse(0.45);

            const raw = speakableText(line);
            if (!raw) continue;

            // Blocks of one assistant turn arrive on separate lines sharing message.id, so dedupe
            // on the text itself rather than on the id.
            const key = `${line.message?.id ?? ""}:${raw.slice(0, 80)}`;
            if (this.spoken.has(key)) continue;
            this.spoken.add(key);
            if (this.spoken.size > 500) this.spoken.clear();

            const text = summarizeForSpeech(raw, SPEAK_MAX_CHARS);
            if (text.length < SPEAK_MIN_CHARS) continue;
            this.events.say(text);
        }
    }

    /** Announces the attached session, but only when it actually changes. */
    private setFocus(sessionId: string, cwd?: string): void {
        const resolved = cwd ?? this.cwdBySession.get(sessionId);
        if (this.focused?.sessionId === sessionId && this.focused.cwd === resolved) return;
        this.focused = { sessionId, cwd: resolved };
        this.events.focus({
            sessionId,
            cwd: resolved,
            project: resolved ? resolved.split("/").filter(Boolean).pop() : undefined,
            sessions: this.liveCount,
        });
    }

    private onSessionChange(change: SessionChange): void {
        this.setFocus(change.session.sessionId, change.session.cwd);
        if (change.to === "busy") {
            this.events.state("thinking");
            return;
        }
        if (change.from !== "busy" || change.to !== "idle") return;

        const cwd = change.session.cwd ?? this.cwdBySession.get(change.session.sessionId);
        const project = cwd ? cwd.split("/").filter(Boolean).pop() : undefined;
        this.events.state("idle");
        this.events.say(project ? `Task complete. ${project}.` : "Task complete.");
    }
}
