import { personaPrompt } from "../src/server/claude/persona.js";

describe("personaPrompt", () => {
    it("establishes the Warmind register", () => {
        const p = personaPrompt();
        expect(p).toMatch(/Rasputin/);
        expect(p).toMatch(/Warmind/);
        expect(p).toMatch(/no pleasantries/i);
    });

    it("forbids markdown, because it is read aloud", () => {
        // say pronounces heading hashes and list bullets; the rest is dropped silently.
        const p = personaPrompt();
        expect(p).toMatch(/no markdown/i);
        expect(p).toMatch(/code fences|bullet/i);
    });

    it("protects substance from the register", () => {
        // The requirement this project has carried from the start: terseness applies to tone, never
        // to content. A persona that says "be terse" makes this the easiest failure to fall into.
        const p = personaPrompt();
        expect(p).toMatch(/not sacrificed/i);
        expect(p).toMatch(/what failed and why/i);
    });

    it("changes length guidance with detail", () => {
        expect(personaPrompt({ detail: "brief" })).toMatch(/two sentences at most/i);
        expect(personaPrompt({ detail: "full" })).toMatch(/as long as the content/i);
        expect(personaPrompt({ detail: "brief" })).not.toBe(personaPrompt({ detail: "full" }));
    });

    it("defaults to full, so detail is never dropped by accident", () => {
        expect(personaPrompt()).toBe(personaPrompt({ detail: "full" }));
    });
});
