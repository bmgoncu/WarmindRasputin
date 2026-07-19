/**
 * Reading Claude Code transcripts.
 *
 * Transcripts are JSONL at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, strictly append-only
 * and written live. Subagent work lands separately at `<uuid>/subagents/agent-<id>.jsonl`.
 *
 * Everything here is a pure function over parsed lines. The file watching lives in tailer.ts, so
 * the parsing rules — which are where the traps are — can be tested without touching a filesystem.
 *
 * Line shapes seen in a real 3000-line transcript: `assistant`, `user`, `system`, `attachment`,
 * `mode`, `permission-mode`, `file-history-snapshot`, `file-history-delta`, `last-prompt`,
 * `queue-operation`, `ai-title`, `agent-name`. Only `assistant` matters for speech.
 */

/** A content block inside an assistant message. */
export interface ContentBlock {
    type: string;
    text?: string;
    name?: string;
}

export interface TranscriptLine {
    type?: string;
    uuid?: string;
    sessionId?: string;
    cwd?: string;
    message?: {
        id?: string;
        role?: string;
        content?: ContentBlock[] | string;
    };
}

/**
 * Text the orb should speak from one transcript line.
 *
 * **Filters on the BLOCK type, never the line or the message.** Measured on a real transcript:
 * 531 distinct `message.id`, 319 of which span more than one line (up to 6), and **263 mix `text`
 * and `tool_use` blocks under the same id**. So "skip messages containing a tool call" would
 * silently drop half the narration, and "speak any assistant line" would read tool invocations
 * aloud — the thing the speech policy exists to prevent.
 *
 * `thinking` blocks are excluded for the same reason as `tool_use`: they are internal reasoning,
 * not something Rasputin says. A real transcript carried 311 of them.
 */
export function speakableText(line: TranscriptLine): string {
    if (line.type !== "assistant") return "";
    const content = line.message?.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";

    return content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => (b.text ?? "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
}

/** True when the line represents tool activity — shown as a visual pulse, never narrated. */
export function isToolActivity(line: TranscriptLine): boolean {
    const content = line.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some((b) => b?.type === "tool_use");
}

/**
 * Strips markdown that should not be read aloud.
 *
 * Speech is not a terminal. Code fences, inline backticks, list bullets and heading hashes are all
 * layout, and `say` pronounces some of them ("hash hash Results"). Link text is kept and the URL
 * dropped — a spoken URL is noise.
 */
export function stripMarkdown(text: string): string {
    return (
        text
            // Fenced blocks go entirely: reading code aloud is never useful.
            .replace(/```[\s\S]*?```/g, " ")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/^\s{0,3}#{1,6}\s+/gm, "")
            .replace(/^\s*[-*+]\s+/gm, "")
            .replace(/^\s*\d+\.\s+/gm, "")
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/\*([^*]+)\*/g, "$1")
            .replace(/^\s*>\s?/gm, "")
            .replace(/^\s*\|.*\|\s*$/gm, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Trims a response to something worth speaking aloud.
 *
 * A long answer read in full is unusable — the point is to know what happened, not to hear an
 * essay. Cuts at a sentence boundary when one is available inside the budget, because stopping
 * mid-clause sounds like a fault rather than a summary.
 */
export function summarizeForSpeech(text: string, maxChars = 320): string {
    const clean = stripMarkdown(text);
    if (clean.length <= maxChars) return clean;

    const window = clean.slice(0, maxChars);
    const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (lastStop > maxChars * 0.4) return window.slice(0, lastStop + 1).trim();

    const lastSpace = window.lastIndexOf(" ");
    return `${(lastSpace > 0 ? window.slice(0, lastSpace) : window).trim()}…`;
}

/** Parses a JSONL chunk, skipping malformed lines rather than throwing on a partial write. */
export function parseLines(chunk: string): TranscriptLine[] {
    const out: TranscriptLine[] = [];
    for (const raw of chunk.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        try {
            out.push(JSON.parse(line) as TranscriptLine);
        } catch {
            // A tail can land mid-line while the writer is flushing. Dropping it is correct: the
            // file is append-only, so the next read starts from the byte offset we did consume.
        }
    }
    return out;
}
