# Godview perf — A/B with an A/A null arm

- A: `/Volumes/SamsungRed/lanes/mv/mv2-pu/base/apps/godview`
- B: `/Volumes/SamsungRed/lanes/mv/mv2-perf/puppeteer/apps/godview`
- 7 rounds · n = 10, 20, 60 · views swarm, list, rain, timeline · 3 s warm-up + 10 s window per view · a state change per agent every 3 s · offscreen at 60 Hz, DPR 2
- started 2026-10-04T21:18:16.952Z, finished 2026-10-04T22:31:14.218Z

## The gate (totals)

Gate rows: frame p50 (ms), long animation frames / 10 s, LoAF duration (ms / s), LoAF blocking (ms / s), all roots render (ms / s), main-thread tasks (ms / s), script (ms / s), layout (ms / s), recalc style (ms / s). The per-view rows and the CPU times are context (M33): they show where work sat, never the verdict.

- **B is worse on 3 gate readings:**
  - n = 10 · timeline · · layout (ms / s): B − A 0.14 (z 4.7; A 0.67)
  - n = 20 · list · · layout (ms / s): B − A 0.29 (z 9.0; A 1.41)
  - n = 20 · timeline · · layout (ms / s): B − A 0.22 (z 5.4; A 1.61)
- A/A health over 108 gate readings: the highest z is 6.8 (n = 20 · rain · · layout (ms / s)); 13 above 2.3; 2 meet the regression rule.
- Context readings that rose (the rule read on a context row; no verdict):
  - n = 10 · list · rAF work (ms / s): B − A 0.57 (z 13.5; A 0.08)
  - n = 10 · list · all React commits / s (every root): B − A 1.20 (z 5.7; A 12.70)
  - n = 10 · swarm · all React commits / s (every root): B − A 1.50 (z 5.3; A 13.30)
  - n = 10 · timeline · all React commits / s (every root): B − A 1.20 (z 4.3; A 12.50)
  - n = 20 · list · rAF work (ms / s): B − A 1.18 (z 12.0; A 0.15)
  - n = 20 · list · all React commits / s (every root): B − A 4.10 (z 6.5; A 20.30)
  - n = 60 · list · rAF work (ms / s): B − A 3.64 (z 13.3; A 0.54)
  - n = 60 · rain · rAF work (ms / s): B − A 4.06 (z 8.0; A 38.37)
  - n = 60 · swarm · rAF work (ms / s): B − A 5.80 (z 4.4; A 144.14)

## Runs and load

