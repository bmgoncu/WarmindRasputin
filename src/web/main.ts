/**
 * Dev harness for the orb.
 *
 * Runs standalone in Chrome with hot reload; the same renderer drops into the Tauri overlay in M4
 * without changes. Background is transparent because the overlay draws the orb only — the page
 * body supplies a dark backdrop here purely so it's visible during development.
 */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Orb } from "./orb/orb.js";
import { SpeechPlayer } from "./audio/feature-driver.js";
import { DaemonLink } from "./net/client.js";
import { DAEMON_PORT } from "../shared/protocol.js";
import { Subtitle } from "./ui/subtitle.js";
import { setupOverlay, inOverlay } from "./overlay.js";

const canvas = document.getElementById("orb") as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false, // no-op through EffectComposer anyway; MSAA is set on the render target
    powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
// ACES is what makes emissive values above 1.0 desaturate toward white at the hot core, which is
// how the reference's blue-white centre reads against the orange shell.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 5.6);

const orb = new Orb();
scene.add(orb.group);

const composer = new EffectComposer(
    renderer,
    // antialias: true on the renderer does nothing once we render through a composer.
    new THREE.WebGLRenderTarget(innerWidth, innerHeight, { samples: 4 }),
);
composer.addPass(new RenderPass(scene, camera));
// Threshold matters: the core is small but very bright, so only it and the lattice highlights
// should cross. Too low and the amber haze blooms too, washing the whole frame out.
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.9));
composer.addPass(new OutputPass());

addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
});

// --- drive ------------------------------------------------------------------------------
// Until M3 wires real audio features, a slider and a simulated speech envelope stand in.
const slider = document.getElementById("level") as HTMLInputElement;
const modeBtn = document.getElementById("mode") as HTMLButtonElement;
const floorBtn = document.getElementById("floor") as HTMLButtonElement;
const shake = document.getElementById("shake") as HTMLInputElement;
const shakeOut = document.getElementById("shakeout") as HTMLElement;
const reach = document.getElementById("reach") as HTMLInputElement;
const reachOut = document.getElementById("reachout") as HTMLElement;
const jolts = document.getElementById("jolts") as HTMLInputElement;
const joltsOut = document.getElementById("joltsout") as HTMLElement;
const arcs = document.getElementById("arcs") as HTMLInputElement;
const arcsOut = document.getElementById("arcsout") as HTMLElement;
const readout = document.getElementById("readout") as HTMLElement;
let simulate = false;

shake.addEventListener("input", () => {
    const k = Number(shake.value) / 100;
    orb.setShakeScale(k);
    shakeOut.textContent = `${k.toFixed(2)}x`;
});

arcs.addEventListener("input", () => {
    const n = Number(arcs.value);
    orb.setArcCount(n);
    arcsOut.textContent = String(n);
});

jolts.addEventListener("input", () => {
    const n = Number(jolts.value);
    orb.setJoltCount(n);
    joltsOut.textContent = String(n);
});

// How far the outer lattice reaches past the shell. Capped at 2.2: the camera sits at z=5.6 with
// a 45 degree fov, so the visible half-height is 2.32 and anything beyond that leaves the frame.
reach.addEventListener("input", () => {
    const r = Number(reach.value) / 100;
    orb.setOuterRadius(r);
    reachOut.textContent = r.toFixed(2);
});

// A/B the resting level: the orb idling at 0.22 against the same scene collapsing to dark.
const FLOOR = 0.22;
floorBtn.addEventListener("click", () => {
    orb.idleFloor = orb.idleFloor > 0 ? 0 : FLOOR;
    floorBtn.textContent = orb.idleFloor > 0 ? `floor ${FLOOR}` : "floor off";
});

modeBtn.addEventListener("click", () => {
    simulate = !simulate;
    modeBtn.textContent = simulate ? "simulated speech" : "manual";
    slider.disabled = simulate;
});

