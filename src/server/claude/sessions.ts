/**
 * Watching the live session registry.
 *
 * `~/.claude/sessions/<pid>.json` is written by every running Claude Code process and carries
 * `cwd`, `sessionId` and `status: busy | idle`. A `busy → idle` edge is the natural "the task is
 * finished" trigger — the transcript alone cannot say that, because a pause between tool calls
 * looks identical to being done.
 *
 * Polled rather than watched. These are small files rewritten in place, FSEvents coalesces such
 * writes unhelpfully, and the whole registry is a handful of files — a `readdir` plus a few reads
 * per second is cheaper than reasoning about dropped events.
 *
 * Stale entries are expected: the file is left behind when a process dies, so a `busy` entry whose
 * pid is gone must not be reported as still working.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Finds a session's transcript without reversing the project-path encoding.
 *
 * That encoding is LOSSY — both `/` and `_` become `-`, so `merge-mogul_2` and `merge-mogul-2`
 * collide and a cwd cannot be turned back into a directory name. But the transcript FILENAME is
 * the session uuid, so scanning the project directories for `<sessionId>.jsonl` is exact.
 */
export async function findTranscript(sessionId: string, projectsDir = PROJECTS_DIR): Promise<string | null> {
    let dirs: string[];
    try {
        dirs = await readdir(projectsDir);
    } catch {
        return null;
    }
    for (const dir of dirs) {
        const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
        try {
            if ((await stat(candidate)).isFile()) return candidate;
        } catch {
            // Not in this project directory.
        }
    }
    return null;
}

export interface SessionEntry {
    pid: number;
    sessionId: string;
    cwd: string;
    status: "busy" | "idle" | string;
    version?: string;
    updatedAt?: number;
}

export interface SessionChange {
    session: SessionEntry;
    /** Always defined: a first sighting is not a change, so it is never reported. */
    from: string;
    to: string;
}

/** True when the process is still alive. Signal 0 tests existence without touching the process. */
export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means it exists but belongs to another user — alive for our purposes.
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

export async function readSessions(dir = SESSIONS_DIR): Promise<SessionEntry[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return []; // no sessions directory yet
    }

    const out: SessionEntry[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
            const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as SessionEntry;
            if (typeof entry?.pid !== "number" || typeof entry?.sessionId !== "string") continue;
            // A file outliving its process is normal. Reporting it would mean announcing the
            // completion of work that ended when the machine was last rebooted.
            if (!isAlive(entry.pid)) continue;
            out.push(entry);
        } catch {
            // Half-written or unreadable — the next poll will catch it.
        }
    }
    return out;
}

/**
 * Emits an event whenever a live session's status changes.
 *
 * The first poll establishes a baseline WITHOUT emitting: attaching while a session happens to be
 * busy should not fire "task complete" the moment it settles, and attaching to a room full of idle
 * sessions should announce nothing at all.
 */
export class SessionWatcher {
    private status = new Map<string, string>();
    private timer: NodeJS.Timeout | null = null;
    private primed = false;

    onChange: ((change: SessionChange) => void) | null = null;
    /** Every live session each poll, reported even when nothing changed. */
    onPoll: ((entries: SessionEntry[]) => void) | null = null;

    constructor(
        private readonly dir = SESSIONS_DIR,
        private readonly pollMs = 700,
    ) {}

    start(): void {
        if (this.timer) return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), this.pollMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One poll pass. Exposed so tests can drive it rather than wait on a timer. */
    async tick(): Promise<void> {
        const live = await readSessions(this.dir);
        this.onPoll?.(live);
        const seen = new Set<string>();

        for (const entry of live) {
            seen.add(entry.sessionId);
            const before = this.status.get(entry.sessionId);
            this.status.set(entry.sessionId, entry.status);
            // A session seen for the FIRST time has not changed status — there is nothing to
            // compare against. Emitting there would report every newly-noticed idle session as an
            // event, including one that merely reappeared after its file was rewritten.
            if (!this.primed || before === undefined || before === entry.status) continue;
            this.onChange?.({ session: entry, from: before, to: entry.status });
        }

        // Forget sessions that have gone, so a restarted one is treated as new rather than
        // compared against a status from a previous life.
        for (const id of [...this.status.keys()]) {
            if (!seen.has(id)) this.status.delete(id);
        }
        this.primed = true;
    }

    /** Current known statuses — for diagnostics. */
    get snapshot(): Record<string, string> {
        return Object.fromEntries(this.status);
    }
}
