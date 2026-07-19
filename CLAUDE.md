# CLAUDE.md — RasputinClaudeAI

A Warmind voice interface for Claude Code, themed as **Rasputin** (Destiny 2): an audio-reactive
orb overlay that speaks in a Russian-accented machine voice. It **observes** Claude sessions
started anywhere (terminal, Rider) via a user-level hook, and **drives** its own sessions via the
Agent SDK. A Node daemon holds all logic; Tauri is a thin transparent shell around a web renderer.

Full design and milestones: `~/.claude/plans/cosmic-bouncing-clarke.md`.

---

## Hard rules

- **Never `git push`.** The human pushes after review. Agents commit locally and hand off.
- **English only** in all code, comments, and docs.
- **Secrets are never committed.** `.env` is untracked; `.env.example` is the documentation.
- **Never reverse the speech itself.** Rasputin's game voice is reverse-Russian and is *deliberately
  unintelligible*. Reverse-*reverb* was tried as a substitute and is now **off** — its pre-echo
  masked word onsets and cost too much clarity (see the masking gotcha below). The backwards
  character lives in the verbatim stingers and the orb's ignition instead.
- **Any chain change must pass the intelligibility gate.** `npm run audition` renders a ladder;
  if a variant can't be transcribed cold, it's rejected however good it sounds.
- **Reference media stays local.** `assets/refs/` is gitignored. This repo contains no downloader.
- **Every gotcha gets a one-line entry** in *Critical conventions & gotchas* below. If a fix
  depended on a non-obvious quirk, it is not done until it's noted here.
- **Any new requirement updates `scripts/setup.sh` AND `docs/BUILD.md` in the same commit.**
  A dependency, system tool, voice, or CLI that someone must have is not added until the setup
  script detects it and the build doc says why it was chosen over the alternatives. `setup.sh
  --check` is the contract: if it passes on a clean machine, the project runs.

## Entry points

| What | Command |
|---|---|
| Render one line and play it | `npm run say -- "All systems operational"` |
| A/B chain variants vs. the reference | `npm run audition -- "some line"` |
| Derive the firequalizer curve from refs | `npm run analyze-ref` |
| Run the daemon | `npm run daemon` (:7331) — run `npm run orb` alongside for the page (:7332) |
| Speak a line through the daemon | `curl -s localhost:7331/speak -d '{"text":"..."}' -H 'content-type: application/json'` |
| Screenshot the orb | `npx tsx tools/shoot.ts <level> <out.png>` |
| Isolate one animated system | `ORB_FREEZE=1` (stop drift/spin/pulses) · `ORB_SOLO=1` (jolts alone) |
| Setup / preflight | `./scripts/setup.sh` · `--check` to verify only |
| Tests | `npm test` |
| Typecheck both halves | `npm run typecheck` |
| Typecheck / build | `npm run build` |

## Architecture

```
Tauri overlay (Rust, M4)                Node daemon :7331
├─ transparent, always-on-top           ├─ http  → page, /audio/<sha>.wav
├─ global hotkey, click-through         ├─ ws    → /ws control channel
└─ WKWebView                            ├─ TTS   → say → ffmpeg → wav + f32le tap
   └─ renderer (Three.js + Web Audio)   ├─ STFT  → feature timeline
      ↕ WebSocket ────────────────────→ ├─ POST /event ← Claude Code hooks
                                        ├─ tailer → transcripts (inode+offset)
                                        └─ Agent SDK → drives Claude sessions
```

- **The daemon is the brain; Tauri is a shell.** The renderer is plain web code — develop it in
  Chrome with hot reload, ship it in the overlay unchanged.
- **Audio playback lives in the browser, never Node.** `AudioContext.currentTime` is a
  sample-accurate clock in the same process as the renderer. `afplay` would leave the renderer
  guessing from `Date.now()` with ±30–60ms of unmeasurable drift — enough to read as badly dubbed.
- **The browser owns the `speaking` state**, not the server; it flips when playback actually starts.
  Otherwise the server declares "speaking" while audio is still decoding and the orb animates
  against silence.

## Voice chain

`say -v "Tom (Enhanced)"` → ffmpeg → TS effects. Each stage maps to one identifiable trait and is
individually bypassable.

