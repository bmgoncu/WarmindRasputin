/**
 * The preferences window.
 *
 * Sends every change to the daemon, which persists it and rebroadcasts to all renderers — so the
 * overlay follows immediately, a second preferences window cannot drift, and settings survive a
 * reload of either. Window-to-window Tauri events would have done none of those, and would not
 * work in Chrome during development.
 *
 * Overlay geometry is the exception: position and size belong to the native window, so those go
 * through Tauri commands directly and are simply absent in a browser.
 */

import { DaemonLink } from "./net/client.js";
import { inOverlay } from "./overlay.js";
import { DAEMON_PORT, type OrbConfig } from "../shared/protocol.js";

/**
 * Never derived from `location` in the app: Tauri serves from `tauri://localhost`, so
 * `location.hostname` is `tauri.localhost`, and the resulting `ws://tauri.localhost:7331` is both
 * unresolvable and blocked by the CSP — which throws synchronously out of `new WebSocket`.
 */
const DAEMON_ORIGIN = inOverlay()
    ? `http://127.0.0.1:${DAEMON_PORT}`
    : location.port === String(DAEMON_PORT)
      ? location.origin
      : `http://${location.hostname || "127.0.0.1"}:${DAEMON_PORT}`;

const DEFAULTS: Required<
    Pick<
        OrbConfig,
        | "idleFloor" | "shakeScale" | "outerRadius" | "joltCount" | "arcCount"
        | "opaqueBackground" | "subtitles" | "chain" | "narrateSubagents"
    >
> = {
    idleFloor: 0.22,
    shakeScale: 1,
    outerRadius: 1.78,
    joltCount: 5,
    arcCount: 3,
    opaqueBackground: false,
    subtitles: true,
    chain: "measured",
    narrateSubagents: false,
};

/** Fixed line for the Test voice button — long enough to hear the degradation and the ballistics,
 *  short enough to re-trigger while dragging a slider. */
const TEST_LINE = "I am Rasputin, the Warmind! At your service!";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
    opaque: $<HTMLInputElement>("opaque"),
    subs: $<HTMLInputElement>("subs"),
    moveMode: $<HTMLInputElement>("movemode"),
    center: $<HTMLButtonElement>("center"),
    bounds: $<HTMLElement>("bounds"),
    chain: $<HTMLSelectElement>("chain"),
    floor: $<HTMLInputElement>("floor"),
    shake: $<HTMLInputElement>("shake"),
    reach: $<HTMLInputElement>("reach"),
    jolts: $<HTMLInputElement>("jolts"),
    arcs: $<HTMLInputElement>("arcs"),
    reset: $<HTMLButtonElement>("reset"),
    test: $<HTMLButtonElement>("test"),
    testHint: $<HTMLElement>("testhint"),
    status: $<HTMLElement>("status"),
};

const link = new DaemonLink(`${DAEMON_ORIGIN.replace(/^http/, "ws")}/ws`, "preferences");

/** Suppresses the echo: applying a broadcast must not re-send it as a change. */
let applying = false;

function push(patch: OrbConfig): void {
    if (applying) return;
    if (!link.send({ type: "set-config", ...patch })) {
        el.status.textContent = "daemon offline — run: npm run daemon";
        el.status.classList.add("bad");
    }
}

function render(cfg: OrbConfig): void {
    applying = true;
    if (cfg.idleFloor !== undefined) {
        el.floor.value = String(Math.round(cfg.idleFloor * 100));
        $("floorv").textContent = cfg.idleFloor.toFixed(2);
    }
    if (cfg.shakeScale !== undefined) {
        el.shake.value = String(Math.round(cfg.shakeScale * 100));
        $("shakev").textContent = `${cfg.shakeScale.toFixed(2)}x`;
    }
    if (cfg.outerRadius !== undefined) {
        el.reach.value = String(Math.round(cfg.outerRadius * 100));
        $("reachv").textContent = cfg.outerRadius.toFixed(2);
    }
    if (cfg.joltCount !== undefined) {
        el.jolts.value = String(cfg.joltCount);
        $("joltsv").textContent = String(cfg.joltCount);
    }
    if (cfg.arcCount !== undefined) {
        el.arcs.value = String(cfg.arcCount);
        $("arcsv").textContent = String(cfg.arcCount);
    }
    if (cfg.opaqueBackground !== undefined) el.opaque.checked = cfg.opaqueBackground;
    if (cfg.subtitles !== undefined) el.subs.checked = cfg.subtitles;
    if (cfg.chain !== undefined) el.chain.value = cfg.chain;
    if (cfg.narrateSubagents !== undefined) $<HTMLInputElement>("subagents").checked = cfg.narrateSubagents;
    applying = false;
}

