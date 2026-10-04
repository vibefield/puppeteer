# Godview perf — A/B with an A/A null arm

- A: `/Volumes/SamsungRed/lanes/mv/mv2-pu/base/apps/godview`
- B: `/Volumes/SamsungRed/lanes/mv/mv2-perf/puppeteer/apps/godview`
- 2 rounds · n = 10 · views list · 3 s warm-up + 10 s window per view · a state change per agent every 3 s · offscreen at 60 Hz, DPR 2
- started 2026-10-04T21:12:20.312Z, finished 2026-10-04T21:14:39.719Z

## The gate (totals)

Gate rows: frame p50 (ms), long animation frames / 10 s, LoAF duration (ms / s), LoAF blocking (ms / s), all roots render (ms / s), main-thread tasks (ms / s), script (ms / s), layout (ms / s), recalc style (ms / s). The per-view rows and the CPU times are context (M33): they show where work sat, never the verdict.

- **No gate reading regressed**: 9 gate readings across 1 cells.
- A/A health over 9 gate readings: the highest z is 0.5 (n = 10 · list · · layout (ms / s)); 0 above 2.3; 0 meet the regression rule.
- No context reading rose.

## Runs and load

| round | arm | load at start (1/5/15 min) | waited | load at end | outcome |
|---|---|---|---|---|---|
| 0 | A | 7.03 / 12.98 / 10.69 | 0 s | 5.73 / 12.3 / 10.5 | 23 s, 54 ops (0 failed) |
| 0 | B | 5.73 / 12.3 / 10.5 | 0 s | 5.33 / 11.7 / 10.33 | 23 s, 54 ops (0 failed) |
| 0 | A' | 5.33 / 11.7 / 10.33 | 0 s | 10.27 / 12.51 / 10.68 | 23 s, 54 ops (0 failed) |
| 1 | B | 10.27 / 12.51 / 10.68 | 0 s | 8.28 / 11.92 / 10.51 | 23 s, 54 ops (0 failed) |
| 1 | A' | 8.28 / 11.92 / 10.51 | 0 s | 7.25 / 11.42 / 10.37 | 23 s, 54 ops (0 failed) |
| 1 | A | 7.25 / 11.42 / 10.37 | 0 s | 8.99 / 11.59 / 10.46 | 23 s, 54 ops (0 failed) |

## Per view and n

T = the median paired difference over rounds, MAD its spread, z = |T| ÷ (1.858·MAD/√R). B regresses on a gate row when B − A > 0, z > 4 and T > 2 % of A; the same rule on a context row reads "context · up", which is no verdict. The A/A arm is the noise: its z should stay near 2 or below.

### n = 10 · list

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.75 | 16.75 | 16.70 | 0.00, 0.10, 0.0 | -0.05, 0.05, 0.8 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 42.93 | 41.23 | 30.12 | -1.69, 7.68, 0.2 | -12.80, 4.28, 2.3 | ok |
| main-thread tasks (ms / s) | 73.48 | 70.91 | 59.44 | -2.57, 12.43, 0.2 | -14.04, 8.38, 1.3 | ok |
| · script (ms / s) | 59.10 | 56.54 | 44.68 | -2.56, 10.51, 0.2 | -14.42, 6.58, 1.7 | ok |
| · layout (ms / s) | 0.77 | 0.71 | 0.84 | -0.06, 0.09, 0.5 | 0.07, 0.11, 0.5 | ok |
| · recalc style (ms / s) | 0.26 | 0.23 | 0.26 | -0.03, 0.05, 0.4 | -0.00, 0.04, 0.1 | ok |
| main-thread CPU (ms / s) | 76.82 | 74.10 | 62.96 | -2.72, 12.91, 0.2 | -13.86, 8.72, 1.2 | context |
| renderer process CPU (ms / s) | 104.53 | 100.87 | 89.90 | -3.66, 15.64, 0.2 | -14.63, 10.84, 1.0 | context |
| rAF work (ms / s) | 0.10 | 0.07 | 0.87 | -0.03, 0.04, 0.6 | 0.76, 0.19, 3.0 | context |
| all React commits / s (every root) | 13.50 | 12.65 | 14.75 | -0.85, 0.25, 2.6 | 1.25, 0.25, 3.8 | context |
| view commits / s (host root) | 12.60 | 11.80 | 10.00 | -0.80, 0.20, 3.0 | -2.60, 0.20, 9.9 | context |
| view render (ms / s, host root) | 11.80 | 11.36 | 0.27 | -0.43, 2.33, 0.1 | -11.54, 0.10, 92.4 | context |

Roots' render, ms / s (median): A host 42.9 (13.5 commits) · A′ host 41.2 (12.6 commits) · B host 27.7 (11.0 commits), stage 2.5 (3.8 commits).