/**
 * Rough stand-in for a speech envelope: syllable-rate bursts grouped into phrases, with short
 * pauses between them.
 *
 * Timings are taken from speech rather than invented. English runs 4–7 syllables/s; phrases last
 * a couple of seconds and the gaps between them are under a second.
 *
 * The first version gated phrases with a 0.21 rad/s sine — a 30-second cycle that left an
 * ELEVEN-SECOND continuous silence, 22 dead seconds in every 60. Clicking into simulate mode
 * during one looked exactly like a broken button, and the idle floor hid it completely: at a
 * constant 0.22 a dead stretch is pixel-identical to manual idle, where before it at least went
 * dark. Its syllable rate was also 1.75 Hz, under half of speech.
 */
function simulatedLevel(t: number): number {
    // One phrase plus its trailing pause. Phrase length varies per cycle so repeated cycles don't
    // line up into a metronome, but every cycle speaks — there is no long dead window by design.
    const CYCLE = 3.2;
    const k = Math.floor(t / CYCLE);
    const local = t - k * CYCLE;
    const speak = 2.3 + 0.55 * Math.sin(k * 2.399);
    if (local > speak) return 0; // the pause between phrases, 0.35–1.45s

    // 4.5 Hz syllables, with an arc over the phrase so it doesn't start and stop abruptly and a
    // slower stress wave so some syllables land harder than others.
    const syllable = Math.max(0, Math.sin(t * 28.3)) ** 0.8;
    const arc = Math.sin(Math.PI * (local / speak)) ** 0.35;
    const stress = 0.6 + 0.4 * Math.sin(t * 3.1 + k);
    return Math.min(1, syllable * arc * stress * 1.25);
}

// --- daemon link ------------------------------------------------------------------------
/**
 * Where the daemon lives.
 *
 * Never derived from `location` in the overlay. Tauri serves the page from `tauri://localhost`, so
 * `location.hostname` is `tauri.localhost` — deriving from it produced
 * `ws://tauri.localhost:7331`, which the CSP's connect-src does not allow, and **a CSP-blocked
 * `new WebSocket()` throws synchronously**. That killed module execution at `link.connect()`,
 * which sits above the render loop: no orb, no overlay setup, no drag layer, all from one bad URL.
 */
const DAEMON_ORIGIN = inOverlay()
    ? `http://127.0.0.1:${DAEMON_PORT}`
    : location.port === String(DAEMON_PORT)
      ? location.origin
      : `http://${location.hostname || "127.0.0.1"}:${DAEMON_PORT}`;

const player = new SpeechPlayer();
const subtitle = new Subtitle();
const link = new DaemonLink(`${DAEMON_ORIGIN.replace(/^http/, "ws")}/ws`, inOverlay() ? "tauri-overlay" : "chrome-dev");
const textInput = document.getElementById("text") as HTMLInputElement;
const chainSel = document.getElementById("chain") as HTMLSelectElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const linkTag = document.getElementById("link") as HTMLElement;
const subBtn = document.getElementById("subs") as HTMLButtonElement;

link.onOpen = () => {
    linkTag.textContent = "daemon connected";
    linkTag.classList.add("on");
    linkTag.classList.remove("bad");
    sendBtn.disabled = false;
};
link.onClose = () => {
    // Naming the fix in the UI: without the daemon there is nothing to synthesise speech, and the
    // button previously just did nothing at all.
    linkTag.textContent = "daemon offline — run: npm run daemon";
    linkTag.classList.remove("on");
    linkTag.classList.add("bad");
    sendBtn.disabled = true;
};
/**
 * Names the narrated session beside the tray glyph.
 *
 * Overlay only — in Chrome there is no tray, and invoking would throw. A second session is shown
 * as a "+n" suffix rather than a list, because the menu bar has room for a word, not an inventory.
 */
function setTrayLabel(project: string | undefined, sessions: number): void {
    if (!inOverlay()) return;
    const extra = sessions > 1 ? ` +${sessions - 1}` : "";
    const text = project ? `${project}${extra}` : "";
    const bridge = (window as unknown as { __TAURI__?: { core?: { invoke: (c: string, a?: unknown) => Promise<unknown> } } }).__TAURI__;
    void bridge?.core?.invoke("set_tray_title", { text }).catch(() => undefined);
}

