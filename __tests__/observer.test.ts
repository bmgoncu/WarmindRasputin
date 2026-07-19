import { SessionObserver, type HookPayload } from "../src/server/claude/observer.js";

function makeObserver() {
    const said: string[] = [];
    const pulses: number[] = [];
    const states: string[] = [];
    const focus: { project?: string; sessions: number; pinned?: boolean }[] = [];
    const obs = new SessionObserver({
        say: (t) => said.push(t),
        pulse: (s) => pulses.push(s),
        state: (s) => states.push(s),
        focus: (f) => focus.push(f),
    });
    // Narration is off by default — see the `enabled` field. Every test below is about what
    // happens once the user has opted in.
    obs.setEnabled(true);
    return { obs, said, pulses, states, focus };
}

/** Reaches the private transcript handler the tailer would normally drive. */
const feed = (obs: SessionObserver, lines: unknown[]): void =>
    (obs as unknown as { onTranscript: (e: unknown) => void }).onTranscript({
        path: "/p/s.jsonl", subagent: false, lines,
    });

const assistant = (content: unknown, id = "m1") => ({
    type: "assistant", message: { id, role: "assistant", content },
});

describe("opt-in", () => {
    it("narrates nothing until enabled", () => {
        // Following the session registry means narration would otherwise start the moment the
        // daemon does — every session on the machine, with no opt-in.
        const said: string[] = [];
        const states: string[] = [];
        const obs = new SessionObserver({
            say: (t) => said.push(t),
            pulse: () => undefined,
            state: (s) => states.push(s),
            focus: () => undefined,
        });
        obs.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/p/x" });
        (obs as unknown as { onTranscript: (e: unknown) => void }).onTranscript({
            path: "/p/x/aaaa.jsonl", subagent: false,
            lines: [{ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "Should stay silent." }] } }],
        });
        expect(said).toEqual([]);
        expect(states).toEqual([]);
        expect(obs.isEnabled).toBe(false);
    });

    it("stops following when disabled, so nothing is polled for nothing", async () => {
        const obs = new SessionObserver({
            say: () => undefined, pulse: () => undefined, state: () => undefined, focus: () => undefined,
        });
        obs.setEnabled(true);
        obs.handleHook({ session_id: "s1", transcript_path: "/tmp/x/abc.jsonl" });
        await new Promise((r) => setTimeout(r, 10));
        expect(obs.watching.length).toBeGreaterThan(0);
        obs.setEnabled(false);
        expect(obs.watching).toEqual([]);
    });
});

describe("hook events", () => {
    it("maps prompt submit to thinking and notification to alert", () => {
        const { obs, states } = makeObserver();
        obs.handleHook({ hook_event_name: "UserPromptSubmit" });
        obs.handleHook({ hook_event_name: "Notification" });
        expect(states).toEqual(["thinking", "alert"]);
    });

    it("pulses on tool use rather than speaking it", () => {
        const { obs, pulses, said } = makeObserver();
        obs.handleHook({ hook_event_name: "PreToolUse", tool_name: "Read" });
        expect(pulses).toHaveLength(1);
        expect(said).toEqual([]);
    });

    it("ignores unknown event names instead of failing", () => {
        // Claude Code gains hook types over time; erroring on one would break on an upgrade.
        const { obs, states, said } = makeObserver();
        expect(() => obs.handleHook({ hook_event_name: "SomethingNewIn2027" })).not.toThrow();
        expect(states).toEqual([]);
        expect(said).toEqual([]);
    });

    it("follows the transcript path from the payload", async () => {
        // The on-disk project directory name is a LOSSY encoding of cwd, so the path must come
        // from the hook rather than be reconstructed.
        const { obs } = makeObserver();
        obs.handleHook({ transcript_path: "/tmp/does-not-exist/abc.jsonl" } as HookPayload);
        await new Promise((r) => setTimeout(r, 10));
        expect(obs.watching).toContain("/tmp/does-not-exist/abc.jsonl");
    });
});

