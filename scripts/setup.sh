#!/usr/bin/env bash
#
# Preflight and setup for RasputinClaudeAI.
#
#   ./scripts/setup.sh          install what is missing, then verify
#   ./scripts/setup.sh --check  verify only, change nothing
#
# Idempotent: safe to re-run, and re-running is the intended way to check an environment.
#
# Two things this deliberately does NOT do:
#   - Install the macOS voices. There is no CLI for it; they come from a GUI download in System
#     Settings. The script detects and instructs instead of pretending.
#   - Fetch reference media. assets/refs/ is gitignored and not ours to redistribute.
set -uo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
FAIL=0
WARN=0

ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; WARN=$((WARN+1)); }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$OFF"; }
head_() { printf '\n%s\n' "$1"; }

# --- platform ------------------------------------------------------------------------------
head_ "Platform"
if [[ "$(uname -s)" != "Darwin" ]]; then
    bad "macOS required — the voice pipeline is built on \`say\`, which has no equivalent elsewhere"
else
    ok "macOS $(sw_vers -productVersion)"
fi

# --- node ----------------------------------------------------------------------------------
head_ "Node"
if ! command -v node >/dev/null 2>&1; then
    bad "node not found — install Node 22 or newer"
else
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    if (( NODE_MAJOR < 22 )); then
        bad "node $(node -v) is too old; package.json requires >=22"
    else
        ok "node $(node -v)"
    fi
fi
command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || bad "npm not found"

# --- homebrew tools ------------------------------------------------------------------------
head_ "Audio tools"

brew_install() {
    local formula="$1"
    if (( CHECK_ONLY )); then
        bad "$formula not found (run without --check to install)"
        return
    fi
    if ! command -v brew >/dev/null 2>&1; then
        bad "$formula not found and Homebrew is unavailable — install $formula manually"
        return
    fi
    printf '    installing %s…\n' "$formula"
    if brew install "$formula" >/dev/null 2>&1; then
        ok "$formula installed"
    else
        bad "brew install $formula failed"
    fi
}