/**
 * Opaque black behind the orb instead of desktop show-through.
 *
 * The renderer clear colour has to change too, not just the CSS: the WebGL canvas is drawn with
 * alpha, so a page background alone still leaves the canvas itself see-through.
 */
function setOpaqueBackground(opaque: boolean): void {
    const colour = opaque ? "#000" : "transparent";
    document.documentElement.style.background = colour;
    document.body.style.background = opaque ? "#000" : inOverlay() ? "transparent" : "#0a0405";
    renderer.setClearColor(0x000000, opaque ? 1 : 0);
}

/** Mirrors daemon config into the dev harness controls so the two never disagree. */
function syncControls(cfg: { shakeScale?: number; outerRadius?: number; joltCount?: number; arcCount?: number }): void {
    if (cfg.shakeScale !== undefined) {
        shake.value = String(Math.round(cfg.shakeScale * 100));
        shakeOut.textContent = `${cfg.shakeScale.toFixed(2)}x`;
    }
    if (cfg.outerRadius !== undefined) {
        reach.value = String(Math.round(cfg.outerRadius * 100));
        reachOut.textContent = cfg.outerRadius.toFixed(2);
    }
    if (cfg.joltCount !== undefined) {
        jolts.value = String(cfg.joltCount);
        joltsOut.textContent = String(cfg.joltCount);
    }
    if (cfg.arcCount !== undefined) {
        arcs.value = String(cfg.arcCount);
        arcsOut.textContent = String(cfg.arcCount);
    }
}

link.onMessage = (msg) => {
    switch (msg.type) {
        case "speak":
            // sourceText over text: for og-warmind the Russian is what plays, but the English is
            // what means anything — same division of labour as the game's own subtitles.
            pendingSubtitle = msg.sourceText ?? msg.text;
            subtitle.setCues(pendingSubtitle);
            void player.play(msg, DAEMON_ORIGIN).catch((e) => {
                console.error("playback failed:", e);
                link.log("error", `playback failed: ${String(e)}`);
                // The subtitle is the fallback channel, not a decoration on top of working audio —
                // exactly as in the game, where the speech is unintelligible and the caption
                // carries the meaning. Silent speech must still be readable.
                subtitle.update(0);
            });
            break;
        case "stop":
            player.stop();
            subtitle.hide();
            break;
        case "pulse":
            orb.pulse(msg.strength);
            break;
        case "state":
            // M3 renders speech only; the rest of the state machine lands with the overlay.
            break;
        case "focus":
            setTrayLabel(msg.project, msg.sessions);
            break;
        case "config":
            if (msg.idleFloor !== undefined) orb.idleFloor = msg.idleFloor;
            if (msg.shakeScale !== undefined) orb.setShakeScale(msg.shakeScale);
            if (msg.outerRadius !== undefined) orb.setOuterRadius(msg.outerRadius);
            if (msg.joltCount !== undefined) orb.setJoltCount(msg.joltCount);
            if (msg.arcCount !== undefined) orb.setArcCount(msg.arcCount);
            if (msg.opaqueBackground !== undefined) setOpaqueBackground(msg.opaqueBackground);
            if (msg.subtitles !== undefined) {
                subtitle.setEnabled(msg.subtitles);
                subBtn.textContent = msg.subtitles ? "subs on" : "subs off";
            }
            if (msg.chain !== undefined) chainSel.value = msg.chain;
            // Keep the dev sliders in step, so the harness and preferences never disagree.
            syncControls(msg);
            break;
    }
};
// Subtitle timing follows PLAYBACK, not the speak message: on a cache miss the audio can be a
// second behind the message, and a subtitle appearing before any sound reads as broken.
let pendingSubtitle = "";
player.onPhase = (id, phase, ctxLatency) => {
    if (phase === "started") {
        subtitle.update(0);
        // Reported because an off-screen or unstyled subtitle looks identical to one that was
        // never asked to show, and the overlay has no devtools to check it in.
        const r = subtitle.rect;
        link.log("info", `subtitle styled=${subtitle.styled} enabled=${subtitle.isEnabled} rect=${r.width}x${r.height}@${r.top} vh=${innerHeight}`);
    }
    else subtitle.hideSoon();
    link.send({ type: "playback", id, phase, ctxLatency });
};
// Each speech onset launches a shockwave, so consonants read as impulses rather than only as level.
player.onOnset = (strength) => orb.pulse(0.45 + strength * 0.55);
player.onWarning = (message) => link.log("warn", message);
link.onOpen = ((prev) => () => {
    prev?.();
    // Adopt whatever the daemon already has, so a reloaded overlay is not reset to defaults.
    link.send({ type: "get-config" });
})(link.onOpen);
// The orb must survive a dead or unreachable daemon. Anything thrown here would otherwise abort
// the module before the render loop starts — which is exactly how a bad WebSocket URL produced a
// black window.
try {
    link.connect();
} catch (err) {
    console.error("daemon link failed to start:", err);
}

