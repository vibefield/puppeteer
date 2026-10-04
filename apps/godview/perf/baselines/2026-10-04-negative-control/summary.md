# Godview perf — A/B with an A/A null arm

- A: `/Volumes/SamsungRed/lanes/mv/mv0-pu/puppeteer/apps/godview`
- B: `/Volumes/SamsungRed/lanes/mv/mv0-pu/puppeteer/apps/godview`
- B is A's own build plus a 2 ms busy wait in every page animation-frame callback: the negative control, which the gate must call worse.
- 7 rounds · n = 10 · views swarm, timeline · 2 s warm-up + 5 s window per view · a state change per agent every 3 s · offscreen at 60 Hz, DPR 2
- started 2026-10-04T02:38:52.435Z, finished 2026-10-04T02:47:11.312Z

## Runs and load

| round | arm | load at start (1/5/15 min) | waited | load at end | outcome |
|---|---|---|---|---|---|
| 0 | A | 12.96 / 44.08 / 102.5 | 0 s | 10.02 / 40.91 / 99.66 | 24 s, 57 ops (0 failed) |
| 0 | B | 10.02 / 40.91 / 99.66 | 0 s | 14.06 / 39.58 / 97.49 | 24 s, 57 ops (0 failed) |
| 0 | A' | 14.06 / 39.58 / 97.49 | 0 s | 17.32 / 38.53 / 95.46 | 24 s, 57 ops (0 failed) |
| 1 | B | 17.32 / 38.53 / 95.46 | 0 s | 12.47 / 35.69 / 92.78 | 23 s, 57 ops (0 failed) |
| 1 | A' | 12.47 / 35.69 / 92.78 | 0 s | 10.4 / 33.71 / 90.74 | 24 s, 57 ops (0 failed) |
| 1 | A | 10.4 / 33.71 / 90.74 | 0 s | 10.12 / 31.83 / 88.42 | 24 s, 57 ops (0 failed) |
| 2 | A' | 10.12 / 31.83 / 88.42 | 0 s | 8.37 / 29.69 / 86.01 | 23 s, 57 ops (0 failed) |
| 2 | A | 8.37 / 29.69 / 86.01 | 0 s | 6.74 / 27.93 / 84.07 | 24 s, 57 ops (0 failed) |
| 2 | B | 6.74 / 27.93 / 84.07 | 0 s | 6.35 / 26.19 / 81.82 | 23 s, 57 ops (0 failed) |
| 3 | A | 6.35 / 26.19 / 81.82 | 0 s | 10.02 / 25.63 / 80.01 | 24 s, 57 ops (0 failed) |
| 3 | B | 10.02 / 25.63 / 80.01 | 0 s | 7.85 / 23.87 / 77.8 | 24 s, 57 ops (0 failed) |
| 3 | A' | 7.85 / 23.87 / 77.8 | 0 s | 6.6 / 22.3 / 75.68 | 24 s, 57 ops (0 failed) |
| 4 | B | 6.6 / 22.3 / 75.68 | 0 s | 5.72 / 21.08 / 74 | 23 s, 57 ops (0 failed) |
| 4 | A' | 5.72 / 21.08 / 74 | 0 s | 6.22 / 20.02 / 72.09 | 23 s, 57 ops (0 failed) |
| 4 | A | 6.22 / 20.02 / 72.09 | 0 s | 5.27 / 18.68 / 70.1 | 24 s, 57 ops (0 failed) |
| 5 | A' | 5.27 / 18.68 / 70.1 | 0 s | 6.82 / 18.14 / 68.71 | 23 s, 57 ops (0 failed) |
| 5 | A | 6.82 / 18.14 / 68.71 | 0 s | 9.25 / 17.91 / 67.16 | 24 s, 57 ops (0 failed) |
| 5 | B | 9.25 / 17.91 / 67.16 | 0 s | 14.11 / 18.55 / 65.98 | 24 s, 57 ops (0 failed) |
| 6 | A | 14.11 / 18.55 / 65.98 | 0 s | 10.85 / 17.42 / 64.2 | 24 s, 57 ops (0 failed) |
| 6 | B | 10.85 / 17.42 / 64.2 | 0 s | 9.04 / 16.58 / 62.81 | 24 s, 57 ops (0 failed) |
| 6 | A' | 9.04 / 16.58 / 62.81 | 0 s | 7.74 / 15.71 / 61.16 | 23 s, 57 ops (0 failed) |

## Per view and n

T = the median paired difference over rounds, MAD its spread, z = |T| ÷ (1.858·MAD/√R). B regresses on a metric when B − A > 0, z > 4 and T > 2 % of A. The A/A arm is the noise: its z should stay near 2 or below.

### n = 10 · swarm

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) — weather | 16.80 | 16.80 | 16.70 | 0.00, 0.10, 0.0 | 0.00, 0.00, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| rAF work (ms / s) | 31.84 | 32.58 | 274.48 | -0.48, 1.30, 0.5 | 242.00, 0.86, 400.7 | **worse** |
| view commits / s | 10.20 | 10.40 | 10.20 | 0.00, 0.20, 0.0 | -0.20, 0.60, 0.5 | ok |
| view render (ms / s) | 2.16 | 2.14 | 1.86 | -0.08, 0.14, 0.8 | -0.32, 0.02, 22.8 | ok |
| all React commits / s | 11.00 | 11.20 | 11.00 | 0.00, 0.40, 0.0 | -0.20, 0.40, 0.7 | ok |

### n = 10 · timeline

| metric | A | A′ | B | A′ − A (T, MAD, z) | B − A (T, MAD, z) | verdict |
|---|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 16.70 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| frame p95 (ms) — weather | 16.80 | 16.70 | 16.80 | 0.00, 0.10, 0.0 | 0.00, 0.10, 0.0 | weather |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00, 0.00, 0.0 | 0.00, 0.00, 0.0 | ok |
| rAF work (ms / s) | 9.88 | 9.58 | 138.20 | -0.08, 0.40, 0.3 | 128.04, 1.00, 182.3 | **worse** |
| view commits / s | 14.40 | 14.40 | 14.00 | 0.00, 0.40, 0.0 | -0.20, 0.20, 1.4 | ok |
| view render (ms / s) | 13.64 | 13.52 | 12.50 | -0.22, 0.32, 1.0 | -1.32, 0.34, 5.5 | ok |
| all React commits / s | 15.20 | 15.40 | 15.00 | -0.20, 0.40, 0.7 | -0.20, 0.20, 1.4 | ok |