if command -v ffmpeg >/dev/null 2>&1; then
    ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
    # The chains name these directly; a build without one fails at render time, not at start.
    #
    # The list is captured ONCE rather than re-piped per filter. Piping ffmpeg into `grep -q` under
    # `set -o pipefail` reports failure even on a match: grep exits at the first hit, ffmpeg takes
    # SIGPIPE, and pipefail surfaces ffmpeg's 141. It fails only for filters early in the
    # alphabetical listing — late ones let grep drain the output first — so it presented as seven
    # specific filters being "missing" from a build that demonstrably had them.
    FILTER_LIST="$(ffmpeg -hide_banner -filters 2>/dev/null)"
    MISSING_FILTERS=()
    for f in firequalizer acrusher aecho asetrate atempo loudnorm alimiter asubboost highpass lowpass; do
        grep -qE "[[:space:]]${f}[[:space:]]" <<<"$FILTER_LIST" || MISSING_FILTERS+=("$f")
    done
    if (( ${#MISSING_FILTERS[@]} )); then
        bad "ffmpeg is missing required filters: ${MISSING_FILTERS[*]}"
    else
        ok "ffmpeg has every filter the chains use"
    fi
else
    brew_install ffmpeg
fi

# Not optional. This ffmpeg has no librubberband, so the CLI binary is the only
# formant-preserving pitch shifter available — and shifting pitch with asetrate instead makes the
# voice sound like tape running slow rather than like a man.
if command -v rubberband >/dev/null 2>&1; then
    ok "rubberband $(rubberband --version 2>&1 | head -1 | awk '{print $NF}')"
else
    brew_install rubberband
fi

# --- voices --------------------------------------------------------------------------------
head_ "Voices"
# `say -v '?'` lists installed voices. Never probe with `say -v NAME -o /dev/null` — that fails
# for EVERY voice, including installed ones, and reports false negatives.
VOICE_LIST="$(say -v '?' 2>/dev/null)"

check_voice() {
    local name="$1" why="$2" required="$3"
    if grep -qF "$name" <<<"$VOICE_LIST"; then
        ok "$name — $why"
    elif [[ "$required" == "required" ]]; then
        bad "$name not installed — $why"
        note "System Settings → Accessibility → Spoken Content → System Voice → Manage Voices"
    else
        warn "$name not installed — $why"
        note "System Settings → Accessibility → Spoken Content → System Voice → Manage Voices"
    fi
}

check_voice "Tom (Enhanced)" "base voice for warmind/measured/plain" required
check_voice "Yuri (Enhanced)" "ru_RU male, required by the og-warmind chain" optional

# --- claude cli ----------------------------------------------------------------------------
head_ "Claude CLI"
if command -v claude >/dev/null 2>&1; then
    ok "claude $(claude --version 2>/dev/null | head -1)"
    note "used by og-warmind to translate before speaking; failures degrade to the source text"
else
    warn "claude not found — og-warmind will speak untranslated English"
    note "https://claude.com/claude-code"
fi

# --- npm deps ------------------------------------------------------------------------------
head_ "Dependencies"
if (( CHECK_ONLY )); then
    [[ -d node_modules ]] && ok "node_modules present" || bad "node_modules missing (run without --check)"
else
    printf '    npm install…\n'
    if npm install --no-audit --no-fund >/dev/null 2>&1; then
        ok "npm dependencies installed"
    else
        bad "npm install failed"
    fi
    # Playwright ships its own Chromium; the system one has no working WebGL here, which is why
    # tools/shoot.ts exists as a screenshot harness at all.
    printf '    playwright chromium…\n'
    if npx playwright install chromium >/dev/null 2>&1; then
        ok "playwright chromium installed"
    else
        warn "playwright chromium install failed — tools/shoot.ts will not work"
    fi
fi

# --- local config --------------------------------------------------------------------------
head_ "Config"
if [[ -f .env ]]; then
    ok ".env present"
elif (( CHECK_ONLY )); then
    warn ".env missing (defaults apply; run without --check to create it)"
else
    cp .env.example .env && ok ".env created from .env.example" || warn "could not create .env"
fi

if [[ -d assets/refs ]] && [[ -n "$(ls -A assets/refs 2>/dev/null)" ]]; then
    ok "assets/refs present — analyze-ref and fit-eq can run"
else
    warn "assets/refs is empty — \`npm run analyze-ref\` and \`npm run fit-eq\` need reference media"
    note "gitignored on purpose; supply your own captures. Everything else works without it."
fi

# --- verify --------------------------------------------------------------------------------
head_ "Verify"
if [[ -d node_modules ]]; then
    npm run typecheck >/dev/null 2>&1 && ok "typecheck clean" || bad "typecheck failed — run: npm run typecheck"
    if npm test >/tmp/rasputin-setup-test.log 2>&1; then
        ok "tests pass ($(grep -oE 'Tests: +[0-9]+ passed' /tmp/rasputin-setup-test.log | grep -oE '[0-9]+' | head -1) tests)"
    else
        bad "tests failed — run: npm test"
    fi
else
    warn "skipping typecheck and tests — dependencies not installed"
fi

# --- summary -------------------------------------------------------------------------------
printf '\n'
if (( FAIL > 0 )); then
    printf '%s%d blocking problem(s)%s' "$RED" "$FAIL" "$OFF"
    (( WARN > 0 )) && printf ', %d warning(s)' "$WARN"
    printf '\n'
    exit 1
fi
if (( WARN > 0 )); then
    printf '%sReady, with %d warning(s)%s — optional features are degraded, core works.\n' "$YELLOW" "$WARN" "$OFF"
else
    printf '%sReady.%s\n' "$GREEN" "$OFF"
fi
printf '\nNext:\n'
printf '  npm run daemon        the brain, on :7331\n'
printf '  npm run orb           the renderer, on :7332 — open it in Chrome\n'
printf '  npm run say -- "All systems operational"    render one line without either\n'