| round | arm | load at start (1/5/15 min) | waited | load at end | outcome |
|---|---|---|---|---|---|
| 0 | A | 4.85 / 9.27 / 9.79 | 0 s | 13.95 / 14.91 / 12.32 | 179 s, 1678 ops (0 failed) |
| 0 | B | 13.95 / 14.91 / 12.32 | 0 s | 7.02 / 12.31 / 11.77 | 177 s, 1670 ops (0 failed) |
| 0 | A' | 7.02 / 12.31 / 11.77 | 0 s | 8.96 / 10.76 / 11.2 | 178 s, 1672 ops (0 failed) |
| 1 | B | 8.96 / 10.76 / 11.2 | 0 s | 12.77 / 13.26 / 12.31 | 178 s, 1672 ops (0 failed) |
| 1 | A' | 12.77 / 13.26 / 12.31 | 0 s | 14.29 / 14.11 / 12.88 | 178 s, 1672 ops (0 failed) |
| 1 | A | 14.29 / 14.11 / 12.88 | 0 s | 17.41 / 14.39 / 13.11 | 178 s, 1672 ops (0 failed) |
| 2 | A' | 17.41 / 14.39 / 13.11 | 0 s | 8.05 / 11.87 / 12.32 | 178 s, 1672 ops (0 failed) |
| 2 | A | 8.05 / 11.87 / 12.32 | 0 s | 17.28 / 16.07 / 14.05 | 178 s, 1672 ops (0 failed) |
| 2 | B | 17.28 / 16.07 / 14.05 | 0 s | 228.36 / 81.24 / 39.14 | 189 s, 1745 ops (0 failed) |
| 3 | A | 49.78 / 85.98 / 51.59 | 180 s | 22.98 / 55.84 / 45.36 | 179 s, 1674 ops (0 failed) |
| 3 | B | 22.98 / 55.84 / 45.36 | 0 s | 309.21 / 132.69 / 76.25 | 193 s, 1754 ops (0 failed) |
| 3 | A' | 53.61 / 113.2 / 83.25 | 210 s | 11.93 / 68.97 / 70.55 | 178 s, 1671 ops (0 failed) |
| 4 | B | 11.93 / 68.97 / 70.55 | 0 s | 16.25 / 43.48 / 59.41 | 178 s, 1673 ops (0 failed) |
| 4 | A' | 16.25 / 43.48 / 59.41 | 0 s | 13.5 / 30.43 / 50.88 | 180 s, 1679 ops (0 failed) |
| 4 | A | 13.5 / 30.43 / 50.88 | 0 s | 11.76 / 21.29 / 43.18 | 179 s, 1675 ops (0 failed) |
| 5 | A' | 11.76 / 21.29 / 43.18 | 0 s | 79.86 / 34.21 / 43.34 | 186 s, 1681 ops (0 failed) |
| 5 | A | 50.83 / 64.52 / 56.33 | 165 s | 20.96 / 45.16 / 49.85 | 178 s, 1673 ops (0 failed) |
| 5 | B | 20.96 / 45.16 / 49.85 | 0 s | 12.72 / 32.36 / 43.73 | 178 s, 1671 ops (0 failed) |
| 6 | A | 12.72 / 32.36 / 43.73 | 0 s | 14.75 / 26.85 / 39.49 | 178 s, 1673 ops (0 failed) |
| 6 | B | 14.75 / 26.85 / 39.49 | 0 s | 94.72 / 62.04 / 51.96 | 178 s, 1674 ops (0 failed) |
| 6 | A' | 49.49 / 54.67 / 49.77 | 45 s | 74.48 / 63.13 / 53.99 | 182 s, 1704 ops (0 failed) |

## Per view and n

T = the median paired difference over rounds, MAD its spread, z = |T| ÷ (1.858·MAD/√R). B regresses on a gate row when B − A > 0, z > 4 and T > 2 % of A; the same rule on a context row reads "context · up", which is no verdict. The A/A arm is the noise: its z should stay near 2 or below.

### n = 10 · list

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.80 | 16.70 | 16.80 | 0.00, 0.00, 0.0 | 0.00, 0.10, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 34.01 | 33.81 | 24.47 | -0.26, 0.90, 0.4 | -9.58, 3.98, 3.4 | ok |
| main-thread tasks (ms / s) | 58.21 | 59.32 | 47.37 | -0.42, 0.37, 1.6 | -11.14, 4.02, 3.9 | ok |
| · script (ms / s) | 45.84 | 47.03 | 35.75 | -0.01, 0.76, 0.0 | -11.00, 4.50, 3.5 | ok |
| · layout (ms / s) | 0.57 | 0.62 | 0.80 | 0.01, 0.02, 0.5 | 0.11, 0.12, 1.3 | ok |
| · recalc style (ms / s) | 0.23 | 0.23 | 0.28 | 0.01, 0.03, 0.6 | 0.03, 0.03, 1.3 | ok |
| main-thread CPU (ms / s) | 61.02 | 62.09 | 50.23 | -0.38, 0.47, 1.2 | -11.15, 3.95, 4.0 | context |
| renderer process CPU (ms / s) | 78.73 | 84.68 | 70.66 | -0.28, 1.36, 0.3 | -11.23, 5.76, 2.8 | context |
| rAF work (ms / s) | 0.08 | 0.08 | 0.64 | 0.02, 0.02, 1.4 | 0.57, 0.06, 13.5 | context · up |
| all React commits / s (every root) | 12.70 | 12.90 | 13.90 | 0.10, 0.20, 0.7 | 1.20, 0.30, 5.7 | context · up |
| view commits / s (host root) | 11.80 | 12.00 | 9.50 | 0.10, 0.20, 0.7 | -2.40, 0.10, 34.2 | context |
| view render (ms / s, host root) | 9.23 | 9.27 | 0.18 | -0.16, 0.26, 0.9 | -9.12, 0.79, 16.4 | context |

