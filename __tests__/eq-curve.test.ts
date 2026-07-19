import { toFirequalizer, type EqCurve } from "../src/server/voice/eq-curve.js";

const curve: EqCurve = {
    fittedAt: "2026-07-19T00:00:00.000Z",
    ref: "assets/refs/rasputin_voice.wav",
    points: [
        { f: 40, g: 14.8 },
        { f: 190, g: -18 },
        { f: 1200, g: 0 },
    ],
};

describe("toFirequalizer", () => {
    it("escapes the entry separators", () => {
        // Load-bearing. An unescaped ';' inside a filter_complex string is a GRAPH separator:
        // ffmpeg would parse the rest of the curve as separate filter chains and build a
        // different, broken graph — usually without erroring.
        const filter = toFirequalizer(curve);
        expect(filter).toContain("\\;");
        expect(filter.replace(/\\;/g, "")).not.toContain(";");
    });

    it("emits one entry per point, in order, with gains intact", () => {
        expect(toFirequalizer(curve)).toBe(
            "firequalizer=gain_entry='entry(40,14.8)\\;entry(190,-18)\\;entry(1200,0)'",
        );
    });

    it("quotes the gain_entry value", () => {
        const filter = toFirequalizer(curve);
        expect(filter).toMatch(/gain_entry='.*'$/);
    });
});
