/**
 * Expands shorthand before it is spoken.
 *
 * Applied to the SPOKEN text only. Subtitles keep the original, because "512 MB" is clearer to read
 * than "five hundred and twelve megabytes" and a caption exists to be scanned. The two diverge on
 * purpose — see `SpeakMsg.text` versus `sourceText`.
 *
 * `say` gets units and symbols wrong in ways that matter: it reads "-45 dB" as "dee bee", skips
 * "~" entirely, and attempts acronyms like JWT and YAML as words. The map is data rather than code
 * so it can be extended without touching this file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface SpeechMap {
    units: Record<string, [string, string]>;
    symbols: Record<string, string>;
    spell: string[];
    jargon: Record<string, string>;
}

/** Same relocation rule as the EQ curve — a bundled app reads its data from Resources. */
const MAP_PATH = process.env.RASPUTIN_ASSETS_DIR
    ? join(process.env.RASPUTIN_ASSETS_DIR, "speech-map.json")
    : "assets/speech-map.json";

let cached: SpeechMap | null = null;

export function loadSpeechMap(path = MAP_PATH): SpeechMap {
    if (cached) return cached;
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as SpeechMap & { _comment?: unknown };
        cached = { units: raw.units, symbols: raw.symbols, spell: raw.spell, jargon: raw.jargon };
    } catch {
        // Absent map is not fatal: speech is still intelligible, just less polished.
        cached = { units: {}, symbols: {}, spell: [], jargon: {} };
    }
    return cached;
}

/** Test seam — the module caches, and tests need to swap maps. */
export function resetSpeechMap(): void {
    cached = null;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Letter-by-letter, spaced so the synthesiser pauses between them.
 *
 * "S Q L" is read as three letters; "SQL" is attempted as a word and comes out "sequel" or worse.
 */
function spellOut(token: string): string {
    return token.split("").join(" ");
}

/**
 * Expands one line of text for speech.
 *
 * Order matters. Units run first because they are anchored to a preceding number and would
 * otherwise be eaten by the jargon pass — `s` is both "seconds" and a plural, and `min` is both
 * "minutes" and "minimum". Requiring the number removes that ambiguity entirely.
 */
export function pronounce(text: string, map = loadSpeechMap()): string {
    let out = text;

    // --- units: a number, then the unit, matched CASE-SENSITIVELY ---------------------------
    // MB is megabytes and Mb is megabits; treating them alike is a factor of eight.
    const units = Object.keys(map.units).sort((a, b) => b.length - a.length);
    if (units.length > 0) {
        const pattern = new RegExp(`(-?\\d+(?:[.,]\\d+)?)\\s*(${units.map(escapeRegex).join("|")})\\b`, "g");
        out = out.replace(pattern, (whole, num: string, unit: string) => {
            const forms = map.units[unit];
            if (!forms) return whole;
            const value = Number(num.replace(",", "."));
            // "1 second", but "1.5 seconds" and "0 seconds" — only exactly one is singular.
            const word = value === 1 || value === -1 ? forms[0] : forms[1];
            return `${num} ${word}`;
        });
    }

    // --- jargon: whole words, case-insensitive ----------------------------------------------
    for (const [short, long] of Object.entries(map.jargon)) {
        // \b does not work against a trailing dot in "e.g.", so the boundary is built explicitly.
        const boundary = /[a-z0-9]$/i.test(short) ? "\\b" : "(?=\\s|$|[,;:])";
        const re = new RegExp(`\\b${escapeRegex(short)}${boundary}`, "gi");
        out = out.replace(re, long);
    }

    // --- acronyms: spelled, case-sensitive so "IT" and "it" stay apart ----------------------
    for (const token of map.spell) {
        const re = new RegExp(`\\b${escapeRegex(token)}\\b`, "g");
        out = out.replace(re, spellOut(token));
    }

    // --- symbols ----------------------------------------------------------------------------
    const symbols = Object.keys(map.symbols).sort((a, b) => b.length - a.length);
    for (const symbol of symbols) {
        const word = map.symbols[symbol];
        // Only when standing alone or attached to a number: replacing every "-" would turn a
        // hyphenated word into two, and every "|" inside a path into "or". Trailing punctuation
        // counts as a boundary — "95%," and "95%." are the common cases and both were being missed.
        const re = new RegExp(
            `(?<=^|\\s|\\d)${escapeRegex(symbol)}(?=\\s|$|\\d|[,.;:!?)\\]])`,
            "g",
        );
        out = out.replace(re, word ? ` ${word} ` : " ");
    }

    // Symbol replacement pads with spaces, which leaves "95 percent ," behind. Inaudible, but the
    // expanded text is also what gets cached and logged.
    return out
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}
