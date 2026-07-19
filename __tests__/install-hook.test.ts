import { addHook, removeHook } from "../src/server/claude/install-hook.js";

const ours = { type: "http", url: "http://127.0.0.1:7331/event", async: true };
const theirs = { type: "command", command: "echo hi" };

describe("addHook", () => {
    it("adds our hook to every subscribed event", () => {
        const out = addHook({}) as { hooks: Record<string, unknown[]> };
        expect(Object.keys(out.hooks).sort()).toEqual(
            ["Notification", "PreToolUse", "Stop", "SubagentStop", "UserPromptSubmit"].sort(),
        );
        expect(JSON.stringify(out.hooks.Stop)).toContain("/event");
    });

    it("is idempotent — re-running does not accumulate duplicates", () => {
        // Each duplicate would fire its own request on every event.
        const once = addHook({});
        const twice = addHook(once);
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
        const entries = JSON.stringify(twice).match(/\/event/g) ?? [];
        expect(entries).toHaveLength(5);
    });

    it("preserves hooks belonging to someone else", () => {
        const existing = { hooks: { Stop: [{ hooks: [theirs] }] } };
        const out = addHook(existing) as { hooks: Record<string, { hooks: unknown[] }[]> };
        const flat = JSON.stringify(out.hooks.Stop);
        expect(flat).toContain("echo hi");
        expect(flat).toContain("/event");
    });

    it("preserves unrelated top-level settings", () => {
        const out = addHook({ model: "opus", permissions: { allow: ["Bash"] } }) as Record<string, unknown>;
        expect(out.model).toBe("opus");
        expect(out.permissions).toEqual({ allow: ["Bash"] });
    });

    it("does not mutate the input", () => {
        const input = { hooks: { Stop: [{ hooks: [theirs] }] } };
        const snapshot = JSON.stringify(input);
        addHook(input);
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});

describe("removeHook", () => {
    it("removes only ours, leaving other hooks intact", () => {
        const settings = { hooks: { Stop: [{ hooks: [theirs, ours] }] } };
        const out = removeHook(settings) as { hooks: Record<string, { hooks: unknown[] }[]> };
        const flat = JSON.stringify(out.hooks.Stop);
        expect(flat).toContain("echo hi");
        expect(flat).not.toContain("/event");
    });

    it("drops the hooks key entirely when nothing is left", () => {
        const out = removeHook(addHook({})) as Record<string, unknown>;
        expect(out.hooks).toBeUndefined();
    });

    it("round-trips: add then remove restores the original", () => {
        const original = { model: "opus", hooks: { Stop: [{ hooks: [theirs] }] } };
        const restored = removeHook(addHook(original));
        expect(JSON.stringify(restored)).toBe(JSON.stringify(original));
    });

    it("is safe on settings that never had a hook", () => {
        expect(removeHook({ model: "opus" })).toEqual({ model: "opus" });
    });
});
