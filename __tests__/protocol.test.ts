import { isServerMsg, isClientMsg, DAEMON_PORT, type ServerMsg, type ClientMsg } from "../src/shared/protocol.js";

describe("message guards", () => {
    it("accepts every ServerMsg variant", () => {
        const msgs: ServerMsg[] = [
            { type: "state", state: "thinking" },
            { type: "stop" },
            { type: "pulse", strength: 0.5 },
            { type: "config", idleFloor: 0.22 },
            {
                type: "speak",
                id: "x",
                audioUrl: "/audio/a.wav",
                text: "hi",
                chain: "measured",
                timeline: { fps: 86, durationSec: 1, env: [], flux: [], onsets: [], centroid: [], bands: [] },
            },
        ];
        for (const m of msgs) expect(isServerMsg(m)).toBe(true);
    });

    it("accepts every ClientMsg variant", () => {
        const msgs: ClientMsg[] = [
            { type: "hello", agent: "chrome-dev" },
            { type: "playback", id: "x", phase: "started" },
            { type: "say", text: "hi" },
        ];
        for (const m of msgs) expect(isClientMsg(m)).toBe(true);
    });

    it("rejects junk rather than throwing", () => {
        // These arrive over a socket from another process, so a bad one must be droppable, not
        // an exception inside the renderer's message handler.
        for (const junk of [null, undefined, 0, "speak", [], {}, { type: "nope" }, { type: 1 }]) {
            expect(isServerMsg(junk)).toBe(false);
            expect(isClientMsg(junk)).toBe(false);
        }
    });

    it("does not confuse the two directions", () => {
        expect(isServerMsg({ type: "hello", agent: "x" })).toBe(false);
        expect(isClientMsg({ type: "stop" })).toBe(false);
    });

    it("pins the daemon port the hook config and renderer both assume", () => {
        expect(DAEMON_PORT).toBe(7331);
    });
});
