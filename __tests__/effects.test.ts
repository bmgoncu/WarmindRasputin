import {
    findPhraseEnds, applyGlitch, applyRingMod, normalizePeak, DEFAULT_GLITCH,
    parsePunctuation, alignMarks,
} from "../src/server/audio/effects.js";

const RATE = 22050;

/** Builds a signal of alternating tone and silence blocks, each `blockMs` long. */
function toneAndSilence(pattern: ("tone" | "quiet")[], blockMs: number): Float32Array {
    const block = Math.floor((blockMs / 1000) * RATE);
    const out = new Float32Array(block * pattern.length);
    pattern.forEach((kind, b) => {
        if (kind !== "tone") return;
        for (let i = 0; i < block; i++) {
            out[b * block + i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / RATE);
        }
    });
    return out;
}

describe("findPhraseEnds", () => {
    it("finds the boundary between speech and a following pause", () => {
        const sig = toneAndSilence(["tone", "quiet", "tone"], 300);
        const ends = findPhraseEnds(sig, RATE);
        expect(ends).toHaveLength(1);
        // The end of the first tone block, ~300ms in. Envelope hop is 10ms, so allow a little slack.
        expect(ends[0].at / RATE).toBeCloseTo(0.3, 1);
    });

    it("ignores gaps shorter than minGapMs", () => {
        // 20ms of quiet is an inter-syllable dip, not punctuation.
        const sig = toneAndSilence(["tone", "quiet", "tone"], 20);
        expect(findPhraseEnds(sig, RATE, { minGapMs: 70 })).toHaveLength(0);
    });

    it("finds one boundary per pause", () => {
        const sig = toneAndSilence(["tone", "quiet", "tone", "quiet", "tone"], 300);
        expect(findPhraseEnds(sig, RATE)).toHaveLength(2);
    });

    it("returns nothing for continuous speech", () => {
        expect(findPhraseEnds(toneAndSilence(["tone", "tone"], 300), RATE)).toHaveLength(0);
    });
});

describe("applyGlitch", () => {
    it("preserves duration — the orb's timeline depends on it", () => {
        const sig = toneAndSilence(["tone", "quiet", "tone"], 300);
        for (const placement of ["energy", "boundary"] as const) {
            const out = applyGlitch(sig, RATE, { ...DEFAULT_GLITCH, placement });
            expect(out.length).toBe(sig.length);
        }
    });

    it("boundary placement writes into the pause, not over the next phrase", () => {
        const sig = toneAndSilence(["tone", "quiet", "tone"], 300);
        const out = applyGlitch(sig, RATE, { ...DEFAULT_GLITCH, placement: "boundary" });

        const block = Math.floor(0.3 * RATE);
        const energy = (from: number, to: number): number => {
            let e = 0;
            for (let i = from; i < to; i++) e += out[i] * out[i];
            return Math.sqrt(e / (to - from));
        };

        // The pause should now contain the stutter...
        expect(energy(block, block * 2)).toBeGreaterThan(0.01);
        // ...while the speech that follows is untouched.
        const originalSecond = (() => {
            let e = 0;
            for (let i = block * 2; i < block * 3; i++) e += sig[i] * sig[i];
            return Math.sqrt(e / block);
        })();
        expect(energy(block * 2, block * 3)).toBeCloseTo(originalSecond, 3);
    });

    it("is deterministic for a given seed", () => {
        const sig = toneAndSilence(["tone", "quiet", "tone"], 300);
        const a = applyGlitch(sig, RATE);
        const b = applyGlitch(sig, RATE);
        expect(Array.from(a)).toEqual(Array.from(b));
    });
});

