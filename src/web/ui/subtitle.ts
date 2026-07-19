/**
 * Subtitles, matched to the Destiny 2 cutscene styling.
 *
 * Read off the reference frame rather than invented:
 *   - Helvetica Neue Medium, near-white but NOT pure white (#e8e8e6 — pure white reads as harsher
 *     than the reference against the dark band). See the font-family note in the CSS for why the
 *     Neue variant is named first.
 *   - A dark translucent band behind the text that fades to fully transparent at both ends,
 *     rather than a rectangle with hard edges. The fade is the detail that makes it read as
 *     Destiny rather than as a video player's caption box.
 *   - ONE band spanning both lines, sized to the longest line — not a box per wrapped line, and
 *     not a fixed-width strip. A full-width band behind three words is the obvious tell.
 *   - Centred, wrapping to at most two lines, low in the frame.
 *
 * Owned by the renderer rather than the harness so it ships with the Tauri overlay unchanged.
 * Built from DOM rather than drawn into the WebGL canvas: text rendering is the one thing the DOM
 * is unambiguously better at, and the overlay is a WKWebView regardless.
 */

/** Seconds the subtitle lingers after audio ends, so it does not vanish on the final syllable. */
const HOLD_AFTER_SEC = 0.6;

/**
 * Longest cue we will show at once, in characters.
 *
 * Sized so a cue wraps to at most two lines at the styled width — the reference never shows three.
 * Long sentences are split at clause boundaries rather than truncated.
 */
export const MAX_CUE_CHARS = 84;

/**
 * Words whose trailing period is not a sentence end.
 *
 * Deliberately excludes "no" and other real words that commonly END sentences — listing one of
 * those would silently glue two cues together every time it appeared, which is a worse failure
 * than splitting an abbreviation.
 */
const ABBREVIATIONS = new Set([
    "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "lt", "sgt", "col", "gen", "approx", "fig",
]);

/**
 * Sentence split that survives decimals and abbreviations.
 *
 * Requiring whitespace after the terminator handles "3.5" on its own — there is no space, so no
 * boundary. "Dr. Smith" needs the extra check, since the space is genuinely there.
 */
function splitSentences(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    const re = /[.!?…]+\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const before = text.slice(start, m.index);
        const lastWord = (before.match(/([A-Za-z.]+)$/)?.[1] ?? "").replace(/\./g, "").toLowerCase();
        // A single letter is an initial ("J. Smith"), not a sentence end.
        if (lastWord.length === 1 || ABBREVIATIONS.has(lastWord)) continue;
        out.push(text.slice(start, m.index + m[0].length).trim());
        start = m.index + m[0].length;
    }
    const tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out;
}

export interface Cue {
    text: string;
    /** Fraction of the utterance at which this cue starts, 0-1. */
    start: number;
    end: number;
}

/**
 * Splits text into cues and times them across the utterance.
 *
 * Timing is proportional to character count rather than derived from the audio. Real forced
 * alignment would need phoneme timings, and `say --interactive` is incompatible with `-o` so
 * there are no free word boundaries — but synthesized speech is evenly paced at a fixed wpm, so
 * length is a good predictor. Positions are FRACTIONS of the utterance, not seconds, so they stay
 * correct regardless of the rendered duration.
 */
export function splitCues(text: string): Cue[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const sentences = splitSentences(trimmed);

    const pieces: string[] = [];
    for (const sentence of sentences) {
        if (sentence.length <= MAX_CUE_CHARS) {
            pieces.push(sentence);
            continue;
        }
        // Too long for one cue: break at clause boundaries first, then at plain word boundaries,
        // so a cue never ends mid-word.
        let rest = sentence;
        while (rest.length > MAX_CUE_CHARS) {
            const window = rest.slice(0, MAX_CUE_CHARS);
            const clause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
            const cut = clause > MAX_CUE_CHARS * 0.45 ? clause + 1 : window.lastIndexOf(" ");
            if (cut <= 0) break;
            pieces.push(rest.slice(0, cut).trim());
            rest = rest.slice(cut).trim();
        }
        if (rest) pieces.push(rest);
    }
    if (pieces.length === 0) return [];

    const total = pieces.reduce((n, p) => n + p.length, 0);
    let acc = 0;
    return pieces.map((piece) => {
        const start = acc / total;
        acc += piece.length;
        return { text: piece, start, end: acc / total };
    });
}

export class Subtitle {
    private readonly root: HTMLDivElement;
    private readonly line: HTMLSpanElement;
    private hideTimer: number | null = null;
    private enabled = true;
    private cues: Cue[] = [];
    private active = -1;

    constructor(parent: HTMLElement = document.body) {
        this.root = document.createElement("div");
        this.root.className = "rasputin-subtitle";
        this.line = document.createElement("span");
        this.root.appendChild(this.line);
        parent.appendChild(this.root);
        this.style();
    }

