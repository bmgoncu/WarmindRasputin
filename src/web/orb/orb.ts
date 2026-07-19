/**
 * The Rasputin orb.
 *
 * Layer stack, matching the reference image the user marked up:
 *   1. core          white-hot centre with radiating spikes
 *   2. inner graph   dense node network close around the core
 *   3. glass shell   translucent amber sphere, barely-there boundary
 *   4. outer graph   sparse node network extending well beyond the shell
 *   5. streaks       elongated embers
 *
 * Decisions taken from the reference rather than invented:
 *   - The networks are GRAPHS (nodes + reforming proximity edges), not fixed meshes.
 *   - The silhouette is a rounded diamond — a superellipsoid, not a sphere.
 *   - Motion is SLOW. Frames 1/15 s apart are near-identical; 1/3 s apart show clear change.
 *   - Amplitude drives a colour-temperature ramp, not scale.
 */

import * as THREE from "three";
import { NodeGraph, type Pulse } from "./graph.js";

const COL_IDLE = new THREE.Color(0xff5410);
const COL_MID = new THREE.Color(0xff8a30);
const COL_HOT = new THREE.Color(0xffa53a);

export class Orb {
    readonly group = new THREE.Group();

    private readonly inner: NodeGraph;
    private readonly outer: NodeGraph;
    private readonly core: THREE.Mesh;
    private readonly shell: THREE.Mesh;
    private readonly haze: THREE.Mesh;
    private readonly rays!: THREE.LineSegments;
    private readonly streaks: THREE.LineSegments;
    private readonly streakSeed: Float32Array;

    /** In-flight shockwaves. Launched irregularly — see update(). */
    private readonly pulses: Pulse[] = [];
    private nextPulse = 0.6;
    private frozen = false;

    private level = 0;
    private readonly warm = new THREE.Color();

