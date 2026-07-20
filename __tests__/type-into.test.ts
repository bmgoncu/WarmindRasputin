import { matchScore } from "../src/server/input/type-into.js";

describe("matchScore", () => {
    it("scores an exact name 1", () => {
        expect(matchScore("LiveOps", "LiveOps")).toBe(1);
    });

    it("ignores case, spaces and punctuation", () => {
        // Real data: a Claude session name against a terminal tab someone typed by hand.
        expect(matchScore("BiAnalysis", "bi analysis")).toBe(1);
        expect(matchScore("IAPProblem", "iap problem")).toBe(1);
    });

    it("still matches when the tab has extra words", () => {
        expect(matchScore("ServerLogs", "Server err logs")).toBeGreaterThan(0.6);
    });

    it("tolerates a typo in either name", () => {
        // The session was named "RevereseEng" while the tab reads "ReverseEng".
        expect(matchScore("RevereseEng", "ReverseEng")).toBeGreaterThan(0.6);
    });

    it("REFUSES an unrelated tab rather than guessing", () => {
        // Selecting the wrong terminal sends the text to the wrong session, which is the failure
        // this module exists to prevent. Measured: a real non-match scores about 0.31.
        expect(matchScore("merge-mogul-7e", "LiveOps")).toBeLessThan(0.6);
        expect(matchScore("merge-mogul-7e", "Crashlytics")).toBeLessThan(0.6);
        expect(matchScore("Crashlytics", "iap problem")).toBeLessThan(0.6);
    });

    it("handles empty names", () => {
        expect(matchScore("", "LiveOps")).toBe(0);
        expect(matchScore("LiveOps", "")).toBe(0);
    });
});
