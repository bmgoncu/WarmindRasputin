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

import { sessionIdForPath, TranscriptTailer, type TailEvent } from "./tailer.js";
import { findTranscript, SessionWatcher, type SessionChange, type SessionEntry } from "./sessions.js";
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
    /** True when the user chose this session rather than it being the most recently active. */
    pinned?: boolean;
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
    // Subagent transcripts are neither followed nor narrated — see the TranscriptTailer doc.
    private readonly tailer = new TranscriptTailer(undefined, false);
    private readonly sessions = new SessionWatcher();
    /** sessionId → cwd, so completion announcements can name the project. */
    private readonly cwdBySession = new Map<string, string>();
    /** Guards against speaking the same block twice when a line is re-read. */
    private readonly spoken = new Set<string>();
    /** The session we are attached to — the most recent one to show activity. */
    private focused: { sessionId: string; cwd?: string; pinned: boolean } | null = null;
    private liveCount = 0;
    /**
     * Session the user pinned, or null to follow whichever was most recently active.
     *
     * When pinned, everything else is ignored outright — the point of choosing a session is not
     * hearing the other four.
     */
    private pinned: string | null = null;
    /**
     * Whether to narrate at all.
     *
     * Off by default and deliberately so. Following the session registry means narration would
     * otherwise begin the moment the daemon starts — every Claude session on the machine, with no
     * opt-in — which is not something software should decide for someone. The Preferences switch
     * is the opt-in, and it also installs the hook.
     */
    private enabled = false;

    constructor(private readonly events: ObserverEvents) {
        this.tailer.onLines = (ev) => this.onTranscript(ev);
        this.sessions.onChange = (change) => this.onSessionChange(change);
        this.sessions.onPoll = (entries) => {
            this.liveCount = entries.length;
            void this.followLiveSessions(entries);
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
     * Follows the transcript of every live session.
     *
     * Hook events alone are not enough. `follow()` starts at the CURRENT end of file, and the
     * daemon restarts — under `tsx watch`, on every edit — so after a restart nothing is followed
     * until the next hook fires, by which time the assistant text written in between has already
     * been appended and is skipped. Polling the registry means narration resumes on its own.
     */
    private async followLiveSessions(entries: SessionEntry[]): Promise<void> {
        if (!this.enabled) return;
        for (const entry of entries) {
            if (entry.cwd) this.cwdBySession.set(entry.sessionId, entry.cwd);
            const path = await findTranscript(entry.sessionId);
            if (path) await this.tailer.follow(path);
        }
    }

    /** Turns narration on or off. Off also stops following, so nothing is polled for nothing. */
    setEnabled(on: boolean): void {
        this.enabled = on;
        if (!on) for (const path of this.tailer.watching) this.tailer.unfollow(path);
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    /** Pins narration to one session, or null for automatic. */
    setPinned(sessionId: string | null): void {
        this.pinned = sessionId;
        if (sessionId) this.setFocus(sessionId, this.cwdBySession.get(sessionId));
    }

    get pinnedSession(): string | null {
        return this.pinned;
    }

    /**
     * May this session take focus and drive orb state?
     *
     * Only the pin restricts this. In automatic mode ANY session may take focus — that is what
     * "most recent" means, and gating it on the current focus would freeze it on the first session
     * seen and never move again.
     */
    private accepted(sessionId: string): boolean {
        return this.pinned === null || this.pinned === sessionId;
    }

    /**
     * Should this session's words be spoken?
     *
     * Stricter than `accepted`: with no pin that means the session in FOCUS, not any session.
     * Following the registry tails every live session, and narrating them all interleaves four
     * projects into one voice.
     */
    private narratable(sessionId: string): boolean {
        if (this.pinned !== null) return this.pinned === sessionId;
        return this.focused === null || this.focused.sessionId === sessionId;
    }

    /**
     * Handles one hook event.
     *
     * Unknown event names are ignored rather than rejected: Claude Code gains hook types over time,
     * and an observer that errors on one it does not recognise would break on an upgrade.
     */
    handleHook(payload: HookPayload): void {
        if (!this.enabled) return;
        if (payload.session_id && payload.cwd) this.cwdBySession.set(payload.session_id, payload.cwd);

        // Follow regardless of the pin: a pinned session can be changed at any moment, and having
        // already been tailing the others means the switch takes effect immediately rather than
        // after their next write.
        if (payload.transcript_path) void this.tailer.follow(payload.transcript_path);

        if (payload.session_id && !this.accepted(payload.session_id)) return;

        // Most recent activity wins when nothing is pinned. With a global hook every session on
        // the machine reports, and "the one that just did something" is the only sensible reading.
        if (payload.session_id) this.setFocus(payload.session_id, payload.cwd);

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
        if (!this.enabled) return;
        // Belt and braces: discovery is off, but a subagent path could still be followed if one
        // were handed over by a hook. Delegated work is never narrated.
        if (ev.subagent) return;
        // Derived from the path rather than read from the line: subagent transcripts carry no
        // session id of their own, and the parent's uuid is in their directory.
        if (!this.narratable(sessionIdForPath(ev.path))) return;

        let latest: string | null = null;
        let dropped = 0;

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
            if (latest !== null) dropped++;
            latest = text;
        }

        // Only the most recent message in a batch is spoken.
        //
        // A live session appends a line or two per read, so this changes nothing in normal use.
        // But any backlog — a slow poll, an adopted session, a burst of output — would otherwise
        // queue minutes of speech that is already stale by the time it is heard. The newest line
        // is the only one still worth saying out loud.
        if (latest === null) return;
        if (dropped > 0) console.log(`observer: spoke the latest of ${dropped + 1} pending messages`);
        this.events.say(latest);
    }

    /**
     * Announces the attached session, but only when something actually changes.
     *
     * The pin is part of that comparison: pinning the session already in focus changes nothing
     * about WHICH session it is, but it does change what the label should say, and leaving it out
     * meant choosing the current session appeared to do nothing.
     */
    private setFocus(sessionId: string, cwd?: string): void {
        const resolved = cwd ?? this.cwdBySession.get(sessionId);
        const pinned = this.pinned !== null;
        if (
            this.focused?.sessionId === sessionId &&
            this.focused.cwd === resolved &&
            this.focused.pinned === pinned
        ) {
            return;
        }
        this.focused = { sessionId, cwd: resolved, pinned };
        this.events.focus({
            sessionId,
            cwd: resolved,
            project: resolved ? resolved.split("/").filter(Boolean).pop() : undefined,
            sessions: this.liveCount,
            pinned,
        });
    }

    private onSessionChange(change: SessionChange): void {
        if (!this.enabled || !this.accepted(change.session.sessionId)) return;
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
