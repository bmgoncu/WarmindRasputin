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

// Dev harness hook: lets tools/shoot.ts and ad-hoc checks read live orb state instead of
// inferring it from pixels. readPixels returns empty after frame present unless
// preserveDrawingBuffer is set, so pixel-sampling gives false negatives.
(window as unknown as { __orb: () => unknown }).__orb = () => orb.debug;
(window as unknown as { __freeze: () => void }).__freeze = () => orb.freeze();
(window as unknown as { __solo: () => void }).__solo = () => orb.solo();

const clock = new THREE.Clock();
function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;

    const target = simulate ? simulatedLevel(t) : Number(slider.value) / 100;
    orb.setLevel(target, dt);
    orb.update(dt, t);

    readout.textContent = orb.level.toFixed(2);
    composer.render();
    requestAnimationFrame(frame);
}
frame();