Roots' render, ms / s (median): A host 34.0 (12.7 commits) · A′ host 33.8 (12.9 commits) · B host 22.4 (10.5 commits), stage 2.1 (3.4 commits).

### n = 10 · rain

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.80 | 16.70 | 16.70 | 0.00, 0.10, 0.0 | 0.00, 0.10, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 29.85 | 28.80 | 24.48 | -0.52, 0.90, 0.8 | -5.77, 1.04, 7.9 | ok |
| main-thread tasks (ms / s) | 84.41 | 82.29 | 75.89 | -1.47, 1.25, 1.7 | -4.14, 2.46, 2.4 | ok |
| · script (ms / s) | 61.53 | 59.46 | 54.76 | -0.84, 1.23, 1.0 | -5.86, 2.15, 3.9 | ok |
| · layout (ms / s) | 0.54 | 0.54 | 0.52 | 0.00, 0.02, 0.1 | 0.02, 0.02, 1.1 | ok |
| · recalc style (ms / s) | 0.16 | 0.17 | 0.17 | -0.00, 0.01, 0.8 | -0.00, 0.01, 0.6 | ok |
| main-thread CPU (ms / s) | 87.67 | 85.90 | 79.86 | -1.63, 2.07, 1.1 | -3.68, 2.04, 2.6 | context |
| renderer process CPU (ms / s) | 125.34 | 126.61 | 119.74 | 0.59, 1.28, 0.7 | 0.44, 1.38, 0.5 | context |
| rAF work (ms / s) | 19.78 | 18.67 | 19.08 | -1.05, 0.70, 2.1 | 0.29, 0.66, 0.6 | context |
| all React commits / s (every root) | 12.90 | 13.20 | 14.80 | -0.10, 0.30, 0.5 | 1.10, 0.80, 2.0 | context |
| view commits / s (host root) | 12.10 | 12.30 | 10.10 | -0.10, 0.30, 0.5 | -2.40, 0.80, 4.3 | context |
| view render (ms / s, host root) | 2.11 | 2.02 | 0.21 | -0.09, 0.05, 2.6 | -1.91, 0.23, 11.8 | context |

Roots' render, ms / s (median): A host 29.9 (12.9 commits) · A′ host 28.8 (13.2 commits) · B host 23.9 (11.1 commits), stage 0.5 (3.7 commits).

### n = 10 · swarm

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.80 | 16.70 | 0.00, 0.10, 0.0 | 0.00, 0.10, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 28.32 | 29.63 | 24.74 | -0.02, 0.61, 0.0 | -3.58, 2.45, 2.1 | ok |
| main-thread tasks (ms / s) | 88.24 | 87.35 | 85.27 | -0.05, 0.84, 0.1 | -5.63, 4.76, 1.7 | ok |
| · script (ms / s) | 73.19 | 72.71 | 69.37 | 0.58, 1.01, 0.8 | -4.58, 4.05, 1.6 | ok |
| · layout (ms / s) | 0.61 | 0.60 | 0.66 | -0.03, 0.03, 1.5 | 0.05, 0.05, 1.5 | ok |
| · recalc style (ms / s) | 0.05 | 0.05 | 0.05 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| main-thread CPU (ms / s) | 92.18 | 91.70 | 89.70 | -0.07, 0.86, 0.1 | -5.11, 5.57, 1.3 | context |
| renderer process CPU (ms / s) | 138.23 | 137.79 | 136.15 | -4.17, 2.23, 2.7 | -7.81, 9.57, 1.2 | context |
| rAF work (ms / s) | 32.59 | 32.07 | 32.45 | 0.15, 0.59, 0.4 | 1.37, 1.22, 1.6 | context |
| all React commits / s (every root) | 13.30 | 12.70 | 14.90 | 0.10, 0.30, 0.5 | 1.50, 0.40, 5.3 | context · up |
| view commits / s (host root) | 12.40 | 11.80 | 10.20 | 0.10, 0.30, 0.5 | -2.20, 0.20, 15.7 | context |
| view render (ms / s, host root) | 2.14 | 2.30 | 0.20 | -0.02, 0.04, 0.7 | -1.98, 0.18, 15.7 | context |

