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

| option                        | default                  |                                                                                                                               |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `--a`, `--b`                  | this app, none           | the `apps/godview` directories to compare (each built)                                                                        |
| `--rounds`                    | 7                        | each round runs every arm once, in an order rotated per round; seven before z is read (build-mv M24)                          |
| `--counts`                    | 10,20,60                 | agents on the board, grown in one launch: 10, then 20, then 60                                                                |
| `--views`                     | swarm,list,rain,timeline | measured at each count, in an order rotated per round; `spend` too, where every arm has it (MV-7)                           |
| `--warmup-ms` / `--window-ms` | 3000 / 10000             | after switching view, settle, then measure                                                                                    |
| `--step-ms`                   | 3000                     | each agent changes state this often, its phase offset by its place                                                            |
| `--fps`                       | 60                       | the offscreen frame rate (Electron allows up to 240)                                                                          |
| `--synthetic-b-ms`            | none                     | the negative control: with no `--b`, B is A's own build plus this many ms of busy wait in every page animation-frame callback |
| `--history-ended`             | none                     | the history arm (TLV): with no `--b`, B is A's own build lending a view that declares `history` a fixture (each agent row a day of turns, this many runs that ended within the hour; `src/renderer/monitor/perf-history.ts`); A and A′ lend none |
| `--load-max`                  | 60                       | before each launch, wait for the 1-minute load average to fall below this (L17)                                               |
| `--out`                       | `perf/runs/<time>`       | `results.json`, `summary.md`, one Electron log per launch                                                                     |

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
  - all commits are counted too, every root's.
