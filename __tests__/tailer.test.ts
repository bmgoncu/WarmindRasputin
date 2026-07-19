import { mkdtemp, writeFile, appendFile, rm, mkdir, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTailer, readNew, subagentDirFor, isSubagentPath } from "../src/server/claude/tailer.js";
import type { TailEvent } from "../src/server/claude/tailer.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rasputin-tail-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const line = (text: string) =>
    JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text }] } }) + "\n";

describe("readNew", () => {
    it("returns only bytes appended since the last read", async () => {
        const p = join(dir, "t.jsonl");
        await writeFile(p, line("one"));
        const state = { path: p, inode: 0, offset: 0 };
        expect(await readNew(state)).toContain("one");
        expect(await readNew(state)).toBeNull();          // nothing new
        await appendFile(p, line("two"));
        const chunk = await readNew(state);
        expect(chunk).toContain("two");
        expect(chunk).not.toContain("one");               // never re-delivers
    });

    it("ignores an mtime touch that appends zero bytes", async () => {
        // THE trap this module exists for: idle sessions are touched roughly hourly with no bytes
        // appended. An mtime or FSEvents watcher fires on every one and the orb narrates nothing.
        const p = join(dir, "t.jsonl");
        await writeFile(p, line("one"));
        const state = { path: p, inode: 0, offset: 0 };
        await readNew(state);
        const future = new Date(Date.now() + 60_000);
        await utimes(p, future, future);
        expect(await readNew(state)).toBeNull();
    });

    it("restarts at zero when the inode changes under the same path", async () => {
        const p = join(dir, "t.jsonl");
        await writeFile(p, line("old"));
        const state = { path: p, inode: 0, offset: 0 };
        await readNew(state);
        const firstInode = state.inode;

        await rm(p);
        await writeFile(p, line("brand new"));            // same path, different inode
        expect((await stat(p)).ino).not.toBe(firstInode);

        const chunk = await readNew(state);
        expect(chunk).toContain("brand new");             // head of the new file is not skipped
        expect(state.inode).not.toBe(firstInode);
    });

    it("re-reads from zero if the file shrinks", async () => {
        const p = join(dir, "t.jsonl");
        await writeFile(p, line("a") + line("b"));
        const state = { path: p, inode: 0, offset: 0 };
        await readNew(state);
        await writeFile(p, line("c"));                    // truncated
        expect(await readNew(state)).toContain("c");
    });

    it("returns null for a file that does not exist", async () => {
        expect(await readNew({ path: join(dir, "nope.jsonl"), inode: 0, offset: 0 })).toBeNull();
    });
});

describe("TranscriptTailer", () => {
    it("follows from the end by default, so attaching does not replay history", async () => {
        const p = join(dir, "t.jsonl");
        await writeFile(p, line("history") .repeat(3));
        const t = new TranscriptTailer();
        const seen: TailEvent[] = [];
        t.onLines = (e) => seen.push(e);
        await t.follow(p);
        await t.tick();
        expect(seen).toHaveLength(0);                     // existing content is not replayed

        await appendFile(p, line("fresh"));
        await t.tick();
        expect(seen).toHaveLength(1);
        expect(JSON.stringify(seen[0].lines)).toContain("fresh");
    });

    it("replays from the start when asked", async () => {
        const p = join(dir, "t.jsonl");
        await writeFile(p, line("history"));
        const t = new TranscriptTailer();
        const seen: TailEvent[] = [];
        t.onLines = (e) => seen.push(e);
        await t.follow(p, true);
        await t.tick();
        expect(seen).toHaveLength(1);
    });

    it("discovers subagent transcripts that appear mid-session", async () => {
        // Watching only the parent goes blind during delegation.
        const p = join(dir, "sess.jsonl");
        await writeFile(p, line("start"));
        const t = new TranscriptTailer();
        const seen: TailEvent[] = [];
        t.onLines = (e) => seen.push(e);
        await t.follow(p);
        await t.tick();

        const subDir = subagentDirFor(p);
        await mkdir(subDir, { recursive: true });
        await writeFile(join(subDir, "agent-abc.jsonl"), line("from subagent"));
        await t.tick();

        expect(seen).toHaveLength(1);
        expect(seen[0].subagent).toBe(true);
        expect(JSON.stringify(seen[0].lines)).toContain("from subagent");
        expect(t.watching).toHaveLength(2);
    });

    it("does not double-follow the same path", async () => {
        const p = join(dir, "t.jsonl");
        await writeFile(p, line("x"));
        const t = new TranscriptTailer();
        await t.follow(p);
        await t.follow(p);
        expect(t.watching).toHaveLength(1);
    });
});

describe("path helpers", () => {
    it("derives the subagents directory from a transcript path", () => {
        expect(subagentDirFor("/p/proj/abc-123.jsonl")).toBe("/p/proj/abc-123/subagents");
    });
    it("recognises subagent paths", () => {
        expect(isSubagentPath("/p/x/subagents/agent-1.jsonl")).toBe(true);
        expect(isSubagentPath("/p/x/abc.jsonl")).toBe(false);
    });
});

describe("subagent replay window", () => {
    it("reads a freshly created subagent transcript from the start", async () => {
        const p = join(dir, "sess.jsonl");
        await writeFile(p, line("start"));
        const t = new TranscriptTailer();
        const seen: TailEvent[] = [];
        t.onLines = (e) => seen.push(e);
        await t.follow(p);
        await t.tick();

        const subDir = subagentDirFor(p);
        await mkdir(subDir, { recursive: true });
        await writeFile(join(subDir, "agent-new.jsonl"), line("delegated work"));
        await t.tick();
        expect(JSON.stringify(seen)).toContain("delegated work");
    });

    it("does NOT replay an old subagent transcript", async () => {
        // A live session's directory accumulates these for its whole life — 226 were present on
        // this machine, none touched in a day. Adopting a session on daemon start replayed every
        // one from the beginning, all at once.
        const p = join(dir, "sess.jsonl");
        await writeFile(p, line("start"));
        const subDir = subagentDirFor(p);
        await mkdir(subDir, { recursive: true });
        const old = join(subDir, "agent-old.jsonl");
        await writeFile(old, line("ancient history"));
        const longAgo = new Date(Date.now() - 60 * 60 * 1000);
        await utimes(old, longAgo, longAgo);

        const t = new TranscriptTailer();
        const seen: TailEvent[] = [];
        t.onLines = (e) => seen.push(e);
        await t.follow(p);
        await t.tick();
        expect(JSON.stringify(seen)).not.toContain("ancient history");

        // It is still followed, so anything appended from now on is heard.
        await appendFile(old, line("new delegation output"));
        await t.tick();
        expect(JSON.stringify(seen)).toContain("new delegation output");
    });
});
