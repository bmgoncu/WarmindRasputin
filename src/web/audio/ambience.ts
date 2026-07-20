/**
 * The ambient bed and one-shot effects.
 *
 * Shares the speech player's AudioContext rather than making its own: two contexts mean two clocks
 * and two output devices' worth of latency, and ducking one against the other would be guesswork.
 *
 * Levels are three gains in series, which is what makes "duck while speaking" a single number
 * rather than a special case in every play call:
 *
 *     source → per-bus gain (ambient | effects) → duck gain → destination
 *
 * The duck gain is 1 while silent and `duckLevel` while Rasputin speaks, so the bed drops under the
 * voice and comes back on its own. Riding the per-bus gains instead would fight the user's own
 * slider positions.
 */

/** Files the daemon serves from `/sfx/`. */
const ARC_COUNT = 6;

export interface AmbienceLevels {
    /** 0-1 ambient bed. */
    ambient: number;
    /** 0-1 one-shot effects — arcs and the horn. */
    effects: number;
    /**
     * 0-1 multiplier applied to BOTH buses while speech is playing.
     *
     * Not a mute: a bed that vanishes entirely draws more attention than one that dips, and the
     * room going dead under every utterance reads as a fault.
     */
    duck: number;
}

export const DEFAULT_LEVELS: AmbienceLevels = { ambient: 0.35, effects: 0.5, duck: 0.3 };

export class Ambience {
    private ctx: AudioContext | null = null;
    private ambientBus: GainNode | null = null;
    private effectsBus: GainNode | null = null;
    private duckBus: GainNode | null = null;
    private bed: AudioBufferSourceNode | null = null;

    private buffers = new Map<string, AudioBuffer>();
    private levels: AmbienceLevels = { ...DEFAULT_LEVELS };
    private ducked = false;
    private wantBed = false;
    private loading: Promise<void> | null = null;

    /** Non-fatal problems, surfaced in the daemon log. */
    onWarning: ((message: string) => void) | null = null;

    /**
     * Attaches to the speech player's context.
     *
     * Called once audio is unlocked — a context created before a user gesture sits suspended, and
     * a bed started there is silent with no error.
     */
    attach(ctx: AudioContext): void {
        if (this.ctx === ctx) return;
        this.ctx = ctx;
        this.duckBus = ctx.createGain();
        this.duckBus.connect(ctx.destination);
        this.ambientBus = ctx.createGain();
        this.effectsBus = ctx.createGain();
        this.ambientBus.connect(this.duckBus);
        this.effectsBus.connect(this.duckBus);
        this.applyLevels(0);
        if (this.wantBed) void this.startBed();
    }

    setLevels(levels: Partial<AmbienceLevels>): void {
        this.levels = { ...this.levels, ...levels };
        this.applyLevels(0.08);
    }

    /** Ducks or restores. Ramped, because a step change in gain is an audible click. */
    setDucked(ducked: boolean): void {
        if (ducked === this.ducked) return;
        this.ducked = ducked;
        this.applyLevels(0.25);
    }

    private applyLevels(rampSec: number): void {
        if (!this.ctx || !this.ambientBus || !this.effectsBus || !this.duckBus) return;
        const now = this.ctx.currentTime;
        const set = (node: GainNode, value: number): void => {
            node.gain.cancelScheduledValues(now);
            node.gain.setValueAtTime(node.gain.value, now);
            if (rampSec > 0) node.gain.linearRampToValueAtTime(value, now + rampSec);
            else node.gain.setValueAtTime(value, now);
        };
        set(this.ambientBus, this.levels.ambient);
        set(this.effectsBus, this.levels.effects);
        set(this.duckBus, this.ducked ? this.levels.duck : 1);
    }

    private async load(name: string, base: string): Promise<AudioBuffer | null> {
        const cached = this.buffers.get(name);
        if (cached) return cached;
        if (!this.ctx) return null;
        try {
            const res = await fetch(new URL(`/sfx/${name}`, base).href);
            if (!res.ok) return null;
            const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
            this.buffers.set(name, buf);
            return buf;
        } catch {
            return null;
        }
    }

    /** Fetches everything up front so a one-shot never waits on the network to fire. */
    async preload(base: string): Promise<void> {
        if (this.loading) return this.loading;
        this.loading = (async () => {
            const names = ["ambience.wav", "horn.wav", ...Array.from({ length: ARC_COUNT }, (_, i) => `arc-${i}.wav`)];
            const results = await Promise.all(names.map((n) => this.load(n, base)));
            const missing = names.filter((_, i) => results[i] === null);
            // ambience.wav is expected to be absent in a distributed build — it comes from
            // reference media that is not ours to redistribute.
            const unexpected = missing.filter((n) => n !== "ambience.wav");
            if (unexpected.length) this.onWarning?.(`sfx missing: ${unexpected.join(", ")}`);
        })();
        return this.loading;
    }

    get hasBed(): boolean {
        return this.buffers.has("ambience.wav");
    }

    async setBedEnabled(on: boolean): Promise<void> {
        this.wantBed = on;
        if (on) await this.startBed();
        else this.stopBed();
    }

    private async startBed(): Promise<void> {
        if (!this.ctx || !this.ambientBus || this.bed) return;
        const buf = this.buffers.get("ambience.wav");
        if (!buf) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(this.ambientBus);
        src.start();
        this.bed = src;
    }

    private stopBed(): void {
        try {
            this.bed?.stop();
        } catch {
            // Already stopped.
        }
        this.bed = null;
    }

    private oneShot(name: string, gain = 1): void {
        if (!this.ctx || !this.effectsBus) return;
        const buf = this.buffers.get(name);
        if (!buf) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        if (gain === 1) {
            src.connect(this.effectsBus);
        } else {
            const g = this.ctx.createGain();
            g.gain.value = gain;
            src.connect(g).connect(this.effectsBus);
        }
        src.start();
    }

    /** Sounded when Claude is waiting on you. */
    playHorn(): void {
        this.oneShot("horn.wav");
    }

    /**
     * Fired by an arc appearing in the graph, not on a timer.
     *
     * Randomised variant and gain: the same sample at the same level twice in a row is instantly
     * recognisable as a sample, and arcs can fire in quick succession.
     */
    playArc(strength = 1): void {
        const i = Math.floor(Math.random() * ARC_COUNT);
        this.oneShot(`arc-${i}.wav`, 0.4 + strength * 0.6);
    }
}
