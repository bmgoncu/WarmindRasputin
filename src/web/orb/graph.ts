/**
 * A drifting node graph — the structure the Rasputin orb is actually made of.
 *
 * This replaced a fixed triangulated icosphere wireframe, which was wrong. The reference is a
 * GRAPH: discrete node points whose edges connect to nearby neighbours and rearrange over time,
 * not a mesh with fixed topology.
 *
 * Timing was measured from consecutive frames rather than guessed. Frames 1/15 s apart are very
 * nearly identical; frames 1/3 s apart show clear rotation and topology change. So the motion is
 * SLOW — a gentle drift with edges reforming over seconds. Fast per-frame flicker would be wrong
 * and would read as noise.
 *
 * Silhouette is a rounded diamond, not a sphere — clearly visible in every reference frame. That
 * comes from a superellipsoid: |x|^n + |y|^n + |z|^n = 1 with n near 1.5 sits between an
 * octahedron (n=1) and a sphere (n=2).
 */

import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

export interface GraphOptions {
    nodeCount: number;
    radius: number;
    /** Superellipsoid exponent. 1 = diamond, 2 = sphere. ~1.5 matches the reference. */
    shape: number;
    /** How far nodes wander from their base position, as a fraction of radius. */
    drift: number;
    /** Drift cycles per second. Low — the reference barely moves in 1/15 s. */
    driftSpeed: number;
    /** Maximum edge length, as a fraction of radius. Longer chords read as a hairball. */
    maxEdgeDist: number;
    /** Per-node connection cap. Without this a few nodes become hubs and it reads as a spider. */
    maxDegree: number;
    /** Seconds between edge-topology rebuilds. */
    rebuildInterval: number;
    /** Radians/sec about Y. */
    spin: number;
    /**
     * How strongly brightness rises toward the centre, 0–1.
     *
     * The single biggest difference from the reference when this was missing: the reference is
     * white-hot at the core and fades to dark red at the rim, while a uniformly-lit graph reads
     * flat and synthetic no matter how the colours are tuned.
     */
    centreBoost: number;
    /** Radius used to normalize the centre gradient — usually the graph's own radius. */
    gradientRadius: number;
    /**
     * 0 = every node sits on the shell surface, 1 = nodes fill the interior volume.
     *
     * Load-bearing for the centre gradient. With all nodes on the surface their radius equals
     * `gradientRadius`, so the normalized r is 1 everywhere and the boost silently does nothing —
     * there are simply no nodes near the middle to light up. The inner graph needs volume fill
     * for its edges to read white-hot toward the core.
     */
    volumeFill: number;
    colour: number;
    seed: number;
}

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Maps a unit direction onto the superellipsoid |x|^n + |y|^n + |z|^n = 1.
 *
 * Scales the direction by t = 1 / (sum |v|^n)^(1/n). It must NOT be renormalized afterwards:
 * doing so forces every direction to radius 1, which is the definition of a sphere. That bug
 * made the shape parameter do nothing at all.
 */
function superellipsoid(x: number, y: number, z: number, n: number): [number, number, number] {
    const p = Math.abs(x) ** n + Math.abs(y) ** n + Math.abs(z) ** n;
    const t = 1 / p ** (1 / n);
    return [x * t, y * t, z * t];
}

interface Edge {
    a: number;
    b: number;
    /** Per-edge brightness multiplier — the reference's edges vary a lot. */
    gain: number;
    /** Phase for a slow independent brightness wobble. */
    phase: number;
    /** Phase for the slow yellow-tint drift. */
    warmPhase: number;
    /** 0 → 1 → 0 over the edge's life. Edges fade rather than pop. */
    age: number;
    life: number;
}

export class NodeGraph {
    readonly group = new THREE.Group();

    private readonly opts: GraphOptions;
    private readonly base: Float32Array;
    private readonly driftPhase: Float32Array;
    private readonly nodePos: Float32Array;
    private readonly nodeBright: Float32Array;
    /** Per-node flare phase, and the live per-frame flare value fed to the shader. */
    private readonly nodeFlare: Float32Array;
    private readonly nodeGain: Float32Array;