describe("applyRingMod", () => {
    it("leaves the signal untouched at zero mix", () => {
        const sig = toneAndSilence(["tone"], 200);
        const out = applyRingMod(sig, RATE, { carrierHz: 62, mix: 0 });
        expect(Array.from(out)).toEqual(Array.from(sig));
    });

    it("changes the signal at non-zero mix", () => {
        const sig = toneAndSilence(["tone"], 200);
        const out = applyRingMod(sig, RATE, { carrierHz: 62, mix: 0.5 });
        expect(Array.from(out)).not.toEqual(Array.from(sig));
    });
});

describe("normalizePeak", () => {
    it("scales the peak to the target", () => {
        const sig = new Float32Array([0.1, -0.2, 0.05]);
        const out = normalizePeak(sig, 0.95);
        expect(Math.max(...Array.from(out).map(Math.abs))).toBeCloseTo(0.95, 5);
    });

    it("leaves all-silence alone rather than dividing by zero", () => {
        const out = normalizePeak(new Float32Array(100), 0.95);
        expect(Array.from(out).every((s) => s === 0)).toBe(true);
    });
});

describe("parsePunctuation", () => {
    it("weights sentence ends above commas", () => {
        const marks = parsePunctuation("First, second. Third?");
        expect(marks.map((m) => m.mark)).toEqual([",", ".", "?"]);
        expect(marks[0].weight).toBeLessThan(marks[1].weight);
        expect(marks[2].weight).toEqual(marks[1].weight);
    });

    it("ignores a decimal point — say does not pause mid-number", () => {
        expect(parsePunctuation("Pi is 3.14 exactly").map((m) => m.mark)).toEqual([]);
    });

    it("collapses runs like '?!' into one event at the strongest weight", () => {
        const marks = parsePunctuation("What?!");
        expect(marks).toHaveLength(1);
        expect(marks[0].weight).toBe(1);
    });

    it("records normalized text position", () => {
        const marks = parsePunctuation("ab, cd.");
        expect(marks[0].pos).toBeLessThan(marks[1].pos);
        expect(marks[1].pos).toBeCloseTo(1, 1);
    });
});

describe("alignMarks", () => {
    const ends = [0, 1000, 2000, 3000, 4000].map((at) => ({ at, gapMs: 100 }));

    it("matches each mark to the pause nearest its text position", () => {
        const marks = parsePunctuation("a, b.");   // ~pos 0.2 and 1.0
        const got = alignMarks(ends, marks, 5000);
        expect(got[0]!.at).toBeLessThan(got[1]!.at);
    });

    it("places every mark rather than starving the last one", () => {
        // Regression: a comma near the end used to claim the final pause by proximity, leaving
        // the sentence-final mark with nothing.
        const marks = parsePunctuation("aaaaaaaa, b?");
        const got = alignMarks(ends, marks, 5000);
        expect(got.every((g) => g !== undefined)).toBe(true);
    });

    it("keeps assignments in reading order", () => {
        const marks = parsePunctuation("a, b, c, d.");
        const got = alignMarks(ends, marks, 5000).filter(Boolean);
        for (let i = 1; i < got.length; i++) expect(got[i]!.at).toBeGreaterThan(got[i - 1]!.at);
    });

    it("returns undefined entries when there are fewer pauses than marks", () => {
        const got = alignMarks([{ at: 0, gapMs: 100 }], parsePunctuation("a, b, c."), 5000);
        expect(got.filter(Boolean).length).toBeLessThanOrEqual(1);
    });
});

describe("findPhraseEnds merging", () => {
    it("merges gaps separated by only a sliver of speech", () => {
        // A long silence whose envelope dips back over threshold briefly should stay ONE gap,
        // not several competing for marks.
        const block = Math.floor(0.3 * RATE);
        const sig = new Float32Array(block * 4);
        for (let i = 0; i < block; i++) sig[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / RATE);
        // one 10ms blip in the middle of the long trailing silence
        for (let i = 0; i < Math.floor(0.01 * RATE); i++) {
            sig[block * 2 + i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / RATE);
        }
        expect(findPhraseEnds(sig, RATE).length).toBe(1);
    });
});
