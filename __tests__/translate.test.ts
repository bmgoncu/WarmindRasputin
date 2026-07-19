import { sanitizeTranslation, cacheKey } from "../src/server/voice/translate.js";

describe("sanitizeTranslation", () => {
    it("passes a clean translation through", () => {
        expect(sanitizeTranslation("Да")).toBe("Да");
        expect(sanitizeTranslation("  Все системы работают.  ")).toBe("Все системы работают.");
    });

    it("strips wrapping quotes, including the Russian ones", () => {
        // Left in, these are SPOKEN — the sanitizer is a correctness requirement, not tidiness.
        expect(sanitizeTranslation('"Да"')).toBe("Да");
        expect(sanitizeTranslation("'Да'")).toBe("Да");
        expect(sanitizeTranslation("«Да»")).toBe("Да");
        expect(sanitizeTranslation("“Да”")).toBe("Да");
    });

    it("unwraps a code fence", () => {
        expect(sanitizeTranslation("```\nДа\n```")).toBe("Да");
        expect(sanitizeTranslation("```text\nДа\n```")).toBe("Да");
    });

    it("drops a leading label", () => {
        expect(sanitizeTranslation("Translation: Да")).toBe("Да");
        expect(sanitizeTranslation("Russian: Да")).toBe("Да");
        expect(sanitizeTranslation("Перевод: Да")).toBe("Да");
    });

    it("keeps only the first line, so commentary is not spoken", () => {
        expect(sanitizeTranslation("Да\n\nNote: this is informal.")).toBe("Да");
        expect(sanitizeTranslation("Да\nAlternatively: Ага")).toBe("Да");
    });

    it("does not mangle a colon inside a real sentence", () => {
        const s = "Внимание: все системы работают.";
        expect(sanitizeTranslation(s)).toBe(s);
    });

    it("does not strip asymmetric or internal quotes", () => {
        expect(sanitizeTranslation('Он сказал "да" вчера.')).toBe('Он сказал "да" вчера.');
        expect(sanitizeTranslation('"Да')).toBe('"Да');
    });

    it("returns empty for empty input, so the caller can fall back", () => {
        expect(sanitizeTranslation("")).toBe("");
        expect(sanitizeTranslation("   \n  ")).toBe("");
    });
});

describe("cacheKey", () => {
    it("is stable for the same text and language", () => {
        expect(cacheKey("Yes", "Russian")).toBe(cacheKey("Yes", "Russian"));
    });

    it("separates languages and texts", () => {
        expect(cacheKey("Yes", "Russian")).not.toBe(cacheKey("Yes", "German"));
        expect(cacheKey("Yes", "Russian")).not.toBe(cacheKey("No", "Russian"));
    });

    it("is filename-safe and short", () => {
        expect(cacheKey("a b/../c", "Russian")).toMatch(/^[0-9a-f]{16}$/);
    });
});