    private edges: Edge[] = [];
    private sinceRebuild = 0;

    private readonly lines: THREE.LineSegments;
    /**
     * Warm/flaring edges, drawn a second time with real screen-space thickness.
     *
     * `LineBasicMaterial.linewidth` is a no-op in WebGL on macOS — it is always 1px whatever you
     * set. LineSegments2 renders each segment as a quad, which is the only way to get width.
     * Its material carries ONE width for the whole object, so thick edges need their own pass
     * rather than a per-edge attribute.
     */
    private readonly thickLines: LineSegments2;
    private readonly thickGeom: LineSegmentsGeometry;
    private readonly thickMat: LineMaterial;
    private readonly points: THREE.Points;
    private readonly lineGeom: THREE.BufferGeometry;
    private readonly maxEdges: number;

    constructor(opts: GraphOptions) {
        this.opts = opts;
        const rand = rng(opts.seed);
        const n = opts.nodeCount;

        this.base = new Float32Array(n * 3);
        this.driftPhase = new Float32Array(n * 3);
        this.nodePos = new Float32Array(n * 3);
        this.nodeBright = new Float32Array(n);
        this.nodeFlare = new Float32Array(n);
        this.nodeGain = new Float32Array(n);

        // Fibonacci sphere for even angular coverage, then pushed onto the superellipsoid.
        // Purely random directions leave visible clumps and voids at these counts.
        const golden = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < n; i++) {
            const y = 1 - (i / (n - 1)) * 2;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const th = golden * i;
            let vx = Math.cos(th) * r;
            let vy = y;
            let vz = Math.sin(th) * r;

            // Sphere → superellipsoid. Axis directions keep full radius, corners pull in; that
            // difference IS the diamond.
            const [sx, sy, sz] = superellipsoid(vx, vy, vz, opts.shape);
            // Cube root gives uniform density through the volume; without it points bunch at the
            // centre and the interior looks like a clump rather than a cloud.
            const depth = 1 - opts.volumeFill * (1 - Math.cbrt(rand()));
            const rr = opts.radius * depth * (0.9 + rand() * 0.2);
            this.base[i * 3 + 0] = sx * rr;
            this.base[i * 3 + 1] = sy * rr;
            this.base[i * 3 + 2] = sz * rr;

            this.driftPhase[i * 3 + 0] = rand() * Math.PI * 2;
            this.driftPhase[i * 3 + 1] = rand() * Math.PI * 2;
            this.driftPhase[i * 3 + 2] = rand() * Math.PI * 2;
            this.nodeBright[i] = 0.35 + rand() * 0.65;
            this.nodeFlare[i] = rand() * 6.283;
        }