Roots' render, ms / s (median): A host 28.3 (13.3 commits) · A′ host 29.6 (12.7 commits) · B host 24.2 (11.2 commits), stage 0.6 (3.7 commits).

### n = 10 · timeline

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.80 | 16.80 | 16.70 | 0.00, 0.10, 0.0 | 0.00, 0.00, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 35.11 | 36.24 | 24.59 | -1.43, 0.86, 2.4 | -10.52, 1.03, 14.5 | ok |
| main-thread tasks (ms / s) | 85.79 | 83.57 | 75.58 | -2.22, 3.18, 1.0 | -8.88, 2.09, 6.0 | ok |
| · script (ms / s) | 58.52 | 58.07 | 45.55 | -1.85, 1.85, 1.4 | -11.21, 1.86, 8.6 | ok |
| · layout (ms / s) | 0.67 | 0.63 | 0.79 | -0.03, 0.02, 1.9 | 0.14, 0.04, 4.7 | **worse** |
| · recalc style (ms / s) | 3.30 | 3.41 | 3.55 | -0.02, 0.10, 0.2 | 0.07, 0.17, 0.6 | ok |
| main-thread CPU (ms / s) | 89.11 | 86.96 | 78.78 | -2.15, 3.74, 0.8 | -8.64, 3.06, 4.0 | context |
| renderer process CPU (ms / s) | 126.16 | 123.94 | 122.02 | 0.09, 5.98, 0.0 | -7.82, 2.81, 4.0 | context |
| rAF work (ms / s) | 7.89 | 8.00 | 8.97 | 0.02, 0.33, 0.1 | 0.50, 0.25, 2.8 | context |
| all React commits / s (every root) | 12.50 | 12.50 | 13.50 | 0.10, 0.10, 1.4 | 1.20, 0.40, 4.3 | context · up |
| view commits / s (host root) | 11.60 | 11.60 | 9.20 | 0.10, 0.10, 1.4 | -2.30, 0.30, 10.9 | context |
| view render (ms / s, host root) | 11.09 | 11.68 | 0.24 | -0.11, 0.48, 0.3 | -10.90, 0.43, 36.1 | context |

Roots' render, ms / s (median): A host 35.1 (12.5 commits) · A′ host 36.2 (12.5 commits) · B host 22.1 (10.2 commits), stage 2.6 (3.4 commits).

### n = 20 · list

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.80 | 16.70 | 0.00, 0.10, 0.0 | 0.00, 0.00, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 55.49 | 51.58 | 43.62 | -0.49, 1.33, 0.5 | -12.01, 2.22, 7.7 | ok |
| main-thread tasks (ms / s) | 97.48 | 94.09 | 82.03 | -0.02, 3.49, 0.0 | -14.58, 3.24, 6.4 | ok |
| · script (ms / s) | 80.05 | 75.68 | 64.02 | -0.45, 2.63, 0.2 | -15.48, 2.74, 8.1 | ok |
| · layout (ms / s) | 1.41 | 1.49 | 1.73 | 0.03, 0.03, 1.4 | 0.29, 0.05, 9.0 | **worse** |
| · recalc style (ms / s) | 0.59 | 0.63 | 0.66 | 0.03, 0.02, 2.0 | 0.04, 0.05, 1.1 | ok |
| main-thread CPU (ms / s) | 101.47 | 98.29 | 86.20 | 0.02, 3.69, 0.0 | -13.92, 2.92, 6.8 | context |
| renderer process CPU (ms / s) | 125.21 | 125.35 | 108.48 | 2.23, 6.77, 0.5 | -11.43, 2.97, 5.5 | context |
| rAF work (ms / s) | 0.15 | 0.15 | 1.26 | -0.01, 0.03, 0.5 | 1.18, 0.14, 12.0 | context · up |
| all React commits / s (every root) | 20.30 | 21.20 | 23.90 | 0.10, 0.90, 0.2 | 4.10, 0.90, 6.5 | context · up |
| view commits / s (host root) | 19.70 | 20.30 | 16.60 | -0.10, 0.90, 0.2 | -2.90, 0.30, 13.8 | context |
| view render (ms / s, host root) | 22.07 | 20.81 | 0.33 | -0.25, 0.46, 0.8 | -21.74, 1.43, 21.6 | context |