**Voice history, so nobody re-litigates it:** `Milena` (ru_RU, female, F0 215 Hz) needed 17
semitones of shift and sounded slowed-down. `Yuri` (ru_RU, **male**, 96.8 Hz) fixed that and gave
genuine Russian phonetics on English text. `Tom (Enhanced)` (en-US, neural, no accent) was then
preferred by ear over Yuri — the neural quality beat the accent. Tom sits at ~109 Hz after the
−2 st shift, above the reference's 80.5 Hz; `pitchSemitones: -6` would match it if that's wanted.

**Three delivery modes**, same voice and same pitch — only the degradation differs, so it reads as
one character speaking with more or less composure. Selected per utterance (M7). A fourth,
`og-warmind`, changes voice *and* language and is described below the table.

| Mode | Glitch | Crush | Room | Ring | Use for |
|---|---|---|---|---|---|
| `warmind` | 2.0/s, anywhere | 7 bit | 0.12/0.06 | 20% | Roleplay, flourishes, the ignition line |
| `measured` | punctuation + 0.55/s scatter | 10 bit | 0.07/0.04 | 11% | Default. Character intact, words legible |
| `plain` | 0.6/s | 11 bit | 0.06/0.03 | 8% | Long reports you need to parse |
| `og-warmind` | as `warmind` | 7 bit | 0.12/0.06 | 20% | The original article — Russian, Yuri |

**`og-warmind`** translates the text to Russian, then speaks it with **Yuri (Enhanced)** (ru_RU,
male) at −3 semitones. Measured F0 **78.6 Hz** against the reference's 80.5 — the closest match in
the project; `warmind` measures 139 Hz on the same line. Intelligibility is explicitly *not* a goal
here, since the listener is not expected to parse the Russian, so degradation runs at full strength.
Translation goes through the authenticated `claude` CLI (there is no `ANTHROPIC_API_KEY` on this
machine), is cached on disk under `cache/translate/`, and **fails soft** — if the CLI is missing or
slow, the source text is spoken instead of nothing. A cache hit is ~320x faster (3.2s → 0.01s).

Base voice is **Tom (Enhanced)**, en-US — chosen by ear over the Russian-accented Yuri.

`measured` uses `placement: "hybrid"` — punctuation-driven glitches at phrase ends, plus a sparse
mid-word scatter. Punctuation intensity comes from the **source text** (`. ! ?` = 1.0, `; :` = 0.7,
`,` = 0.45) while position comes from the **audio** pauses; neither works alone, because the
envelope can't distinguish a comma from a full stop and the text can't say where in time the pause
landed. Marks are matched to pauses by relative position, with one gap reserved per remaining mark
so a late comma can't starve the sentence-final mark. Each repeat decays ×0.72 — a hang, not a loop.

**Settled settings** (chosen by ear via `npm run audition`; change these only with a listening test):

| Stage | Value | Why |
|---|---|---|
| Pitch | −2 semitones (`rubberband -F`) | Lands at F0 82.6 Hz vs the reference's 80.5 |
| Formants | −1 semitone (`asetrate`) | Small on purpose — see the pitch/formant gotcha below |
| Glitch | 2.0 events/s, 14–42 ms grains | The "medium" rung; reads authoritative |
| Ring mod | 20% wet, 62 Hz carrier | Mechanical without scattering vowels |
| Reverse-reverb | **off** | Pre-echo masked word onsets; cost too much intelligibility |
| Room echo | 0.12 / 0.06, two taps | Lands *after* each word, where masking is weak |

**Measured target** from `assets/refs/` extracted game audio (89s): RMS −20.4 dBFS, peak −0.2,
**crest factor 10.2** (dynamic — do *not* over-compress), dynamic range 96 dB.

| Band | Reference | Implication |
|---|---|---|
| **20–150 Hz** | **Dominant by a wide margin** | Major low-shelf lift + `asubboost`. Biggest gap vs. raw `say`. |
| 150–500 Hz | Strong | Moderate lift |
| 500 Hz–2.5 kHz | Present, not dominant | Leave flat — intelligibility band, protect it |
| >5 kHz | Sharp rolloff | `lowpass` ≈ 5–6 kHz |

Also in the reference and worth copying: broadband vertical striations (impulse/click artifacts —
`acrusher` plus injected impulses) and hard silences between phrases, not a continuous bed.

## Orb visual

Matched to Destiny reference frames, **not** a reinterpretation. Verified from extracted frames:

- **The nodes and edges are a lattice on the shell**, not orbiting satellites. Irregular
  triangulated wireframe (noise-perturbed icosphere edges), 2–3 concentric layers, `depthTest: false`
  so the far side shows through — that see-through quality is most of the depth cue.
