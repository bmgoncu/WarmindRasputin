/**
 * Render one line and play it.
 *
 *   npm run say -- "All systems operational"
 *   npm run say -- --chain=clean "All systems operational"
 *   npm run say -- --no-play "..."     # render only, print the path
 *
 * Playback here uses `afplay`, which is fine for auditioning from a terminal. The real product
 * plays audio in the browser instead — see CLAUDE.md -> Architecture for why that distinction
 * matters (sample-accurate clock in the same process as the renderer).
 */

import { spawn } from "node:child_process";
import { synthesize } from "./synth.js";

function play(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const p = spawn("afplay", [path], { stdio: "ignore" });
        p.on("error", reject);
        p.on("close", () => resolve());
    });
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const chain = args.find((a) => a.startsWith("--chain="))?.split("=")[1];
    const noPlay = args.includes("--no-play");
    const text = args.filter((a) => !a.startsWith("--")).join(" ");

    if (!text) {
        console.error('Usage: npm run say -- [--chain=warmind|clean|dry] [--no-play] "text"');
        process.exitCode = 1;
        return;
    }

    const started = Date.now();
    const { wavPath, samples, sampleRate, cached } = await synthesize({ text, chain });
    const renderMs = Date.now() - started;

    console.log(
        `${wavPath}  ${(samples.length / sampleRate).toFixed(1)}s  ` +
            `${cached ? "cached" : `rendered in ${renderMs}ms`}`,
    );

    if (!noPlay) await play(wavPath);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
