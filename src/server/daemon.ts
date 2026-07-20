/**
 * The daemon — everything except rendering.
 *
 * Owns synthesis, feature extraction, the audio cache, and the WebSocket control channel. The
 * renderer is a client: it receives `speak` with a URL and a timeline, and reports back when
 * audio actually starts.
 *
 * Audio is served over HTTP rather than pushed down the socket. The renderer needs it in an
 * AudioBuffer to schedule against `AudioContext.currentTime`, `fetch` + `decodeAudioData` is the
 * path that gets it there, and a URL is also replayable by hand when something sounds wrong.
 *
 * In development the page is served by Vite on 7332 and this daemon runs on 7331; the renderer
 * connects across. That split exists so the orb keeps hot reload. If `dist/` is present the
 * daemon serves it too, which is the Tauri path where there is no Vite.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { synthesize } from "./voice/synth.js";
import { pronounce } from "./voice/pronounce.js";
import { extractTimeline, toWire } from "./audio/timeline.js";
import { getChain } from "./voice/chains.js";
import { translate } from "./voice/translate.js";
import { SessionObserver, type HookPayload } from "./claude/observer.js";
import { hookState, setHook } from "./claude/install-hook.js";
import { readSessions } from "./claude/sessions.js";
import { ClaudeDriver } from "./claude/driver.js";
import { VoiceInput } from "./voice/listen.js";
import { allPhrases, phrase } from "./voice/phrases.js";
import { resolveTarget, typeInto } from "./input/type-into.js";
import { DAEMON_PORT, isClientMsg, type OrbConfig, type ServerMsg, type SpeakMsg } from "../shared/protocol.js";

const STARTED_AT = new Date().toISOString();
const CONFIG_PATH = resolve("cache", "config.json");

/**
 * Live settings, owned by the daemon.
 *
 * The daemon holds them rather than either window because the preferences window and the overlay
 * are separate webviews with no shared memory, and because settings must survive a reload of
 * either. Defaults match the values tuned by ear in M2.
 */
let config: OrbConfig = {
    idleFloor: 0.22,
    shakeScale: 1,
    outerRadius: 1.78,
    joltCount: 5,
    arcCount: 3,
    opaqueBackground: false,
    subtitles: true,
    chain: "measured",
    narrateSubagents: false,
    speechDetail: "full",
    persona: false,
    ambientVolume: 0.35,
    effectsVolume: 0.5,
    bgDuckVolume: 0.3,
    questionSound: true,
    dictateMode: "agent",
    dictateSubmit: true,
};

async function loadConfig(): Promise<void> {
    try {
        config = { ...config, ...(JSON.parse(await readFile(CONFIG_PATH, "utf8")) as OrbConfig) };
    } catch {
        // No saved config yet, or it is unreadable — defaults stand.
    }
}

async function saveConfig(): Promise<void> {
    try {
        await mkdir(dirname(CONFIG_PATH), { recursive: true });
        await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
        console.warn("could not persist config:", String(err));
    }
}
const CACHE_DIR = resolve("cache");
// vite.config.ts builds to lib/web, not dist/. This pointed at dist/ and so silently served 404
// for every asset in production — invisible in development, where Vite serves the page instead.
const DIST_DIR = resolve("lib", "web");
/** Rendered effects. Beside the bundled daemon in an installed app, in dist-sfx during development. */
const SFX_DIR = process.env.RASPUTIN_ASSETS_DIR
    ? resolve(process.env.RASPUTIN_ASSETS_DIR, "sfx")
    : resolve("dist-sfx");

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wav": "audio/wav",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
};

const clients = new Set<WebSocket>();

function broadcast(msg: ServerMsg): void {
    const json = JSON.stringify(msg);
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(json);
    }
}

/**
 * Resolves a URL path inside a root directory, or null if it escapes.
 *
 * `normalize` before the prefix check, not after: `/audio/../../etc/passwd` only collapses to
 * something outside the root once normalized, and comparing the raw path would pass it through.
 */
function safeJoin(root: string, urlPath: string): string | null {
    const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
    const full = resolve(join(root, rel));
    return full.startsWith(root) ? full : null;
}

