import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessions, SessionWatcher, isAlive, type SessionChange } from "../src/server/claude/sessions.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rasputin-sess-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const write = (name: string, entry: Record<string, unknown>) =>
    writeFile(join(dir, name), JSON.stringify(entry));

/** This test process is guaranteed alive, so it stands in for a running Claude. */
const LIVE = process.pid;
/** Very unlikely to exist; used for the stale-file case. */
const DEAD = 999_999;

describe("isAlive", () => {
    it("recognises a live process and a dead one", () => {
        expect(isAlive(LIVE)).toBe(true);
        expect(isAlive(DEAD)).toBe(false);
    });
});

describe("readSessions", () => {
    it("returns an empty list when the directory is absent", async () => {
        expect(await readSessions(join(dir, "nope"))).toEqual([]);
    });

    it("reads live entries", async () => {
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p/one", status: "busy" });
        const out = await readSessions(dir);
        expect(out).toHaveLength(1);
        expect(out[0].sessionId).toBe("s1");
    });

    it("skips entries whose process is gone", async () => {
        // The file outlives the process, so a stale `busy` would otherwise be announced as work
        // finishing when it ended at the last reboot.
        await write("dead.json", { pid: DEAD, sessionId: "gone", cwd: "/p", status: "busy" });
        expect(await readSessions(dir)).toEqual([]);
    });

    it("skips malformed files rather than throwing", async () => {
        await writeFile(join(dir, "bad.json"), "{ not json");
        await write("ok.json", { pid: LIVE, sessionId: "s1", cwd: "/p", status: "idle" });
        expect(await readSessions(dir)).toHaveLength(1);
    });

    it("ignores non-json files", async () => {
        await writeFile(join(dir, "notes.txt"), "hello");
        expect(await readSessions(dir)).toEqual([]);
    });
});

describe("SessionWatcher", () => {
    it("does not emit on the first pass, so attaching announces nothing", async () => {
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p", status: "busy" });
        const w = new SessionWatcher(dir);
        const seen: SessionChange[] = [];
        w.onChange = (c) => seen.push(c);
        await w.tick();
        expect(seen).toHaveLength(0);
    });

    it("emits busy -> idle, the task-complete edge", async () => {
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p/proj", status: "busy" });
        const w = new SessionWatcher(dir);
        const seen: SessionChange[] = [];
        w.onChange = (c) => seen.push(c);
        await w.tick();
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p/proj", status: "idle" });
        await w.tick();
        expect(seen).toHaveLength(1);
        expect(seen[0].from).toBe("busy");
        expect(seen[0].to).toBe("idle");
    });

    it("does not re-emit while the status holds", async () => {
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p", status: "busy" });
        const w = new SessionWatcher(dir);
        const seen: SessionChange[] = [];
        w.onChange = (c) => seen.push(c);
        await w.tick();
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p", status: "idle" });
        await w.tick();
        await w.tick();
        await w.tick();
        expect(seen).toHaveLength(1);
    });

    it("forgets a session that disappears, so a restart is not compared to a past life", async () => {
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p", status: "busy" });
        const w = new SessionWatcher(dir);
        const seen: SessionChange[] = [];
        w.onChange = (c) => seen.push(c);
        await w.tick();
        await rm(join(dir, "a.json"));
        await w.tick();
        expect(w.snapshot).toEqual({});
        // Reappearing as idle must not read as busy -> idle.
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p", status: "idle" });
        await w.tick();
        expect(seen).toHaveLength(0);
    });

    it("tracks several sessions independently", async () => {
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p/a", status: "busy" });
        await write("b.json", { pid: LIVE, sessionId: "s2", cwd: "/p/b", status: "busy" });
        const w = new SessionWatcher(dir);
        const seen: SessionChange[] = [];
        w.onChange = (c) => seen.push(c);
        await w.tick();
        await write("a.json", { pid: LIVE, sessionId: "s1", cwd: "/p/a", status: "idle" });
        await w.tick();
        expect(seen.map((c) => c.session.sessionId)).toEqual(["s1"]);
    });
});