Roots' render, ms / s (median): A host 55.5 (20.3 commits) · A′ host 51.6 (21.2 commits) · B host 37.1 (17.3 commits), stage 5.8 (6.6 commits).

### n = 20 · rain

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.70 | 16.80 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 45.86 | 48.25 | 40.78 | 0.74, 1.01, 1.0 | -6.40, 1.92, 4.7 | ok |
| main-thread tasks (ms / s) | 126.72 | 134.88 | 123.61 | 3.50, 1.90, 2.6 | -3.10, 3.64, 1.2 | ok |
| · script (ms / s) | 96.23 | 102.39 | 90.96 | 3.14, 2.28, 2.0 | -5.27, 3.99, 1.9 | ok |
| · layout (ms / s) | 1.12 | 1.17 | 1.13 | -0.04, 0.01, 6.8 | 0.01, 0.09, 0.1 | ok |
| · recalc style (ms / s) | 0.24 | 0.27 | 0.25 | -0.00, 0.01, 0.2 | -0.00, 0.01, 0.3 | ok |
| main-thread CPU (ms / s) | 131.54 | 140.21 | 128.51 | 4.01, 2.01, 2.8 | -3.03, 4.30, 1.0 | context |
| renderer process CPU (ms / s) | 178.74 | 193.34 | 178.16 | 6.85, 2.65, 3.7 | -1.55, 7.47, 0.3 | context |
| rAF work (ms / s) | 29.27 | 30.09 | 30.45 | 1.43, 0.34, 6.0 | 1.50, 1.25, 1.7 | context |
| all React commits / s (every root) | 23.60 | 25.20 | 27.90 | -0.30, 0.60, 0.7 | 3.50, 1.30, 3.8 | context |
| view commits / s (host root) | 22.70 | 24.40 | 19.90 | -0.60, 0.40, 2.1 | -3.70, 0.90, 5.9 | context |
| view render (ms / s, host root) | 5.02 | 5.19 | 0.30 | 0.05, 0.12, 0.6 | -4.75, 0.38, 17.8 | context |

Roots' render, ms / s (median): A host 45.9 (23.6 commits) · A′ host 48.3 (25.2 commits) · B host 39.5 (20.9 commits), stage 1.3 (7.0 commits).

### n = 20 · swarm

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.80 | 16.70 | 0.10, 0.00, ∞ | 0.00, 0.00, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 42.96 | 42.19 | 37.16 | 1.07, 1.83, 0.8 | -6.87, 3.26, 3.0 | ok |
| main-thread tasks (ms / s) | 142.16 | 136.84 | 128.97 | 2.09, 5.61, 0.5 | -9.79, 6.23, 2.2 | ok |
| · script (ms / s) | 120.99 | 117.44 | 111.34 | 2.15, 4.92, 0.6 | -10.10, 5.92, 2.4 | ok |
| · layout (ms / s) | 1.02 | 0.99 | 1.09 | 0.05, 0.06, 1.2 | 0.14, 0.05, 3.7 | ok |
| · recalc style (ms / s) | 0.05 | 0.05 | 0.04 | 0.00, 0.00, 0.0 | -0.01, 0.00, 1.8 | ok |
| main-thread CPU (ms / s) | 148.85 | 142.89 | 134.11 | 2.31, 6.17, 0.5 | -9.66, 5.61, 2.5 | context |
| renderer process CPU (ms / s) | 195.79 | 193.60 | 180.61 | -1.72, 6.91, 0.4 | -14.70, 2.78, 7.5 | context |
| rAF work (ms / s) | 53.31 | 53.35 | 54.03 | 0.41, 0.93, 0.6 | 0.73, 1.73, 0.6 | context |
| all React commits / s (every root) | 21.10 | 21.40 | 24.30 | 0.40, 0.50, 1.1 | 2.70, 1.30, 3.0 | context |
| view commits / s (host root) | 20.20 | 20.50 | 17.00 | 0.30, 0.40, 1.1 | -3.20, 1.50, 3.0 | context |
| view render (ms / s, host root) | 4.76 | 4.89 | 0.31 | 0.08, 0.21, 0.5 | -4.56, 0.48, 13.5 | context |

