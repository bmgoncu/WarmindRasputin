/**
 * Overlay-mode adaptation.
 *
 * The same renderer runs in Chrome for development and inside the Tauri window in production. The
 * differences are entirely presentational, and they live here so neither `main.ts` nor the orb has
 * to know which host it is in.
 *
 * In the overlay:
 *   - the page background goes fully transparent, so the orb floats over whatever is behind it
 *   - the dev controls are hidden by default, because an always-on-top window covered in sliders
 *     is a debugging tool, not an assistant
 *   - controls reappear while the window is interactive (Cmd+Shift+R), since that is the only
 *     moment they can be used at all — the window ignores the cursor the rest of the time
 */

/** True when running inside the Tauri webview rather than a browser tab. */
export function inOverlay(): boolean {
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
    return w.__TAURI_INTERNALS__ !== undefined || w.__TAURI__ !== undefined;
}

interface TauriBridge {
    event?: { listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<unknown> };
    core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

function bridge(): TauriBridge | null {
    return (window as unknown as { __TAURI__?: TauriBridge }).__TAURI__ ?? null;
}

/**
 * Applies overlay presentation and wires the interactivity toggle. No-op in a browser.
 *
 * Returns whether overlay mode was entered, so callers can log it.
 */
export function setupOverlay(controls: HTMLElement[]): boolean {
    if (!inOverlay()) return false;

    // The dev backdrop is a near-black used so the orb's darkest tones are visible in Chrome. In
    // the overlay it would show as a black square over the desktop.
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    const setControls = (visible: boolean): void => {
        for (const el of controls) el.style.display = visible ? "" : "none";
    };
    setControls(false);

    // Emitted by the Rust side on Cmd+Shift+R. Ambient = click-through, interactive = focused.
    void bridge()?.event?.listen("overlay-interactive", (e) => {
        setControls(e.payload === true);
    });

    return true;
}