// The overlay has no reachable devtools in a release build, so uncaught failures would otherwise
// be entirely invisible — the window just stops doing things.
addEventListener("error", (e) => link.log("error", `${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener("unhandledrejection", (e) => link.log("error", `unhandled rejection: ${String(e.reason)}`));

function submit(): void {
    const text = textInput.value.trim();
    if (!text) return;
    // Any click or keypress counts as the gesture that unlocks audio; without one the context
    // stays suspended, currentTime never advances, and the orb ignores speech entirely.
    void player.unlock();
    // Only clear on a send that actually left. Clearing unconditionally threw the user's text
    // away while the daemon was down, so the failure destroyed input as well as being invisible.
    if (link.send({ type: "say", text, chain: chainSel.value })) {
        textInput.value = "";
    } else {
        linkTag.textContent = "daemon offline — run: npm run daemon";
        linkTag.classList.add("bad");
    }
}
sendBtn.addEventListener("click", submit);
subBtn.addEventListener("click", () => {
    subtitle.setEnabled(!subtitle.isEnabled);
    subBtn.textContent = subtitle.isEnabled ? "subs on" : "subs off";
});
textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
});

// Dev harness hook: lets tools/shoot.ts and ad-hoc checks read live orb state instead of
// inferring it from pixels. readPixels returns empty after frame present unless
// preserveDrawingBuffer is set, so pixel-sampling gives false negatives.
// Overlay presentation. Harmless no-op in Chrome, where the dev controls stay visible.
const overlayActive = setupOverlay([
    document.getElementById("ui") as HTMLElement,
    document.getElementById("say") as HTMLElement,
]);
if (overlayActive) console.log("running as overlay — Cmd+Shift+R toggles interactivity");

(window as unknown as { __orb: () => unknown }).__orb = () => orb.debug;
(window as unknown as { __freeze: () => void }).__freeze = () => orb.freeze();
(window as unknown as { __solo: () => void }).__solo = () => orb.solo();
(window as unknown as { __speech: () => unknown }).__speech = () => ({
    connected: link.connected,
    unlocked: player.unlocked,
    speaking: player.speaking,
    level: player.sample(),
    progress: player.progress,
    text: player.currentText,
    overlay: inOverlay(),
    subtitle: subtitle.text,
    subsEnabled: subtitle.isEnabled,
    cues: subtitle.state,
});

const clock = new THREE.Clock();
function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    // Real speech outranks both stand-ins whenever it is playing.
    const spoken = player.sample();
    const target = spoken ?? (simulate ? simulatedLevel(t) : Number(slider.value) / 100);
    orb.setLevel(target, dt);
    orb.update(dt, t);

    // Cues advance against playback progress, not a timer — see Subtitle.update.
    if (player.speaking) subtitle.update(player.progress);

    readout.textContent = orb.level.toFixed(2);
    composer.render();
    requestAnimationFrame(frame);
}
frame();
