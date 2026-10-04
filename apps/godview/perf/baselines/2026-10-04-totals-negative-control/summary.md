# Godview perf — A/B with an A/A null arm

- A: `/Volumes/SamsungRed/lanes/mv/mv2-perf/puppeteer/apps/godview`
- B: `/Volumes/SamsungRed/lanes/mv/mv2-perf/puppeteer/apps/godview`
- B is A's own build plus a 2 ms busy wait in every page animation-frame callback: the negative control, which the gate must call worse.
- 2 rounds · n = 10 · views swarm · 3 s warm-up + 10 s window per view · a state change per agent every 3 s · offscreen at 60 Hz, DPR 2
- started 2026-10-04T21:14:45.611Z, finished 2026-10-04T21:17:04.014Z

## The gate (totals)

Gate rows: frame p50 (ms), long animation frames / 10 s, LoAF duration (ms / s), LoAF blocking (ms / s), all roots render (ms / s), main-thread tasks (ms / s), script (ms / s), layout (ms / s), recalc style (ms / s). The per-view rows and the CPU times are context (M33): they show where work sat, never the verdict.

- **B is worse on 2 gate readings:**
  - n = 10 · swarm · main-thread tasks (ms / s): B − A 244.11 (z 152.4; A 86.53)
  - n = 10 · swarm · · script (ms / s): B − A 244.38 (z 191.1; A 70.39)
- A/A health over 9 gate readings: the highest z is 31.0 (n = 10 · swarm · all roots render (ms / s)); 3 above 2.3; 0 meet the regression rule.
- Context readings that rose (the rule read on a context row; no verdict):
  - n = 10 · swarm · main-thread CPU (ms / s): B − A 242.68 (z 149.3; A 90.88)
  - n = 10 · swarm · renderer process CPU (ms / s): B − A 238.77 (z 59.6; A 138.81)
  - n = 10 · swarm · rAF work (ms / s): B − A 251.45 (z 290.0; A 32.20)

## Runs and load

| round | arm | load at start (1/5/15 min) | waited | load at end | outcome |
|---|---|---|---|---|---|
| 0 | A | 8.35 / 11.41 / 10.41 | 0 s | 7.14 / 10.96 / 10.27 | 23 s, 54 ops (0 failed) |
| 0 | B | 7.14 / 10.96 / 10.27 | 0 s | 5.74 / 10.33 / 10.06 | 23 s, 54 ops (0 failed) |
| 0 | A' | 5.74 / 10.33 / 10.06 | 0 s | 11.7 / 11.59 / 10.54 | 23 s, 54 ops (0 failed) |
| 1 | B | 11.7 / 11.59 / 10.54 | 0 s | 9.29 / 11.06 / 10.37 | 23 s, 54 ops (0 failed) |
| 1 | A' | 9.29 / 11.06 / 10.37 | 0 s | 11.14 / 11.5 / 10.56 | 23 s, 54 ops (0 failed) |
| 1 | A | 11.14 / 11.5 / 10.56 | 0 s | 8.93 / 10.99 / 10.4 | 23 s, 54 ops (0 failed) |

## Per view and n

T = the median paired difference over rounds, MAD its spread, z = |T| ÷ (1.858·MAD/√R). B regresses on a gate row when B − A > 0, z > 4 and T > 2 % of A; the same rule on a context row reads "context · up", which is no verdict. The A/A arm is the noise: its z should stay near 2 or below.

### n = 10 · swarm

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.75 | 16.75 | 16.70 | 0.00, 0.10, 0.0 | -0.05, 0.05, 0.8 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 26.08 | 24.86 | 23.47 | -1.22, 0.03, 31.0 | -2.61, 0.26, 7.6 | ok |
| main-thread tasks (ms / s) | 86.53 | 84.74 | 330.64 | -1.79, 0.16, 8.3 | 244.11, 1.22, 152.4 | **worse** |
| · script (ms / s) | 70.39 | 68.69 | 314.77 | -1.70, 0.18, 7.4 | 244.38, 0.97, 191.1 | **worse** |
| · layout (ms / s) | 0.68 | 0.67 | 0.65 | -0.00, 0.02, 0.2 | -0.03, 0.00, 13.4 | ok |
| · recalc style (ms / s) | 0.06 | 0.06 | 0.06 | 0.00, 0.00, 0.5 | 0.00, 0.00, 0.3 | ok |
| main-thread CPU (ms / s) | 90.88 | 89.33 | 333.57 | -1.55, 0.06, 20.5 | 242.68, 1.24, 149.3 | context · up |
| renderer process CPU (ms / s) | 138.81 | 134.45 | 377.59 | -4.36, 6.10, 0.5 | 238.77, 3.05, 59.6 | context · up |
| rAF work (ms / s) | 32.20 | 32.19 | 283.65 | -0.00, 0.08, 0.0 | 251.45, 0.66, 290.0 | context · up |
| all React commits / s (every root) | 15.20 | 14.80 | 15.05 | -0.40, 0.20, 1.5 | -0.15, 0.05, 2.3 | context |
| view commits / s (host root) | 10.55 | 10.10 | 10.40 | -0.45, 0.15, 2.3 | -0.15, 0.15, 0.8 | context |
| view render (ms / s, host root) | 0.18 | 0.22 | 0.19 | 0.04, 0.02, 1.5 | 0.01, 0.07, 0.2 | context |

Roots' render, ms / s (median): A host 25.5 (11.5 commits), stage 0.6 (3.7 commits) · A′ host 24.3 (11.1 commits), stage 0.6 (3.7 commits) · B host 22.9 (11.3 commits), stage 0.6 (3.7 commits).

