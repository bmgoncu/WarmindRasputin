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
import { DAEMON_PORT, type OrbConfig } from "../shared/protocol.js";

const DAEMON_ORIGIN =
    location.port === String(DAEMON_PORT)
        ? location.origin
        : `http://${location.hostname || "127.0.0.1"}:${DAEMON_PORT}`;

const DEFAULTS: Required<Pick<OrbConfig, "idleFloor" | "shakeScale" | "outerRadius" | "joltCount" | "arcCount" | "opaqueBackground" | "subtitles" | "chain">> = {
    idleFloor: 0.22,
    shakeScale: 1,
    outerRadius: 1.78,
    joltCount: 5,
    arcCount: 3,
    opaqueBackground: false,
    subtitles: true,
    chain: "measured",
};

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
link.connect();

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
el.reset.addEventListener("click", () => push({ ...DEFAULTS }));

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