    /**
     * Styles are applied through CSSOM rather than an injected `<style>` element.
     *
     * A `<style>` block is governed by the CSP's `style-src`, and Tauri rewrites the app CSP with
     * nonces — the presence of a nonce makes browsers ignore `'unsafe-inline'`, so the block was
     * silently dropped in the overlay while working fine in Chrome. An unstyled subtitle is a
     * static block after a 100vh canvas, i.e. off-screen: invisible, with nothing logged.
     *
     * Direct CSSOM property assignment is NOT subject to `style-src`, so this cannot be blocked.
     */
    private style(): void {
        Object.assign(this.root.style, {
            position: "fixed",
            left: "50%",
            bottom: "12%",
            transform: "translateX(-50%)",
            // Sized by its longest line, so a short subtitle gets a short band. A full-width band
            // behind three words is the obvious tell.
            width: "fit-content",
            maxWidth: "min(60vw, 780px)",
            padding: "0.34em 2.6em",
            textAlign: "center",
            pointerEvents: "none",
            opacity: "0",
            transition: "opacity 180ms ease-out",
            zIndex: "10",
            // ONE band spanning both lines, fading to nothing at each end. Putting the gradient on
            // the text instead (with box-decoration-break) draws a separate box per wrapped line,
            // which the reference never shows.
            backgroundImage:
                "linear-gradient(to right," +
                " rgba(6,6,8,0) 0%, rgba(6,6,8,0.55) 10%, rgba(6,6,8,0.76) 42%," +
                " rgba(6,6,8,0.72) 62%, rgba(6,6,8,0.5) 90%, rgba(6,6,8,0) 100%)",
        } satisfies Partial<CSSStyleDeclaration>);

        Object.assign(this.line.style, {
            // Helvetica Neue ahead of Helvetica deliberately. Measured, plain Helvetica renders
            // only THREE distinct faces across weights 300-700 — 300/400/500 all Regular and
            // 600/700 both Bold — so "slightly less bold" is unreachable with it. Neue has a real
            // Medium at 500, which is the weight this sits at.
            fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
            fontSize: "clamp(15px, 1.62vw, 25px)",
            fontWeight: "500",
            lineHeight: "1.36",
            letterSpacing: "0.004em",
            color: "#e8e8e6",
            // Keeps text legible where the band has faded to nothing at the ends.
            textShadow: "0 1px 3px rgba(0,0,0,0.92), 0 0 2px rgba(0,0,0,0.75)",
        } satisfies Partial<CSSStyleDeclaration>);
    }

    /** True when the styling actually took effect — surfaced in diagnostics. */
    get styled(): boolean {
        return getComputedStyle(this.root).position === "fixed";
    }

    setEnabled(on: boolean): void {
        this.enabled = on;
        if (!on) this.hide();
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    /** Current visible text, or "" — used by tests and the debug hook. */
    get text(): string {
        return this.root.classList.contains("on") ? this.line.textContent ?? "" : "";
    }

    /** Visible rect, for diagnostics — an off-screen subtitle is otherwise indistinguishable. */
    get rect(): { top: number; width: number; height: number } {
        const r = this.root.getBoundingClientRect();
        return { top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    }

    /** Loads an utterance as timed cues. Nothing displays until `update` is called. */
    setCues(text: string): void {
        this.cues = splitCues(text);
        this.active = -1;
    }

    /**
     * Advances to whichever cue covers `progress` (0-1 through the utterance).
     *
     * Driven by playback progress rather than a timer, so cues stay aligned to the audio even
     * when a frame is slow or playback is interrupted.
     */
    update(progress: number): void {
        if (!this.enabled || this.cues.length === 0) return;
        let idx = this.cues.findIndex((c) => progress < c.end);
        if (idx < 0) idx = this.cues.length - 1;
        if (idx === this.active) return;
        this.active = idx;
        this.show(this.cues[idx].text);
    }

    /** Cue count and current index — for the debug hook and tests. */
    get state(): { cues: number; active: number } {
        return { cues: this.cues.length, active: this.active };
    }

    show(text: string): void {
        if (!this.enabled || !text.trim()) return;
        this.root.style.opacity = "1";
        if (this.hideTimer !== null) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        this.line.textContent = text.trim();
        this.root.classList.add("on");
        this.root.style.opacity = "1";
    }

    /** Hides after a hold, so the last word is not cut off as the audio tail decays. */
    hideSoon(holdSec = HOLD_AFTER_SEC): void {
        if (this.hideTimer !== null) clearTimeout(this.hideTimer);
        this.hideTimer = window.setTimeout(() => {
            this.root.classList.remove("on");
            this.root.style.opacity = "0";
            this.hideTimer = null;
        }, holdSec * 1000);
    }

    hide(): void {
        this.cues = [];
        this.active = -1;
        if (this.hideTimer !== null) {
            clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
        this.root.classList.remove("on");
        this.root.style.opacity = "0";
    }
}
