# What it needs, what it is made of, and why

Companion to `README.md` (how to run it) and `CLAUDE.md` (how to work on it). This file records
**choices and their evidence**, so they are not re-litigated from scratch. Where a decision was
made by measurement, the measurement is here.

---

## 1. Requirements

### Hard — nothing works without these

| Requirement | Version tested | Why |
|---|---|---|
| **macOS** | 15 (Darwin 25.4) | The entire voice pipeline is `say`. No equivalent exists on Linux or Windows. |
| **Node** | 22+ (tested 25.9) | `package.json` pins `engines.node >=22`. Uses native `fetch`, `node:test`-era APIs, ESM throughout. |
| **npm** | 11+ | Never pnpm or yarn — see *Package manager* below. |
| **ffmpeg** | 8.1.1 | Every voice chain is an ffmpeg filtergraph. |
| **rubberband** (CLI) | 4.x | `brew install rubberband`. **Not optional** — see below. |
| **Tom (Enhanced)** voice | — | Base voice for `warmind`, `measured`, `plain`. |

### Soft — a named feature degrades, nothing breaks

| Requirement | Enables | Without it |
|---|---|---|
| **Yuri (Enhanced)** voice | `og-warmind` | That mode falls back to the default voice, losing the point of it |
| **claude CLI** | `og-warmind` translation | Speaks the untranslated English; fails soft by design |
| **Playwright Chromium** | `tools/shoot.ts` | No screenshot feedback loop |
| **`assets/refs/`** | `analyze-ref`, `fit-eq` | Those two commands only; the fitted curve is already committed |
| **Rust toolchain** | M4 Tauri overlay | The overlay only; the daemon and renderer need no Rust |

`./scripts/setup.sh` checks all of the above and installs what it safely can. Re-running it is the
intended way to verify an environment. `--check` verifies without changing anything.

### Why `rubberband` is not optional

This ffmpeg build has **no `librubberband`**, so the CLI binary is the only formant-preserving
pitch shifter available.

That matters because pitch and formants must be shifted *separately*. `asetrate` moves both
together, and a male voice is not a female voice slowed down: F0 differs ~12 semitones between
speakers while formants differ only ~2–3. Dropping a voice 13 semitones with `asetrate` made the
vocal tract read as enormous — it sounded like tape running slow, not like a man. The correct split
is a small `asetrate` for formants, then `rubberband -p <n> -F` for pitch with formants held.

### ffmpeg filters this build lacks

`rubberband`, `areverb`, `drawtext`. Consequences: pitch shifting goes through the external CLI,
reverb is `afir` convolution or stacked `aecho`, and any labelled comparison image has to be built
without `drawtext`.

---

## 2. Packages, and why each one is here

Runtime dependencies are deliberately near-zero. Everything below is a considered choice.

### Runtime — one package

| Package | Why this and not something else |
|---|---|
| **`ws`** | The only runtime dependency. Node ships a WebSocket *client* but no server, and the daemon needs to push `speak` to connected renderers. Rejected alternatives: Socket.IO (a protocol layer we do not need, plus a client bundle), raw SSE (one-directional; the renderer must report playback back). |

### Development

| Package | Role | Why |
|---|---|---|
| **`typescript`** | Language | Plain `tsc`. Two configs — see *Typechecking* below. |
| **`tsx`** | Run TS directly | Every `npm run` entry point is `tsx <file>`. No build step during development. The daemon runs under `tsx watch`. |
| **`vite`** | Renderer dev server | Hot reload for the orb. Transpiles only — **it does not typecheck**, which is why `npm run typecheck` exists separately. |
| **`three`** + `@types/three` | WebGL | The orb is a layered particle/line scene; hand-rolling WebGL would be weeks for no gain. `@types/three` is separate because three ships no bundled types. |
| **`jest`** + `ts-jest` | Tests | Matches the sibling projects in `Depo/`. ESM, so `npm test` sets `--experimental-vm-modules`. |
| **`playwright`** | Screenshot harness | Headless Chrome's `--screenshot` renders **blank frames** for WebGL on this machine and hangs on every software-GL flag combination. Playwright ships its own Chromium with working GL. This is why it is a dependency rather than a convenience. |
| **`@tauri-apps/cli`** + `@tauri-apps/api` | Overlay shell | Tauri v2. Chosen over Electron: the webview is the system WebKit rather than a bundled Chromium, so the app is ~10 MB instead of ~150, and transparent always-on-top windows are first-class. |
| **`@types/node`**, `@types/jest`, `@types/ws` | Types | — |