- **The core is white-blue, not orange.** Orange is the shell; crimson is the environment.
- **Amplitude drives a colour-temperature ramp**, not mainly scale: deep red (idle) → orange →
  yellow-white (peak), plus lattice density and spark count. Scale change is subtle and secondary.
- Overlay renders **orb only on transparency** — no chamber. Faithful anyway: the speech reference
  has a near-black background.

## Critical conventions & gotchas

- **Tail transcripts by `(inode, byte offset)` — never mtime.** Idle sessions are touched hourly
  with *zero bytes appended*; an mtime/FSEvents watcher fires spurious wakeups. Verified.
- **Subagent work lands in separate files** at `<session-uuid>/subagents/agent-<id>.jsonl`. Watching
  only the parent transcript goes blind during delegation — which is what the observer deliberately
  wants: delegated work is a different voice reporting internal progress, and narrating it buries
  the session's own answers. `TranscriptTailer` still supports following them; the observer passes
  `followSubagents: false`, cutting polled files from 74 to 11.
- **The project-path encoding is lossy** — both `/` and `_` map to `-`, so `merge-mogul_2` and
  `merge-mogul-2` collide. Never reverse it; read `cwd` inside the JSONL, or take `transcript_path`
  straight from the hook payload.
- **One assistant response spans multiple JSONL lines** sharing a `message.id`, one per content
  block. Never assume one line = one message.
- **There is no channel to inject input into a running session** — no FIFOs, no sockets under
  `~/.claude/`. Driving an agent means owning the process (Agent SDK / CLI).
- **`~/.claude/sessions/<pid>.json`** is a live registry with `cwd`, `sessionId`, and `busy|idle` —
  the trigger for "task complete". Same data from `claude agents --json`, no TTY needed.
- **Speech policy: speak assistant `text` blocks, never `tool_use` blocks.** No spoken "Read(…)"
  or "Grep(…)". This is a filter on block `type`, not string-matching. Tool activity shows
  *visually* as a `thinking` pulse and is never narrated.
- **ffmpeg 8.1.1 here has no `rubberband`, `areverb` or `drawtext`.** Pitch-shift is
  `asetrate`+`aresample`+`atempo`; reverb is `afir` convolution or stacked `aecho`.
- **Never hand-tune the matching EQ — run `npm run fit-eq`.** Five hand-tuning attempts failed to
  converge (max error oscillated 17 → 8 → 5.6 → 8.6 dB) because a high-Q notch cannot shift a band
  average and a shelf wide enough to shift it flattens the neighbouring band. The fitted curve
  wants **+15 dB at 40 Hz and −18 dB at 190 Hz** — a 33 dB swing inside two octaves that no
  peak/shelf combination reproduces. Fitting got max error to 3.3–6.3 dB in one pass.
- **An unescaped `;` inside a `filter_complex` string is a graph separator.** `firequalizer`
  entries must be joined with `\;` or ffmpeg silently builds a different, broken graph.
- **Crest factor is dominated by silence, not compression.** The 90s reference measures 10.2 but
  comparable 4s windows of the *same recording* measure 3.7–5.5. Comparing a short render against
  the whole-file figure invents an over-compression problem that isn't there — `analyze-ref`
  compares duration-matched windows for this reason.
- **Pitch and formants must be shifted separately — this is the big one.** `asetrate` moves both
  together. A male voice is *not* a female voice slowed down: F0 differs ~12 semitones between
  speakers, formants only ~2–3. Dropping Milena 13 semitones with `asetrate` made the vocal tract
  read as enormous and sounded like tape running slow. Correct split: small `asetrate` for
  formants, then `rubberband -p <n> -F` for the pitch with formants held.
- **Use `Yuri` (male, ru_RU), not `Milena` (female).** Measured F0: Yuri 96.8 Hz, Milena 215 Hz,
  reference 80.5 Hz — Yuri needs a 3-semitone shift where Milena needed 17, so the artifacts
  largely disappear. **Yuri is not installed by default**: System Settings → Accessibility →
  Spoken Content → System Voice → Manage Voices.
- **`rubberband` is a required dependency** (`brew install rubberband`). This ffmpeg build has no
  `librubberband`, so the CLI binary is the only formant-preserving pitch shifter available.
- **Every input that changes the output must be in the synth cache key.** `effects` was missing
  once, so an effects-off render silently returned the effects-on file and a verification
  reported the effects doing nothing at all.
