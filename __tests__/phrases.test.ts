import { phrase, allPhrases } from "../src/server/voice/phrases.js";

describe("phrase", () => {
    it("returns a line for every kind", () => {
        for (const kind of ["ack", "listening", "empty", "failed", "complete"] as const) {
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
