import { phrase, allPhrases, completionPhrase, spokenProjectName } from "../src/server/voice/phrases.js";

describe("phrase", () => {
    it("returns a line for every kind", () => {
        for (const kind of ["ack", "listening", "empty", "failed", "complete", "completeNamed"] as const) {
            expect(phrase(kind).length).toBeGreaterThan(0);
        }
    });

    it("never repeats the same line twice in a row", () => {
        // Hearing "Acknowledged. Acknowledged." is the tell that it is a canned list.
        let previous = "";
        for (let i = 0; i < 60; i++) {
            const next = phrase("ack");
            expect(next).not.toBe(previous);
            previous = next;
        }
    });

    it("uses more than one line over a run", () => {
        const seen = new Set(Array.from({ length: 40 }, () => phrase("ack")));
        expect(seen.size).toBeGreaterThan(3);
    });

    it("copes with a kind that has a single option", () => {
        // Filtering out the previous line must not leave an empty pool.
        for (let i = 0; i < 5; i++) expect(typeof phrase("failed")).toBe("string");
    });

    it("stays in the Warmind register — no pleasantries", () => {
        const banned = /\b(sure|okay|ok|thanks|please|sorry|happy to)\b/i;
        for (const line of allPhrases()) expect(line).not.toMatch(banned);
    });

    it("keeps every line short enough to be instant", () => {
        for (const line of allPhrases()) expect(line.length).toBeLessThanOrEqual(45);
    });
});

describe("completionPhrase", () => {
    it("names the project, in its SPOKEN form", () => {
        // Directory names are not read out verbatim — see spokenProjectName.
        expect(completionPhrase("RasputinClaudeAI")).toContain("Warmind Rasputin");
        expect(completionPhrase("merge-mogul")).toContain("merge mogul");
    });

    it("leaves no placeholder behind", () => {
        for (let i = 0; i < 30; i++) expect(completionPhrase("merge-mogul")).not.toContain("{");
    });

    it("falls back cleanly when there is no project", () => {
        // Substituting an empty string would announce "Operation concluded on ." — a completion is
        // the announcement most likely to be heard from another room, so it must survive missing
        // data rather than read out the gap.
        for (const missing of [undefined, "", "   "]) {
            const line = completionPhrase(missing);
            expect(line).not.toContain("{");
            expect(line).not.toMatch(/\son\s*\.|:\s*$|\s\.\s*$/);
            expect(line.length).toBeGreaterThan(8);
        }
    });

    it("varies rather than repeating", () => {
        const seen = new Set(Array.from({ length: 40 }, () => completionPhrase("proj")));
        expect(seen.size).toBeGreaterThan(3);
    });

    it("never repeats twice in a row", () => {
        let previous = "";
        for (let i = 0; i < 40; i++) {
            const next = completionPhrase("proj");
            expect(next).not.toBe(previous);
            previous = next;
        }
    });

    it("stays in register", () => {
        const banned = /\b(sure|okay|great|awesome|thanks|finished up|all set)\b/i;
        for (let i = 0; i < 30; i++) expect(completionPhrase("proj")).not.toMatch(banned);
    });
});

describe("spokenProjectName", () => {
    it("uses the alias for this project", () => {
        expect(spokenProjectName("RasputinClaudeAI")).toBe("Warmind Rasputin");
    });

    it("matches the alias regardless of case or punctuation in the folder", () => {
        expect(spokenProjectName("rasputin-claude-ai")).toBe("Warmind Rasputin");
        expect(spokenProjectName("rasputinclaudeai")).toBe("Warmind Rasputin");
    });

    it("splits camel and Pascal case", () => {
        // Directory names are written for filesystems; run together they are unintelligible aloud.
        expect(spokenProjectName("HomeAssitant")).toBe("Home Assitant");
        expect(spokenProjectName("mergeMogul")).toBe("merge Mogul");
    });

    it("keeps an acronym together but separates the word after it", () => {
        expect(spokenProjectName("AIToolsKit")).toBe("AI Tools Kit");
    });

    it("turns separators into spaces", () => {
        expect(spokenProjectName("merge-mogul_2")).toBe("merge mogul 2");
        expect(spokenProjectName("bq-analytics-tools")).toBe("bq analytics tools");
    });

    it("leaves an ordinary lowercase name alone", () => {
        expect(spokenProjectName("api")).toBe("api");
    });

    it("handles empty input", () => {
        expect(spokenProjectName("")).toBe("");
        expect(spokenProjectName("   ")).toBe("");
    });
});