async function serveFile(res: ServerResponse, path: string): Promise<boolean> {
    try {
        const s = await stat(path);
        if (!s.isFile()) return false;
        res.writeHead(200, {
            "content-type": MIME[extname(path)] ?? "application/octet-stream",
            "content-length": s.size,
            // The filename is a content hash, so the bytes can never change under it.
            "cache-control": extname(path) === ".wav" ? "public, max-age=31536000, immutable" : "no-cache",
        });
        createReadStream(path).pipe(res);
        return true;
    } catch {
        return false;
    }
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        let data = "";
        req.on("data", (c) => {
            data += c;
            // A hook payload or a line of text; anything larger is a mistake or an attack.
            if (data.length > 1_000_000) reject(new Error("body too large"));
        });
        req.on("end", () => resolvePromise(data));
        req.on("error", reject);
    });
}

/**
 * Renders one utterance and tells every renderer to play it.
 *
 * Synthesis is cached on a hash of the text and chain parameters, so repeated lines are instant —
 * but the timeline is recomputed each time regardless. It is a few ms over data already in memory,
 * and caching it separately would add a second invalidation path to get wrong.
 */
export async function speak(text: string, chain = "measured"): Promise<SpeakMsg> {
    // Translation happens here rather than inside synthesize so the audio cache stays a pure
    // function of the text it actually renders — and so a cached translation short-circuits
    // before any ffmpeg work is considered.
    const target = getChain(chain).translateTo;
    let spoken = text;
    if (target) {
        const t = await translate({ text, lang: target, cacheDir: CACHE_DIR });
        spoken = t.text;
        console.log(`translated${t.cached ? " (cached)" : ""}: ${text} -> ${spoken}`);
    }

    // Expanded for the synthesiser only. The caption keeps the original, because "512 MB" reads
    // better than "512 megabytes" on screen — see SpeakMsg.sourceText.
    const voiced = pronounce(spoken);
    const result = await synthesize({ text: voiced, chain, cacheDir: CACHE_DIR });
    const timeline = extractTimeline(result.samples, result.sampleRate);
    const msg: SpeakMsg = {
        type: "speak",
        id: randomUUID(),
        audioUrl: `/audio/${result.wavPath.split("/").pop()}`,
        timeline: toWire(timeline),
        // What was SPOKEN, not what was typed.
        text: spoken,
        // Kept separately so subtitles can show the meaning rather than the phonetics. Also how
        // the caption avoids the pronunciation expansion applied to `voiced`.
        sourceText: spoken === text ? undefined : text,
        chain,
    };
    broadcast(msg);
    return msg;
}

/**
 * Observes any Claude session that reports in.
 *
 * Speech is queued rather than fired in parallel: several sessions can finish at once, and
 * overlapping utterances are unintelligible. `speak` broadcasts and returns as soon as the audio
 * is rendered, so this serialises synthesis, not playback.
 */
let speaking = Promise.resolve();

/** Serialises synthesis so two sources cannot render and broadcast at the same moment. */
function enqueueSpeech(text: string): void {
    console.log(`say: ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`);
    speaking = speaking
        .then(() => speak(text, config.chain))
        .then(() => undefined)
        .catch((e) => console.error("speak failed:", e));
}

const observer = new SessionObserver({
    say: (text) => enqueueSpeech(text),
    pulse: (strength) => broadcast({ type: "pulse", strength }),
    state: (state) => broadcast({ type: "state", state }),
    question: (about) => {
        console.log(`question: ${about ?? "(waiting on you)"}`);
        if (config.questionSound !== false) broadcast({ type: "question", about });
    },
    focus: (info) => {
        lastFocus = { type: "focus", ...info };
        // A spoken instruction should act on the project being watched, not on the daemon's own
        // directory. Following focus is what makes "run the tests" mean the right repo.
        if (info.cwd) driver.setCwd(info.cwd);
        broadcast(lastFocus);
    },
});

/**
 * Last focus broadcast, replayed to windows that connect later.
 *
 * The overlay may reload or the app may start after a session is already being narrated; without
 * this the tray would sit blank until the next session event, which can be minutes.
 */
let lastFocus: ServerMsg & { type: "focus" } = { type: "focus", sessions: 0 };
let drivenSessionId: string | null = null;

/**
 * The session Rasputin runs himself.
 *
 * Its speech goes through the same queue as the observer's, so a driven answer and a narrated one
 * cannot talk over each other.
 */
const voice = new VoiceInput({ log: (m) => console.log(`voice: ${m}`) });

/**
 * Starts capturing and darkens the orb.
 *
 * The orb dropping to zero is the whole feedback signal — with the idle floor at 0.22 there is
 * otherwise nothing to distinguish "listening" from "sitting there".
 */