describe("speech policy", () => {
    it("speaks assistant text", () => {
        const { obs, said } = makeObserver();
        feed(obs, [assistant([{ type: "text", text: "The build finished with twelve tests passing." }])]);
        expect(said).toEqual(["The build finished with twelve tests passing."]);
    });

    it("never speaks tool_use, and pulses instead", () => {
        const { obs, said, pulses } = makeObserver();
        feed(obs, [assistant([{ type: "tool_use", name: "Read" }])]);
        expect(said).toEqual([]);
        expect(pulses).toHaveLength(1);
    });

    it("speaks the text of a turn that also called a tool", () => {
        const { obs, said, pulses } = makeObserver();
        feed(obs, [assistant([
            { type: "text", text: "Reading the configuration file now." },
            { type: "tool_use", name: "Read" },
        ])]);
        expect(said).toEqual(["Reading the configuration file now."]);
        expect(pulses).toHaveLength(1);
    });

    it("does not repeat a block seen twice", () => {
        const { obs, said } = makeObserver();
        const line = assistant([{ type: "text", text: "This should be spoken only once." }]);
        feed(obs, [line]);
        feed(obs, [line]);
        expect(said).toHaveLength(1);
    });

    it("skips very short text", () => {
        // "Done." carries no information a pulse does not already convey.
        const { obs, said } = makeObserver();
        feed(obs, [assistant([{ type: "text", text: "Done." }])]);
        expect(said).toEqual([]);
    });

    it("strips markdown and truncates long answers", () => {
        const { obs, said } = makeObserver();
        feed(obs, [assistant([{ type: "text", text: "## Result\n- item one\n" + "word ".repeat(200) }])]);
        expect(said[0]).not.toContain("##");
        expect(said[0]).not.toContain("- item");
        expect(said[0].length).toBeLessThanOrEqual(322);
    });

    it("ignores user and system lines", () => {
        const { obs, said } = makeObserver();
        feed(obs, [
            { type: "user", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } },
            { type: "system", message: { content: [{ type: "text", text: "system note" }] } },
        ]);
        expect(said).toEqual([]);
    });
});

describe("task completion", () => {
    const change = (from: string, to: string, cwd = "/Users/x/Depo/merge-mogul") =>
        ({ session: { pid: 1, sessionId: "s1", cwd, status: to }, from, to });
    const fire = (obs: SessionObserver, c: unknown): void =>
        (obs as unknown as { onSessionChange: (c: unknown) => void }).onSessionChange(c);

    it("announces completion on busy -> idle, naming the project", () => {
        const { obs, said, states } = makeObserver();
        fire(obs, change("busy", "idle"));
        expect(said).toEqual(["Task complete. merge-mogul."]);
        expect(states).toContain("idle");
    });

    it("says thinking when a session goes busy", () => {
        const { obs, states, said } = makeObserver();
        fire(obs, change("idle", "busy"));
        expect(states).toEqual(["thinking"]);
        expect(said).toEqual([]);
    });

    it("does not announce completion for any other transition", () => {
        const { obs, said } = makeObserver();
        fire(obs, change("idle", "idle"));
        expect(said).toEqual([]);
    });
});

describe("focus", () => {
    it("names the project from the cwd on a hook event", () => {
        const { obs, focus } = makeObserver();
        obs.handleHook({ session_id: "s1", cwd: "/Users/x/Depo/merge-mogul" });
        expect(focus).toHaveLength(1);
        expect(focus[0].project).toBe("merge-mogul");
    });

    it("does not re-announce the same session", () => {
        // Every hook event carries a session_id; emitting on each would rewrite the tray label
        // dozens of times a minute for no change.
        const { obs, focus } = makeObserver();
        obs.handleHook({ session_id: "s1", cwd: "/p/one" });
        obs.handleHook({ session_id: "s1", cwd: "/p/one", hook_event_name: "PreToolUse" });
        obs.handleHook({ session_id: "s1", cwd: "/p/one", hook_event_name: "Stop" });
        expect(focus).toHaveLength(1);
    });

    it("follows the most recently active session when several are running", () => {
        const { obs, focus } = makeObserver();
        obs.handleHook({ session_id: "s1", cwd: "/p/one" });
        obs.handleHook({ session_id: "s2", cwd: "/p/two" });
        obs.handleHook({ session_id: "s1", cwd: "/p/one" });
        expect(focus.map((f) => f.project)).toEqual(["one", "two", "one"]);
    });

    it("copes with a hook that carries no cwd", () => {
        const { obs, focus } = makeObserver();
        obs.handleHook({ session_id: "s1" });
        expect(focus[0].project).toBeUndefined();
    });
});