- **Every React root's render time** (build-mv M33). A view `/host` mounts in its OWN root (every view, through
  `reactMonitorView`; the legacy bridge did the same until MV-8) is no fiber of the host's tree, so the view row above cannot see it. The same hook therefore records, for every committed
  root of every renderer, the root fiber's `actualDuration`: the time React spent rendering that commit, the whole
  tree's. `all roots render` is their sum. Each root also carries its container's name, its first named components and
  its place: `host` (it holds the monitor stage), `stage` (below the stage: a view's own root) or `other`.
- **Main-thread tasks** (build-mv M33), from DevTools' Performance domain: `Performance.enable` once the page is ready,
  then `Performance.getMetrics` read inside each probe window, so neither evaluate's own work is counted. The
  cumulative counters' differences are recorded (`measurement.main`):
  - `TaskDuration`: every task the renderer's main thread ran, React, rAF, input, timers, layout and paint alike. Work
    a slice moves between a message handler and an animation frame stays inside this total.
  - its parts: `ScriptDuration`, `LayoutDuration`, `RecalcStyleDuration`;
  - context: `ThreadTime` (the main thread's CPU time) and `ProcessTime` (the renderer process's CPU time, every
    thread).
- **The board**: the list's rows by status, as evidence the agents walk their turns.

## Reading the summary (summary.mjs)

The summary opens with **the gate**: it reads TOTALS (M33), because a slice can move work between the per-view rows
without changing how much there is (its own root, a frame scheduler moving updates into rAF):

- gate rows: frame p50, long animation frames (count, duration, blocking), `all roots render`, `main-thread tasks`
  and its parts (script, layout, recalc style);
- context rows: rAF work, all commits, the host root's view commits and render, and the CPU times. They show where the
  work sat. When the regression rule fires on one it reads `context · up`, which is no verdict;
- frame p95 is weather.

The section lists the gate readings that regressed, the A/A arm's health over the gate readings and the context
readings that rose. Each cell ends with where the roots' render time sat, per arm.

Per n and view:

- each arm's median over rounds;
- the paired per-round differences A′ − A (the null arm, the same build twice) and B − A, read with one estimator:
  T = the median difference, MAD = its spread, z = |T| ÷ (1.858·MAD/√R);
- a gate metric regresses when B − A > 0, z > 4 and T > 2 % of A's median;
- the A/A z is the instrument's health: near 2 or below;
- seven rounds come before z is read (M24): with three, MAD often collapses to 0 and z reads ∞ on a difference of
  nothing;
- rates are per second of the nominal window, and differences are rounded to 1e-3, so equal counts never read as a
  difference.

## Proved (`baselines/`)

- **A/A, R = 7** (`2026-10-04-aa-r7`, today's views):
  - 14 launches, none failed; load at launch 15.6–59.0;
  - of about 108 readings (12 cells × 9 metrics), three exceed z 2.3, the highest 3.6, and none meets the regression
    rule.
- **Negative control** (`2026-10-04-negative-control`, `--synthetic-b-ms 2`, R = 7, n = 10):
  - the swarm's rAF work reads B − A = +242 ms/s (two callbacks a frame × 60 Hz × 2 ms = 240), z 401, **worse**;
  - the timeline reads +128 ms/s, z 182, **worse**;
  - the A/A arm in the same rounds reads z 0.5 and 0.3;
  - frame p50 stays 16.7 ms: a 2 ms cost per callback is invisible to frame time and plain in rAF work.
- Those two runs predate the totals (M33): their summaries were read when rAF work was a gate row.
- **The totals see a separate root** (`2026-10-04-totals-proof-ab`: A = the pre-MV-2 export, B = MV-2, R = 2, n = 10,
  the list):
  - A has one root, `div#root` (host); its `AgentList` fiber renders 11.8 ms/s inside the host's 42.9;
  - B has two: the host's, and a `stage` root below the monitor stage whose first components are `AgentList`,
    `AgentIcon`, the legacy view in its own root. It renders 2.5 ms/s over 3.8 commits/s, 0.65–0.77 ms a render
    against A's 0.94. It commits as often as the field changes (n ÷ 3 a second) where A's view re-rendered on almost
    every host commit, so the per-second figure is lower, not missing;
  - the hook sees one renderer in both builds, so the view's root is the host's own `react-dom`;
  - CDP's script time moves with the roots' render time (B − A −14.4 against −12.8 ms/s), an independent instrument
    agreeing. R = 2 reads no z (M24); the full run does.
- **The totals' negative control** (`2026-10-04-totals-negative-control`, `--synthetic-b-ms 2`, R = 2, n = 10, the
  swarm): main-thread tasks read B − A = +244 ms/s (two callbacks a frame × 60 Hz × 2 ms = 240), z 152, **worse**,
  and script +244 ms/s, z 191, **worse**; `all roots render` stays put (−2.6 ms/s), since the busy wait is in rAF,
  not in React.

## MV-2's A/B on the totals (`baselines/2026-10-04-mv2-ab-totals`)

A = the pre-MV-2 export (`1afaff7`), B = pu `mv/land` `2fe8425`; R = 7, n = 10/20/60, four views. 21 launches, none
failed, 0 failed ops. The load at launch was 4.9–53.6, but it spiked DURING five launches (to 309 at the end of
round 3's B, 228 at round 2's B, 95 at round 6's B, 80 and 74 in two A′ launches), and n = 60 is measured last in
each launch, so it took the most.

- **The totals are lower in B in every cell.** Main-thread tasks: −3 to −20 ms/s at n = 10 and 20, −31 (swarm),
  −46 (rain), −130 (timeline) and −149 (list) ms/s at n = 60, with z > 4 in six cells. All roots render: −3.6 to
  −98 ms/s. Frame p50 is 16.7 ms everywhere, LoAF blocking stays 0.
- **Three gate readings are worse, all layout:** n = 10 timeline +0.14 ms/s (z 4.7, A 0.67), n = 20 list +0.29
  (z 9.0, A 1.41), n = 20 timeline +0.22 (z 5.4, A 1.61). B lays out more often (+0.5 to +8 passes/s; two roots
  commit at different moments, the view's in the frame scheduler's rAF), and each pass is cheaper (0.10–0.30 ms
  against 0.13–0.31). The same cells' tasks fall 9–20 ms/s.
- Near the line, no verdict: n = 60 timeline's LoAF duration +46 ms/s (z 3.9), fewer long frames (33 against 53 per
  10 s) each longer, with no blocking time; the A/A arm read +23 (z 2.4) in the same cell.
- Context that rose, as M33 foresaw: rAF work (n = 10/20/60 list, n = 60 rain and swarm: the frame scheduler) and all
  commits (n = 10 list, swarm and timeline, n = 20 list: two roots commit where one did).
- The A/A arm: of 108 gate readings, 13 exceed z 2.3, the highest 6.8 (n = 20 rain layout, negative), and two meet the
  regression rule, script at n = 60 swarm (+6.3 ms/s, z 4.2) and n = 60 timeline (+17.1 ms/s, z 5.0), under the
  load spikes above. MV-2's earlier run, at a calmer load, read a highest A/A z of 1.1.

## Limits

- Offscreen frames are not the display's: the A/B pairing is valid because both arms run the same way, not because the
  absolute numbers match an on-screen Godview.
- The imposter's hooks are real native traffic into the real runtime, but the TUI is off and no terminal is mounted
  in a pane: the deck holds only the first pane's shell.
- The machine is shared (L17): loads are recorded per launch in `summary.md`; medians, not tails, decide.
