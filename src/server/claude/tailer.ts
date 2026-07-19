/**
 * Follows append-only JSONL transcripts.
 *
 * **Tails by (inode, byte offset) — never mtime.** Idle sessions are touched roughly hourly with
 * ZERO bytes appended. An mtime or FSEvents watcher fires on every one of those, so the orb would
 * wake and narrate nothing at 3am. Verified against real transcripts.
 *
 * The inode half matters too: a rotated or replaced file keeps its path but gets a new inode, and
 * an offset carried across that boundary either skips content or reads garbage. Inode change means
 * start over at zero.
 *
 * Polling rather than `fs.watch`: the cost is one `stat` per file per interval, the failure modes
 * are all visible, and FSEvents on macOS coalesces and reorders in ways that are painful to reason
 * about for a file being appended to continuously.
 */

import { readdir, open, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseLines, type TranscriptLine } from "./transcript.js";

/** How often to stat followed files. */
export const POLL_MS = 400;

interface Followed {
    path: string;
    inode: number;
    offset: number;
}

export interface TailEvent {
    path: string;
    /** True for `<uuid>/subagents/agent-<id>.jsonl`. */
    subagent: boolean;
    lines: TranscriptLine[];
}

/**
 * Reads whatever has been appended since the last read.
 *
 * Returns null when nothing changed, so callers can distinguish "no new bytes" from "new bytes
 * that parsed to nothing".
 */
export async function readNew(state: Followed): Promise<string | null> {
    let s;
    try {
        s = await stat(state.path);
    } catch {
        return null; // deleted or not yet created
    }

    // A new inode at the same path is a different file. Carrying the old offset across would skip
    // the head of the new one, or read past its end.
    if (s.ino !== state.inode) {
        state.inode = s.ino;
        state.offset = 0;
    }
    // Truncation: the only sane response for an append-only log that shrank is to re-read it.
    if (s.size < state.offset) state.offset = 0;
    if (s.size === state.offset) return null;

    const fh = await open(state.path, "r");
    try {
        const length = s.size - state.offset;
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, state.offset);
        state.offset += bytesRead;
        return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
        await fh.close();
    }
}

/**
 * Follows a transcript and every subagent transcript beside it.
 *
 * Watching only the parent goes blind during delegation: subagent output lands in
 * `<session-uuid>/subagents/agent-<id>.jsonl`, a different file entirely, and those files appear
 * mid-session so the directory has to be rescanned rather than enumerated once.
 */
export class TranscriptTailer {
    private followed = new Map<string, Followed>();
    private timer: NodeJS.Timeout | null = null;
    private scanning = false;

    onLines: ((ev: TailEvent) => void) | null = null;

    constructor(private readonly pollMs = POLL_MS) {}

    /**
     * Starts following a transcript. Safe to call repeatedly with the same path.
     *
     * `fromStart: false` (the default) begins at the CURRENT end of file, so attaching to a
     * long-running session does not replay its entire history through the speech pipeline.
     */
    async follow(path: string, fromStart = false): Promise<void> {
        if (this.followed.has(path)) return;
        let inode = 0;
        let offset = 0;
        try {
            const s = await stat(path);
            inode = s.ino;
            offset = fromStart ? 0 : s.size;
        } catch {
            // Not there yet — it will be picked up once it appears, from offset 0.
        }
        this.followed.set(path, { path, inode, offset });
    }

    unfollow(path: string): void {
        this.followed.delete(path);
    }

    get watching(): string[] {
        return [...this.followed.keys()];
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), this.pollMs);
        // Node should be free to exit even with a tailer running.
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One poll pass. Exposed so tests can drive it deterministically instead of waiting. */
    async tick(): Promise<void> {
        if (this.scanning) return; // a slow disk must not overlap passes
        this.scanning = true;
        try {
            await this.discoverSubagents();
            for (const state of [...this.followed.values()]) {
                const chunk = await readNew(state);
                if (chunk === null) continue;
                const lines = parseLines(chunk);
                if (lines.length === 0) continue;
                this.onLines?.({
                    path: state.path,
                    subagent: isSubagentPath(state.path),
                    lines,
                });
            }
        } finally {
            this.scanning = false;
        }
    }

    /** Picks up subagent transcripts that appear after a session is already being followed. */
    private async discoverSubagents(): Promise<void> {
        for (const path of [...this.followed.keys()]) {
            if (isSubagentPath(path)) continue;
            const dir = subagentDirFor(path);
            let entries: string[];
            try {
                entries = await readdir(dir);
            } catch {
                continue; // no subagents for this session, which is the common case
            }
            for (const name of entries) {
                if (!name.endsWith(".jsonl")) continue;
                const full = join(dir, name);
                // From the start: a subagent file is created when the delegation begins, so its
                // whole contents are new to us.
                if (!this.followed.has(full)) await this.follow(full, true);
            }
        }
    }
}

/** `<dir>/<uuid>.jsonl` → `<dir>/<uuid>/subagents` */
export function subagentDirFor(transcriptPath: string): string {
    return join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ""), "subagents");
}

export function isSubagentPath(path: string): boolean {
    return path.includes("/subagents/");
}

/**
 * Session id for a transcript path.
 *
 * The transcript filename IS the session uuid — verified against the live registry, where all 11
 * session ids matched a transcript filename exactly. Subagent transcripts sit at
 * `<uuid>/subagents/agent-<id>.jsonl`, so their session is the grandparent directory.
 *
 * Deriving this is what makes it possible to narrate one session and ignore the rest: the tailer
 * deals in paths, while the user picks a session.
 */
export function sessionIdForPath(path: string): string {
    if (isSubagentPath(path)) {
        const parts = path.split("/");
        const i = parts.lastIndexOf("subagents");
        return i > 0 ? parts[i - 1] : "";
    }
    return basename(path).replace(/\.jsonl$/, "");
}
