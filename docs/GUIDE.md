# RasputinClaudeAI — Usage & Reference

> The operator's manual. For what this *is*, see the [README](../README.md).

A Warmind voice interface for Claude Code, themed as **Rasputin** (Destiny 2): an audio-reactive
orb overlay that speaks in a Russian-accented machine voice. It **observes** Claude sessions
started anywhere — terminal, Rider — via a user-level hook, and **drives** its own sessions via the
Agent SDK.

macOS only. The voice pipeline is built on `say`, which has no equivalent elsewhere.

```
┌─ Tauri overlay (M4) ─────────┐        ┌─ Node daemon :7331 ──────────────┐
│  transparent, always-on-top  │        │  synthesis · features · cache    │
│  └─ renderer (Three.js)      │◄──ws──►│  /audio/<sha>.wav · POST /speak  │
│     orb · subtitles          │        │  hooks · transcript tailer       │
└──────────────────────────────┘        └──────────────────────────────────┘
```

The daemon is the brain; the overlay is a thin shell around plain web code. The renderer is
developed in Chrome with hot reload and ships into the overlay unchanged.

## Quick start

```bash
./scripts/setup.sh          # installs and verifies prerequisites; safe to re-run
npm run daemon              # the brain, :7331
npm run orb                 # the renderer, :7332 — open in Chrome
```

Type a line into the field at the top of the page and press **speak**. No overlay needed to work
on either half.

To render one line without running anything:

```bash
npm run say -- "All systems operational"
```

## Commands

| What | Command |
|---|---|
| Setup / preflight | `./scripts/setup.sh` · `./scripts/setup.sh --check` |
| Run the daemon | `npm run daemon` (:7331, reloads on edit) |
| Run the renderer | `npm run orb` (:7332) |
| Run the overlay | `npm run overlay` — transparent, always-on-top |
| Build the overlay app | `npm run overlay:build` |
| Check and build a release | `npm run release` · `npm run release -- --build` |
| Render one line and play it | `npm run say -- "some line"` |
| A/B chain variants vs. the reference | `npm run audition -- "some line"` |
| Install the observe hook | `npm run hook:install` (prints a diff; add `-- --apply` to write) |
| Ask Claude, answered aloud | `curl -s localhost:7331/ask -H 'content-type: application/json' -d '{"text":"..."}'` |
| Speak through the daemon | `curl -s localhost:7331/speak -H 'content-type: application/json' -d '{"text":"..."}'` |
| Screenshot the orb | `npx tsx tools/shoot.ts <level> <out.png>` |
| Tests | `npm test` |
| Typecheck both halves | `npm run typecheck` |

`npm run build` runs `tsc` over the **server only** — the renderer is checked by
`npm run typecheck`, which covers both. See [`BUILD.md`](BUILD.md).

## Delivery modes

Same character, four presentations. Selected per utterance.

| Mode | Voice | Use for |
|---|---|---|
| `warmind` | Tom (Enhanced) | Roleplay, flourishes, the ignition line |
| `measured` | Tom (Enhanced) | Default. Character intact, every word legible |
| `plain` | Tom (Enhanced) | Long reports you need to parse |
| `og-warmind` | Yuri (Enhanced) | Translated to Russian first. The original article |

`og-warmind` measures F0 **78.6 Hz** against the game reference's 80.5 — the closest match in the
project. Its subtitles show the English you typed, not the Russian being spoken, matching the game:
Rasputin is deliberately unintelligible and the subtitle carries the meaning.

## Documentation

| File | For |
|---|---|
| [`RELEASE.md`](RELEASE.md) | Building a release, what ships, and the honest signing state |
| [`BUILD.md`](BUILD.md) | Requirements, every dependency and why, voice decisions with measurements, how it is built |
| [`../CLAUDE.md`](../CLAUDE.md) | Working agreements and the gotcha list — read before changing anything |
| `~/.claude/plans/cosmic-bouncing-clarke.md` | Full design and milestones |

## Status

M0 skeleton · M1 voice pipeline · M2 orb renderer · M3 audio-reactive binding · M4 overlay shell ·
M5 observe sessions — **done**.
M6 drive Claude · M7 persona, skills and agents — **done**. M8 standalone app and release — **done**.

The overlay is a **menu-bar app** — no Dock icon. Its tray glyph carries the menu:
Show Orb · Interactive · Move Overlay · Preferences… · Quit. Beside the glyph it names the Claude
session currently being narrated (`merge-mogul`, or `merge-mogul +2` when several are live), since
with a global hook every session on the machine reports in.

Turn narration on from **Preferences → Narrate Claude sessions** — no terminal needed. It edits
`~/.claude/settings.json`, backs it up first, and leaves any other hooks alone. It is **off until
you turn it on**: the daemon can find live sessions by itself, so the switch is the opt-in.
**Follow the active session** narrates whichever was most recently active — the tray then reads
`Auto LiveOps +2`, using the session name since several sessions usually share a project. Turn it
off and **Listen to** pins one, listed as `project — session — status`. **Narrate subagent work**
is off by default: delegated output is a different voice reporting internal progress and buries the
session's own answers.

**Hold Cmd+Shift+Space** to talk: the orb goes dark while listening, Rasputin acknowledges
immediately, then Claude answers aloud.

Voice drives a **separate** Claude session, not the terminal you are watching — Claude Code has no
channel for injecting input into a running session, so driving one means owning the process. That
session follows the project currently in focus, and the daemon logs
`claude --resume <id>` so the exchange can be read back.
**Cmd+Shift+R** toggles between *ambient* (visible, click-through) and *interactive* (focused,
controls shown). Preferences holds the orb tuning, subtitles, default voice mode, opaque-vs-
transparent background, launch-at-login, and overlay position, plus a **Test voice** button that
speaks a fixed line through the selected mode so settings can be auditioned without switching
windows. Settings are owned by the daemon and persisted to `cache/config.json`, so the overlay and
preferences never disagree.

## Reference media

`assets/refs/` is gitignored and this repo contains no downloader. The captures it expects are not
ours to redistribute; supply your own. Only `npm run analyze-ref` and `npm run fit-eq` need them —
everything else works without.
