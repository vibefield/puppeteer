# View goldens (MV-0)

Pixel goldens of the monitor views as they ship, recorded before the monitor-view contract (MV) moves them onto the
SDK. They are the visual gate for every MV slice: a slice's capture is compared against these, and any difference
either goes away or is named and shown to James as an intentional change.

## What is captured

`views/<view>/<theme>-<size>-n<n>.png`, 48 images (5.6 MB), with `views/manifest.json` listing each one's
parameters and sha256 and the environment that recorded them.

|        |                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| views  | list, rain, swarm (since MV-5: twelve images recorded from the legacy swarm's lab at base `d91c7b7`, which the ported view is held to; animations on, it is motion), timeline (one set of ids since MV-8: it was captured twice, with the book Godview kept and `-bare` without it, until MV-6 retired the book (runtime only) and the two drew byte-identical images; MV-8 folded them, keeping the unsuffixed ids) |
| themes | light, dark                                                                                                                                             |
| sizes  | Godview's stage (35 % of the window, floor 170 px): compact 680×170 · default 1180×252 · wide 1728×378                                                  |
| rows   | n = 1 and n = 20 from the seeded world (`packages/views/src/lab/lab-world.ts`)                                                                          |
| motion | 60 frames stepped on the capture clock; animations off (`data-godview-animations="off"`), but the rain on: it ran its loop regardless until MV-4, and since it honours the switch it is asked for motion |

The swarm's truer goldens are its frame sequences, in `swarm/` (below): what matters there is the physics and the
models it hands its renderer over time, not one frame of pixels. Its twelve pixel images came with the port (MV-5) as
the coarse gate beside them: a port that moved a colour, a glyph or the empty words would fail them.

## The swarm's frame goldens

`swarm/<scenario>.json`: the frames the shipping `AgentSwarm` (the SDK view since MV-5, mounted through the lab's
`/host` slot) hands its renderer, recorded by `swarm-frames.mjs` through a paint spy. At bundle time the spy replaces
`createSwarmRenderer`, for AgentSwarm alone, with a renderer that records. Everything else runs as shipped:

- the view and its bubble models;
- the physics inline — a single-file page has no `import.meta.url`, so the view's driver runs the same host in this
  thread and reports `physics: 'inline'` — pumped from the view's frame loop on the capture clock's exact 60 Hz
  frames, so a fixed timestep;
- real layout and the usage column as a stage obstacle (MV-D19), in the same offscreen window as the pixel goldens.

| scenario            | stage    | rows | theme |
| ------------------- | -------- | ---- | ----- |
| `default-n20-light` | 1180×252 | 20   | light |
| `compact-n20-dark`  | 680×170  | 20   | dark  |
| `default-n1-light`  | 1180×252 | 1    | light |

Each scenario runs 60 frames from mount, then the world moves on (`labWorld({ churn: true })`): the active agent stops
on a permission, the one asking gets its answer, an unread one is closed, and one arrives. Then it runs 60 more frames
(motion on).

A golden keeps every 4th frame, the frames either side of the change, and the last. Per body it records:

- place, eased radius, arrival scale and opacity, focus, phase seed, accent and link;
- its bubble model, stored once under a hash (numbers rounded to 1e-4).

The compare is field by field and exact, and it prints the first differences with their paths.

```sh
node goldens/swarm-frames.mjs            # record into a temp dir and compare against goldens/swarm
node goldens/swarm-frames.mjs --update   # re-record (an intentional change, named in its commit)
```

The same three sequences also run under vitest with happy-dom (build-mv M1), in every `pnpm test`:
`packages/views/test/swarm-frames.test.tsx`, with its goldens in `test/goldens/swarm/`. It lives outside the view's
folder since MV-5 because it needs the lab's world, and a view's folder may import only the SDK (MV-W1).

- The same paint spy (`vi.mock` of the renderer module), the driver's inline physics (happy-dom has no `Worker`; the
  test asserts the `physics: 'inline'` report) on fake rAF, fake time from `LAB_NOW_MS`, and a seeded `Math.random`.
- happy-dom lays nothing out, so the stage's box and the usage column's obstacle are Godview's geometry, given by
  hand through the view's `stage` input.
- Re-record with `pnpm exec vitest run test/swarm-frames.test.tsx -u` (from `packages/views`).

The two are kept on purpose. The vitest one is the every-commit gate. The Electron one is the witness with real layout,
real colours and real chrome.

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

The capture opens each lab page (`dist/<view>-lab.html?capture=1&theme=…&size=…&n=…&animations=0|1`) in
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
- Mutation probe: moving the list's top padding by 1 px (`styles/list.css`, `views/list/list.css` since MV-4) failed all 12 list goldens (1.4–4.3 % of
  pixels each) with the shifted edges in the diff panels; reverted.
- Swarm frames: two recordings after the golden matched it exactly (3 of 3). A probe softening the radius spring
  (`RADIUS_SPRING_OMEGA` 16 → 15) failed on exactly the bodies the churn changed, from the first frame after it
  (`/frames/17/bodies/7/radius: 55.77 → 55.31`); reverted.

## Notes

- Offscreen `capturePage` does capture the WebGPU swarm. The blank-readback limit is `drawImage` from a live WebGPU
  canvas, not the window's own capture. Swarm pixel goldens are therefore possible later, at about 0.5 MB an image.
- Electron 43 crashed (SIGTRAP) when an offscreen window was destroyed and another opened, so the capture reuses one
  window for every page. Godview itself did not reproduce it (MV-5, Electron 43.1.0, 2026-10-05):
  `node worker-windows-probe.mjs` runs the real app offscreen, opens four windows through Godview's own door and
  destroys two whose swarm ran its physics worker, and the main process lives; every window's slot reported
  `physics: worker`. The crash's shape remains the capture's, and the capture keeps its one window.
- The main is ESM and must not await `app.whenReady()` at top level: Electron emits `ready` only after the entry
  module finishes evaluating.
