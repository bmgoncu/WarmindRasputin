# Releasing

`npm run release` checks everything and refuses to build if anything is wrong.
`npm run release -- --build` then produces the `.app` and `.dmg`.

It does **not** tag, push, or publish. A human does that after reviewing the artefact — the same
rule as every commit in this project.

## What ships, and what does not

The app bundles the daemon: `scripts/bundle-daemon.mjs` inlines it and its two runtime dependencies
(`ws`, the Agent SDK) into one 1.5 MB file, shipped in `Resources/daemon/` alongside the fitted EQ
curve. An installed copy therefore runs **without a checked-out repo** — verified by running the
`.app` from `/tmp`, where it started the bundled daemon, worked from Application Support, and
synthesised speech.

Four things are deliberately **not** bundled:

| Not bundled | Why |
|---|---|
| **Node** | ~100 MB for a runtime most developers already have. The app resolves an installed one by absolute path. |
| **ffmpeg** | Large, and its licence makes redistribution a decision rather than a detail. |
| **rubberband** | Same reasoning; `brew install rubberband`. |
| **The Enhanced voices** | There is no CLI to install them — they come from a GUI download in System Settings. |

`scripts/setup.sh` checks all of them, and `npm run release` re-checks them because a user needs
them too, not just whoever builds.

## Signing — the honest state

The app is **ad-hoc signed**. Two consequences, both real:

1. **Gatekeeper blocks a downloaded copy.** The user must right-click → Open the first time, or run
   `xattr -dr com.apple.quarantine /Applications/Rasputin.app`.
2. **Permission grants break on every rebuild.** TCC ties Microphone and Accessibility grants to the
   code signature, and an ad-hoc signature changes each build. macOS may then show Rasputin as
   allowed while silently denying it — the fix is to remove the entry and let it re-prompt.

Both are fixed by a Developer ID certificate ($99/year Apple Developer Program), after which
`tauri build` can sign and notarise via `APPLE_CERTIFICATE`, `APPLE_ID` and `APPLE_PASSWORD`. Until
then the release notes must say so plainly; a downloaded app that appears broken to Gatekeeper is
worse than one that explains itself.

## Version

`package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` must agree. The preflight
compares all three — it caught `package.json` having no `version` field at all.

## Steps

```bash
npm run release                 # check
npm run release -- --build      # check, then build .app and .dmg
git tag -a v0.1.0 -m "..."      # human
git push origin v0.1.0          # human
gh release create v0.1.0 --notes-file NOTES.md src-tauri/target/release/bundle/dmg/*.dmg
```

Release notes should carry the Gatekeeper instruction and the prerequisite list, since neither is
discoverable from a `.dmg`.