async function listenDown(): Promise<void> {
    if (await voice.start()) broadcast({ type: "state", state: "listening" });
}

/** Transcribes and sends the result to Claude. */
async function listenUp(): Promise<void> {
    broadcast({ type: "state", state: "thinking" });
    const text = await voice.stop();
    if (!text) {
        console.log("voice: nothing transcribed");
        enqueueSpeech(phrase("empty"));
        broadcast({ type: "state", state: "idle" });
        return;
    }
    console.log(`heard (${config.dictateMode === "type" ? "type" : "agent"} mode): ${text}`);
    // Always shown, whatever happens to it next. Seeing what was heard is how a misheard phrase is
    // caught, and that matters as much when the text goes to the agent as when it is typed.
    broadcast({ type: "caption", text, holdSec: 4 });
    // Answered locally and immediately. A round trip to the agent is seconds, and the gap between
    // releasing the key and hearing anything is where the interface feels dead. This is queued
    // before the agent is even consulted, so it plays while Claude is still thinking.
    enqueueSpeech(phrase("ack"));

    if (config.dictateMode === "type") {
        await dictateIntoSession(text);
        return;
    }
    driver.ask(text);
}

/**
 * Types a dictated instruction into the terminal running the chosen session.
 *
 * Shown as a caption first and typed only after a pause, so a misheard phrase can be seen — and
 * focus moved — before any keystrokes are sent. Typing into the wrong window is not undoable.
 */
async function dictateIntoSession(text: string): Promise<void> {
    const wanted = config.focusSessionId ?? lastFocus.sessionId;
    const live = await readSessions();
    const session = wanted ? live.find((s) => s.sessionId === wanted) : undefined;
    if (!session) {
        console.log("dictate: no target session — pick one in Preferences");
        enqueueSpeech(phrase("failed"));
        broadcast({ type: "state", state: "idle" });
        return;
    }

    const target = await resolveTarget({ pid: session.pid, cwd: session.cwd, name: session.name });
    if (target.kind === "none") {
        console.log(`dictate: ${target.description}`);
        enqueueSpeech(phrase("failed"));
        broadcast({ type: "state", state: "idle" });
        return;
    }

    console.log(`dictate → ${target.description}: ${text}`);
    // The pause the user asked for: enough to read it and move focus if it is wrong.
    await new Promise((r) => setTimeout(r, 1200));

    const ok = await typeInto(target, text, config.dictateSubmit !== false);
    if (!ok) {
        console.log("dictate: could not type — check Accessibility permission for Rasputin");
        enqueueSpeech(phrase("failed"));
    }
    broadcast({ type: "state", state: "idle" });
}

const driver = new ClaudeDriver({
    say: (text) => enqueueSpeech(text),
    state: (state) => broadcast({ type: "state", state }),
    log: (message) => console.log(`driver: ${message}`),
    session: (sessionId) => {
        drivenSessionId = sessionId;
        observer.excludeSession(sessionId);
        // Printed in full and resumable on purpose: a driven session is spoken, not shown, so
        // without this there is no way to read back what was actually asked and answered.
        console.log(`driver session ${sessionId} — read it with: claude --resume ${sessionId}`);
    },
});

/**
 * Renders every canned line into the cache at startup.
 *
 * Their whole purpose is to be instant; a cold render is 300-800ms of exactly the silence they
 * exist to cover. Sequential rather than parallel — a dozen concurrent ffmpeg chains would fight
 * over the CPU with whatever the user is actually doing.
 */
