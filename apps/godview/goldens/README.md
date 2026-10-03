# View goldens (MV-0)

Pixel goldens of the monitor views as they ship, recorded before the monitor-view contract (MV) moves them onto the
SDK. They are the visual gate for every MV slice: a slice's capture is compared against these, and any difference
either goes away or is named and shown to James as an intentional change.

## What is captured

`views/<view>/<theme>-<size>-n<n>[-bare].png`, 48 images (4.2 MB), with `views/manifest.json` listing each one's
parameters and sha256 and the environment that recorded them.

|        |                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| views  | list, rain, timeline (the timeline twice: with the book Godview keeps today, and `-bare`, without one: what it draws once MV-6 retires the ledger, L10) |
| themes | light, dark                                                                                                                                             |
| sizes  | Godview's stage (35 % of the window, floor 170 px): compact 680×170 · default 1180×252 · wide 1728×378                                                  |
| rows   | n = 1 and n = 20 from the seeded world (`packages/views/src/lab/lab-world.ts`)                                                                          |
| motion | animations off (`data-godview-animations="off"`), 60 frames stepped on the capture clock                                                                |

The swarm is not here. Its golden is its frame sequence (`packages/views/src/views/swarm/goldens`), because what
matters there is the physics and the models it hands its renderer, not one frame of pixels.

## Commands

From `apps/godview`:

```sh
node goldens/capture.mjs --compare      # capture into a temp dir, compare against goldens/views, print the report path
node goldens/capture.mjs                # capture only; prints the dir
node goldens/compare.mjs --candidate <dir> [--golden goldens/views] [--out <dir>] [--tolerance 8] [--threshold 0.001]
node goldens/capture.mjs --update       # re-record goldens/views (an intentional change, named in its commit)
```

`--only <text>` captures the ids containing it (`--only rain/`, `--only dark-wide`); `--no-build` reuses
`dist/*-lab.html` instead of rebuilding the labs first. Run with `TMPDIR=/tmp`.

The capture opens each lab page (`dist/<view>-lab.html?capture=1&theme=…&size=…&n=…&animations=0[&book=0]`) in
one offscreen Electron window: it is never shown, the Dock icon is hidden, and nothing takes focus. To look at any
golden's page by hand, open the same URL without `capture=1`.

## Reading a comparison

A pixel differs when any channel moved by more than `--tolerance` (8/255 by default). An image fails when more than
`--threshold` of its pixels differ (0.1 % by default), when its size changed (`SIZE`), or when it is missing
(`MISSING`). An image the goldens don't hold is listed as `NEW`. Every image with a differing pixel gets
`diffs/<view>/<name>.diff.png`, three panels: the golden, the capture, and the differing pixels in red over the golden
faded (brighter red for a bigger move). `report.md` and `report.json` sit beside the diffs. The exit code is 1 when
anything fails.

## Why it is deterministic

Same machine, same build: three consecutive captures were byte-identical (48 of 48, tolerance 0), so the default
tolerance is headroom for another Mac, not noise on this one. What pins it:

- **The capture clock** (`packages/views/src/lab/lab-clock.ts`, `capture=1` only):
  - `Date.now()` stands at 2026-10-03T15:00:00Z, and `performance.now()` advances only with stepped frames.
  - `Math.random` is seeded, and rAF runs only when stepped, at exactly 60 Hz.
  - The wall clock does not advance on purpose. Resize observers fire on real frames, between virtual ones, so a view
    that reads the time there (the timeline's scale) drew its axis a fraction of a pixel apart from run to run.
- **The page**: the stage alone at the origin. `capture-main.mjs` checks the stage's rect and devicePixelRatio, and a
  page that logs an error fails its capture.
- **The environment**:
  - `TZ=UTC` and `--lang=en-US`, because the timeline prints local times.
  - `offscreen.deviceScaleFactor: 2` (Retina), whatever display is attached; an offscreen page is at 1 otherwise.
  - Electron and Chromium versions are recorded in the manifest.

A golden recorded on another machine or OS release can differ in glyph rasterisation. Compare captures from one
environment, and re-record (`--update`) when the environment changes, saying so in the commit.

## Proved

- A/A: three captures in a row, 48 of 48 identical.
- Mutation probe: moving the list's top padding by 1 px (`styles/list.css`) failed all 12 list goldens (1.4–4.3 % of
  pixels each) with the shifted edges in the diff panels; reverted.

## Notes

- Offscreen `capturePage` does capture the WebGPU swarm. The blank-readback limit is `drawImage` from a live WebGPU
  canvas, not the window's own capture. Swarm pixel goldens are therefore possible later, at about 0.5 MB an image.
- Electron 43 crashed (SIGTRAP) when an offscreen window was destroyed and another opened, so the capture reuses one
  window for every page.
- The main is ESM and must not await `app.whenReady()` at top level: Electron emits `ready` only after the entry
  module finishes evaluating.