### Deliberately absent

| Not used | Why |
|---|---|
| **Any linter** | No eslint/prettier/biome config exists anywhere in `Depo/`. Consistent with every sibling project. |
| **pnpm / yarn** | npm only, matching `merge-mogul`, `bq-analytics-tools`, `HomeAssitant`. |
| **A schema library** (zod, io-ts) | The `ServerMsg`/`ClientMsg` union is small and its guards are structural. A bad message must be *dropped with a log line*, never throw inside a socket handler — 12 lines of type predicates do that and add no bundle weight to the renderer. |
| **A UI framework** | The renderer is a canvas plus a handful of controls. React would be the largest dependency in the project to manage six sliders. |
| **A state library** | The orb owns its own state; the protocol carries the rest. |
| **An HTTP framework** (express, fastify) | The daemon serves four routes. `node:http` is enough and keeps the dependency surface at one package. |

---

## 3. Voices — the decision history

This is the most re-litigated area in the project. The order below is chronological, and each step
was settled by measurement or by a listening test, not by preference alone.

| Voice | Locale | Measured F0 | Verdict |
|---|---|---|---|
| **Milena** | ru_RU, female | 215 Hz | **Rejected.** Needed 17 semitones of shift to reach the reference, which sounded slowed-down. Also inherently low-mid heavy: raw output measured +18.8 dB at 150–500 Hz against the reference's +6.3 — that band needs *cutting*, and boosting it was a 17 dB error that read as mud. |
| **Yuri (Enhanced)** | ru_RU, **male** | 96.8 Hz | **Kept, for `og-warmind`.** Needs only ~3 semitones, so the shift artifacts largely disappear. Genuine Russian phonetics. |
| **Tom (Enhanced)** | en-US, neural | — | **Chosen for the default chains.** Preferred by ear over Yuri in an A/B: the neural quality beat the accent. |
| Siri voices | — | — | **Not reachable.** `say` cannot address them. *Enhanced* voices can, once downloaded. |

**Reference target:** the extracted game audio measures F0 **80.5 Hz**.

**Where the chains actually land**, measured on the same line through the full pipeline:

| Chain | Voice | Pitch shift | Output F0 |
|---|---|---|---|
| `warmind` | Tom (Enhanced) | −2 st | 139 Hz |
| `og-warmind` | Yuri (Enhanced) | −3 st | **78.6 Hz** |

`og-warmind` is the closest match in the project — essentially on the reference. `-3` rather than
`-2` because Yuri starts at 96.8 Hz natively; `96.8 × 2^(-3/12) = 81.4`.

### Two traps when probing voices

- **Never use `say -v NAME -o /dev/null` to test availability.** It fails for *every* voice,
  including installed ones. This produced a false conclusion that Enhanced voices were unreachable
  when Tom and Evan had been available all along. Use `say -v '?'` and match the name.
- **Enhanced voices are not installed by default.** There is no CLI to install them:
  System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.

---

## 4. Delivery modes

Same voice and pitch across the first three — only the degradation differs, so it reads as one
character with more or less composure.

| Mode | Glitch | Crush | Room | Ring | Voice |
|---|---|---|---|---|---|
| `warmind` | 2.0/s, anywhere | 7 bit | 0.12/0.06 | 20% | Tom (Enhanced) |
| `measured` | punctuation + 0.55/s scatter | 10 bit | 0.07/0.04 | 11% | Tom (Enhanced) |
| `plain` | 0.6/s | 11 bit | 0.06/0.03 | 8% | Tom (Enhanced) |
| `og-warmind` | as `warmind` | 7 bit | 0.12/0.06 | 20% | Yuri (Enhanced), Russian |

