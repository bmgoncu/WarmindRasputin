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

/**
 * A shockwave travelling outward from the core.
 *
 * Measured from the reference: brightening marches from ring 0 to ring 5 in roughly 0.35s, but
 * only on ~40% of frame steps — so these are discrete pulses launched irregularly, not a
 * continuous ripple. Nodes and edges light up as the front passes them.
 */
export interface Pulse {
    /** Seconds since launch. */
    age: number;
    /** Seconds to cross the whole orb. */
    life: number;
    /** Peak strength, 0-1. */
    strength: number;
}

/**
 * An electric jolt walking the graph edge by edge.
 *
 * Distinct from a Pulse: a pulse is radial and geometric — it sweeps a sphere of radius outward
 * regardless of structure. A jolt is TOPOLOGICAL, hopping node to node along actual edges, so it
 * traces the network like current finding a path.
 *
 * The lit region is a SEGMENT with a head and a tail, carved out of the path by arc length — so
 * an edge is partially lit and the bright part visibly slides along it:
 *
 *     N....***N**...N        head mid-edge, tail spilling back over the previous node
 *     N***...N...            head near a node, tail behind it
 *
 * Lighting whole edges instead makes it read as edges switching on and off in sequence, which is
 * a different effect entirely — no motion within an edge, so nothing appears to travel.
 */
interface Jolt {
    /** Nodes visited, oldest first. The lit segment is carved out of this path. */
    path: number[];
    /** Node currently being travelled toward. */
    next: number;
    /** 0-1 along the edge from path[last] to next. */
    t: number;
    /** Edges traversed per second. */
    speed: number;
    /** Remaining lifetime in seconds. */
    life: number;
    /** Edges traversed so far — distance travelled, since `path` is trimmed to the tail window. */
    hops: number;
    /** Length of the lit segment, in edge-lengths. Below 1 it sits inside a single edge. */
    tail: number;
    strength: number;
}

/**
 * A discharge jumping BETWEEN two unconnected nodes, across open space.
 *
 * The opposite of a Jolt in every respect, which is why it is a separate system rather than a
 * jolt variant. A jolt walks existing edges and persists for seconds; an arc ignores the topology
 * entirely, spans a gap no edge covers, and is gone in a fifth of a second. That contrast is the
 * point — the jolt reads as current flowing through the structure, the arc as the structure
 * failing to contain it.
 *
 * The polyline is baked into world space at spawn rather than tracked to its endpoint nodes. Over
 * a ~0.2s life the nodes drift by far less than the arc's own jaggedness, so following them would
 * cost per-frame basis math to buy nothing visible.
 */
interface Arc {
    /** Baked world-space polyline, (ARC_SEGMENTS + 1) * 3. */
    pts: Float32Array;
    age: number;
    life: number;
    strength: number;
}