link.onOpen = () => {
    el.status.textContent = "connected";
    el.status.classList.remove("bad");
    link.send({ type: "get-config" });
};
link.onClose = () => {
    el.status.textContent = "daemon offline — run: npm run daemon";
    el.status.classList.add("bad");
};
link.onMessage = (msg) => {
    if (msg.type === "config") render(msg);
};
// Show the defaults immediately. Until the daemon answers `get-config` the controls would
// otherwise sit at the midpoint of their range with blank readouts, which reads as broken.
render(DEFAULTS);
try {
    link.connect();
} catch (err) {
    console.error("daemon link failed to start:", err);
    el.status.textContent = "daemon offline — run: npm run daemon";
    el.status.classList.add("bad");
}

// --- wiring ------------------------------------------------------------------------------
// `input` rather than `change`, so dragging a slider updates the orb live — the whole reason these
// were sliders during tuning.
el.floor.addEventListener("input", () => push({ idleFloor: Number(el.floor.value) / 100 }));
el.shake.addEventListener("input", () => push({ shakeScale: Number(el.shake.value) / 100 }));
el.reach.addEventListener("input", () => push({ outerRadius: Number(el.reach.value) / 100 }));
el.jolts.addEventListener("input", () => push({ joltCount: Number(el.jolts.value) }));
el.arcs.addEventListener("input", () => push({ arcCount: Number(el.arcs.value) }));
el.opaque.addEventListener("change", () => push({ opaqueBackground: el.opaque.checked }));
el.subs.addEventListener("change", () => push({ subtitles: el.subs.checked }));
el.chain.addEventListener("change", () => push({ chain: el.chain.value }));
$<HTMLInputElement>("subagents").addEventListener("change", (e) =>
    push({ narrateSubagents: (e.target as HTMLInputElement).checked }),
);
el.reset.addEventListener("click", () => push({ ...DEFAULTS }));

/**
 * Speaks a fixed line through the mode currently selected here.
 *
 * Sends the chain explicitly rather than relying on the daemon's default, so the dropdown can be
 * auditioned without committing to it — and so a change made a moment ago is definitely the one
 * being heard rather than whatever the daemon last persisted.
 */
el.test.addEventListener("click", () => {
    const sent = link.send({ type: "say", text: TEST_LINE, chain: el.chain.value });
    if (!sent) {
        el.testHint.textContent = "daemon offline";
        return;
    }
    el.testHint.textContent =
        el.chain.value === "og-warmind" ? "translating, first time is slow…" : "speaking…";
    el.test.disabled = true;
    // No completion signal reaches this window — playback is reported by the renderer that owns
    // the audio, not by this one — so the button re-arms on a timer rather than pretending to know.
    window.setTimeout(() => {
        el.test.disabled = false;
        el.testHint.textContent = "";
    }, el.chain.value === "og-warmind" ? 5000 : 2600);
});

// --- native window geometry ---------------------------------------------------------------
interface TauriBridge {
    core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}
const tauri = (): TauriBridge | null => (window as unknown as { __TAURI__?: TauriBridge }).__TAURI__ ?? null;

async function refreshBounds(): Promise<void> {
    const bridge = tauri();
    if (!bridge?.core) {
        el.bounds.textContent = "position controls need the overlay app";
        el.moveMode.disabled = true;
        el.center.disabled = true;
        return;
    }
    try {
        const b = (await bridge.core.invoke("get_overlay_bounds")) as { x: number; y: number; width: number; height: number };
        el.bounds.textContent = `${b.width}×${b.height} at ${b.x}, ${b.y}`;
    } catch {
        el.bounds.textContent = "";
    }
}

// --- session narration ---------------------------------------------------------------------
// Over HTTP rather than the socket: this is a request with an answer, and the answer (what
// changed, where the backup went) belongs to the caller rather than to every connected window.
const narrate = $<HTMLInputElement>("narrate");
const narrateHint = $<HTMLElement>("narratehint");

interface HookState {
    installed: boolean;
    settingsPath: string;
    endpoint: string;
    events: string[];
    changed?: boolean;
    backup?: string;
}

function showHook(state: HookState): void {
    narrate.checked = state.installed;
    narrate.disabled = false;
    narrateHint.textContent = state.installed
        ? `On. Every Claude session reports to ${state.endpoint}. Edits ${state.settingsPath}.`
        : `Off. Turning this on adds an async hook to ${state.settingsPath} so sessions report to Rasputin. Your settings are backed up first, and other hooks are left alone.`;
}

async function refreshHook(): Promise<void> {
    try {
        showHook((await (await fetch(`${DAEMON_ORIGIN}/hook`)).json()) as HookState);
    } catch {
        narrate.disabled = true;
        narrateHint.textContent = "daemon offline — cannot read hook status";
    }
}

