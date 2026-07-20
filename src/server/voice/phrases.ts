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
export type PhraseKind = "ack" | "listening" | "empty" | "failed" | "complete" | "completeNamed";

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
    /**
     * A task finished, with no project to name.
     *
     * Used when the session's working directory is unknown — rare, but a completion announcement
     * that says "undefined" is worse than one that says less.
     */
    complete: [
        "Directive fulfilled.",
        "Operation concluded.",
        "Task complete. Returning to standby.",
        "Execution ended. All subroutines idle.",
        "Objective achieved.",
        "Work has ceased. Awaiting further directives.",
    ],
    /**
     * A task finished on a named project. `{project}` is substituted.
     *
     * Written so the project name lands late where possible — it is the one word a listener is
     * waiting for, and a phrase that opens with it is half heard before they are paying attention.
     */
    completeNamed: [
        "Directive fulfilled. {project}.",
        "Operation concluded on {project}.",
        "{project}. Objective achieved.",
        "Task complete. {project} returns to standby.",
        "Execution ended on {project}. All subroutines idle.",
        "{project} is quiet. Work has ceased.",
        "Cycle closed on {project}.",
        "{project}: directive discharged.",
    ],
};

/**
 * Project names that should be spoken differently from how they are written on disk.
 *
 * Keyed by the normalised directory name, so case and punctuation in the folder do not matter.
 */
const SPOKEN_NAMES: Record<string, string> = {
    rasputinclaudeai: "Warmind Rasputin",
};

/**
 * Turns a directory name into something worth saying aloud.
 *
 * Directory names are written for filesystems, not for speech: `RasputinClaudeAI` runs three words
 * together and `merge-mogul_2` is read as punctuation. Splitting camel case and turning separators
 * into spaces fixes most of it; the alias table handles the ones where the project is simply called
 * something else out loud.
 */
export function spokenProjectName(project: string): string {
    const trimmed = project.trim();
    if (!trimmed) return trimmed;

    const alias = SPOKEN_NAMES[trimmed.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (alias) return alias;

    return (
        trimmed
            // Split camel and Pascal case: "mergeMogul" and "RasputinClaudeAI" both become words.
            // The second rule catches the boundary in an acronym run, e.g. "AITools" -> "AI Tools".
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .replace(/[-_.]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/** Remembers the last line of each kind, so the same one is never heard twice running. */
const lastUsed = new Map<PhraseKind, string>();

/**
 * Picks a line, avoiding an immediate repeat.
 *
 * With ten acknowledgements a naive random pick still repeats about one time in ten, and hearing
 * "Acknowledged. Acknowledged." is exactly the tell that it is a canned list.
 */
export function phrase(kind: PhraseKind, vars: Record<string, string> = {}): string {
    const options = PHRASES[kind];
    const previous = lastUsed.get(kind);
    const pool = options.length > 1 ? options.filter((p) => p !== previous) : options;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    lastUsed.set(kind, chosen);
    return chosen.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/**
 * The line spoken when a task finishes.
 *
 * Falls back to the unnamed set when there is no project, rather than substituting an empty string
 * and announcing "Operation concluded on ." — a completion is the one announcement most likely to
 * be heard from another room, so it has to survive missing data cleanly.
 */
export function completionPhrase(project?: string): string {
    const name = project?.trim();
    return name ? phrase("completeNamed", { project: spokenProjectName(name) }) : phrase("complete");
}

/**
 * Lines the Test voice button speaks.
 *
 * Kept here so they are warmed with everything else — the button exists to check the queue and the
 * subtitle, and waiting several seconds for a cold render obscures both.
 */
export const TEST_LINES = [
    "I am Rasputin, the Warmind! At your service!",
    "Alpha one, the first utterance.",
    "Bravo two, the second utterance.",
    "Charlie three, the third utterance.",
];

/** Every line, for pre-rendering. */
export function allPhrases(): string[] {
    // completeNamed carries a placeholder, so it cannot be pre-rendered — the project is only known
    // when a task actually finishes.
    const warmable = Object.entries(PHRASES)
        .filter(([kind]) => kind !== "completeNamed")
        .flatMap(([, lines]) => lines);
    return [...warmable, ...TEST_LINES];
}