- **The glitch scatter must source grains from the CLEAN input, never from `out`.** Sourcing from
  the already-glitched buffer lets it copy a stuttered region and stutter it again, compounding
  into smear. This produced a render that sounded broken and was initially misdiagnosed as the
  scatter feature itself being wrong — it was the compounding, and the scatter is desirable.
- **Siri voices are NOT reachable, but Enhanced ones are.** `Evan (Enhanced)` / `Tom (Enhanced)`
  work with `say` once downloaded via Manage Voices. Note `say -v NAME -o /dev/null` fails for
  *every* voice — never use `/dev/null` to probe voice availability, it reports false negatives.
- **Milena is inherently low-mid heavy.** Raw `say` measures +18.8 dB at 150–500 Hz against the
  reference's +6.3. That band needs *cutting*; boosting it was a 17 dB error that read as mud.
- **`ffmpeg -v error` suppresses `astats` output** — astats reports at info level, so a stats run
  with `-v error` silently prints nothing.
- **`say --interactive` is incompatible with `-o`**, so there are no free word timings. Word
  boundaries are derived from the envelope (silence gate at −38 dB held ≥90ms).
- **`loudnorm` is load-bearing.** `say` loudness varies per utterance; without it the orb's
  response amplitude would depend on sentence length.
- **`antialias: true` is a no-op through `EffectComposer`** — use a `{ samples: 4 }` render target.
- **`npm run build` (plain `tsc`) does NOT check the renderer.** The root tsconfig excludes
  `src/web`, and Vite transpiles without typechecking, so renderer type errors are invisible to
  both — a `private` field was being read from `main.ts` for hours under a clean `tsc --noEmit`.
  Use `npm run typecheck`, which runs the root config and `tsconfig.web.json`.
- **Never adopt an existing transcript from offset 0.** A live session's directory accumulates
  subagent transcripts for its whole life — 226 on this machine, none touched in a day — so
  following them from the start replays entire past sessions at once. Only a file written within
  `REPLAY_WINDOW_MS` is read from the beginning; everything else starts at EOF.
- **Narrating "all sessions" is never what anyone means.** With the registry followed, every live
  session is tailed; speaking them all interleaves four projects into one voice. Automatic mode
  narrates the FOCUSED session only. Note focus eligibility and narration eligibility are separate
  questions — gating hook events on the current focus freezes it on the first session forever.
- **Speak only the newest message in a batch.** A backlog queues minutes of speech that is stale
  before it is heard.
- **Do not style overlay UI with an injected `<style>` element — use CSSOM.** `<style>` blocks are
  governed by `style-src`, and Tauri rewrites the app CSP with nonces; a nonce makes browsers
  ignore `'unsafe-inline'`, so the block is dropped silently. An unstyled subtitle is a static
  block after a 100vh canvas — off-screen, invisible, nothing logged. Direct CSSOM assignment
  (`el.style.x = …`) is not subject to `style-src`.
- **The renderer can log to the daemon (`link.log`).** The overlay has no reachable devtools in a
  release build, so this is the only way to see inside it. Two overlay-only bugs were diagnosed
  from the daemon log alone.
- **Never derive the daemon origin from `location` in the overlay.** Tauri serves the page from
  `tauri://localhost`, so `location.hostname` is `tauri.localhost` — the derived
  `ws://tauri.localhost:7331` is unresolvable AND outside the CSP.
- **A CSP-blocked `new WebSocket()` throws SYNCHRONOUSLY.** Because `link.connect()` sits above the
  render loop at module scope, one bad URL aborted module execution and produced a black window
  with no orb, visible dev controls, no drag layer and no config — four symptoms, one cause. The
  orb must never depend on the daemon: the link is wrapped in try/catch.
- **Tauri's CSP needs `ipc: http://ipc.localhost` in `connect-src`** or every `invoke()` fails.
- **Homebrew's `rustup` keeps its shims in its own opt dir, not `~/.cargo/bin`.** So
  `brew install rustup && rustup default stable` succeeds while `cargo` stays off PATH, and
  `tauri dev` fails with a bare `cargo metadata … No such file or directory`. The npm scripts go
  through `scripts/with-rust.sh`, which finds the toolchain itself — no shell profile edit needed.
- **`cmd | grep -q` under `set -o pipefail` reports failure on a MATCH.** grep exits at the first
  hit, the producer takes SIGPIPE, and pipefail surfaces its 141. In `setup.sh` this presented as
  seven ffmpeg filters missing from a build that had them — and only the ones early in the
  alphabetical listing, because late matches let grep drain the output first. Capture once into a
  variable, then grep that.
