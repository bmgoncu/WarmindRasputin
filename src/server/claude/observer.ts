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
import { isToolActivity, speakableText, splitForSpeech, summarizeForSpeech } from "./transcript.js";
import { completionPhrase, spokenProjectName } from "../voice/phrases.js";

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
    /** Registry session name, e.g. "LiveOps". */
    name?: string;
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
 * Length of ONE spoken utterance, not of the whole reply.
 *
 * A long answer is split into several utterances at sentence boundaries and spoken in order. It
 * used to be truncated here, which meant a listener heard the opening of a report and was never
 * told the rest existed — detail is not sacrificed for brevity in this project.
 */
const SPEAK_MAX_CHARS = 320;

/** Ignore text shorter than this. Single words like "Done." add noise without adding information. */
const SPEAK_MIN_CHARS = 12;

export class SessionObserver {
    // Subagent transcripts are neither followed nor narrated — see the TranscriptTailer doc.
    // Subagent following starts off and is switched by setNarrateSubagents.
    private readonly tailer = new TranscriptTailer(undefined, false);
    private readonly sessions = new SessionWatcher();
    /** sessionId → cwd, so completion announcements can name the project. */
    private readonly cwdBySession = new Map<string, string>();
    /** sessionId → registry name, which is what tells two sessions in one project apart. */
    private readonly nameBySession = new Map<string, string>();
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
    /**
     * Whether delegated work is narrated. Off by default.
     *
     * A session can spend minutes inside subagents, and their output is a different voice
     * reporting internal progress — it buries the session's own answers. Tool-call pulses still
     * show the orb is alive during the silence.
     */
    private narrateSubagents = false;
    /**
     * "brief" speaks only the opening of a long reply; "full" speaks all of it, in chunks.
     *
     * Full is the default. Verbosity is a setting, not a fixed clip level.
     */
    private detail: "brief" | "full" = "full";
    /**
     * Sessions Rasputin drives himself.
     *
     * A driven session registers in `~/.claude/sessions/` like any other, so without this the
     * observer narrates the very answer the driver is already speaking — every driven reply is
     * said twice, in two overlapping voices.
     */
    private readonly ownSessions = new Set<string>();

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
            if (entry.name) this.nameBySession.set(entry.sessionId, entry.name);
            const path = await findTranscript(entry.sessionId);
            if (path) await this.tailer.follow(path);
        }
    }

    /** Marks a session as one we drive, so it is never narrated a second time. */
    excludeSession(sessionId: string): void {
        this.ownSessions.add(sessionId);
    }

    /** How much of a long reply to speak. */
    setDetail(detail: "brief" | "full"): void {
        this.detail = detail;
    }

    get speechDetail(): "brief" | "full" {
        return this.detail;
    }

    /** Narrate delegated subagent work as well as the session's own replies. */
    setNarrateSubagents(on: boolean): void {
        this.narrateSubagents = on;
        this.tailer.setFollowSubagents(on);
    }

    get isNarratingSubagents(): boolean {
        return this.narrateSubagents;
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
        if (this.ownSessions.has(sessionId)) return false;
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
        if (this.ownSessions.has(sessionId)) return false;
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
        // Checked here as well as at discovery: a subagent path can still arrive via a hook
        // payload even when discovery is off.
        if (ev.subagent && !this.narrateSubagents) return;
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

            if (raw.length < SPEAK_MIN_CHARS) continue;
            if (latest !== null) dropped++;
            latest = raw;
        }

        // Only the most recent message in a batch is spoken.
        //
        // A live session appends a line or two per read, so this changes nothing in normal use.
        // But any backlog — a slow poll, an adopted session, a burst of output — would otherwise
        // queue minutes of speech that is already stale by the time it is heard. The newest line
        // is the only one still worth saying out loud.
        if (latest === null) return;
        if (dropped > 0) console.log(`observer: spoke the latest of ${dropped + 1} pending messages`);

        if (this.detail === "brief") {
            const brief = summarizeForSpeech(latest, SPEAK_MAX_CHARS);
            if (brief.length >= SPEAK_MIN_CHARS) this.events.say(brief);
            return;
        }
        // Queued in order by the daemon, so a long reply is heard whole rather than clipped.
        const parts = splitForSpeech(latest, SPEAK_MAX_CHARS);
        if (parts.length > 1) console.log(`observer: speaking a long reply in ${parts.length} parts`);
        for (const part of parts) {
            if (part.length >= SPEAK_MIN_CHARS || parts.length === 1) this.events.say(part);
        }
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
            // Spoken form here too, so the tray label matches what is said aloud.
            project: resolved ? spokenProjectName(resolved.split("/").filter(Boolean).pop() ?? "") : undefined,
            name: this.nameBySession.get(sessionId),
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
        this.events.say(completionPhrase(project));
    }
}
