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
const readout = document.getElementById("readout") as HTMLElement;
let simulate = false;

modeBtn.addEventListener("click", () => {
    simulate = !simulate;
    modeBtn.textContent = simulate ? "simulated speech" : "manual";
    slider.disabled = simulate;
});

/** Rough stand-in for a speech envelope: syllable-rate bursts with pauses between phrases. */
function simulatedLevel(t: number): number {
    const syllable = Math.max(0, Math.sin(t * 11) * 0.5 + 0.5) ** 1.6;
    const phrase = Math.max(0, Math.sin(t * 0.55) * 0.5 + 0.62);
    const gate = Math.sin(t * 0.21) > -0.3 ? 1 : 0;
    return Math.min(1, syllable * phrase * gate);
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

    readout.textContent = target.toFixed(2);
    composer.render();
    requestAnimationFrame(frame);
}
frame();
