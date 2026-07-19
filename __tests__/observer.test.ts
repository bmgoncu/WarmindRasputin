import { SessionObserver, type HookPayload } from "../src/server/claude/observer.js";

function makeObserver() {
    const said: string[] = [];
    const pulses: number[] = [];
    const states: string[] = [];
    const obs = new SessionObserver({
        say: (t) => said.push(t),
        pulse: (s) => pulses.push(s),
        state: (s) => states.push(s),
    });
    return { obs, said, pulses, states };
}

/** Reaches the private transcript handler the tailer would normally drive. */
const feed = (obs: SessionObserver, lines: unknown[]): void =>
    (obs as unknown as { onTranscript: (e: unknown) => void }).onTranscript({
        path: "/p/s.jsonl", subagent: false, lines,
    });

const assistant = (content: unknown, id = "m1") => ({
    type: "assistant", message: { id, role: "assistant", content },
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
