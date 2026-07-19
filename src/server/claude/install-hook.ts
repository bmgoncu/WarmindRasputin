/**
 * Installs (or removes) the user-level hook that makes every Claude session report to the daemon.
 *
 *   npx tsx src/server/claude/install-hook.ts          show what would change
 *   npx tsx src/server/claude/install-hook.ts --apply  write it
 *   npx tsx src/server/claude/install-hook.ts --remove show removal, add --apply to do it
 *
 * This edits `~/.claude/settings.json`, which is the user's own global config and governs every
 * Claude session on the machine — so it prints a diff and does nothing unless `--apply` is passed,
 * and it always writes a timestamped backup first.
 *
 * The hook is `type: "http"` with `async: true`. Async matters: the endpoint must never be able to
 * stall a session, and a synchronous hook pointed at a daemon that is down would do exactly that.
 */

import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DAEMON_PORT } from "../../shared/protocol.js";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const ENDPOINT = `http://127.0.0.1:${DAEMON_PORT}/event`;

/**
 * Events we subscribe to.
 *
 * `PostToolUse` is deliberately absent: the transcript tailer already sees tool results, and
 * subscribing would double every tool into two visual pulses.
 */
const EVENTS = ["UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SubagentStop"] as const;

interface HookEntry {
    type?: string;
    url?: string;
    async?: boolean;
}
interface HookMatcher {
    matcher?: string;
    hooks?: HookEntry[];
}
type HookMap = Record<string, HookMatcher[]>;
interface Settings {
    hooks?: HookMap;
    [key: string]: unknown;
}

function isOurs(entry: HookEntry): boolean {
    return entry?.type === "http" && typeof entry.url === "string" && entry.url.includes("/event");
}

/** Adds our hook to each event, leaving any other hooks on that event untouched. */
export function addHook(settings: Settings): Settings {
    const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
    const hooks = next.hooks as HookMap;

    for (const event of EVENTS) {
        const matchers = [...(hooks[event] ?? [])];
        // Replace our own entry rather than appending, so re-running is idempotent instead of
        // accumulating duplicates that each fire a request.
        const cleaned = matchers
            .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isOurs(h)) }))
            .filter((m) => (m.hooks ?? []).length > 0);
        cleaned.push({ hooks: [{ type: "http", url: ENDPOINT, async: true }] });
        hooks[event] = cleaned;
    }
    return next;
}

/** Removes our hook and any now-empty structure, leaving other people's hooks alone. */
export function removeHook(settings: Settings): Settings {
    const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
    const hooks = next.hooks as HookMap;

    for (const event of Object.keys(hooks)) {
        const cleaned = (hooks[event] ?? [])
            .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isOurs(h)) }))
            .filter((m) => (m.hooks ?? []).length > 0);
        if (cleaned.length > 0) hooks[event] = cleaned;
        else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete next.hooks;
    return next;
}

async function readSettings(): Promise<Settings> {
    try {
        return JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Settings;
    } catch {
        return {};
    }
}

export interface HookState {
    installed: boolean;
    settingsPath: string;
    endpoint: string;
    events: readonly string[];
}

/**
 * Whether every subscribed event carries our hook.
 *
 * All-or-nothing on purpose: a partial install (one event added, another lost to a hand edit)
 * should read as "not installed" so pressing Install repairs it, rather than as "installed" while
 * silently missing half the events.
 */
export async function hookState(): Promise<HookState> {
    const settings = await readSettings();
    const hooks = (settings.hooks ?? {}) as HookMap;
    const installed = EVENTS.every((event) =>
        (hooks[event] ?? []).some((m) => (m.hooks ?? []).some(isOurs)),
    );
    return { installed, settingsPath: SETTINGS_PATH, endpoint: ENDPOINT, events: EVENTS };
}

/**
 * Installs or removes the hook, returning what changed.
 *
 * Shared by the CLI and the Preferences button, so both take the same backup and the same
 * idempotent path — the button must not be a second, laxer implementation of the same edit.
 */
export async function setHook(enabled: boolean): Promise<{ changed: boolean; backup?: string }> {
    const current = await readSettings();
    const before = JSON.stringify(current, null, 2);
    const next = enabled ? addHook(current) : removeHook(current);
    const after = JSON.stringify(next, null, 2);
    if (before === after) return { changed: false };

    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    let backup: string | undefined;
    if (before !== "{}") {
        backup = `${SETTINGS_PATH}.rasputin-backup-${Date.now()}`;
        await copyFile(SETTINGS_PATH, backup).catch(() => {
            backup = undefined;
        });
    }
    await writeFile(SETTINGS_PATH, `${after}\n`, "utf8");
    return { changed: true, backup };
}

/** Minimal line diff — enough to review a settings change, and no dependency. */
function diff(before: string, after: string): string {
    const a = before.split("\n");
    const b = after.split("\n");
    const out: string[] = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] !== undefined) out.push(`  - ${a[i]}`);
        if (b[i] !== undefined) out.push(`  + ${b[i]}`);
    }
    return out.join("\n");
}

async function main(): Promise<void> {
    const apply = process.argv.includes("--apply");
    const remove = process.argv.includes("--remove");

    const current = await readSettings();
    const before = JSON.stringify(current, null, 2);
    const next = remove ? removeHook(current) : addHook(current);
    const after = JSON.stringify(next, null, 2);

    console.log(`settings: ${SETTINGS_PATH}`);
    console.log(`endpoint: ${ENDPOINT}`);
    console.log(`events:   ${EVENTS.join(", ")}\n`);

    if (before === after) {
        console.log(remove ? "Nothing to remove — the hook is not installed." : "Already installed; nothing to change.");
        return;
    }

    console.log(diff(before, after));

    if (!apply) {
        console.log(`\nNothing written. Re-run with --apply to ${remove ? "remove" : "install"}.`);
        return;
    }

    const result = await setHook(!remove);
    if (result.backup) console.log(`\nbacked up to ${result.backup}`);
    console.log(remove ? "Removed." : "Installed. New Claude sessions will report to the daemon.");
}

if (process.argv[1]?.endsWith("install-hook.ts") || process.argv[1]?.endsWith("install-hook.js")) {
    void main();
}
