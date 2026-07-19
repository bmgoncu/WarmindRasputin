import { speakableText, isToolActivity, stripMarkdown, summarizeForSpeech, parseLines } from "../src/server/claude/transcript.js";

const assistant = (content: unknown, id = "m1") => ({ type: "assistant", message: { id, role: "assistant", content } });

describe("speakableText", () => {
    it("speaks text blocks", () => {
        expect(speakableText(assistant([{ type: "text", text: "All systems operational." }]) as never))
            .toBe("All systems operational.");
    });

    it("NEVER speaks tool_use blocks", () => {
        // The speech policy in one assertion: no spoken "Read(...)" or "Grep(...)".
        expect(speakableText(assistant([{ type: "tool_use", name: "Read" }]) as never)).toBe("");
    });

    it("never speaks thinking blocks", () => {
        expect(speakableText(assistant([{ type: "thinking", text: "hmm" }]) as never)).toBe("");
    });

    it("keeps the text when a single message mixes text and tool_use", () => {
        // Measured on a real transcript: 263 message ids mix these two block types. Filtering per
        // MESSAGE rather than per BLOCK would silently drop half the narration.
        const line = assistant([
            { type: "text", text: "Reading the config." },
            { type: "tool_use", name: "Read" },
            { type: "thinking", text: "internal" },
        ]);
        expect(speakableText(line as never)).toBe("Reading the config.");
    });

    it("ignores non-assistant lines", () => {
        for (const type of ["user", "system", "attachment", "mode", "file-history-snapshot", "ai-title"]) {
            expect(speakableText({ type, message: { content: [{ type: "text", text: "x" }] } } as never)).toBe("");
        }
    });

    it("handles string content and missing content", () => {
        expect(speakableText({ type: "assistant", message: { content: "plain" } } as never)).toBe("plain");
        expect(speakableText({ type: "assistant", message: {} } as never)).toBe("");
        expect(speakableText({} as never)).toBe("");
    });
});

describe("isToolActivity", () => {
    it("detects a tool call for the visual pulse", () => {
        expect(isToolActivity(assistant([{ type: "tool_use", name: "Bash" }]) as never)).toBe(true);
        expect(isToolActivity(assistant([{ type: "text", text: "hi" }]) as never)).toBe(false);
    });
});

describe("stripMarkdown", () => {
    it("drops fenced code entirely", () => {
        expect(stripMarkdown("Before\n```js\nconst x = 1;\n```\nAfter")).toBe("Before After");
    });

    it("unwraps inline code, bold, italic and links", () => {
        expect(stripMarkdown("Run `npm test` now")).toBe("Run npm test now");
        expect(stripMarkdown("**bold** and *italic*")).toBe("bold and italic");
        expect(stripMarkdown("see [the docs](https://example.com)")).toBe("see the docs");
    });

    it("removes heading hashes and list bullets, which say pronounces", () => {
        expect(stripMarkdown("## Results\n- one\n- two")).toBe("Results one two");
        expect(stripMarkdown("1. first\n2. second")).toBe("first second");
    });

    it("collapses whitespace", () => {
        expect(stripMarkdown("a\n\n\nb   c")).toBe("a b c");
    });
});

describe("summarizeForSpeech", () => {
    it("passes short text through untouched", () => {
        expect(summarizeForSpeech("Build complete.")).toBe("Build complete.");
    });

    it("cuts at a sentence boundary when one fits", () => {
        const text =
            "The build finished. Twelve tests passed and one failed. " +
            "The failure is in the timeline module and looks like an off-by-one.";
        const out = summarizeForSpeech(text, 70);
        expect(out).toBe("The build finished. Twelve tests passed and one failed.");
        expect(out.endsWith(".")).toBe(true);
    });

    it("prefers a word cut over a uselessly short sentence cut", () => {
        // Deliberate trade-off: a sentence boundary is only taken if it retains at least 40% of
        // the budget. "Done." followed by 400 characters of detail should not summarise to "Done."
        // — that discards everything the listener needed.
        const out = summarizeForSpeech("Done. " + "detail ".repeat(80), 120);
        expect(out.startsWith("Done. detail")).toBe(true);
        expect(out.endsWith("…")).toBe(true);
    });

    it("never cuts mid-word when no sentence boundary fits", () => {
        const out = summarizeForSpeech("word ".repeat(200), 100);
        expect(out.length).toBeLessThanOrEqual(102);
        expect(out.endsWith("…")).toBe(true);
        expect(out).not.toMatch(/wor…$/);
    });

    it("strips markdown before measuring, so a code block does not eat the budget", () => {
        const text = "Done.\n```\n" + "y".repeat(500) + "\n```";
        expect(summarizeForSpeech(text, 100)).toBe("Done.");
    });
});

describe("parseLines", () => {
    it("parses JSONL and skips blanks", () => {
        expect(parseLines('{"type":"a"}\n\n{"type":"b"}\n')).toHaveLength(2);
    });

    it("skips a torn final line rather than throwing", () => {
        // A tail can land mid-line while the writer flushes. The file is append-only, so the next
        // read resumes from the offset actually consumed.
        const out = parseLines('{"type":"a"}\n{"type":"b","message":{"cont');
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe("a");
    });
});
