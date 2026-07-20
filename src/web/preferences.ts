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
        | "opaqueBackground" | "subtitles" | "chain" | "narrateSubagents" | "speechDetail" | "dictateMode" | "dictateSubmit" | "persona"
        | "ambientVolume" | "effectsVolume" | "bgDuckVolume" | "questionSound"
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
    speechDetail: "full",
    persona: false,
    ambientVolume: 0.35,
    effectsVolume: 0.5,
    bgDuckVolume: 0.3,
    questionSound: true,
    dictateMode: "agent",
    dictateSubmit: true,
};

/**
 * What the Test voice button says.
 *
 * The first line is the character check — long enough to hear the degradation and the ballistics.
 * The three that follow are queued behind it deliberately: they exercise the two things that were
 * broken and are easy to regress. Utterances must follow one another rather than cutting each
 * other off, and the subtitle must track whichever is CURRENTLY being spoken rather than the last
 * one to arrive. Distinct, ordered words make both audible and visible at a glance.
 */
const TEST_LINES = [
    "I am Rasputin, the Warmind! At your service!",
    "Alpha one, the first utterance.",
    "Bravo two, the second utterance.",
    "Charlie three, the third utterance.",
];

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
    for (const [id, key, fmt] of [
        ["ambient", "ambientVolume", 2],
        ["effects", "effectsVolume", 2],
        ["duck", "bgDuckVolume", 2],
    ] as const) {
        const v = cfg[key];
        if (v === undefined) continue;
        $<HTMLInputElement>(id).value = String(Math.round(v * 100));
        $(`${id}v`).textContent = v.toFixed(fmt);
    }
    if (cfg.questionSound !== undefined) $<HTMLInputElement>("questionsound").checked = cfg.questionSound;
    if (cfg.persona !== undefined) $<HTMLInputElement>("persona").checked = cfg.persona;
    if (cfg.dictateMode !== undefined) $<HTMLSelectElement>("dictate").value = cfg.dictateMode;
    if (cfg.dictateSubmit !== undefined) $<HTMLInputElement>("dictatesubmit").checked = cfg.dictateSubmit;
    if (cfg.speechDetail !== undefined) $<HTMLSelectElement>("detail").value = cfg.speechDetail;
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
for (const [id, key] of [
    ["ambient", "ambientVolume"],
    ["effects", "effectsVolume"],
    ["duck", "bgDuckVolume"],
] as const) {
    $<HTMLInputElement>(id).addEventListener("input", (e) => {
        const v = Number((e.target as HTMLInputElement).value) / 100;
        $(`${id}v`).textContent = v.toFixed(2);
        push({ [key]: v });
    });
}
$<HTMLInputElement>("questionsound").addEventListener("change", (e) =>
    push({ questionSound: (e.target as HTMLInputElement).checked }),
);
$<HTMLInputElement>("persona").addEventListener("change", (e) =>
    push({ persona: (e.target as HTMLInputElement).checked }),
);
$<HTMLSelectElement>("dictate").addEventListener("change", (e) =>
    push({ dictateMode: (e.target as HTMLSelectElement).value as "agent" | "type" }),
);
$<HTMLInputElement>("dictatesubmit").addEventListener("change", (e) =>
    push({ dictateSubmit: (e.target as HTMLInputElement).checked }),
);
$<HTMLSelectElement>("detail").addEventListener("change", (e) =>
    push({ speechDetail: (e.target as HTMLSelectElement).value as "brief" | "full" }),
);
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
    // Sent as separate utterances rather than one long line: queueing is the behaviour under test,
    // and a single message would never exercise it.
    let sent = true;
    for (const line of TEST_LINES) {
        if (!link.send({ type: "say", text: line, chain: el.chain.value })) sent = false;
    }
    if (!sent) {
        el.testHint.textContent = "daemon offline";
        return;
    }
    const slow = el.chain.value === "og-warmind";
    el.testHint.textContent = slow
        ? "translating four lines, first time is slow…"
        : "speaking four lines — each should finish before the next begins";
    el.test.disabled = true;
    // No completion signal reaches this window — playback is reported by the renderer that owns
    // the audio, not by this one — so the button re-arms on a timer rather than pretending to know.
    window.setTimeout(
        () => {
            el.test.disabled = false;
            el.testHint.textContent = "";
        },
        slow ? 22000 : 14000,
    );
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

/**
 * Enables or disables everything that only means something while narration is on.
 *
 * Leaving them live was misleading: picking a session and setting automatic mode look like they
 * are doing something, and they are — but nothing is spoken, because the master switch is off.
 * That produced two rounds of "it did not speak" against controls that were working correctly.
 */
function setNarrationDependentsEnabled(on: boolean): void {
    autoFollow.disabled = !on;
    focusSel.disabled = !on || autoFollow.checked;
    $<HTMLInputElement>("subagents").disabled = !on;
    for (const id of ["focushint"]) {
        $(id).style.opacity = on ? "1" : "0.45";
    }
}

function showHook(state: HookState): void {
    narrate.checked = state.installed;
    narrate.disabled = false;
    narrateHint.textContent = state.installed
        ? `On. Every Claude session reports to ${state.endpoint}. Edits ${state.settingsPath}.`
        : `OFF — nothing is spoken. Turn this on to narrate sessions; it adds an async hook to ${state.settingsPath}, backs your settings up first, and leaves other hooks alone.`;
    narrateHint.style.color = state.installed ? "" : "#ff9a6a";
    setNarrationDependentsEnabled(state.installed);
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
    let data: { pinned: string | null; enabled: boolean; sessions: LiveSession[] };
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
    focusSel.disabled = wanted === "" || !data.enabled;
    autoFollow.disabled = !data.enabled;
    $<HTMLInputElement>("subagents").disabled = !data.enabled;
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
    focusHint.textContent = !data.enabled
        ? `${data.sessions.length} sessions live, but narration is off — turn on "Narrate Claude sessions" above.`
        : wanted
          ? "Only this session is narrated. Others are ignored until you change this."
          : `Narrates whichever session was most recently active — ${data.sessions.length} live. Shown as "Auto <session>" beside the tray icon.`;
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