**Intelligibility is a hard gate** on the first three: `npm run audition` renders a ladder, and any
variant that cannot be transcribed cold is rejected however good it sounds. `og-warmind` is exempt
— the listener is not expected to parse the Russian, so degradation runs at full strength and the
subtitle carries the meaning.

**The speech itself is never reversed.** Rasputin's game voice is reverse-Russian and deliberately
unintelligible; copying that destroys comprehension. Reverse-*reverb* was tried as a substitute and
is now off — its pre-echo masked word onsets and cost too much clarity.

---

## 5. How it is built

### Layout

```
src/
  server/          Node. No DOM.
    daemon.ts        HTTP + WS on :7331
    voice/           chains, synthesis, translation, audition tooling
    audio/           STFT, feature timeline, effects, arcs
  shared/
    protocol.ts      the ServerMsg/ClientMsg union — imported by BOTH halves
  web/             Browser. No node: imports.
    main.ts          dev harness entry
    orb/             Three.js scene
    audio/           playback and the feature driver
    net/             daemon link
    ui/              subtitles
tools/shoot.ts     Playwright screenshot harness
scripts/setup.sh   preflight
__tests__/         mirrors src filenames
```

`src/shared/protocol.ts` being imported by both halves is the point: a message type added on one
side and not the other is a compile error, not a silent runtime no-op.

### Typechecking — two configs, and why

| Command | Covers |
|---|---|
| `npm run build` | `tsc` — **server only** |
| `npm run typecheck` | server **and** renderer |

The root `tsconfig.json` sets `"exclude": ["src/web"]`, because the two halves need different
module resolution: the daemon is NodeNext and emits to `lib/`, the renderer is bundler-resolved and
emits nothing. `tsconfig.web.json` covers `src/web` and `tools/`.

**This matters more than it sounds.** Vite transpiles without typechecking, so for a long stretch
*no renderer file was typechecked at all* — a `private` field was being read from `main.ts` under a
clean `tsc --noEmit`. Always use `npm run typecheck`.

### Tests

Jest with ts-jest, ESM (`--experimental-vm-modules`). Tests live in the root `__tests__/`, named
after the file they cover: `src/foo-bar.ts` → `__tests__/foo-bar.test.ts`.

Run one file: `npm test -- timeline`

### The screenshot feedback loop

Visual work is verified by rendering and looking, not by reasoning about it. `tools/shoot.ts`
drives Playwright; `ORB_FREEZE=1` stops drift/spin/pulses and `ORB_SOLO=1` draws only the jolt and
arc segments against black.

Both exist because **a frame-difference image cannot isolate one animated system** — drift, spin,
edge shimmer, aging and pulses all animate every frame, so diffing consecutive frames lights up the
entire graph and proves nothing.

### Audio pipeline shape

```
say -v <voice>  →  ffmpeg (formants, chain, EQ)  →  rubberband -F (pitch)  →  wav
                                                          └─ asplit ─→ f32le analysis tap
```

The analysis tap comes off the **end** of the chain, so the feature timeline describes exactly the
signal that reaches the speaker. Verified by cross-correlating the two envelopes: **1.0000 at lag
0**. If a chain change ever splits them, every utterance goes silently out of sync and it will look
like a clock bug in the renderer.

Everything that affects output must be in the synth cache key. `effects` was missing once, and an
effects-off render silently returned the effects-on file — the verification then reported the
effects doing nothing at all.

### Timing

Playback lives in the **browser**, never Node. `AudioContext.currentTime` is a sample-accurate
clock in the same process as the render loop; `afplay` would leave the renderer guessing from
`Date.now()` with ±30–60 ms of unmeasurable drift, which reads as badly dubbed.

The orb is driven from `elapsed − outputLatency + 45 ms`. Human audio-visual tolerance is
asymmetric — roughly 125 ms is acceptable when the visual *leads* but only ~45 ms when it *lags* —
so erring early reads as tight and erring late reads as dubbed.

