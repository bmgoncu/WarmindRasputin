#!/usr/bin/env bash
#
# Pre-flight for a release, and the artefact build.
#
#   ./scripts/release.sh          check only
#   ./scripts/release.sh --build  check, then build the .app and .dmg
#
# Does NOT tag, push, or publish. A human does that after reviewing what this produced — the same
# rule as every other commit in this project.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
FAIL=0
ok()  { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
bad() { printf '  %s✗%s %s\n' "$RED" "$OFF" "$1"; FAIL=$((FAIL+1)); }
warn(){ printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$1"; }

printf '\nVersions\n'
PKG=$(node -p "require('./package.json').version")
TAU=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
CAR=$(grep -m1 '^version' src-tauri/Cargo.toml | sed 's/.*"\(.*\)".*/\1/')
if [[ "$PKG" == "$TAU" && "$PKG" == "$CAR" ]]; then
    ok "all three agree on $PKG"
else
    bad "disagree — package.json $PKG, tauri.conf.json $TAU, Cargo.toml $CAR"
fi

printf '\nWorking tree\n'
if [[ -z "$(git status --porcelain)" ]]; then ok "clean"; else bad "uncommitted changes — commit before releasing"; fi

printf '\nQuality gates\n'
npm run typecheck >/dev/null 2>&1 && ok "typecheck" || bad "typecheck failed"
if npm test >/tmp/rasputin-release-test.log 2>&1; then
    ok "tests pass ($(grep -oE 'Tests: +[0-9]+ passed' /tmp/rasputin-release-test.log | grep -oE '[0-9]+' | head -1))"
else
    bad "tests failed — see /tmp/rasputin-release-test.log"
fi

printf '\nSigning\n'
# TCC grants are tied to the code signature, so an ad-hoc one means microphone and accessibility
# permissions are invalidated on every rebuild — for the user, not just the developer.
if [[ -d src-tauri/target/release/bundle/macos/Rasputin.app ]]; then
    SIG=$(codesign -dv src-tauri/target/release/bundle/macos/Rasputin.app 2>&1 | grep -oE 'Signature=[a-z]+' | cut -d= -f2)
    if [[ "$SIG" == "adhoc" || -z "$SIG" ]]; then
        warn "ad-hoc signature — Gatekeeper will block a downloaded copy, and permission grants break on every rebuild"
        warn "a Developer ID certificate is needed to fix both; see docs/RELEASE.md"
    else
        ok "signed: $SIG"
    fi
fi

printf '\nRuntime prerequisites (the user needs these too)\n'
for tool in node ffmpeg rubberband; do
    command -v "$tool" >/dev/null 2>&1 && ok "$tool" || bad "$tool missing"
done
command -v claude >/dev/null 2>&1 && ok "claude CLI (og-warmind translation)" || warn "claude CLI missing — og-warmind speaks untranslated"
command -v whisperkit-cli >/dev/null 2>&1 && ok "whisperkit-cli (voice input)" || warn "whisperkit-cli missing — no voice input"
say -v '?' 2>/dev/null | grep -q "Tom (Enhanced)" && ok "Tom (Enhanced) voice" || bad "Tom (Enhanced) not installed"
say -v '?' 2>/dev/null | grep -q "Yuri (Enhanced)" && ok "Yuri (Enhanced) voice" || warn "Yuri (Enhanced) missing — og-warmind falls back"

printf '\n'
if (( FAIL > 0 )); then
    printf '%s%d blocking problem(s).%s Not building.\n' "$RED" "$FAIL" "$OFF"
    exit 1
fi

if [[ "${1:-}" != "--build" ]]; then
    printf 'Ready. Re-run with --build to produce the .app and .dmg.\n'
    exit 0
fi

printf 'Building…\n'
if npx tauri build --bundles app,dmg 2>&1 | tail -3; then
    printf '\n%sArtefacts%s\n' "$GREEN" "$OFF"
    ls -lh src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | awk '{print "  " $9 "  " $5}'
    printf '\nNext, by hand:\n'
    printf '  git tag -a v%s -m "..."   &&  git push origin v%s\n' "$PKG" "$PKG"
    printf '  gh release create v%s --notes-file <notes> src-tauri/target/release/bundle/dmg/*.dmg\n' "$PKG"
fi