Roots' render, ms / s (median): A host 43.0 (21.1 commits) · A′ host 42.2 (21.4 commits) · B host 35.8 (18.0 commits), stage 1.3 (6.5 commits).

### n = 20 · timeline

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.80 | 16.80 | 0.10, 0.00, ∞ | 0.10, 0.00, ∞ | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 58.44 | 61.41 | 46.35 | 2.99, 3.28, 1.3 | -15.30, 0.91, 23.9 | ok |
| main-thread tasks (ms / s) | 137.41 | 146.04 | 116.80 | 4.63, 5.11, 1.3 | -20.13, 1.29, 22.2 | ok |
| · script (ms / s) | 97.12 | 104.60 | 81.02 | 2.76, 4.07, 1.0 | -20.39, 2.59, 11.2 | ok |
| · layout (ms / s) | 1.61 | 1.65 | 1.92 | 0.04, 0.06, 0.8 | 0.22, 0.06, 5.4 | **worse** |
| · recalc style (ms / s) | 4.78 | 4.66 | 4.49 | 0.19, 0.29, 0.9 | -0.10, 0.21, 0.7 | ok |
| main-thread CPU (ms / s) | 142.03 | 151.49 | 121.97 | 5.20, 5.55, 1.3 | -19.72, 1.11, 25.3 | context |
| renderer process CPU (ms / s) | 191.45 | 196.42 | 166.63 | 7.60, 5.46, 2.0 | -20.92, 4.14, 7.2 | context |
| rAF work (ms / s) | 12.26 | 11.87 | 12.67 | 0.03, 0.64, 0.1 | 0.76, 0.32, 3.4 | context |
| all React commits / s (every root) | 23.40 | 25.30 | 29.40 | 0.60, 0.70, 1.2 | 4.10, 1.60, 3.6 | context |
| view commits / s (host root) | 22.60 | 24.80 | 20.90 | 0.60, 0.70, 1.2 | -3.20, 1.30, 3.5 | context |
| view render (ms / s, host root) | 24.78 | 25.86 | 0.30 | 0.98, 1.15, 1.2 | -24.46, 1.74, 20.0 | context |

Roots' render, ms / s (median): A host 58.4 (23.4 commits) · A′ host 61.4 (25.3 commits) · B host 39.1 (21.9 commits), stage 7.0 (7.3 commits).

