/**
 * Canned lines, spoken without asking Claude anything.
 *
 * A round trip to the agent is seconds; an acknowledgement has to land in well under one or the
 * interface feels dead between releasing the key and hearing anything. These never leave the
 * daemon, and they are pre-rendered at startup so the cache is already hot when the first one is
 * needed — a cold render is 300-800ms of exactly the silence they exist to fill.
 *
 * Register is Rasputin's: cold, machine-logical, no pleasantries. "Acknowledged", never "Sure!".
 */

/** What a canned line is for. */
export type PhraseKind = "ack" | "listening" | "empty" | "failed" | "complete";

const PHRASES: Record<PhraseKind, string[]> = {
    /** Spoken the moment a spoken instruction has been transcribed, before Claude is consulted. */
    ack: [
        "Acknowledged.",
        "Directive received.",
        "Processing.",
        "Query accepted.",
        "Understood. Executing.",
        "Compliance.",
        "Input received. Analysing.",
        "Working.",
        "Affirmative. Proceeding.",
        "Directive logged. Stand by.",
    ],
    /** Optional confirmation that capture has begun. */
    listening: ["Listening.", "Speak.", "Awaiting input.", "Channel open."],
    /** The microphone heard nothing worth transcribing. */
    empty: ["No input detected.", "Silence. Repeat the directive.", "Nothing received."],
    /** Something in the pipeline failed. */
    failed: ["Subroutine failure.", "Unable to comply.", "Directive could not be processed."],
    /** A driven or observed task finished. */
    complete: ["Task complete.", "Directive fulfilled.", "Operation concluded.", "Done."],
};

/** Remembers the last line of each kind, so the same one is never heard twice running. */
const lastUsed = new Map<PhraseKind, string>();

/**
 * Picks a line, avoiding an immediate repeat.
 *
 * With ten acknowledgements a naive random pick still repeats about one time in ten, and hearing
 * "Acknowledged. Acknowledged." is exactly the tell that it is a canned list.
 */
export function phrase(kind: PhraseKind): string {
    const options = PHRASES[kind];
    const previous = lastUsed.get(kind);
    const pool = options.length > 1 ? options.filter((p) => p !== previous) : options;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    lastUsed.set(kind, chosen);
    return chosen;
}

/** Every line, for pre-rendering. */
export function allPhrases(): string[] {
    return Object.values(PHRASES).flat();
}
