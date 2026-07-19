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
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { synthesize } from "./voice/synth.js";
import { extractTimeline, toWire } from "./audio/timeline.js";
import { getChain } from "./voice/chains.js";
import { translate } from "./voice/translate.js";
import { DAEMON_PORT, isClientMsg, type ServerMsg, type SpeakMsg } from "../shared/protocol.js";

const STARTED_AT = new Date().toISOString();
const CACHE_DIR = resolve("cache");
// vite.config.ts builds to lib/web, not dist/. This pointed at dist/ and so silently served 404
// for every asset in production — invisible in development, where Vite serves the page instead.
const DIST_DIR = resolve("lib", "web");

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

    const result = await synthesize({ text: spoken, chain, cacheDir: CACHE_DIR });
    const timeline = extractTimeline(result.samples, result.sampleRate);
    const msg: SpeakMsg = {
        type: "speak",
        id: randomUUID(),
        audioUrl: `/audio/${result.wavPath.split("/").pop()}`,
        timeline: toWire(timeline),
        // What was SPOKEN, not what was typed.
        text: spoken,
        // Kept separately so subtitles can show the meaning rather than the phonetics.
        sourceText: spoken === text ? undefined : text,
        chain,
    };
    broadcast(msg);
    return msg;
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

export function start(port = DAEMON_PORT): ReturnType<typeof createServer> {
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
                    void speak(parsed.text, parsed.chain).catch((e) => console.error("speak failed:", e));
                    break;
            }
        });
    });

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