describe("pinning a session", () => {
    const feedPath = (obs: SessionObserver, path: string, lines: unknown[]): void =>
        (obs as unknown as { onTranscript: (e: unknown) => void }).onTranscript({ path, subagent: false, lines });

    const P1 = "/p/proj/aaaaaaaa-1111-2222-3333-444444444444.jsonl";
    const P2 = "/p/proj/bbbbbbbb-1111-2222-3333-444444444444.jsonl";
    const S1 = "aaaaaaaa-1111-2222-3333-444444444444";
    const S2 = "bbbbbbbb-1111-2222-3333-444444444444";

    it("narrates every session when nothing is pinned", () => {
        const { obs, said } = makeObserver();
        feedPath(obs, P1, [assistant([{ type: "text", text: "From the first session here." }], "a")]);
        feedPath(obs, P2, [assistant([{ type: "text", text: "From the second session here." }], "b")]);
        expect(said).toHaveLength(2);
    });

    it("narrates only the pinned session", () => {
        const { obs, said } = makeObserver();
        obs.setPinned(S1);
        feedPath(obs, P1, [assistant([{ type: "text", text: "From the first session here." }], "a")]);
        feedPath(obs, P2, [assistant([{ type: "text", text: "From the second session here." }], "b")]);
        expect(said).toEqual(["From the first session here."]);
    });

    it("never narrates subagent work, even for the pinned session", () => {
        // Deliberate reversal of the original design. Delegated work is a different voice
        // reporting internal progress, and narrating it buries the session's own answers.
        const { obs, said } = makeObserver();
        obs.setPinned(S1);
        (obs as unknown as { onTranscript: (e: unknown) => void }).onTranscript({
            path: `/p/proj/${S1}/subagents/agent-xyz.jsonl`,
            subagent: true,
            lines: [assistant([{ type: "text", text: "Delegated work reporting back." }], "c")],
        });
        expect(said).toEqual([]);
    });

    it("ignores hook events from other sessions while pinned", () => {
        const { obs, states, focus } = makeObserver();
        obs.setPinned(S1);
        focus.length = 0;
        obs.handleHook({ hook_event_name: "UserPromptSubmit", session_id: S2, cwd: "/p/other" });
        expect(states).toEqual([]);
        expect(focus).toHaveLength(0);
    });

    it("returns to automatic when unpinned, following whatever is active", () => {
        const { obs, said } = makeObserver();
        obs.setPinned(S1);
        obs.setPinned(null);
        // Unpinned does not mean "narrate everything" — it means follow the focused session. S2
        // becomes focused by being the most recent to report in.
        obs.handleHook({ session_id: S2, cwd: "/p/two" });
        feedPath(obs, P2, [assistant([{ type: "text", text: "From the second session here." }], "b")]);
        expect(said).toEqual(["From the second session here."]);
    });

    it("in automatic mode, narrates only the focused session", () => {
        // The complaint that started this: several sessions interleaved into one voice.
        const { obs, said } = makeObserver();
        obs.handleHook({ session_id: S1, cwd: "/p/one" });
        feedPath(obs, P2, [assistant([{ type: "text", text: "Some other project talking." }], "x")]);
        feedPath(obs, P1, [assistant([{ type: "text", text: "The focused project talking." }], "y")]);
        expect(said).toEqual(["The focused project talking."]);
    });

    it("speaks only the newest message when a batch arrives at once", () => {
        // A backlog would otherwise queue minutes of speech that is stale before it is heard.
        const { obs, said } = makeObserver();
        obs.handleHook({ session_id: S1, cwd: "/p/one" });
        feedPath(obs, P1, [
            assistant([{ type: "text", text: "First of several queued messages." }], "a"),
            assistant([{ type: "text", text: "Second of several queued messages." }], "b"),
            assistant([{ type: "text", text: "Third and newest queued message." }], "c"),
        ]);
        expect(said).toEqual(["Third and newest queued message."]);
    });

    it("reports the pin in focus updates", () => {
        const { obs, focus } = makeObserver();
        obs.handleHook({ session_id: S1, cwd: "/p/proj" });
        obs.setPinned(S1);
        expect(focus.at(-1)?.pinned).toBe(true);
    });
});