### n = 60 · list

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 167.95 | 176.00 | 100.33 | 0.01, 8.82, 0.0 | -97.75, 11.08, 12.6 | ok |
| main-thread tasks (ms / s) | 311.49 | 322.49 | 219.56 | -1.14, 21.39, 0.1 | -148.68, 9.34, 22.7 | ok |
| · script (ms / s) | 262.67 | 272.36 | 165.44 | -0.62, 17.26, 0.1 | -144.92, 9.46, 21.8 | ok |
| · layout (ms / s) | 5.18 | 4.97 | 5.92 | 0.01, 0.23, 0.1 | 0.25, 0.68, 0.5 | ok |
| · recalc style (ms / s) | 2.27 | 2.32 | 2.09 | -0.10, 0.02, 6.4 | -0.11, 0.44, 0.3 | ok |
| main-thread CPU (ms / s) | 320.34 | 331.21 | 228.89 | -1.49, 21.55, 0.1 | -148.38, 11.66, 18.1 | context |
| renderer process CPU (ms / s) | 378.14 | 392.93 | 287.09 | -0.42, 27.24, 0.0 | -163.10, 15.04, 15.4 | context |
| rAF work (ms / s) | 0.54 | 0.44 | 4.05 | -0.05, 0.11, 0.6 | 3.64, 0.39, 13.3 | context · up |
| all React commits / s (every root) | 56.10 | 58.30 | 69.10 | -0.80, 2.10, 0.5 | 4.40, 4.90, 1.3 | context |
| view commits / s (host root) | 55.20 | 57.60 | 50.00 | -1.00, 2.00, 0.7 | -14.30, 6.30, 3.2 | context |
| view render (ms / s, host root) | 98.60 | 104.95 | 0.61 | -0.51, 1.28, 0.6 | -98.18, 3.67, 38.1 | context |

Roots' render, ms / s (median): A host 168.0 (56.1 commits) · A′ host 176.0 (58.3 commits) · B host 70.3 (50.6 commits), stage 26.0 (17.0 commits).

### n = 60 · rain

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.80 | 16.80 | 0.00, 0.10, 0.0 | 0.10, 0.00, ∞ | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 119.68 | 118.47 | 84.84 | 5.89, 4.93, 1.7 | -26.80, 5.35, 7.1 | ok |
| main-thread tasks (ms / s) | 275.91 | 274.82 | 224.77 | 7.44, 19.40, 0.5 | -46.06, 7.05, 9.3 | ok |
| · script (ms / s) | 232.39 | 228.71 | 178.36 | 8.95, 16.54, 0.8 | -43.46, 8.45, 7.3 | ok |
| · layout (ms / s) | 3.19 | 3.32 | 3.32 | 0.09, 0.11, 1.2 | -0.03, 0.10, 0.4 | ok |
| · recalc style (ms / s) | 0.68 | 0.74 | 0.71 | 0.03, 0.04, 1.0 | -0.02, 0.05, 0.5 | ok |
| main-thread CPU (ms / s) | 286.36 | 284.34 | 235.51 | 7.94, 19.96, 0.6 | -45.36, 6.79, 9.5 | context |
| renderer process CPU (ms / s) | 356.22 | 360.10 | 304.73 | 1.14, 9.26, 0.2 | -35.19, 15.13, 3.3 | context |
| rAF work (ms / s) | 38.37 | 37.52 | 42.60 | -1.23, 1.97, 0.9 | 4.06, 0.72, 8.0 | context · up |
| all React commits / s (every root) | 74.00 | 71.90 | 74.20 | -0.30, 2.10, 0.2 | 4.90, 2.10, 3.3 | context |
| view commits / s (host root) | 73.10 | 71.10 | 55.50 | -0.40, 1.90, 0.3 | -12.70, 3.20, 5.7 | context |
| view render (ms / s, host root) | 25.04 | 25.02 | 0.71 | 1.13, 0.55, 2.9 | -24.41, 0.57, 61.0 | context |

Roots' render, ms / s (median): A host 119.7 (74.0 commits) · A′ host 118.5 (71.9 commits) · B host 79.6 (56.3 commits), stage 5.5 (17.9 commits).

