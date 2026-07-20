/**
 * The fitted matching-EQ curve: shared type, loader, and firequalizer serialization.
 *
 * Produced by `npm run fit-eq`, consumed by chains.ts. Absent curve = chain renders unmatched,
 * which is the correct behaviour before anyone has run the fitter.
 */

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

/**
 * Where the fitted curve lives.
 *
 * RASPUTIN_ASSETS_DIR is set by the overlay when it runs the bundled daemon: an installed app
 * cannot write inside its own bundle, so it works from a directory in Application Support while
 * its read-only data stays in Resources.
 */
export const CURVE_PATH = process.env.RASPUTIN_ASSETS_DIR
    ? join(process.env.RASPUTIN_ASSETS_DIR, "eq-curve.json")
    : "assets/eq-curve.json";

export interface EqPoint {
    /** Control frequency in Hz. */
    f: number;
    /** Correction in dB at that frequency. */
    g: number;
}

export interface EqCurve {
    fittedAt: string;
    ref: string;
    points: EqPoint[];
}

let cached: EqCurve | null | undefined;

export function loadCurve(path = CURVE_PATH): EqCurve | null {
    if (cached !== undefined) return cached;
    cached = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as EqCurve) : null;
    return cached;
}

/** Test seam — fit-eq writes the file mid-process, so the cache has to be droppable. */
export function clearCurveCache(): void {
    cached = undefined;
}

/**
 * Serializes to a `firequalizer` filter.
 *
 * The semicolons separating entries MUST be backslash-escaped: an unescaped `;` inside a
 * filter_complex string is a graph separator and silently produces a different (broken) graph.
 */
export function toFirequalizer(curve: EqCurve): string {
    const entries = curve.points.map((p) => `entry(${p.f},${p.g})`).join("\\;");
    return `firequalizer=gain_entry='${entries}'`;
}