narrate.addEventListener("change", async () => {
    const wanted = narrate.checked;
    narrate.disabled = true;
    narrateHint.textContent = wanted ? "installing…" : "removing…";
    try {
        const res = await fetch(`${DAEMON_ORIGIN}/hook`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: wanted }),
        });
        const state = (await res.json()) as HookState;
        showHook(state);
        if (state.changed && state.backup) {
            narrateHint.textContent += ` Backup: ${state.backup.split("/").pop()}`;
        }
        // Only NEW sessions read settings at startup, so saying nothing here would look like a
        // no-op to anyone with a session already open.
        if (state.changed) narrateHint.textContent += " Takes effect in new Claude sessions.";
    } catch (err) {
        narrateHint.textContent = `failed: ${String(err)}`;
        void refreshHook();
    }
});
void refreshHook();

// --- which session to listen to ------------------------------------------------------------
const focusSel = $<HTMLSelectElement>("focus");
const focusHint = $<HTMLElement>("focushint");
const autoFollow = $<HTMLInputElement>("auto");

interface LiveSession {
    sessionId: string;
    cwd?: string;
    project?: string;
    /** Registry session name. Without it, eleven sessions in one project are indistinguishable. */
    name?: string;
    status: string;
    pid: number;
}

/**
 * Rebuilds the session list.
 *
 * Rebuilt wholesale rather than diffed, but only when the set actually changed — replacing the
 * options every second would close the dropdown under the user's cursor mid-click.
 */
let lastSessionKey = "";
async function refreshSessions(): Promise<void> {
    let data: { pinned: string | null; sessions: LiveSession[] };
    try {
        data = await (await fetch(`${DAEMON_ORIGIN}/sessions`)).json();
    } catch {
        focusSel.disabled = true;
        focusHint.textContent = "daemon offline";
        return;
    }
    focusSel.disabled = false;

    const key = JSON.stringify([data.pinned, data.sessions.map((s) => [s.sessionId, s.status, s.name])]);
    if (key === lastSessionKey) return;
    lastSessionKey = key;

    const wanted = data.pinned ?? "";
    autoFollow.checked = wanted === "";
    // Disabled rather than hidden when automatic: the list is still worth seeing, and a control
    // that vanishes is harder to find again than one that is greyed.
    focusSel.disabled = wanted === "";
    focusSel.innerHTML = "";

    for (const s of data.sessions) {
        const opt = document.createElement("option");
        opt.value = s.sessionId;
        const project = s.project ?? s.cwd ?? "unknown";
        const name = s.name ?? s.sessionId.slice(0, 8);
        opt.textContent = `${project} — ${name} — ${s.status}`;
        focusSel.appendChild(opt);
    }
    // A pinned session that is no longer running still needs an entry, or the dropdown would
    // silently snap back to automatic and misrepresent what the daemon is doing.
    if (wanted && !data.sessions.some((s) => s.sessionId === wanted)) {
        const opt = document.createElement("option");
        opt.value = wanted;
        opt.textContent = `${wanted.slice(0, 8)} — not running`;
        focusSel.appendChild(opt);
    }
    focusSel.value = wanted || (data.sessions[0]?.sessionId ?? "");
    focusHint.textContent = wanted
        ? "Only this session is narrated. Others are ignored until you change this."
        : `Narrates whichever session was most recently active — ${data.sessions.length} live. Shown as "Auto <project>" beside the tray icon.`;
}

focusSel.addEventListener("change", () => {
    if (autoFollow.checked) return;
    push({ focusSessionId: focusSel.value || null });
    lastSessionKey = "";
    void refreshSessions();
});

autoFollow.addEventListener("change", () => {
    // Leaving automatic pins whatever is selected in the list, so the switch never lands in a
    // state with no session chosen.
    push({ focusSessionId: autoFollow.checked ? null : focusSel.value || null });
    lastSessionKey = "";
    void refreshSessions();
});
void refreshSessions();
setInterval(() => void refreshSessions(), 2000);

const autostart = $<HTMLInputElement>("autostart");
async function refreshAutostart(): Promise<void> {
    const bridge = tauri();
    if (!bridge?.core) {
        autostart.disabled = true;
        return;
    }
    try {
        autostart.checked = (await bridge.core.invoke("get_autostart")) === true;
    } catch {
        autostart.disabled = true;
    }
}
autostart.addEventListener("change", () => {
    void tauri()?.core?.invoke("set_autostart", { enabled: autostart.checked }).catch(() => refreshAutostart());
});
void refreshAutostart();

el.moveMode.addEventListener("change", () => {
    void tauri()?.core?.invoke("set_move_mode", { enabled: el.moveMode.checked });
});
el.center.addEventListener("click", async () => {
    await tauri()?.core?.invoke("center_overlay");
    await refreshBounds();
});
void refreshBounds();
// Cheap poll: the window can be dragged while this panel is open, and there is no move event to
// subscribe to from another webview.
setInterval(() => void refreshBounds(), 1000);
