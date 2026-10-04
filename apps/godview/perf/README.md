# Godview paired perf harness (MV-0)

The performance gate for the monitor-view contract (build-mv L14, L17). It runs the **real** Godview (main, runtime,
ghosttead, renderer) with imposter agents changing state on a fixed schedule, and measures each monitor view. Two
builds run interleaved in one session and are judged against an A/A null arm. A recorded baseline is reference,
never a bound.

```sh
# from apps/godview, after `node build.mjs` in every app compared
node perf/harness.mjs                                     # A/A on this app: the baseline
node perf/harness.mjs --b /path/to/slice/apps/godview      # A/B/A′ rounds; A is --a (this app by default)
```

| option                        | default                  |                                                                                                      |
| ----------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `--a`, `--b`                  | this app, none           | the `apps/godview` directories to compare (each built)                                               |
| `--rounds`                    | 7                        | each round runs every arm once, in an order rotated per round; seven before z is read (build-mv M24) |
| `--counts`                    | 10,20,60                 | agents on the board, grown in one launch: 10, then 20, then 60                                       |
| `--views`                     | swarm,list,rain,timeline | measured at each count, in an order rotated per round                                                |
| `--warmup-ms` / `--window-ms` | 3000 / 10000             | after switching view, settle, then measure                                                           |
| `--step-ms`                   | 3000                     | each agent changes state this often, its phase offset by its place                                   |
| `--fps`                       | 60                       | the offscreen frame rate (Electron allows up to 240)                                                 |
| `--load-max`                  | 60                       | before each launch, wait for the 1-minute load average to fall below this (L17)                      |
| `--out`                       | `perf/runs/<time>`       | `results.json`, `summary.md`, one Electron log per launch                                            |

## What one launch does

1. Makes a temporary HOME and profile, so nothing touches real agent configuration, history or accounts. A `claude`
   wrapper runs the imposter (`packages/imposter/bin/ai.mjs --claude`) with its TUI off, dialing the harness's
   control channel (`control-plane.mjs`).
2. Starts Electron on the app with `NODE_OPTIONS=--require perf/offscreen-main.cjs`:
   - every window is offscreen (never shown, Dock hidden, no focus taken, 60 Hz frames, DPR 2), so a run can neither
     steal James's focus nor be occluded;
   - `--use-mock-keychain` keeps the keychain out of it;
   - each window loads `about:blank` and holds its document at a gate until the harness has registered
     `page-probe.js`, so the probe precedes the app's first script.
3. Spawns agents through the app's own door (`window.puppeteer.createAgentSession`), in batches of 10, across six
   project folders. Each agent then walks one turn per seven steps — prompt, read, a command that waits on permission,
   the command, the answer — so the board shows working, blocked and idle, with the field changing n ÷ 3 times a
   second.
4. At each count, clicks each view's bar button, waits `--warmup-ms`, then measures a `--window-ms` window.

## The metrics (page-probe.js)

- **Frame time**: deltas between consecutive rAF callbacks; p50, and p95 (weather; L14). The offscreen window
  produces frames at a fixed 60 Hz, so the floor is 16.7 ms and the number moves only when the main thread runs long.
- **Long animation frames**: Chromium's `long-animation-frame` entries: count, total and blocking duration.
- **rAF work**: how long the page's own animation-frame callbacks ran, per second. The canvas views draw there (the
  swarm's loop and its inline physics, the rain, the timeline), so their per-frame cost shows while frames still land
  inside the budget. The probe installs a timing wrapper before any page script, and its own sampler is not counted.
- **React commits of the view**, through a minimal React DevTools global hook (React's own injection point; the app is
  unchanged):
  - a commit rendered the view when the view's fiber (the stage section's first child) is a new object carrying
    React's PerformedWork flag;
  - its `actualDuration` is the view's render time, as a `<Profiler>` around it would report (Godview's renderer
    bundle is React's development build, which times every render);
  - all commits are counted too.
- **The board**: the list's rows by status, as evidence the agents walk their turns.

## Reading the summary (summary.mjs)

Per n and view:

- each arm's median over rounds;
- the paired per-round differences A′ − A (the null arm, the same build twice) and B − A, read with one estimator:
  T = the median difference, MAD = its spread, z = |T| ÷ (1.858·MAD/√R);
- a metric regresses when B − A > 0, z > 4 and T > 2 % of A's median;
- the A/A z is the instrument's health: near 2 or below;
- seven rounds come before z is read (M24): with three, MAD often collapses to 0 and z reads ∞ on a difference of
  nothing;
- rates are per second of the nominal window, and differences are rounded to 1e-3, so equal counts never read as a
  difference.

## Limits

- Offscreen frames are not the display's: the A/B pairing is valid because both arms run the same way, not because the
  absolute numbers match an on-screen Godview.
- The imposter's hooks are real native traffic into the real runtime, but the TUI is off and no terminal is mounted
  in a pane: the deck holds only the first pane's shell.
- The machine is shared (L17): loads are recorded per launch in `summary.md`; medians, not tails, decide.
