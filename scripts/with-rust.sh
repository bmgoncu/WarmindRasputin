#!/usr/bin/env bash
#
# Runs a command with the Rust toolchain on PATH.
#
#   ./scripts/with-rust.sh tauri dev
#
# Exists because Homebrew's `rustup` formula keeps its shims in its own opt directory rather than
# `~/.cargo/bin`. So `brew install rustup && rustup default stable` succeeds, `rustup` works, and
# `cargo` is still not found — which surfaces as tauri failing on `cargo metadata` with a bare
# "No such file or directory".
#
# Resolving it here rather than in a shell profile keeps `npm run overlay` working on a machine
# nobody has configured, which is the same reason scripts/setup.sh exists.
set -euo pipefail

if ! command -v cargo >/dev/null 2>&1; then
    for candidate in \
        "$(brew --prefix rustup 2>/dev/null || true)/bin" \
        "$HOME/.cargo/bin" \
        "/opt/homebrew/opt/rustup/bin" \
        "/usr/local/opt/rustup/bin"
    do
        if [[ -x "$candidate/cargo" ]]; then
            export PATH="$candidate:$PATH"
            break
        fi
    done
fi

if ! command -v cargo >/dev/null 2>&1; then
    cat >&2 <<'MSG'
cargo not found.

The overlay needs a Rust toolchain:

    brew install rustup && rustup default stable

If that has already run, the shims are probably off PATH — Homebrew keeps them in its own opt
directory, not ~/.cargo/bin. Check with:

    ./scripts/setup.sh --check
MSG
    exit 1
fi

exec "$@"
