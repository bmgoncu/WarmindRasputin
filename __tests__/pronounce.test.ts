import { pronounce, loadSpeechMap } from "../src/server/voice/pronounce.js";

const map = loadSpeechMap("assets/speech-map.json");
const say = (s: string) => pronounce(s, map);

describe("units", () => {
    it("expands data sizes and times", () => {
        expect(say("512MB in 200ms")).toBe("512 megabytes in 200 milliseconds");
    });

    it("distinguishes MB from Mb — a factor of eight", () => {
        expect(say("100 Mb")).toBe("100 megabits");
        expect(say("100 MB")).toBe("100 megabytes");
    });

    it("uses the singular for exactly one", () => {
        expect(say("1 second")).toBe("1 second");
        expect(say("1 ms")).toBe("1 millisecond");
        expect(say("1.5 s")).toBe("1.5 seconds");
        expect(say("0 ms")).toBe("0 milliseconds");
    });

    it("handles a negative measurement", () => {
        expect(say("Peak was -45 dB")).toContain("-45 decibels");
    });

    it("requires a number, so prose is untouched", () => {
        // "s" and "min" are also a plural and a word; anchoring to a number removes the ambiguity.
        expect(say("the s and min values")).toBe("the s and minimum values");
        expect(say("this happens")).toBe("this happens");
    });
});

describe("symbols", () => {
    it("expands percentages, including before punctuation", () => {
        expect(say("CPU at 95%, done")).toContain("95 percent,");
        expect(say("Coverage is 87%.")).toBe("Coverage is 87 percent.");
    });

    it("expands comparisons", () => {
        expect(say("max <= 10")).toBe("maximum less than or equal to 10");
        expect(say("~30")).toContain("approximately 30");
    });

    it("leaves hyphens and paths alone", () => {
        // Replacing every symbol would split hyphenated words and turn pipes in paths into "or".
        expect(say("a-b hyphen stays")).toBe("a-b hyphen stays");
        expect(say("path/to|file")).toBe("path/to|file");
    });
});

describe("acronyms", () => {
    it("spells out ones say mangles", () => {
        expect(say("the JWT in the YAML")).toBe("the J W T in the Y A M L");
        expect(say("SQL over HTTPS")).toBe("S Q L over H T T P S");
    });

    it("is case-sensitive, so ordinary words survive", () => {
        expect(say("it is on us")).toBe("it is on us");
    });
});

describe("jargon", () => {
    it("expands common shorthand", () => {
        expect(say("pushed the repo config to prod")).toBe(
            "pushed the repository configuration to production",
        );
    });

    it("expands Latin abbreviations with trailing dots", () => {
        expect(say("e.g. this")).toBe("for example this");
        expect(say("i.e. that")).toBe("that is that");
    });

    it("matches whole words only", () => {
        // "repo" must not fire inside "reporter", or prose is quietly corrupted.
        expect(say("the reporter said")).toBe("the reporter said");
        expect(say("a repository exists")).toBe("a repository exists");
    });
});

describe("robustness", () => {
    it("survives an empty or missing map", () => {
        const empty = { units: {}, symbols: {}, spell: [], jargon: {} };
        expect(pronounce("512MB in 200ms", empty)).toBe("512MB in 200ms");
    });

    it("returns empty for empty input", () => {
        expect(say("")).toBe("");
    });
});
