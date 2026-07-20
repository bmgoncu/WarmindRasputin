/**
 * Renders the sound effects the renderer plays: the attention horn, the arc crackles, and the
 * ambient bed.
 *
 * Horn and arcs are synthesised, so they ship. The ambient hum is derived from reference media in
 * `assets/refs/`, which is gitignored and not ours to redistribute — it is used when present and
 * skipped otherwise, so a released copy simply has no bed rather than shipping something it should
 * not.
 */
import { writeFile, mkdir, access, copyFile } from "node:fs/promises";
import { synthHorn } from "../lib/server/audio/horn.js";
import { arcVariants } from "../lib/server/audio/arcs.js";

const RATE = 22050;
const OUT = "dist-sfx";
await mkdir(OUT, { recursive: true });

/** 16-bit mono WAV. The renderer decodes it once and holds the buffer. */
function wav(samples, rate) {
    const data = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        data.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

await writeFile(`${OUT}/horn.wav`, wav(synthHorn(RATE), RATE));
console.log("  horn.wav");

// Several variants so repeated arcs do not sound like one sample retriggered.
const arcs = arcVariants(RATE, 6, 1337);
for (let i = 0; i < arcs.length; i++) {
    await writeFile(`${OUT}/arc-${i}.wav`, wav(arcs[i], RATE));
}
console.log(`  arc-0..${arcs.length - 1}.wav`);

const hum = "assets/refs/ambience-hum.wav";
try {
    await access(hum);
    await copyFile(hum, `${OUT}/ambience.wav`);
    console.log("  ambience.wav (from assets/refs — local only, not redistributable)");
} catch {
    console.log("  ambience.wav SKIPPED — assets/refs/ambience-hum.wav not present");
}
