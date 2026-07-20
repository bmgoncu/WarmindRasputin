import { phrase, allPhrases, completionPhrase } from "../src/server/voice/phrases.js";

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
    it("names the project", () => {
        expect(completionPhrase("RasputinClaudeAI")).toContain("RasputinClaudeAI");
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
