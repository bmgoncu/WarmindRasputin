/**
 * Typing dictated text into the terminal that is actually running a session.
 *
 * Claude Code has no channel for injecting input into a running interactive session — verified
 * three ways: the CLI's `--remote-control` routes through claude.ai rather than a local API, the
 * SDK's DirectConnect helpers only normalise a remote server URL, and there are still zero FIFOs
 * and zero sockets under `~/.claude/`. `TIOCSTI`, the ioctl that pushes bytes into a tty's input
 * queue as if typed, is blocked by macOS with EPERM even on a pty this process owns.
 *
 * So the text is typed — synthetically, through the accessibility API. The problem that leaves is
 * aim, and the answer is the tty:
 *
 *   1. Every session's registry entry carries a **pid**, and every pid has a **tty**.
 *   2. Terminal.app exposes the tty of every tab, so a session there can be targeted EXACTLY —
 *      the right window and the right tab, with no guessing.
 *   3. Rider's embedded terminal is not scriptable per tab, but its window titles carry the
 *      project name, so the correct window can at least be raised. Which tab inside it is focused
 *      is the user's to arrange.
 *
 * Typing into the wrong window is not recoverable, so nothing here focuses or types without an
 * identified target, and the caller shows the text first.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type TargetKind = "terminal-tab" | "app-window" | "frontmost" | "none";

export interface TypeTarget {
    kind: TargetKind;
    /** Human-readable description, for logs and the UI. */
    description: string;
    app?: string;
    windowIndex?: number;
    tabIndex?: number;
}

/** Controlling terminal of a process, e.g. `ttys014`, or null if it has none. */
export async function ttyForPid(pid: number): Promise<string | null> {
    try {
        const { stdout } = await run("ps", ["-o", "tty=", "-p", String(pid)]);
        const tty = stdout.trim();
        return tty && tty !== "??" ? tty : null;
    } catch {
        return null;
    }
}

/**
 * The application that owns a process, by walking up to the last ancestor before launchd.
 *
 * A Claude session's parent is a shell, whose parent is the terminal emulator — so this is how a
 * session in Rider's embedded terminal is told apart from one in Terminal.app.
 */
export async function owningApp(pid: number): Promise<string | null> {
    // Walks to the LAST ancestor before launchd and returns its name. Reading `comm` of the
    // current process at each step instead returns the shell, because a session's own parent is
    // always a shell — the terminal emulator is further up.
    let current = pid;
    let owner: string | null = null;
    for (let i = 0; i < 12; i++) {
        let ppid: number;
        try {
            const { stdout } = await run("ps", ["-o", "ppid=", "-p", String(current)]);
            ppid = Number(stdout.trim());
        } catch {
            break;
        }
        if (!ppid || ppid === 1) break;
        try {
            const { stdout } = await run("ps", ["-o", "comm=", "-p", String(ppid)]);
            const name = stdout.trim().split("/").pop() ?? "";
            // Shells and multiplexers are hosts, not the owning application.
            if (name && !/^(-?zsh|-?bash|-?sh|-?fish|login|tmux.*|screen)$/.test(name)) owner = name;
        } catch {
            // Keep whatever we had.
        }
        current = ppid;
    }
    return owner;
}

async function osascript(script: string): Promise<string> {
    const { stdout } = await run("osascript", ["-e", script]);
    return stdout.trim();
}

/**
 * Finds the Terminal.app tab whose tty matches.
 *
 * `tty of tab` is a documented Terminal property and reports `/dev/ttysNNN`, which is exactly what
 * `ps` gives for the session's pid. That correspondence is what makes exact targeting possible at
 * all rather than a heuristic on window titles.
 */
export async function findTerminalTab(tty: string): Promise<{ windowIndex: number; tabIndex: number } | null> {
    const want = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    const script = `
tell application "Terminal"
    repeat with w from 1 to count of windows
        repeat with t from 1 to count of tabs of window w
            try
                if (tty of tab t of window w) is "${want}" then return (w as string) & "," & (t as string)
            end try
        end repeat
    end repeat
end tell
return ""`;
    try {
        const result = await osascript(script);
        if (!result) return null;
        const [w, t] = result.split(",").map(Number);
        return Number.isFinite(w) && Number.isFinite(t) ? { windowIndex: w, tabIndex: t } : null;
    } catch {
        return null;
    }
}

/** Raises a Rider window whose title mentions the project, since its tabs are not scriptable. */
export async function findAppWindow(app: string, projectHint: string): Promise<number | null> {
    const script = `
tell application "System Events"
    if not (exists process "${app}") then return ""
    tell process "${app}"
        repeat with i from 1 to count of windows
            if (name of window i) contains "${projectHint}" then return (i as string)
        end repeat
    end tell
end tell
return ""`;
    try {
        const result = await osascript(script);
        const index = Number(result);
        return Number.isFinite(index) && index > 0 ? index : null;
    } catch {
        return null;
    }
}

export interface SessionTarget {
    pid: number;
    cwd?: string;
}

/**
 * Works out where a session's input should go.
 *
 * Never falls back to "the frontmost window" on its own — an unidentified target means the text
 * would land wherever focus happens to be, which is how dictation ends up in a source file.
 */
export async function resolveTarget(session: SessionTarget): Promise<TypeTarget> {
    const tty = await ttyForPid(session.pid);
    if (!tty) return { kind: "none", description: `pid ${session.pid} has no terminal` };

    const tab = await findTerminalTab(tty);
    if (tab) {
        return {
            kind: "terminal-tab",
            description: `Terminal window ${tab.windowIndex} tab ${tab.tabIndex} (${tty})`,
            app: "Terminal",
            ...tab,
        };
    }

    const owner = await owningApp(session.pid);
    if (owner) {
        const project = (session.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
        const windowIndex = project ? await findAppWindow(owner, project) : null;
        if (windowIndex) {
            return {
                kind: "app-window",
                description: `${owner} window ${windowIndex} (${project}) — its focused terminal tab`,
                app: owner,
                windowIndex,
            };
        }
        return { kind: "app-window", description: `${owner} — its focused window`, app: owner };
    }

    return { kind: "none", description: `could not locate a window for pid ${session.pid}` };
}

/**
 * Focuses the target and types.
 *
 * `keystroke` rather than pasting: a paste would clobber the clipboard, and the point is to behave
 * as though the text were typed. Return is sent separately so `submit: false` can leave the line
 * in the prompt for review.
 */
export async function typeInto(target: TypeTarget, text: string, submit = true): Promise<boolean> {
    if (target.kind === "none" || !target.app) return false;
    // AppleScript string literals: backslashes first, or the escaping of quotes is itself escaped.
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    let focus = "";
    if (target.kind === "terminal-tab" && target.windowIndex && target.tabIndex) {
        focus = `
tell application "Terminal"
    activate
    set selected tab of window ${target.windowIndex} to tab ${target.tabIndex} of window ${target.windowIndex}
    set index of window ${target.windowIndex} to 1
end tell
delay 0.15`;
    } else {
        focus = `
tell application "${target.app}" to activate
delay 0.2`;
    }

    const script = `${focus}
tell application "System Events"
    keystroke "${escaped}"
    ${submit ? "delay 0.05\n    key code 36" : ""}
end tell`;
    try {
        await osascript(script);
        return true;
    } catch {
        return false;
    }
}