    constructor() {
        // --- core -----------------------------------------------------------------------
        this.core = new THREE.Mesh(
            new THREE.PlaneGeometry(0.8, 0.8),
            new THREE.ShaderMaterial({
                uniforms: { uLevel: { value: 0 }, uTime: { value: 0 } },
                vertexShader: /* glsl */ `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: /* glsl */ `
                    uniform float uLevel;
                    varying vec2 vUv;
                    void main() {
                        float d = length(vUv - 0.5) * 2.0;
                        // Two gaussians: a tight hot core and a wide soft halo. Gaussian rather
                        // than smoothstep because it never reaches zero abruptly — there is no
                        // edge to see at any exposure.
                        float core = exp(-d * d * 30.0);
                        float halo = exp(-d * d * 6.0);
                        float f = core * 1.35 + halo * 0.5;
                        vec3 c = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.97, 0.90), uLevel);
                        gl_FragColor = vec4(c * (1.5 + 3.0 * uLevel) * f, 1.0);
                    }
                `,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        );

        // --- glass shell ----------------------------------------------------------------
        // Minimal and very transparent by request: enough fresnel rim to read as a surface,
        // with the networks left to dominate. No environment map — on a transparent overlay a
        // real reflection would have nothing to reflect.
        this.shell = new THREE.Mesh(
            new THREE.SphereGeometry(1.0, 64, 64),
            new THREE.ShaderMaterial({
                uniforms: { uLevel: { value: 0 }, uColor: { value: COL_MID.clone() } },
                vertexShader: /* glsl */ `
                    varying vec3 vN; varying vec3 vView;
                    void main() {
                        vN = normalize(normalMatrix * normal);
                        vec4 mv = modelViewMatrix * vec4(position, 1.0);
                        vView = normalize(-mv.xyz);
                        gl_Position = projectionMatrix * mv;
                    }
                `,
                fragmentShader: /* glsl */ `
                    uniform float uLevel; uniform vec3 uColor;
                    varying vec3 vN; varying vec3 vView;
                    void main() {
                        float ndv = abs(dot(normalize(vN), normalize(vView)));
                        // Fresnel: nearly invisible face-on, bright at grazing angles. This is
                        // what reads as glass without any reflection to sample.
                        float rim = pow(1.0 - ndv, 5.5);
                        float body = pow(ndv, 3.4) * 0.05;
                        gl_FragColor = vec4(uColor * (rim * (0.5 + uLevel * 0.45) + body), 1.0);
                    }
                `,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.FrontSide,
            }),
        );

        // --- interior haze --------------------------------------------------------------
        this.haze = new THREE.Mesh(
            new THREE.SphereGeometry(0.94, 32, 32),
            new THREE.ShaderMaterial({
                uniforms: { uLevel: { value: 0 }, uColor: { value: COL_MID.clone() } },
                vertexShader: /* glsl */ `
                    varying vec3 vN; varying vec3 vView;
                    void main() {
                        vN = normalize(normalMatrix * normal);
                        vec4 mv = modelViewMatrix * vec4(position, 1.0);
                        vView = normalize(-mv.xyz);
                        gl_Position = projectionMatrix * mv;
                    }
                `,
                fragmentShader: /* glsl */ `
                    uniform float uLevel; uniform vec3 uColor;
                    varying vec3 vN; varying vec3 vView;
                    void main() {
                        float ndv = abs(dot(normalize(vN), normalize(vView)));
                        gl_FragColor = vec4(uColor * pow(ndv, 2.8) * (0.07 + 0.3 * uLevel), 1.0);
                    }
                `,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.BackSide,
            }),
        );

        // --- graphs ---------------------------------------------------------------------
        // Inner: dense, tight around the core, faster churn.
        this.inner = new NodeGraph({
            nodeCount: 150,
            radius: 0.72,
            shape: 1.2,
            drift: 0.09,
            driftSpeed: 0.35,
            maxEdgeDist: 0.42,
            maxDegree: 5,
            rebuildInterval: 0.9,
            spin: 0.075,
            centreBoost: 2.2,
            gradientRadius: 0.72,
            volumeFill: 0.9,
            worldRadius: 1.6,
            pushScale: 0.05,
            joltInterval: 0,
            maxJolts: 0,
            speechJitter: 0.022,
            colour: 0xffb070,
            seed: 4242,
        });

        // Outer: sparse, extends well past the shell, slower and more diamond-shaped.
        this.outer = new NodeGraph({
            nodeCount: 260,
            radius: 1.45,
            shape: 1.05,
            drift: 0.035,
            driftSpeed: 0.18,
            // 0.30 ≈ nearest-neighbour spacing. At the previous 0.50 each node reached past its
            // neighbours to 2nd and 3rd ones, so edges crossed and the shell read as debris.
            maxEdgeDist: 0.3,
            maxDegree: 6,
            rebuildInterval: 1.8,
            spin: -0.045,
            centreBoost: 0.5,
            gradientRadius: 1.45,
            // Given radial THICKNESS on purpose. At 0.04 this was a one-node-thick shell, so a
            // radial wave lit every node at the same instant — the pingpong. With depth, the
            // front sweeps through it over time.
            volumeFill: 0.32,
            worldRadius: 1.6,
            // Outer shell takes the visible push; the inner volume moves less.
            pushScale: 0.13,
            // Electric jolts walk the outer shell only.
            joltInterval: 1.6,
            maxJolts: 3,
            speechJitter: 0.034,
            colour: 0xff5f26,
            seed: 90210,
        });

        // --- core rays ------------------------------------------------------------------
        // The reference core is not a ball — it throws radiating spikes. Built from line
        // segments starting just off centre so they read as rays rather than as a starburst
        // glyph pinned to the middle.
        {
            const RAYS = 12;
            const rv = new Float32Array(RAYS * 6);
            for (let i = 0; i < RAYS; i++) {
                const th = Math.random() * Math.PI * 2;
                const ph = Math.acos(2 * Math.random() - 1);
                const dx = Math.sin(ph) * Math.cos(th);
                const dy = Math.cos(ph);
                const dz = Math.sin(ph) * Math.sin(th);
                const inner = 0.04;
                const outer = 0.1 + Math.random() * 0.16;
                rv[i * 6 + 0] = dx * inner; rv[i * 6 + 1] = dy * inner; rv[i * 6 + 2] = dz * inner;
                rv[i * 6 + 3] = dx * outer; rv[i * 6 + 4] = dy * outer; rv[i * 6 + 5] = dz * outer;
            }
            const rg = new THREE.BufferGeometry();
            rg.setAttribute("position", new THREE.BufferAttribute(rv, 3));
            this.rays = new THREE.LineSegments(
                rg,
                new THREE.LineBasicMaterial({
                    color: 0xfff2dc,
                    transparent: true,
                    opacity: 0.22,
                    blending: THREE.AdditiveBlending,
                    depthTest: false,
                    depthWrite: false,
                }),
            );
        }

        // --- streaks --------------------------------------------------------------------
        const COUNT = 150;
        this.streakSeed = new Float32Array(COUNT * 4);
        for (let i = 0; i < COUNT; i++) {
            this.streakSeed[i * 4 + 0] = Math.random() * Math.PI * 2;
            this.streakSeed[i * 4 + 1] = Math.acos(2 * Math.random() - 1);
            this.streakSeed[i * 4 + 2] = 0.3 + Math.random() * 1.4;
            this.streakSeed[i * 4 + 3] = 0.3 + Math.random() * 1.5;
        }
        const sGeom = new THREE.BufferGeometry();
        sGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(COUNT * 6), 3));
        this.streaks = new THREE.LineSegments(
            sGeom,
            new THREE.LineBasicMaterial({
                color: 0xffc890,
                transparent: true,
                opacity: 0.7,
                blending: THREE.AdditiveBlending,
                depthTest: false,
                depthWrite: false,
            }),
        );

        this.group.add(this.haze, this.core, this.rays, this.inner.group, this.shell, this.outer.group, this.streaks);
    }

    /** Live state for the dev harness. */
    /** Dev only — draws only the jolt segments, against black. See NodeGraph.solo. */
    solo(): void {
        this.freeze();
        this.core.visible = false;
        this.shell.visible = false;
        this.haze.visible = false;
        this.rays.visible = false;
        this.streaks.visible = false;
        this.inner.solo();
        this.outer.solo();
    }

    /** Dev only — see NodeGraph.freeze. Also stops pulses, leaving jolts as the only motion. */
    freeze(): void {
        this.inner.freeze();
        this.outer.freeze();
        this.frozen = true;
        this.pulses.length = 0;
    }

    get debug(): Record<string, unknown> {
        return { inner: this.inner.debug, outer: this.outer.debug, pulses: this.pulses.length, level: this.level, idleFloor: this.idleFloor };
    }

    /**
     * Resting level the orb never falls below. 0 lets it collapse to dark.
     *
     * At a dead 0 the orb reads as switched off — the centre gradient has nothing to grade and
     * the lattice goes nearly invisible, so idle looks like a fault rather than like a machine
     * waiting. 0.22 is the level where both are legible while still sitting clearly below speech.
     */
    idleFloor = 0.22;

    /** VU ballistics — fast attack, slow release, frame-rate independent. */
    setLevel(target: number, dt: number): void {
        target = Math.max(target, this.idleFloor);
        const tau = (target > this.level ? 30 : 220) / 1000;
        this.level += (target - this.level) * (1 - Math.exp(-dt / tau));
    }

    update(dt: number, t: number): void {
        const L = this.level;
        this.updatePulses(dt, L);

        this.warm.copy(COL_IDLE).lerp(COL_MID, Math.min(1, L * 1.8));
        // Capped at 0.75 — lerping fully to hot turned the whole orb cream and lost the orange.
        if (L > 0.55) this.warm.lerp(COL_HOT, ((L - 0.55) / 0.45) * 0.75);

        (this.core.material as THREE.ShaderMaterial).uniforms.uLevel.value = L;
        for (const m of [this.shell, this.haze]) {
            const mat = m.material as THREE.ShaderMaterial;
            mat.uniforms.uLevel.value = L;
            mat.uniforms.uColor.value.copy(this.warm);
        }

        // Rays counter-rotate against the graphs and brighten hard with level.
        this.rays.rotation.y -= 0.09 * dt;
        this.rays.rotation.z += 0.05 * dt;
        (this.rays.material as THREE.LineBasicMaterial).opacity = 0.14 + L * 0.26;

        this.inner.update(dt, t, L, this.warm, this.pulses);
        this.outer.update(dt, t, L, this.warm, this.pulses);

        // Breathing is NOT a uniform scale. Scaling the group moves every node in lockstep,
        // which reads as a pingpong; the reference shows a swell that crosses the structure and
        // dissipates. That now comes from the same wave fronts that drive the brightness pulses,
        // displacing nodes radially as they pass — see GraphOptions.pushScale.

        // Subtle — the reference lights up, it doesn't inflate.
        this.group.scale.setScalar(1 + L * 0.05);
        this.updateStreaks(t, L);
    }

    /**
     * Launches shockwaves at irregular intervals and ages the ones in flight.
     *
     * Interval is randomized rather than fixed — the reference launches these erratically, and a
     * metronome reads as a loading spinner. Speaking makes them both more frequent and stronger.
     */
    private updatePulses(dt: number, level: number): void {
        if (this.frozen) return;
        this.nextPulse -= dt * (1 + level * 1.8);
        if (this.nextPulse <= 0) {
            this.nextPulse = 1.1 + Math.random() * 2.4;
            this.pulses.push({
                age: 0,
                // A pulse should take a couple of seconds to cross, not a fraction of one.
                // The ring-delta measurement suggested ~0.35s, but that metric tracks a noisy
                // per-frame brightness peak that jumps between rings — it reported motion much
                // faster than the wave actually travels. Watching the reference is the better
                // instrument here.
                life: 1.8 + Math.random() * 1.2,
                strength: 0.5 + Math.random() * 0.5,
            });
        }
        for (let i = this.pulses.length - 1; i >= 0; i--) {
            this.pulses[i].age += dt;
            if (this.pulses[i].age >= this.pulses[i].life) this.pulses.splice(i, 1);
        }
    }

    private updateStreaks(t: number, level: number): void {
        const pos = this.streaks.geometry.getAttribute("position") as THREE.BufferAttribute;
        const arr = pos.array as Float32Array;
        const count = this.streakSeed.length / 4;
        const len = 0.05 + level * 0.14;

        for (let i = 0; i < count; i++) {
            const phase = this.streakSeed[i * 4 + 0] + t * this.streakSeed[i * 4 + 3] * 0.16;
            const incl = this.streakSeed[i * 4 + 1];
            const r = this.streakSeed[i * 4 + 2];
            const x = r * Math.sin(incl) * Math.cos(phase);
            const y = r * Math.cos(incl);
            const z = r * Math.sin(incl) * Math.sin(phase);
            const tx = -Math.sin(phase);
            const tz = Math.cos(phase);

            arr[i * 6 + 0] = x; arr[i * 6 + 1] = y; arr[i * 6 + 2] = z;
            arr[i * 6 + 3] = x + tx * len; arr[i * 6 + 4] = y; arr[i * 6 + 5] = z + tz * len;
        }
        pos.needsUpdate = true;
        (this.streaks.material as THREE.LineBasicMaterial).opacity = 0.3 + level * 0.5;
    }
}
