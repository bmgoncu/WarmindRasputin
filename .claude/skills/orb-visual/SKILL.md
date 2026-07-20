---
name: orb-visual
description: Use when changing the orb renderer — the node graphs, jolts, arcs, pulses, shaders or bloom. Covers what the Destiny reference actually shows, the verification loop, and the measurements that have repeatedly misled.
---

# Orb visual

Matched to Destiny reference frames, **not** reinterpreted. Layer stack back to front: core ·
interior haze · inner graph · glass shell · outer graph · streaks.

## What the reference actually shows

- **The nodes and edges are a lattice on the shell**, not orbiting satellites. Irregular
  triangulated wireframe, `depthTest: false` so the far side shows through — that see-through
  quality is most of the depth cue.
- **The core is white-blue, not orange.** Orange is the shell; crimson is the environment.
- **Amplitude drives a colour-temperature ramp**, not mainly scale. Deep red → orange →
  yellow-white, plus lattice density and spark count. Scale change is subtle and secondary.
- **The silhouette is a rounded diamond** — a superellipsoid, not a sphere.

## Verify by looking, not by reasoning

`npx tsx tools/shoot.ts <level> <out.png>` renders the live orb. Two flags exist because a
frame-difference image cannot isolate one animated system — drift, spin, edge shimmer, aging and
pulses all animate every frame, so a naive diff lights up the entire graph:

- `ORB_FREEZE=1` stops drift, spin, rebuilds and pulses
- `ORB_SOLO=1` draws jolt and arc segments alone against black

## Measurements that have misled

Radial metrics have been wrong at least three times — on wave speed, breathing amplitude and edge
extent. Prefer looking at the render.

- **The superellipsoid must NOT be renormalised.** Normalising to unit length forces every direction
  to radius 1, which is the definition of a sphere, and makes the shape parameter do nothing.
- **`maxEdgeDist` is a FRACTION of radius**, so growing the radius scales spacing and threshold
  together — the density looks identical. Only node count and the degree cap thin a graph.
- **`worldRadius` is shared across graphs.** Normalising per-graph made the outer shell light all at
  once, which reads as a pingpong rather than a travelling wave.
- **The push wave needs `aRest`** — the undisplaced radius. Without it, brightening and radial
  dimming cancel and the wave inverts.
- **Jolts must reroute on rebuild, never be culled**, or travel is capped at the rebuild interval.
- **Never adopt an existing transcript-like file from offset 0** — the same rule as the tailer.
- **`antialias: true` is a no-op through `EffectComposer`** — use a `{ samples: 4 }` target.
- **`Points` render round.** Streaks must be short `LineSegments` oriented along velocity.