        // Edge buffer is preallocated at the theoretical maximum and drawn with setDrawRange,
        // so topology changes never reallocate.
        this.maxEdges = Math.ceil((n * opts.maxDegree) / 2) + 8;
        this.lineGeom = new THREE.BufferGeometry();
        this.lineGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 6), 3));
        this.lineGeom.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 2), 1));
        this.lineGeom.setAttribute("aWarm", new THREE.BufferAttribute(new Float32Array(this.maxEdges * 2), 1));

        const lineMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(opts.colour) },
                uHotColor: { value: new THREE.Color(0xffe6b8) },
                uWarmColor: { value: new THREE.Color(0xffc23a) },
                uIntensity: { value: 1 },
                uBoost: { value: opts.centreBoost },
                uRadius: { value: opts.gradientRadius },
            },
            vertexShader: /* glsl */ `
                attribute float aAlpha;
                attribute float aWarm;
                uniform float uBoost;
                uniform float uRadius;
                varying float vA;
                varying float vHot;
                varying float vFade;
                varying float vWarm;
                void main() {
                    vA = aAlpha;
                    vWarm = aWarm;
                    // Distance from the orb centre, normalized. Drives the radial gradient, so a
                    // single edge can be hot at its inner end and dim at its outer one.
                    float r = clamp(length(position) / uRadius, 0.0, 1.0);
                    vHot = mix(1.0, 1.0 + uBoost * 3.0, pow(1.0 - r, 2.2));
                    // Alpha falls off outward too — this is the "fade" along each edge.
                    vFade = mix(0.32, 1.0, pow(1.0 - r, 1.4));
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform vec3 uColor; uniform float uIntensity; uniform vec3 uHotColor; uniform vec3 uWarmColor;
                varying float vA;
                varying float vHot;
                varying float vFade;
                varying float vWarm;
                void main() {
                    // Middle ground: the shift toward white is capped at 0.7 so edges keep their
                    // orange identity instead of blowing to pure white near the core.
                    float k = clamp((vHot - 1.0) * 0.34, 0.0, 0.7);
                    vec3 c = mix(uColor, uHotColor, k);
                    // Independent slow yellow drift, scattered across the graph. This is a TINT
                    // that varies per edge and over time, deliberately not a flare — flaring
                    // edges read as flicker noise.
                    c = mix(c, uWarmColor, vWarm * 0.75);
                    gl_FragColor = vec4(c * vA * vFade * uIntensity * vHot * (1.0 + vWarm * 0.35), 1.0);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            // Back-half edges stay visible; the see-through quality is most of the depth cue.
            depthTest: false,
            depthWrite: false,
        });
        this.lines = new THREE.LineSegments(this.lineGeom, lineMat);

        this.thickGeom = new LineSegmentsGeometry();
        this.thickMat = new LineMaterial({
            color: 0xffc23a,
            linewidth: 1.75,         // in pixels, thanks to LineSegments2
            transparent: true,
            opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthTest: false,
            depthWrite: false,
            vertexColors: true,
        });
        this.thickMat.resolution.set(window.innerWidth, window.innerHeight);
        this.thickLines = new LineSegments2(this.thickGeom, this.thickMat);
        this.thickLines.frustumCulled = false;

        // Nodes are round bright dots in the reference — Points is correct here, unlike streaks.
        const ptGeom = new THREE.BufferGeometry();
        ptGeom.setAttribute("position", new THREE.BufferAttribute(this.nodePos, 3));
        ptGeom.setAttribute("aBright", new THREE.BufferAttribute(this.nodeBright, 1));
        ptGeom.setAttribute("aFlare", new THREE.BufferAttribute(this.nodeGain, 1));
        const ptMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0xffd9a0) },
                uFlareColor: { value: new THREE.Color(0xffc42e) },
                uIntensity: { value: 1 },
                uSize: { value: 0.075 },
                uBoost: { value: opts.centreBoost },
                uRadius: { value: opts.gradientRadius },
            },
            vertexShader: /* glsl */ `
                attribute float aBright;
                attribute float aFlare;
                uniform float uSize;
                uniform float uBoost;
                uniform float uRadius;
                varying float vB;
                varying float vFlare;
                void main() {
                    float r = clamp(length(position) / uRadius, 0.0, 1.0);
                    vB = aBright * mix(1.0, 1.0 + uBoost * 3.2, pow(1.0 - r, 2.2));
                    vFlare = aFlare;
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    // World-size -> pixels. uSize is in world units; the 300 is roughly
                    // viewportHeight / (2*tan(fov/2)), so a node lands at a few pixels rather
                    // than the ~170 it was before, which whited the whole frame out.
                    gl_PointSize = uSize * (300.0 / -mv.z) * (0.6 + aBright * 0.8) * (1.0 + aFlare * 0.85);
                    gl_Position = projectionMatrix * mv;
                }
            `,
            fragmentShader: /* glsl */ `
                uniform vec3 uColor; uniform float uIntensity; uniform vec3 uFlareColor;
                varying float vB;
                varying float vFlare;
                void main() {
                    // Soft round falloff computed procedurally — no texture needed.
                    float d = length(gl_PointCoord - 0.5) * 2.0;
                    float a = smoothstep(1.0, 0.0, d);
                    // Flare shifts colour toward warm yellow and lifts brightness. It must NOT
                    // touch gl_PointSize — scaling the sprite made flaring nodes visibly swell.
                    vec3 c = mix(uColor, uFlareColor, clamp(vFlare * 0.95, 0.0, 1.0));
                    gl_FragColor = vec4(c * vB * uIntensity * (1.0 + vFlare * 2.4), 1.0) * a * a;
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthTest: false,
            depthWrite: false,
        });
        this.points = new THREE.Points(ptGeom, ptMat);

        this.group.add(this.lines, this.thickLines, this.points);
        this.rebuildEdges();
    }

    /**
     * Rebuilds the edge set by proximity.
     *
     * Two rules keep it from becoming a hairball, and both matter: a per-node degree cap (without
     * it a few nodes accumulate a dozen edges each and it reads as a spider) and a maximum edge
     * length (long chords across the interior are what make it look like yarn).
     */
    private rebuildEdges(): void {
        const n = this.opts.nodeCount;
        const maxD = this.opts.maxEdgeDist * this.opts.radius;
        const degree = new Uint8Array(n);
        const next: Edge[] = [];
        const existing = new Map(this.edges.map((e) => [`${e.a}:${e.b}`, e]));

        for (let i = 0; i < n && next.length < this.maxEdges; i++) {
            if (degree[i] >= this.opts.maxDegree) continue;
            for (let j = i + 1; j < n && next.length < this.maxEdges; j++) {
                if (degree[j] >= this.opts.maxDegree || degree[i] >= this.opts.maxDegree) continue;
                const dx = this.nodePos[i * 3] - this.nodePos[j * 3];
                const dy = this.nodePos[i * 3 + 1] - this.nodePos[j * 3 + 1];
                const dz = this.nodePos[i * 3 + 2] - this.nodePos[j * 3 + 2];
                if (dx * dx + dy * dy + dz * dz > maxD * maxD) continue;

                // Carry an existing edge's age forward so surviving edges don't restart their
                // fade-in on every rebuild, which would make the whole graph pulse in lockstep.
                const prev = existing.get(`${i}:${j}`);
                next.push(prev ?? { a: i, b: j, age: 0, life: 1.6 + Math.random() * 2.6, gain: 0.35 + Math.random() * 0.95, phase: Math.random() * 6.283, warmPhase: Math.random() * 6.283 });
                degree[i]++;
                degree[j]++;
            }
        }
        this.edges = next;
    }

    /** `level` 0–1 scales brightness and, mildly, how far nodes push outward. */
    update(dt: number, t: number, level: number, colour: THREE.Color): void {
        const o = this.opts;
        const n = o.nodeCount;
        const swell = 1 + level * 0.06;

        for (let i = 0; i < n; i++) {
            const d = o.drift * o.radius;
            const sp = o.driftSpeed;
            this.nodePos[i * 3 + 0] =
                (this.base[i * 3 + 0] + Math.sin(t * sp + this.driftPhase[i * 3 + 0]) * d) * swell;
            this.nodePos[i * 3 + 1] =
                (this.base[i * 3 + 1] + Math.sin(t * sp * 0.83 + this.driftPhase[i * 3 + 1]) * d) * swell;
            this.nodePos[i * 3 + 2] =
                (this.base[i * 3 + 2] + Math.sin(t * sp * 1.17 + this.driftPhase[i * 3 + 2]) * d) * swell;
        }
        (this.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

        // Node flares: 0 most of the time, briefly approaching 1. Subtle by request — the
        // visible effect is a warm yellow tint and a modest lift, not a pop.
        for (let i = 0; i < n; i++) {
            this.nodeGain[i] = Math.pow(Math.max(0, Math.sin(t * 0.42 + this.nodeFlare[i])), 18);
        }
        (this.points.geometry.getAttribute("aBright") as THREE.BufferAttribute).needsUpdate = true;

        this.sinceRebuild += dt;
        if (this.sinceRebuild >= o.rebuildInterval) {
            this.sinceRebuild = 0;
            this.rebuildEdges();
        }

        // Write live edges into the preallocated buffer, fading in and out over their lifetime.
        const pos = this.lineGeom.getAttribute("position") as THREE.BufferAttribute;
        const alpha = this.lineGeom.getAttribute("aAlpha") as THREE.BufferAttribute;
        const warm = this.lineGeom.getAttribute("aWarm") as THREE.BufferAttribute;
        const pArr = pos.array as Float32Array;
        const aArr = alpha.array as Float32Array;
        const wArr = warm.array as Float32Array;

        let w = 0;
        const thickPts: number[] = [];
        const thickCol: number[] = [];
        for (const e of this.edges) {
            e.age += dt;
            if (e.age > e.life) e.age = 0; // recycle rather than churn the array
            const k = e.age / e.life;
            const fade = Math.sin(Math.PI * k); // 0 → 1 → 0

            const ax = this.nodePos[e.a * 3];
            const ay = this.nodePos[e.a * 3 + 1];
            const az = this.nodePos[e.a * 3 + 2];
            const bx = this.nodePos[e.b * 3];
            const by = this.nodePos[e.b * 3 + 1];
            const bz = this.nodePos[e.b * 3 + 2];

            // Shorter edges read brighter — long ones become ghosts, which stops the interior
            // filling in with a wash of chords.
            const len = Math.hypot(bx - ax, by - ay, bz - az) / (o.maxEdgeDist * o.radius);
            // Slow independent shimmer per edge, on top of the life fade.
            const shimmer = 0.72 + 0.28 * Math.sin(t * 0.9 + e.phase);
            // No flare on edges — only nodes catch light. Flaring edges read as flicker noise.
            const a = fade * e.gain * shimmer * (1 - len * len) * (0.55 + level * 0.75);

            pArr[w * 6 + 0] = ax; pArr[w * 6 + 1] = ay; pArr[w * 6 + 2] = az;
            pArr[w * 6 + 3] = bx; pArr[w * 6 + 4] = by; pArr[w * 6 + 5] = bz;
            aArr[w * 2 + 0] = a; aArr[w * 2 + 1] = a;
            // Slow, smooth, per-edge — most edges sit near zero, a scattered few go warm.
            const warmth = Math.max(0, Math.sin(t * 0.33 + e.warmPhase)) ** 3;
            wArr[w * 2 + 0] = warmth; wArr[w * 2 + 1] = warmth;

            // Past the threshold an edge also gets drawn thick. Brightness ramps from the
            // threshold rather than from 0, so edges thicken in smoothly instead of popping.
            if (warmth > 0.35) {
                const g = ((warmth - 0.35) / 0.65) * a * 2.2;
                thickPts.push(ax, ay, az, bx, by, bz);
                thickCol.push(g, g * 0.72, g * 0.22, g, g * 0.72, g * 0.22);
            }
            w++;
        }
        pos.needsUpdate = true;
        alpha.needsUpdate = true;
        warm.needsUpdate = true;
        this.lineGeom.setDrawRange(0, w * 2);

        // LineSegmentsGeometry has no draw-range equivalent, so it is rebuilt each frame from
        // however many edges are currently warm. That count is small (a scattered handful), so
        // the per-frame allocation is cheap.
        if (thickPts.length > 0) {
            this.thickGeom.setPositions(new Float32Array(thickPts));
            this.thickGeom.setColors(new Float32Array(thickCol));
            this.thickLines.visible = true;
        } else {
            this.thickLines.visible = false;
        }

        // Y only. Adding an X component tumbled the superellipsoid so its silhouette averaged
        // out to a circle over time — the shape is genuinely angular (measured min/max silhouette
        // radius ratio 0.73 at n=1.05), it was the rotation hiding it.
        this.group.rotation.y += o.spin * dt;

        (this.lines.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(colour);
        (this.lines.material as THREE.ShaderMaterial).uniforms.uIntensity.value = 1.1 + level * 2.2;
        (this.points.material as THREE.ShaderMaterial).uniforms.uIntensity.value = 1.6 + level * 3.0;
    }
}
