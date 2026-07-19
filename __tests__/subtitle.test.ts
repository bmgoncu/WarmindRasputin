import { splitCues, MAX_CUE_CHARS } from "../src/web/ui/subtitle.js";

describe("splitCues", () => {
    it("returns nothing for empty input", () => {
        expect(splitCues("")).toEqual([]);
        expect(splitCues("   \n ")).toEqual([]);
    });

    it("keeps a short line as one cue spanning the whole utterance", () => {
        const c = splitCues("All systems operational.");
        expect(c).toHaveLength(1);
        expect(c[0].start).toBe(0);
        expect(c[0].end).toBeCloseTo(1, 6);
    });

    it("splits on sentence boundaries", () => {
        const c = splitCues("All systems operational. The Warmind is awake. I am here.");
        expect(c.map((x) => x.text)).toEqual([
            "All systems operational.",
            "The Warmind is awake.",
            "I am here.",
        ]);
    });

    it("times cues proportionally to length and covers 0..1 without gaps", () => {
        const c = splitCues("Short one. A considerably longer sentence than the first one here.");
        expect(c[0].start).toBe(0);
        expect(c[c.length - 1].end).toBeCloseTo(1, 6);
        for (let i = 1; i < c.length; i++) expect(c[i].start).toBeCloseTo(c[i - 1].end, 6);
        // The longer sentence must occupy more of the timeline.
        expect(c[1].end - c[1].start).toBeGreaterThan(c[0].end - c[0].start);
    });

    it("does not split on a decimal point or an abbreviation", () => {
        expect(splitCues("Threat level 3.5 confirmed.")).toHaveLength(1);
        expect(splitCues("Dr. Smith is aboard.")).toHaveLength(1);
    });

    it("breaks an over-long sentence at a clause boundary", () => {
        const long =
            "Whether we wanted it or not we have stepped into a war with the Cabal on Mars, " +
            "and the Warmind has been silent for a very long time indeed.";
        const c = splitCues(long);
        expect(c.length).toBeGreaterThan(1);
        for (const cue of c) expect(cue.text.length).toBeLessThanOrEqual(MAX_CUE_CHARS + 2);
        expect(c[0].text.endsWith(",")).toBe(true);
    });

    it("never ends a cue mid-word", () => {
        const long = "a".repeat(30) + " " + "word ".repeat(40);
        for (const cue of splitCues(long)) {
            expect(cue.text).toBe(cue.text.trim());
            expect(cue.text.endsWith("wor")).toBe(false);
        }
    });

    it("reassembles to the original words in order", () => {
        const src = "First sentence here. Second one, which is rather longer, follows it. Third.";
        const joined = splitCues(src).map((c) => c.text).join(" ");
        expect(joined.replace(/\s+/g, " ")).toBe(src.replace(/\s+/g, " "));
    });
});