/** Kinks per arc. Below ~5 it reads as a bent stick, above ~10 the jaggedness turns to fuzz. */
const ARC_SEGMENTS = 7;

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
    /** Mean seconds between jolt spawns. 0 disables them. */
    joltInterval: number;
    /** Cap on simultaneous jolts. */
    maxJolts: number;
    /** Concurrent arcs to sustain. 0 disables. */
    arcCount: number;
    /**
     * Mean jolt lifetime in seconds.
     *
     * Sustaining N jolts needs a spawn every life/N seconds, so the ONLY way to hold a large
     * population without a frantic spawn rate is to make each one last longer. Deriving the cap
     * from a fixed lifetime instead made raising the slider read as speed rather than as count —
     * at cap 50 it was spawning 13 times a second where cap 5 spawned once.
     */
    joltLife: number;
    /**
     * How far nodes vibrate at full level, as a fraction of radius. 0 disables.
     *
     * Speech energy shakes the lattice — the structure is being driven, not just lit. Kept small:
     * past roughly 0.05 the edges smear and the graph stops reading as a fixed structure.
     */
    speechJitter: number;
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
     * Radius the wave front is measured against — the WHOLE orb's extent, not this graph's.
     *
     * Normalizing per-graph was a bug: the outer graph is a thin shell, so every one of its nodes
     * sat at nr ~= 1.0 and the front reached all of them in the same instant. The entire layer
     * flashed together, which reads as a pingpong rather than a wave. Measuring against a shared
     * world radius makes one coherent front travel through the inner volume and then the outer
     * shell.
     */
    worldRadius: number;
    /**
     * How far a passing wave front pushes nodes outward, as a fraction of radius.
     *
     * This is what makes the breathing a travelling WAVE rather than a pingpong. Scaling the
     * whole group up and down moves every node in lockstep, which reads as mechanical pumping;
     * displacing nodes only where the front currently is makes the swell visibly cross the
     * structure and dissipate behind itself.
     */
    pushScale: number;
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

    /** Dev only: draws jolt segments and nothing else, so their shape can be read directly. */
    solo(): void {
        this.soloJolts = true;
    }

    /**
     * Dev only: stops drift, spin and edge rebuilds.
     *
     * Everything in this scene moves at once, so a frame-difference image shows the whole graph
     * lit up and reveals nothing about any single system. Freezing the ambient motion leaves only
     * the system under test — jolts, waves — visible in the diff.
     */
    freeze(): void {
        this.opts.drift = 0;
        this.opts.driftSpeed = 0;
        this.opts.spin = 0;
        this.opts.rebuildInterval = 1e9;
    }

    /** Fired when an arc spawns, carrying its strength, so a sound can accompany it. */
    onArc: ((strength: number) => void) | null = null;

    /** Live counts for the dev harness — see window.__orb in main.ts. */
    get debug(): { jolts: number; edges: number; nodes: number; litEdges: number; arcs: number; hops: number[]; shake: number; stat: Record<string, number> } {
        return {
            jolts: this.jolts.length,
            edges: this.edges.length,
            nodes: this.opts.nodeCount,
            litEdges: this.jolts.reduce((n, j) => n + Math.ceil(j.tail) + 1, 0),
            arcs: this.arcs.length,
            hops: this.jolts.map((j) => j.hops),
            shake: Math.sqrt(this.jitter.reduce((a, v) => a + v * v, 0) / this.jitter.length),
            stat: { ...this.joltStat },
        };
    }

    private readonly opts: GraphOptions;
    private readonly base: Float32Array;
    private readonly driftPhase: Float32Array;
    private readonly nodePos: Float32Array;
    private readonly nodeBright: Float32Array;
    /** Per-node flare phase, and the live per-frame flare value fed to the shader. */
    private readonly nodeFlare: Float32Array;
    private readonly nodeGain: Float32Array;
    /** Undisplaced radius per node, so the gradient is immune to the push wave. */
    private readonly nodeRest: Float32Array;

    private edges: Edge[] = [];
    /** node -> connected node indices. Rebuilt with the edge set; jolts walk this. */
    private adjacency: number[][] = [];
    private jolts: Jolt[] = [];
    private arcs: Arc[] = [];
    private nextArc = 0.4;
    private nextJolt = 1.5;
    private joltStat = { spawned: 0, expired: 0, isolated: 0, rewired: 0, culled: 0 };
    private soloJolts = false;
    /** Per-node jitter offset from jolts and speech energy, in world units. */
    private readonly jitter: Float32Array;
    /** Fixed per-axis phases so each node vibrates independently rather than the graph pulsing. */
    private readonly shakePhase: Float32Array;
    private jitterFloor = 0;
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
        this.nodeRest = new Float32Array(n);
        this.jitter = new Float32Array(n * 3);
        this.shakePhase = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) this.shakePhase[i] = rand() * Math.PI * 2;

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
        // Rest radius, independent of wave displacement — see aRest in the shader.
        ptGeom.setAttribute("aRest", new THREE.BufferAttribute(this.nodeRest, 1));
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
                attribute float aRest;
                uniform float uSize;
                uniform float uBoost;
                uniform float uRadius;
                varying float vB;
                varying float vFlare;
                void main() {
                    float r = clamp(aRest / uRadius, 0.0, 1.0);
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

        this.adjacency = Array.from({ length: this.opts.nodeCount }, () => [] as number[]);
        for (const e of next) {
            this.adjacency[e.a].push(e.b);
            this.adjacency[e.b].push(e.a);
        }
        // A jolt whose current edge vanished in the rebuild would walk into nothing.
        // A rebuild rewires edges under any jolt in flight. Killing those jolts caps their travel
        // at the rebuild interval no matter how long their lifetime is — so instead they REROUTE:
        // pick a new neighbour from the node they last passed. Only a node left isolated ends one.
        this.jolts = this.jolts.filter((j) => {
            const here = j.path[j.path.length - 1];
            const nbrs = this.adjacency[here];
            if (!nbrs || nbrs.length === 0) {
                this.joltStat.culled++;
                return false;
            }
            if (nbrs.includes(j.next)) return true;
            const opts = nbrs.length > 1 ? nbrs.filter((x) => x !== j.path[j.path.length - 2]) : nbrs;
            j.next = opts[Math.floor(Math.random() * opts.length)];
            this.joltStat.rewired++;
            return true;
        });
    }

    /**
     * Spawns, advances and expires jolts, and accumulates the node jitter they cause.
     *
     * Jitter is written into a buffer rather than applied directly because node positions are
     * recomputed from base + drift + wave push every frame; the jolt contribution has to be added
     * on top of that rather than fighting it.
     */
    private updateJolts(dt: number, level: number): void {
        const o = this.opts;
        this.jitter.fill(0);
        if (o.joltInterval <= 0) return;

        this.nextJolt -= dt * (1 + level * 1.5);
        if (this.nextJolt <= 0 && this.jolts.length < o.maxJolts) {
            // Randomized, not fixed — evenly spaced jolts read as a metronome.
            this.nextJolt = o.joltInterval * (0.45 + Math.random() * 1.5);
            const start = Math.floor(Math.random() * o.nodeCount);
            const nbrs = this.adjacency[start];
            if (nbrs && nbrs.length > 0) {
                this.jolts.push({
                    path: [start],
                    next: nbrs[Math.floor(Math.random() * nbrs.length)],
                    t: 0,
                    hops: 0,
                    speed: 7 + Math.random() * 8,
                    life: o.joltLife * (0.72 + Math.random() * 0.56),
                    tail: 0.45 + Math.random() * 0.5,
                    strength: 0.6 + Math.random() * 0.4,
                });
                this.joltStat.spawned++;
            }
        }

        for (let i = this.jolts.length - 1; i >= 0; i--) {
            const j = this.jolts[i];
            j.life -= dt;
            j.t += j.speed * dt;

            while (j.t >= 1) {
                j.t -= 1;
                const nbrs = this.adjacency[j.next];
                if (!nbrs || nbrs.length === 0) {
                    j.life = 0;
                    this.joltStat.isolated++;
                    break;
                }
                const prev = j.path[j.path.length - 1];
                // Prefer not to backtrack — a jolt oscillating on one edge reads as a stuck
                // light rather than as current travelling.
                const options = nbrs.length > 1 ? nbrs.filter((x) => x !== prev) : nbrs;
                j.hops++;
                j.path.push(j.next);
                j.next = options[Math.floor(Math.random() * options.length)];
                // Only as much history as the tail can reach back through.
                while (j.path.length > Math.ceil(j.tail) + 2) j.path.shift();
            }

            if (j.life <= 0) {
                if (j.life > -dt) this.joltStat.expired++;
                this.jolts.splice(i, 1);
                continue;
            }

            // Jitter only the nodes the lit segment is actually near, so the disturbance
            // travels with the jolt instead of shaking its whole path.
            const amp = 0.014 * o.radius * j.strength;
            const touch = [j.next, j.path[j.path.length - 1], j.path[j.path.length - 2]];
            for (const idx of touch) {
                if (idx === undefined || idx < 0) continue;
                this.jitter[idx * 3 + 0] += (Math.random() - 0.5) * amp;
                this.jitter[idx * 3 + 1] += (Math.random() - 0.5) * amp;
                this.jitter[idx * 3 + 2] += (Math.random() - 0.5) * amp;
            }
        }
    }

    /**
     * Live tuning — rescales the whole layer.
     *
     * Base positions are stored already multiplied by radius, so this is a uniform scale, and the
     * per-frame rest radius follows from them. Topology is unaffected: maxEdgeDist is a FRACTION
     * of radius, so the edge threshold grows with the node spacing and the same pairs stay
     * connected. That is precisely why radius alone cannot thin a graph out — only the node count
     * and the degree cap can.
     */
    setRadius(r: number): void {
        const k = r / this.opts.radius;
        if (!Number.isFinite(k) || k <= 0) return;
        for (let i = 0; i < this.base.length; i++) this.base[i] *= k;
        this.opts.gradientRadius *= k;
        this.opts.radius = r;
    }

    /**
     * Live tuning — jolt spawn interval, concurrency and lifetime. An interval of 0 disables them.
     *
     * Trims any jolts already in flight past the new cap, so lowering the slider takes effect
     * immediately rather than after the excess ones happen to expire.
     */
    setJolts(interval: number, max: number, life: number): void {
        this.opts.joltInterval = interval;
        this.opts.maxJolts = max;
        this.opts.joltLife = life;
        if (this.jolts.length > max) this.jolts.length = max;
    }

    /** Shared across graphs — see GraphOptions.worldRadius. */
    setWorldRadius(v: number): void {
        this.opts.worldRadius = v;
    }

    /** Live tuning — see the shake slider in the dev harness. */
    setSpeechJitter(v: number): void {
        this.opts.speechJitter = v;
    }

    /** Level below which there is no shake at all — normally the orb's idle floor. */
    setJitterFloor(v: number): void {
        this.jitterFloor = Math.min(0.95, Math.max(0, v));
    }

    /**
     * Adds speech-driven vibration on top of whatever the jolts contributed.
     *
     * Deterministic sines of time rather than per-frame Math.random(): random jitter re-rolled
     * every frame vibrates faster on a 120 Hz display than on a 60 Hz one, so the orb would feel
     * different on different monitors. Two octaves, because a single sine reads as a smooth
     * wobble rather than as a driven structure.
     *
     * Drive is measured ABOVE the idle floor, not from zero. Curving raw level leaves a residue at
     * rest — with the floor holding level at 0.22, level^1.8 is still 0.058, so the orb buzzed
     * permanently in idle and in manual mode. Rescaling from the floor makes rest exactly zero.
     */
    private applySpeechJitter(t: number, level: number): void {
        const o = this.opts;
        if (o.speechJitter <= 0) return;
        const drive = (level - this.jitterFloor) / (1 - this.jitterFloor);
        if (drive <= 0.01) return;
        const amp = o.speechJitter * o.radius * drive ** 1.8;
        const n = o.nodeCount;
        for (let i = 0; i < n * 3; i++) {
            const ph = this.shakePhase[i];
            this.jitter[i] += (Math.sin(t * 44 + ph) * 0.75 + Math.sin(t * 107 + ph * 2.3) * 0.25) * amp;
        }
    }

    /**
     * Spawns and ages arcs.
     *
     * Unlike jolts, the spawn rate SHOULD rise with the count here. A jolt is an object you follow,
     * so a fast spawn rate reads as flicker; an arc is a flash, so flashing more often is exactly
     * what more arcs means. Lifetime therefore stays fixed and only the rate moves.
     */
    private updateArcs(dt: number): void {
        const o = this.opts;

        for (let i = this.arcs.length - 1; i >= 0; i--) {
            this.arcs[i].age += dt;
            if (this.arcs[i].age >= this.arcs[i].life) this.arcs.splice(i, 1);
        }
        if (o.arcCount <= 0) return;

        // Mean arc life is ~0.2s, so sustaining N concurrent needs a spawn every 0.2/N seconds.
        this.nextArc -= dt;
        if (this.nextArc > 0 || this.arcs.length >= o.arcCount) return;
        this.nextArc = (0.2 / o.arcCount) * (0.5 + Math.random());

        const arc = this.makeArc();
        if (arc) {
            this.arcs.push(arc);
            // Fired here rather than on a timer, so the crackle and the flash are the same event.
            this.onArc?.(arc.strength);
        }
    }

    /**
     * Picks two nodes far enough apart to have no edge between them and bakes a jagged path.
     *
     * Rejects adjacent pairs explicitly: an arc that happens to land on an existing edge is
     * indistinguishable from a jolt and wastes the effect.
     */
    private makeArc(): Arc | null {
        const o = this.opts;
        const pos = this.nodePos;
        const n = o.nodeCount;
        const minSpan = 0.5 * o.radius;
        const maxSpan = 1.3 * o.radius;

        const a = Math.floor(Math.random() * n);
        let b = -1;
        for (let tries = 0; tries < 24; tries++) {
            const cand = Math.floor(Math.random() * n);
            if (cand === a || this.adjacency[a]?.includes(cand)) continue;
            const d = Math.hypot(
                pos[cand * 3] - pos[a * 3],
                pos[cand * 3 + 1] - pos[a * 3 + 1],
                pos[cand * 3 + 2] - pos[a * 3 + 2],
            );
            if (d >= minSpan && d <= maxSpan) {
                b = cand;
                break;
            }
        }
        if (b < 0) return null;

        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const dx = pos[b * 3] - ax, dy = pos[b * 3 + 1] - ay, dz = pos[b * 3 + 2] - az;
        const len = Math.hypot(dx, dy, dz);

        // Two vectors perpendicular to the span, to displace the kinks into. The seed axis is
        // chosen away from the span direction — cross product with a near-parallel vector
        // collapses to zero length and the arc would come out perfectly straight.
        const sx = Math.abs(dz) > 0.9 * len ? 1 : 0;
        const sz = Math.abs(dz) > 0.9 * len ? 0 : 1;
        let p1x = dy * sz - dz * 0, p1y = dz * sx - dx * sz, p1z = dx * 0 - dy * sx;
        const p1l = Math.hypot(p1x, p1y, p1z) || 1;
        p1x /= p1l; p1y /= p1l; p1z /= p1l;
        let p2x = dy * p1z - dz * p1y, p2y = dz * p1x - dx * p1z, p2z = dx * p1y - dy * p1x;
        const p2l = Math.hypot(p2x, p2y, p2z) || 1;
        p2x /= p2l; p2y /= p2l; p2z /= p2l;

        const pts = new Float32Array((ARC_SEGMENTS + 1) * 3);
        const wander = len * 0.14;
        for (let k = 0; k <= ARC_SEGMENTS; k++) {
            const f = k / ARC_SEGMENTS;
            // Displacement tapers to zero at both ends so the arc is anchored to its nodes rather
            // than floating off them.
            const taper = Math.sin(Math.PI * f);
            const o1 = (Math.random() - 0.5) * wander * taper;
            const o2 = (Math.random() - 0.5) * wander * taper;
            pts[k * 3 + 0] = ax + dx * f + p1x * o1 + p2x * o2;
            pts[k * 3 + 1] = ay + dy * f + p1y * o1 + p2y * o2;
            pts[k * 3 + 2] = az + dz * f + p1z * o1 + p2z * o2;
        }

        return { pts, age: 0, life: 0.13 + Math.random() * 0.16, strength: 0.7 + Math.random() * 0.3 };
    }

    /** Emits every arc's polyline, brightest at strike and decaying with a per-frame flicker. */
    private emitArcSegments(pts: number[], cols: number[]): void {
        for (const arc of this.arcs) {
            const k = arc.age / arc.life;
            // Fast attack, decaying tail, plus a flicker — a smooth fade reads as a glowing wire
            // rather than as a discharge.
            const env = (1 - k) ** 0.55 * Math.min(1, k * 12) * (0.75 + Math.random() * 0.25);
            const g = arc.strength * env * 3.2;
            for (let i = 0; i < ARC_SEGMENTS; i++) {
                pts.push(
                    arc.pts[i * 3], arc.pts[i * 3 + 1], arc.pts[i * 3 + 2],
                    arc.pts[i * 3 + 3], arc.pts[i * 3 + 4], arc.pts[i * 3 + 5],
                );
                // Hotter and whiter than the jolts, which lean warm — an arc is the brighter event.
                cols.push(g, g * 0.97, g * 0.9, g, g * 0.97, g * 0.9);
            }
        }
    }

    /** Live tuning — concurrent arc count. Dev harness slider. */
    setArcCount(n: number): void {
        this.opts.arcCount = Math.max(0, n);
        if (this.arcs.length > n) this.arcs.length = Math.max(0, n);
    }

    /**
     * Emits the lit sub-segments for every jolt.
     *
     * Walks backward from the head along the path, consuming `tail` edge-lengths and clipping to
     * each edge as it goes. A tail shorter than one edge stays inside that edge; a longer one
     * spills back across nodes into earlier edges.
     */
    private emitJoltSegments(pts: number[], cols: number[]): void {
        const pos = this.nodePos;
        const at = (i: number, out: [number, number, number]): void => {
            out[0] = pos[i * 3];
            out[1] = pos[i * 3 + 1];
            out[2] = pos[i * 3 + 2];
        };
        const A: [number, number, number] = [0, 0, 0];
        const B: [number, number, number] = [0, 0, 0];

        for (const j of this.jolts) {
            let remaining = j.tail;
            // Head sits between path[last] and next, at fraction t.
            let hiNode = j.next;
            let loNode = j.path[j.path.length - 1];
            let hiFrac = j.t;
            let pathIdx = j.path.length - 1;
            // Arc distance from the head to the current piece's leading end. Brightness is a
            // function of this, so it has to accumulate across pieces — measuring within each
            // piece independently restarts the ramp at every node and reads as a dashed line.
            let behind = 0;
            // Fade the whole jolt in and out so it doesn't pop at spawn or death.
            const envelope = Math.min(1, j.life * 2.5, (j.tail + 0.3) * 2);

            while (remaining > 0 && loNode !== undefined) {
                const span = Math.min(remaining, hiFrac);
                const loFrac = hiFrac - span;
                at(loNode, A);
                at(hiNode, B);

                // Sub-divide so the segment is brightest at the head and fades toward the tail.
                const STEPS = 4;
                for (let k = 0; k < STEPS; k++) {
                    const f0 = loFrac + ((hiFrac - loFrac) * k) / STEPS;
                    const f1 = loFrac + ((hiFrac - loFrac) * (k + 1)) / STEPS;
                    // Distance behind the head at this piece's midpoint. The head is at hiFrac of
                    // the FIRST piece, so distance grows as f decreases and as `behind` climbs.
                    const dHead = behind + (hiFrac - (f0 + f1) / 2);
                    // ^1.6 keeps the hot part concentrated near the head rather than smearing the
                    // brightness evenly along the tail, which is what makes it read as a spark
                    // dragging a trail instead of a uniformly glowing stick.
                    const fadeK = (1 - Math.min(1, dHead / j.tail)) ** 1.6;
                    const g = j.strength * envelope * (0.18 + fadeK * 3.5);
                    pts.push(
                        A[0] + (B[0] - A[0]) * f0, A[1] + (B[1] - A[1]) * f0, A[2] + (B[2] - A[2]) * f0,
                        A[0] + (B[0] - A[0]) * f1, A[1] + (B[1] - A[1]) * f1, A[2] + (B[2] - A[2]) * f1,
                    );
                    // Electric: near-white leaning cold, distinct from the warm drift edges.
                    cols.push(g, g * 0.95, g * 0.82, g, g * 0.95, g * 0.82);
                }

                remaining -= span;
                behind += span;
                if (remaining <= 0) break;
                // Spill back into the previous edge.
                hiNode = loNode;
                pathIdx -= 1;
                loNode = j.path[pathIdx];
                hiFrac = 1;
            }
        }
    }

    /** `level` 0–1 scales brightness and, mildly, how far nodes push outward. */
    update(dt: number, t: number, level: number, colour: THREE.Color, pulses: Pulse[] = []): void {
        const o = this.opts;
        const n = o.nodeCount;
        const swell = 1 + level * 0.06;

        for (let i = 0; i < n; i++) {
            const d = o.drift * o.radius;
            const sp = o.driftSpeed;
            const bx = this.base[i * 3 + 0] + Math.sin(t * sp + this.driftPhase[i * 3 + 0]) * d;
            const by = this.base[i * 3 + 1] + Math.sin(t * sp * 0.83 + this.driftPhase[i * 3 + 1]) * d;
            const bz = this.base[i * 3 + 2] + Math.sin(t * sp * 1.17 + this.driftPhase[i * 3 + 2]) * d;

            // Radial displacement from any wave front currently crossing this node's radius.
            // The push band is wider than the brightness band so the swell feels like a body of
            // motion rather than a hard shell hitting each node.
            let push = 0;
            if (pulses.length > 0 && o.pushScale > 0) {
                const nr = Math.hypot(bx, by, bz) / o.worldRadius;
                for (const p of pulses) {
                    const front = (p.age / p.life) * 1.25;
                    const dist = Math.abs(nr - front);
                    if (dist < 0.16) {
                        const shape = Math.cos((dist / 0.16) * Math.PI * 0.5); // smooth, no edge
                        push += shape * p.strength * (1 - p.age / p.life) * o.pushScale;
                    }
                }
            }

            this.nodeRest[i] = Math.hypot(bx, by, bz);
            const k = swell * (1 + push);
            this.nodePos[i * 3 + 0] = bx * k + this.jitter[i * 3 + 0];
            this.nodePos[i * 3 + 1] = by * k + this.jitter[i * 3 + 1];
            this.nodePos[i * 3 + 2] = bz * k + this.jitter[i * 3 + 2];
        }
        (this.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        (this.points.geometry.getAttribute("aRest") as THREE.BufferAttribute).needsUpdate = true;

        // Node flares: 0 most of the time, briefly approaching 1. Subtle by request — the
        // visible effect is a warm yellow tint and a modest lift, not a pop.
        //
        // Pulse fronts add on top: a node lights when a front is passing its radius. The band is
        // narrow so the wave reads as a travelling ring rather than a general brightening.
        for (let i = 0; i < n; i++) {
            let g = Math.pow(Math.max(0, Math.sin(t * 0.42 + this.nodeFlare[i])), 18);
            if (pulses.length > 0) {
                const nr = Math.hypot(
                    this.nodePos[i * 3], this.nodePos[i * 3 + 1], this.nodePos[i * 3 + 2],
                ) / o.worldRadius;
                for (const p of pulses) {
                    const front = (p.age / p.life) * 1.25;   // travels past the rim before dying
                    const d = Math.abs(nr - front);
                    if (d < 0.1) {
                        // Fades as the front expands, so a pulse dissipates rather than
                        // reaching the rim at full strength.
                        const falloff = 1 - p.age / p.life;
                        g = Math.min(2.2, g + (1 - d / 0.1) * p.strength * falloff * 2.4);
                    }
                }
            }
            // Nodes the lit head is passing light hard; the one behind it less so.
            for (const j of this.jolts) {
                if (j.next === i) g = Math.max(g, 1.4 * j.strength * j.t);
                else if (j.path[j.path.length - 1] === i) g = Math.max(g, 1.3 * j.strength * (1 - j.t));
            }
            this.nodeGain[i] = g;
        }
        (this.points.geometry.getAttribute("aBright") as THREE.BufferAttribute).needsUpdate = true;

        this.updateJolts(dt, level);
        this.updateArcs(dt);
        this.applySpeechJitter(t, level);

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
            // A passing front also thickens edges, which is what makes the wave visible as
            // structure rather than only as brighter dots.
            let pulseBoost = 0;
            if (pulses.length > 0) {
                const mr = Math.hypot((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2) / o.worldRadius;
                for (const p of pulses) {
                    const front = (p.age / p.life) * 1.25;
                    const d = Math.abs(mr - front);
                    if (d < 0.1) pulseBoost = Math.max(pulseBoost, (1 - d / 0.1) * p.strength * (1 - p.age / p.life));
                }
            }

            if (!this.soloJolts && (warmth > 0.35 || pulseBoost > 0.25)) {
                const g = Math.max((warmth - 0.35) / 0.65, pulseBoost) * a * 2.2;
                thickPts.push(ax, ay, az, bx, by, bz);
                thickCol.push(g, g * 0.72, g * 0.22, g, g * 0.72, g * 0.22);
            }
            w++;
        }
        pos.needsUpdate = true;
        alpha.needsUpdate = true;
        warm.needsUpdate = true;
        this.lineGeom.setDrawRange(0, this.soloJolts ? 0 : w * 2);
        this.points.visible = !this.soloJolts;

        this.emitJoltSegments(thickPts, thickCol);
        this.emitArcSegments(thickPts, thickCol);

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
