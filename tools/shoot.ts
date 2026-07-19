/**
 * Screenshots the running orb so changes can be checked against the reference instead of guessed.
 *
 *   npx tsx tools/shoot.ts [level] [outPath]
 *
 * Headless Chrome via the `--screenshot` flag does not render WebGL on this machine (it produced
 * blank frames, then hung on every software-GL flag combination). Playwright ships its own
 * Chromium with working GL, which is why it's a dev dependency.
 */

import { chromium } from "playwright";

const URL = process.env.ORB_URL ?? "http://127.0.0.1:7332/";

async function main(): Promise<void> {
    const level = Number(process.argv[2] ?? 0);
    const out = process.argv[3] ?? "shot.png";

    const browser = await chromium.launch({
        args: ["--use-gl=angle", "--use-angle=metal", "--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
    });

    await page.goto(URL, { waitUntil: "networkidle" });

    // Drive the level slider, then let the scene settle — the orb's ballistics have a 220ms
    // release, and the graphs need a moment of drift before they look representative.
    await page.evaluate((lv) => {
        const s = document.getElementById("level") as HTMLInputElement;
        s.value = String(Math.round(lv * 100));
        s.dispatchEvent(new Event("input"));
    }, level);
    await page.waitForTimeout(1400);

    // ORB_FREEZE=1 stops drift, spin and pulses so a frame-difference image isolates the jolts.
    if (process.env.ORB_FREEZE === "1") {
        await page.evaluate(() => (window as unknown as { __freeze: () => void }).__freeze());
        await page.waitForTimeout(250);
    }
    // ORB_SOLO=1 draws jolt segments alone against black — the only way to read their shape,
    // since against the full graph they are indistinguishable from warm edges.
    if (process.env.ORB_SOLO === "1") {
        await page.evaluate(() => (window as unknown as { __solo: () => void }).__solo());
        await page.waitForTimeout(700);
    }

    // Report whether WebGL actually initialized — a blank screenshot is otherwise ambiguous
    // between "nothing rendered" and "rendered black".
    const info = await page.evaluate(() => {
        const c = document.getElementById("orb") as HTMLCanvasElement;
        const gl = c.getContext("webgl2");
        return { webgl2: !!gl, w: c.width, h: c.height };
    });

    // Burst mode: several frames from ONE page load, so the sequence is temporally continuous
    // and can be analysed for motion the same way the reference video was.
    const burst = Number(process.env.ORB_BURST ?? 0);
    if (burst > 0) {
        const gapMs = Number(process.env.ORB_BURST_GAP ?? 150);
        for (let i = 0; i < burst; i++) {
            await page.locator("#orb").screenshot({ path: out.replace(/\.png$/, `-${String(i).padStart(2, "0")}.png`) });
            await page.waitForTimeout(gapMs);
        }
    } else {
        await page.locator("#orb").screenshot({ path: out });
    }
    await browser.close();

    console.log(`  ${out}  level=${level}  webgl2=${info.webgl2}  canvas=${info.w}x${info.h}`);
    if (errors.length) {
        console.log("  page errors:");
        for (const e of errors.slice(0, 5)) console.log(`    ${e}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