async function warmPhrases(): Promise<void> {
    const chain = config.chain ?? "measured";
    // og-warmind translates before speaking, so warming it would fire a dozen CLI round trips.
    if (chain === "og-warmind") return;
    const started = Date.now();
    for (const line of allPhrases()) {
        try {
            await synthesize({ text: line, chain, cacheDir: CACHE_DIR });
        } catch {
            return; // voice pipeline unavailable; not worth reporting on every line
        }
    }
    console.log(`warmed ${allPhrases().length} canned lines in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    // The dev page is served by Vite on another origin, so it needs CORS to reach this daemon.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
    }

    if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        // startedAt is here because a stale daemon is otherwise invisible: it answers every
        // request normally while serving whatever code it was launched with. That cost a real
        // debugging detour — og-warmind subtitles appeared to ignore sourceText when in fact the
        // process predated the field. `npm run daemon` now runs under `tsx watch`.
        res.end(JSON.stringify({ ok: true, clients: clients.size, pid: process.pid, startedAt: STARTED_AT }));
        return;
    }

    if (url.pathname === "/speak" && req.method === "POST") {
        try {
            const body = JSON.parse((await readBody(req)) || "{}") as { text?: string; chain?: string };
            if (!body.text?.trim()) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "text is required" }));
                return;
            }
            const msg = await speak(body.text, body.chain);
            res.writeHead(200, { "content-type": "application/json" });
            // The timeline is large and the caller already got it over the socket.
            res.end(JSON.stringify({ id: msg.id, audioUrl: msg.audioUrl, frames: msg.timeline.env.length }));
        } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
        }
        return;
    }

    if (url.pathname === "/event" && req.method === "POST") {
        // Answered immediately and unconditionally. The hook is configured `async: true`, but a
        // slow or failing endpoint here must never be able to stall someone's Claude session.
        res.writeHead(204).end();
        try {
            const payload = JSON.parse((await readBody(req)) || "{}") as HookPayload;
            observer.handleHook(payload);
        } catch (err) {
            console.warn("bad hook payload:", String(err));
        }
        return;
    }

    // Narration on/off, driven from Preferences so the terminal is not required.
    if (url.pathname === "/hook") {
        if (req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(await hookState()));
            return;
        }
        if (req.method === "POST") {
            try {
                const body = JSON.parse((await readBody(req)) || "{}") as { enabled?: boolean };
                const result = await setHook(body.enabled === true);
                const state = await hookState();
                // One switch, one meaning: the hook and narration are the same decision. Leaving
                // them separate would let the daemon narrate with no hook installed, which is
                // exactly the surprise this gate exists to prevent.
                observer.setEnabled(state.installed);
                if (result.changed) {
                    console.log(`hook ${state.installed ? "installed" : "removed"}${result.backup ? ` (backup: ${result.backup})` : ""}`);
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ...state, changed: result.changed, backup: result.backup }));
            } catch (err) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: String(err) }));
            }
            return;
        }
    }

    // Push-to-talk over HTTP too, so it can be driven from a script or a hotkey daemon.
    if (url.pathname === "/listen" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { phase?: string };
        if (body.phase === "down") void listenDown();
        else if (body.phase === "up") void listenUp();
        else void voice.cancel();
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, recording: voice.isRecording }));
        return;
    }

    // Drive Claude over HTTP as well as the socket, so it is scriptable and testable by hand.
    if (url.pathname === "/ask" && req.method === "POST") {
        try {
            const body = JSON.parse((await readBody(req)) || "{}") as { text?: string };
            if (!body.text?.trim()) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "text is required" }));
                return;
            }
            driver.ask(body.text);
            res.writeHead(202, { "content-type": "application/json" });
            res.end(JSON.stringify({ accepted: true, running: driver.isRunning }));
        } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
        }
        return;
    }

    if (url.pathname === "/sessions" && req.method === "GET") {
        const live = await readSessions();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                driven: drivenSessionId,
                drivenCwd: driver.workingDir,
                enabled: observer.isEnabled,
                subagents: observer.isNarratingSubagents,
                pinned: observer.pinnedSession,
                sessions: live.map((entry) => ({
                    sessionId: entry.sessionId,
                    cwd: entry.cwd,
                    project: entry.cwd?.split("/").filter(Boolean).pop(),
                    name: entry.name,
                    status: entry.status,
                    pid: entry.pid,
                })),
            }),
        );
        return;
    }

    if (url.pathname === "/observed" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ watching: observer.watching }));
        return;
    }

    if (url.pathname.startsWith("/sfx/")) {
        const path = safeJoin(SFX_DIR, url.pathname.slice("/sfx".length));
        if (path && (await serveFile(res, path))) return;
        res.writeHead(404).end("no such effect");
        return;
    }

    if (url.pathname.startsWith("/audio/")) {
        const path = safeJoin(CACHE_DIR, url.pathname.slice("/audio".length));
        if (path && (await serveFile(res, path))) return;
        res.writeHead(404).end("no such audio");
        return;
    }

    // Static page, when built to lib/web. Absent in dev, where Vite serves it.
    const asset = safeJoin(DIST_DIR, url.pathname === "/" ? "/index.html" : url.pathname);
    if (asset && (await serveFile(res, asset))) return;

    res.writeHead(404).end("not found");
}

export function start(port = Number(process.env.RASPUTIN_PORT ?? DAEMON_PORT)): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
        handle(req, res).catch((err) => {
            console.error("request failed:", err);
            if (!res.headersSent) res.writeHead(500).end("internal error");
        });
    });

    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws) => {
        clients.add(ws);
        ws.on("close", () => clients.delete(ws));
        ws.on("error", (err) => console.error("ws error:", err));
        ws.on("message", (raw) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw.toString());
            } catch {
                console.warn("dropped unparseable client message");
                return;
            }
            if (!isClientMsg(parsed)) {
                console.warn("dropped unknown client message:", parsed);
                return;
            }
            switch (parsed.type) {
                case "hello":
                    console.log(`renderer attached: ${parsed.agent} (${clients.size} total)`);
                    break;
                case "playback":
                    // This is the authoritative speaking signal — see the protocol doc.
                    console.log(`playback ${parsed.phase} ${parsed.id.slice(0, 8)}`);
                    break;
                case "say":
                    void speak(parsed.text, parsed.chain ?? config.chain).catch((e) =>
                        console.error("speak failed:", e),
                    );
                    break;
                case "ask":
                    console.log(`ask: ${parsed.text.slice(0, 80)}`);
                    driver.ask(parsed.text);
                    break;
                case "interrupt":
                    void driver.interrupt();
                    break;
                case "listen":
                    if (parsed.phase === "down") void listenDown();
                    else if (parsed.phase === "up") void listenUp();
                    else void voice.cancel().then(() => broadcast({ type: "state", state: "idle" }));
                    break;
                case "set-config": {
                    const { type: _ignored, ...patch } = parsed;
                    config = { ...config, ...patch };
                    if ("focusSessionId" in patch) observer.setPinned(patch.focusSessionId ?? null);
                    if ("narrateSubagents" in patch) observer.setNarrateSubagents(patch.narrateSubagents === true);
                    if ("persona" in patch) driver.setPersona(patch.persona === true);
                    if (patch.speechDetail) {
                        observer.setDetail(patch.speechDetail);
                        driver.setDetail(patch.speechDetail);
                    }
                    void saveConfig();
                    // Back to EVERY renderer including the sender, so the overlay follows the
                    // preferences window and a second preferences window cannot drift.
                    broadcast({ type: "config", ...config });
                    break;
                }
                case "log": {
                    const tag = `[${parsed.level}]`;
                    console.log(`renderer ${tag} ${parsed.message}`);
                    break;
                }
                case "get-config":
                    ws.send(JSON.stringify({ type: "config", ...config } satisfies ServerMsg));
                    ws.send(JSON.stringify(lastFocus));
                    break;
            }
        });
    });

    void loadConfig().then(() => {
        observer.setPinned(config.focusSessionId ?? null);
        observer.setNarrateSubagents(config.narrateSubagents === true);
        observer.setDetail(config.speechDetail ?? "full");
        driver.setDetail(config.speechDetail ?? "full");
        driver.setPersona(config.persona === true);
    });
    // The installed hook is the record of consent, so it decides whether narration runs.
    void hookState().then((state) => {
        observer.setEnabled(state.installed);
        if (state.installed) console.log("narration on — hook is installed");
    });
    observer.start();
    // Warm the model in the background so the first push-to-talk is not the one that waits a
    // minute for a cold load.
    void voice.ensureServer();
    void warmPhrases();

    // Started by the overlay: exit when its stdin pipe closes.
    //
    // The parent holds the write end for its entire life, so this fires however the overlay dies —
    // including SIGKILL, where no shutdown handler runs. Without it a killed overlay orphans the
    // daemon, and the next launch finds the port taken by a process nothing owns.
    if (process.env.RASPUTIN_PARENT_PIPE === "1") {
        process.stdin.resume();
        const bye = (): void => {
            console.log("parent went away — exiting");
            process.exit(0);
        };
        process.stdin.on("end", bye);
        process.stdin.on("close", bye);
        process.stdin.on("error", bye);
    }

    server.listen(port, "127.0.0.1", () => {
        console.log(`rasputin daemon on http://127.0.0.1:${port}  (ws /ws)`);
    });
    return server;
}

// Only auto-start when run directly, so tests can import `speak` and `start` without binding a
// port. Compared as resolved paths — matching on basename alone would also fire for any other
// script happening to be called daemon.ts.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    start();
}
