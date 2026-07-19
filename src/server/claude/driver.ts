/**
 * Driving Claude, as opposed to observing it.
 *
 * M5 watches sessions someone else started. This owns one: it runs the Agent SDK, feeds it
 * requests, and speaks the answers. There is no channel to inject input into a running Claude
 * session — no FIFOs, no sockets under `~/.claude/` — so driving one means owning the process.
 *
 * The prompt is an **AsyncIterable**, not a string. A string prompt is a single shot: the SDK
 * closes the input stream, and `interrupt()` and `setPermissionMode()` are unavailable because
 * they are control requests that only exist while streaming input. An iterable keeps the session
 * open for follow-up turns and makes stopping mid-answer possible, which matters here more than
 * usual — speech takes real time, and being unable to cut it off is the difference between an
 * assistant and a monologue.
 *
 * Speech is deliberately NOT streamed per token. Sentences are the unit: the voice chain renders a
 * whole utterance and derives its feature timeline from it, so half a sentence would be rendered,
 * spoken, and then contradicted by the rest arriving.
 */

import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { speakableText, splitForSpeech } from "./transcript.js";

export interface DriverEvents {
    /** Speak this. Already stripped of markdown. */
    say: (text: string) => void;
    /**
     * The session id the SDK allocated.
     *
     * The observer needs it in order to EXCLUDE it: a driven session registers in
     * `~/.claude/sessions/` like any other, so the observer picks up its transcript and narrates
     * the same answer the driver is already speaking — every driven reply said twice.
     */
    session: (sessionId: string) => void;
    /** Server-driven orb state. */
    state: (state: "idle" | "thinking" | "alert") => void;
    /** Free-form progress for the daemon log. */
    log: (message: string) => void;
}

export interface DriverOptions {
    cwd?: string;
    model?: string;
    /**
     * Tool permission handling.
     *
     * `bypassPermissions` is NOT the default. A voice assistant that silently runs anything it
     * decides to is a bad trade even when convenient — the spoken "shall I proceed?" gate belongs
     * here, and until it exists the safe default is the one that stops and asks.
     */
    permissionMode?: Options["permissionMode"];
    /** Cap on assistant turns per request, so a runaway loop cannot talk indefinitely. */
    maxTurns?: number;
}

/** Length of ONE utterance. Long answers are split across several, never truncated. */
const SPEAK_MAX_CHARS = 320;

/**
 * A queue that presents itself as an AsyncIterable of user messages.
 *
 * The SDK pulls from this; `push` feeds it. Written by hand rather than pulled in as a dependency
 * because the semantics matter: it must never drop a message, and it must be able to end cleanly
 * so the SDK's own loop terminates rather than hanging on a promise that is never resolved.
 */
export class MessageQueue {
    private pending: SDKUserMessage[] = [];
    private waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
    private closed = false;

    push(text: string): void {
        if (this.closed) return;
        const msg: SDKUserMessage = {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: "",
        } as SDKUserMessage;

        if (this.waiting) {
            const resolve = this.waiting;
            this.waiting = null;
            resolve({ value: msg, done: false });
        } else {
            this.pending.push(msg);
        }
    }

    close(): void {
        this.closed = true;
        if (this.waiting) {
            const resolve = this.waiting;
            this.waiting = null;
            resolve({ value: undefined as never, done: true });
        }
    }

    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        while (!this.closed) {
            const next = this.pending.shift();
            if (next) {
                yield next;
                continue;
            }
            const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
                this.waiting = resolve;
            });
            if (result.done) return;
            yield result.value;
        }
    }
}

export class ClaudeDriver {
    private session: Query | null = null;
    private queue: MessageQueue | null = null;
    private running = false;
    private sessionId: string | null = null;

    constructor(
        private readonly events: DriverEvents,
        private readonly opts: DriverOptions = {},
    ) {}

    get isRunning(): boolean {
        return this.running;
    }

    get isOpen(): boolean {
        return this.session !== null;
    }

    /** Session id allocated by the SDK, once known. */
    get ownSessionId(): string | null {
        return this.sessionId;
    }

    /**
     * Sends a request, starting the session on first use.
     *
     * Later requests reuse the same session, so context carries across turns — asking "and now the
     * tests?" only means something if the previous answer is still in scope.
     */
    ask(text: string): void {
        if (!text.trim()) return;
        if (!this.session) this.open();
        this.queue?.push(text);
        this.events.state("thinking");
    }

    private open(): void {
        const queue = new MessageQueue();
        this.queue = queue;

        const session = query({
            prompt: queue,
            options: {
                cwd: this.opts.cwd ?? process.cwd(),
                ...(this.opts.model ? { model: this.opts.model } : {}),
                permissionMode: this.opts.permissionMode ?? "default",
                maxTurns: this.opts.maxTurns ?? 24,
            },
        });
        this.session = session;
        void this.consume(session);
    }

    /** Reads the SDK's message stream and turns it into speech and state. */
    private async consume(session: Query): Promise<void> {
        this.running = true;
        try {
            for await (const message of session) {
                this.handle(message);
            }
        } catch (err) {
            this.events.log(`driver error: ${String(err)}`);
            this.events.state("alert");
        } finally {
            this.running = false;
            if (this.session === session) {
                this.session = null;
                this.queue = null;
            }
            this.events.state("idle");
        }
    }

    private handle(message: SDKMessage): void {
        const id = (message as { session_id?: string }).session_id;
        if (id && id !== this.sessionId) {
            this.sessionId = id;
            this.events.session(id);
        }

        switch (message.type) {
            case "assistant": {
                // Reuses the observer's block filter, so the speech policy is defined once: text
                // blocks are spoken, tool_use and thinking never are.
                const raw = speakableText(message as never);
                if (!raw) return;
                // Split rather than truncated: a driven answer is the thing the user asked for,
                // so clipping it is worse here than anywhere else.
                for (const part of splitForSpeech(raw, SPEAK_MAX_CHARS)) this.events.say(part);
                return;
            }
            case "result": {
                const result = message as { subtype?: string; is_error?: boolean };
                if (result.is_error) {
                    this.events.log(`driver finished with an error: ${result.subtype ?? "unknown"}`);
                    this.events.state("alert");
                } else {
                    this.events.state("idle");
                }
                return;
            }
            default:
                // The SDK emits dozens of message kinds — status, hooks, task notifications. None
                // of them are speech, and new ones must not break this loop.
                return;
        }
    }

    /** Stops the current answer. Only available because the prompt is a stream. */
    async interrupt(): Promise<void> {
        if (!this.session) return;
        try {
            await this.session.interrupt();
            this.events.log("driver interrupted");
        } catch (err) {
            this.events.log(`interrupt failed: ${String(err)}`);
        }
        this.events.state("idle");
    }

    /** Ends the session. The next `ask` starts a fresh one with no memory of this. */
    close(): void {
        this.queue?.close();
        try {
            this.session?.close();
        } catch {
            // Already gone.
        }
        this.session = null;
        this.queue = null;
        this.running = false;
    }
}
