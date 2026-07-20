---
name: rasputin-voice
description: Use when changing the voice chain, adding a delivery mode, tuning pitch/formants/glitch, or debugging why a rendered line sounds wrong. Covers `say` flags, the ffmpeg chain, auditioning, and the settled values that should not be re-litigated.
---

# Rasputin voice chain

`say -v <voice>` → ffmpeg (formants, chain, matching EQ) → `rubberband -F` (pitch) → TS effects → wav,
with an f32le analysis tap off the **end** of the chain.

## Before changing anything

- **Audition it.** `npm run audition -- "some line"` renders a ladder of variants. A variant you
  cannot transcribe cold is rejected however good it sounds — intelligibility is a hard gate on
  every mode except `og-warmind`.
- **Do not re-litigate the voices.** `Milena` (ru_RU female, F0 215 Hz) needed 17 semitones and
  sounded slowed-down. `Yuri` (ru_RU male, 96.8 Hz) fixed that. `Tom (Enhanced)` (en-US neural) was
  then preferred by ear for the default chains — the neural quality beat the accent. `og-warmind`
  uses Yuri at −3 st and measures **F0 78.6 Hz** against the reference's 80.5.
- **Never reverse the speech itself.** The game voice is reverse-Russian and deliberately
  unintelligible. Reverse-*reverb* was tried as a substitute and is off — its pre-echo masked word
  onsets.

## The traps

- **Pitch and formants must be shifted separately.** `asetrate` moves both; a male voice is not a
  female voice slowed down. Small `asetrate` for formants, then `rubberband -p <n> -F` for pitch.
- **`rubberband` is a required dependency.** This ffmpeg has no `librubberband`.
- **Never hand-tune the matching EQ — run `npm run fit-eq`.** Five hand attempts oscillated
  17 → 8 → 5.6 → 8.6 dB. The fitted curve wants +15 dB at 40 Hz and −18 dB at 190 Hz.
- **An unescaped `;` inside `filter_complex` is a graph separator.** `firequalizer` entries need `\;`.
- **Every input that changes output must be in the synth cache key.** `effects` was missing once and
  an effects-off render silently returned the effects-on file.
- **The glitch scatter must source grains from the CLEAN input**, never from the already-glitched
  buffer — that compounds into smear.
- **`ffmpeg -v error` suppresses `astats`**, which reports at info level.
- **`say -v NAME -o /dev/null` fails for every voice.** Never use it to probe availability; use
  `say -v '?'`.
- **Crest factor is dominated by silence.** Compare duration-matched windows or you will invent an
  over-compression problem that is not there.

## Delivery modes

`warmind` · `measured` (default) · `plain` · `og-warmind` (translates to Russian, uses Yuri).
Only the degradation differs across the first three, so it reads as one character with more or less
composure. See `docs/BUILD.md` for the table and the measured F0 of each.