### n = 60 · swarm

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 16.70 | 16.70 | 16.80 | 0.00, 0.00, 0.0 | 0.00, 0.10, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 97.65 | 101.50 | 76.64 | 1.28, 1.33, 1.4 | -21.61, 7.86, 3.9 | ok |
| main-thread tasks (ms / s) | 338.61 | 351.46 | 307.57 | 5.82, 3.14, 2.6 | -30.98, 15.94, 2.8 | ok |
| · script (ms / s) | 308.18 | 317.80 | 277.21 | 6.26, 2.12, 4.2 | -32.97, 13.37, 3.5 | ok |
| · layout (ms / s) | 3.05 | 3.22 | 3.42 | 0.18, 0.11, 2.4 | 0.25, 0.12, 2.9 | ok |
| · recalc style (ms / s) | 0.21 | 0.22 | 0.19 | 0.01, 0.01, 0.9 | -0.03, 0.02, 1.8 | ok |
| main-thread CPU (ms / s) | 347.56 | 361.43 | 316.96 | 5.86, 3.26, 2.6 | -30.25, 17.11, 2.5 | context |
| renderer process CPU (ms / s) | 423.10 | 444.05 | 395.27 | 2.97, 8.95, 0.5 | -26.69, 15.82, 2.4 | context |
| rAF work (ms / s) | 144.14 | 145.77 | 153.07 | 3.12, 2.78, 1.6 | 5.80, 1.88, 4.4 | context · up |
| all React commits / s (every root) | 56.20 | 56.80 | 64.90 | 0.60, 0.90, 0.9 | 1.60, 7.60, 0.3 | context |
| view commits / s (host root) | 55.50 | 55.90 | 46.90 | 0.40, 0.80, 0.7 | -14.70, 7.20, 2.9 | context |
| view render (ms / s, host root) | 21.31 | 21.68 | 0.59 | 0.46, 0.09, 7.3 | -20.88, 1.68, 17.7 | context |

Roots' render, ms / s (median): A host 97.7 (56.2 commits) · A′ host 101.5 (56.8 commits) · B host 70.9 (47.6 commits), stage 5.7 (16.6 commits).

### n = 60 · timeline

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) | 66.70 | 66.70 | 66.70 | 0.10, 0.20, 0.7 | 16.50, 16.50, 1.4 | weather |
| long animation frames / 10 s | 53.00 | 54.00 | 33.00 | 2.00, 1.00, 2.8 | 1.00, 4.00, 0.4 | ok |
| LoAF duration (ms / s) | 338.89 | 362.04 | 385.11 | 23.15, 13.78, 2.4 | 46.22, 17.02, 3.9 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| all roots render (ms / s) | 194.74 | 197.77 | 93.94 | 7.78, 4.64, 2.4 | -84.42, 19.89, 6.0 | ok |
| main-thread tasks (ms / s) | 394.06 | 399.59 | 248.94 | 20.81, 8.38, 3.5 | -130.48, 19.36, 9.6 | ok |
| · script (ms / s) | 326.34 | 333.78 | 184.95 | 17.06, 4.83, 5.0 | -138.99, 25.59, 7.7 | ok |
| · layout (ms / s) | 6.54 | 6.97 | 5.66 | 0.32, 0.16, 2.8 | 0.40, 0.77, 0.7 | ok |
| · recalc style (ms / s) | 7.87 | 7.47 | 7.59 | 0.15, 0.52, 0.4 | 0.50, 0.61, 1.2 | ok |
| main-thread CPU (ms / s) | 403.02 | 408.76 | 258.20 | 20.33, 7.41, 3.9 | -128.85, 18.22, 10.1 | context |
| renderer process CPU (ms / s) | 469.49 | 485.53 | 335.29 | 27.14, 13.24, 2.9 | -133.80, 17.32, 11.0 | context |
| rAF work (ms / s) | 26.10 | 27.18 | 26.57 | 1.13, 0.28, 5.7 | 4.38, 3.54, 1.8 | context |
| all React commits / s (every root) | 61.70 | 59.10 | 55.20 | -1.50, 1.40, 1.5 | 1.20, 6.00, 0.3 | context |
| view commits / s (host root) | 60.80 | 58.40 | 39.20 | -1.40, 1.40, 1.4 | -15.40, 5.40, 4.1 | context |
| view render (ms / s, host root) | 119.12 | 120.52 | 0.63 | 3.40, 2.80, 1.7 | -118.57, 13.54, 12.5 | context |

Roots' render, ms / s (median): A host 194.7 (61.7 commits) · A′ host 197.8 (59.1 commits) · B host 66.2 (39.6 commits), stage 28.9 (13.9 commits).