The **renderer** owns the `speaking` state, not the server. The server sends `speak`; the renderer
answers `playback` when audio actually starts. A server that declares "speaking" on send has the
orb animating while audio is still fetching and decoding.

---

## 6. The overlay (M4)

`src-tauri/` is deliberately thin — four things a browser cannot do for itself, and nothing else:
a transparent undecorated always-on-top window, click-through, a global hotkey that fires while
another app has focus, and staying off the Dock. Everything with behaviour is in the daemon and
the renderer, which loads unchanged from Chrome.

- **`macOSPrivateApi: true` is required** in `tauri.conf.json` for a transparent window on macOS.
- **Homebrew's `rustup` puts its shims in its own opt dir, not `~/.cargo/bin`.** So
  `brew install rustup && rustup default stable` succeeds and still leaves `rustc` and `cargo` off
  PATH — `tauri dev` then fails with a bare `cargo metadata … No such file or directory`. The
  `overlay` scripts run through `scripts/with-rust.sh`, which locates the toolchain itself, so no
  shell profile edit is required. `setup.sh --check` reports the state either way.
- **`frontendDist` is `../lib/web`, not `../dist`** — `vite.config.ts` builds to `lib/web`. The
  daemon's static route had the same mistake and would have 404'd every asset in production,
  invisible in development where Vite serves the page.
- **`Cargo.lock` is committed.** Convention for a binary crate; it is what makes the build
  reproducible.
- **Cmd+Shift+R toggles ambient ↔ interactive**, not show/hide. The orb is meant to be present the
  way a status light is, and an overlay you must summon before it can tell you anything defeats
  the observing half of the project.
- **It is a menu-bar app**: `ActivationPolicy::Accessory` keeps it out of the Dock and the app
  switcher, so the tray menu is the only chrome. Quit lives there, since there is no menu bar of
  its own to quit from.
- **The tray icon must be a template image.** macOS ignores the colour and paints the alpha shape
  black on a light menu bar, white on a dark one; without `icon_as_template(true)` the glyph is a
  black smudge in dark mode. Built from the source glyph with
  `geq=r=0:g=0:b=0:a='r(X,Y)'` — the white-on-black artwork's red channel becomes the alpha mask.
  Note `lum(X,Y)` is YUV-only and errors on RGBA input.
- **The renderer must not derive the daemon origin from `location`.** In Tauri `location.hostname`
  is `tauri.localhost`; the resulting WebSocket URL is unresolvable and outside the CSP, and a
  CSP-blocked `new WebSocket()` throws synchronously — aborting module execution before the render
  loop starts. Use `127.0.0.1` explicitly when `inOverlay()`.
- **`connect-src` must include `ipc: http://ipc.localhost`** or every Tauri `invoke()` fails.
- **`Image::from_path` needs tauri's `image-png` feature.** Without it the tray can only use the
  compiled-in window icon.
- **Preferences is a second window with its own vite entry.** `rollupOptions.input` must list
  `preferences.html`, or it is never built and the window loads a 404.
- **Settings live in the daemon, not in either window.** The overlay and preferences are separate
  webviews with no shared memory, so changes travel renderer → daemon → all renderers. That path
  also works in Chrome, survives a reload of either window, and gives one place to persist from
  (`cache/config.json`). Window-to-window Tauri events would satisfy none of those.

## 7. Operational notes

- **`npm run daemon` runs under `tsx watch`.** Plain `tsx` has no reload, and a stale daemon
  answers every request normally while serving old code — a fix then appears not to work.
  `GET /health` reports `pid` and `startedAt`; check it before debugging anything server-side.
- **Audio will not start without a user gesture.** An `AudioContext` created on page load sits in
  `suspended`, where `currentTime` does not advance — the orb ignores speech entirely and nothing
  errors. The speak button calls `unlock()`. Playwright needs
  `--autoplay-policy=no-user-gesture-required`.
- **The daemon binds loopback only.** The hook endpoint is unauthenticated; do not bind `0.0.0.0`.
- **`cache/` is regenerable** — rendered speech keyed by `sha256(text + chainParams)`, plus
  translations under `cache/translate/`. Safe to delete; the next render is just slower.
