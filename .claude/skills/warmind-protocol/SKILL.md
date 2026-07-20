---
name: warmind-protocol
description: Use when adding or changing a message between the daemon and the renderer, or when something works in Chrome but not in the Tauri overlay. Covers the ServerMsg/ClientMsg union, who owns which state, and the overlay-only traps.
---

# Warmind protocol

`src/shared/protocol.ts` is imported by **both** halves. A variant added on one side and not the
other is a compile error rather than a silent runtime no-op — that is the whole point, so extend the
union rather than passing loose objects.

## Ownership rules

- **The RENDERER owns `speaking`.** The server sends `speak`; the renderer answers `playback` when
  audio actually starts. A server that declares "speaking" on send animates against silence.
- **The RENDERER owns playback order and the subtitle.** The daemon serialises *rendering* and
  broadcasts as soon as audio exists, far faster than it can be spoken. Utterances queue in the
  renderer, and the caption travels **with** the audio — setting it on arrival strands a stale line
  on screen.
- **The DAEMON owns settings.** The overlay and preferences are separate webviews with no shared
  memory, so config travels renderer → daemon → all renderers, and persists to `cache/config.json`.
  That path also works in Chrome and survives either window reloading.
- **Timing is a feature timeline plus a duration, never per-frame level messages.** WebSocket
  delivery is not sample-accurate; the renderer schedules against `AudioContext.currentTime`.

## Overlay-only traps

- **Never derive the daemon origin from `location`.** Tauri serves from `tauri://localhost`, so
  `location.hostname` is `tauri.localhost`; the resulting URL is unresolvable and outside the CSP —
  and **a CSP-blocked `new WebSocket()` throws synchronously**, killing module execution before the
  render loop starts.
- **`connect-src` must include `ipc: http://ipc.localhost`** or every `invoke()` fails.
- **Style overlay UI through CSSOM, not an injected `<style>` element.** Tauri rewrites the CSP with
  nonces, which makes `'unsafe-inline'` inert.
- **Nothing on the network path may take the render loop down** — the orb must survive a dead daemon.
- **Use `link.log()` to debug the overlay.** A release-build WKWebView has no devtools; the
  app-spawned daemon logs to `~/Library/Logs/Rasputin/daemon.log`.