- **A running daemon does not pick up server-side edits — `npm run daemon` uses `tsx watch`.**
  Plain `tsx` has no reload, and a stale daemon answers every request normally while serving old
  code, so a fix appears not to work. `GET /health` reports `startedAt` and `pid`; compare it
  against your last edit before debugging anything server-side.
- **Plain Helvetica has no middle weight — asking for 600 gives full Bold.** Measured on this
  machine it renders only three distinct faces across 300-700: 300/400/500 are all Regular and
  600/700 are both Bold. `document.fonts.check` is no help, it returns true for every weight of any
  available family. Subtitles use **Helvetica Neue**, which has a real Medium at 500.
- **A translation must be sanitized before it is spoken.** Models wrap output in quotes, add code
  fences, prefix `Translation:`, or append an alternative on a second line — every one of those
  gets read aloud. `sanitizeTranslation` strips them; the colon-label rule deliberately does not
  fire on a real sentence like `Внимание: ...`.
- **The analysis tap and the played wav must stay the same signal.** `synthesize` returns both
  from one `asplit`; verified by cross-correlating their envelopes — correlation 1.0000 at lag 0.
  If a chain change ever splits them, every utterance goes silently out of sync and it will look
  like a clock bug in the renderer.
- **Audio starts suspended without a user gesture.** An `AudioContext` created on load sits in
  `suspended` where `currentTime` does not advance, so the orb ignores speech entirely and nothing
  errors. The harness calls `player.unlock()` on the speak button; Playwright needs
  `--autoplay-policy=no-user-gesture-required`.
- **The idle floor hides dead test signals.** With `idleFloor` at 0.22 a stretch where the driver
  outputs nothing is pixel-identical to manual idle, so a broken envelope reads as a broken button
  instead. The harness's simulated speech had an 11-second silence for exactly this reason —
  measure a driver's per-second peak over a full minute before trusting it, don't watch it.
- **A population of lifetime-bound objects reaches steady state after one LIFETIME, not one
  interval.** Measuring jolt fill 6s after raising the cap to a 17.5s lifetime read 55% and looked
  like a bug; the same setting measures 83% once given 1.6 lifetimes to settle.
- **Never pass a named function expression to `page.evaluate` from a `tsx` script.** esbuild
  rewrites it to call its `__name` helper, which does not exist inside the page, so it throws
  `ReferenceError: __name is not defined`. Pass the probe as a source string instead.
- **A frame-difference image cannot isolate one animated system.** Drift, spin, edge shimmer, edge
  aging and pulses all animate every frame, so diffing consecutive frames lights up the entire
  graph and says nothing about the system under test. Use `ORB_FREEZE=1` to stop the ambient
  motion, or `ORB_SOLO=1` to draw jolts alone against black — that is what confirmed the jolt
  segments travel rather than whole edges flashing.
- **Jolts must reroute on edge rebuild, never be culled.** The outer graph rewires every 1.8s, so
  dropping jolts whose current edge vanished capped travel at the rebuild interval however long
  their lifetime was — measured 0.3 jolts in flight vs 1.89 after rerouting.
- **A jolt's head-to-tail fade must accumulate across edge pieces.** Measuring the fade within
  each piece independently restarts the ramp at every node, which reads as a dashed line, and in
  the first version it also came out inverted — bright tail, dim head.
- **`Points` render round.** Streak particles must be short `LineSegments` oriented along velocity,
  or instanced quads.
- **Config files are 2-space; TypeScript source is 4-space** (matches the sibling Node projects).
- **No linter.** Deliberate — no eslint/prettier/biome config exists anywhere in `Depo/`.
- **Tests live in root `__tests__/`**, named after the source file they cover (`src/foo-bar.ts` →
  `__tests__/foo-bar.test.ts`). Jest runs ESM, so `npm test` sets `--experimental-vm-modules`.

## Agents / skills

Built alongside the milestones (M7):

- `.claude/skills/orb-visual/` — lattice construction rules, bloom/ACES setup, what the reference
  actually shows.
- `.claude/skills/rasputin-voice/` — `say` flags, the ffmpeg chain, how to audition a line.
- `.claude/skills/warmind-protocol/` — the `ServerMsg`/`ClientMsg` union and how to extend it.
- `.claude/agents/shader-smith.md` — GLSL specialist.
- `.claude/agents/voice-tuner.md` — renders candidate chains and reports on character.
