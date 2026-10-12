# Godview perf — A/A baseline

- A: `/Volumes/SamsungRed/lanes/mv/mv0-pu/puppeteer/apps/godview`
- 7 rounds · n = 10, 20, 60 · views swarm, list, rain, timeline · 3 s warm-up + 10 s window per view · a state change per agent every 3 s · offscreen at 60 Hz, DPR 2
- started 2026-10-04T01:11:02.661Z, finished 2026-10-04T02:34:25.040Z

## Runs and load

| round | arm | load at start (1/5/15 min) | waited | load at end | outcome |
|---|---|---|---|---|---|
| 0 | A | 37.73 / 147.95 / 114.57 | 0 s | 60.47 / 105.76 / 102.79 | 180 s, 1686 ops (0 failed) |
| 0 | A' | 47.99 / 100.77 / 101.06 | 15 s | 101.82 / 90.65 / 95.85 | 184 s, 1677 ops (0 failed) |
| 1 | A' | 50.72 / 105.88 / 104.76 | 210 s | 15.56 / 64.96 / 87.79 | 177 s, 1672 ops (0 failed) |
| 1 | A | 15.56 / 64.96 / 87.79 | 0 s | 22.42 / 51.3 / 78.18 | 177 s, 1669 ops (0 failed) |
| 2 | A | 22.42 / 51.3 / 78.18 | 0 s | 353.32 / 159.3 / 115.14 | 189 s, 1703 ops (0 failed) |
| 2 | A' | 54.11 / 115.57 / 105.08 | 150 s | 92.68 / 99.35 / 99.71 | 179 s, 1677 ops (0 failed) |
| 3 | A' | 52.56 / 117.74 / 119.45 | 510 s | 327.23 / 180.84 / 142.6 | 192 s, 1713 ops (0 failed) |
| 3 | A | 58.47 / 130.21 / 128.2 | 135 s | 310.57 / 168.84 / 141.26 | 190 s, 1701 ops (0 failed) |
| 4 | A | 50.2 / 157.15 / 150.24 | 270 s | 16.19 / 93.35 / 124.73 | 177 s, 1670 ops (0 failed) |
| 4 | A' | 16.19 / 93.35 / 124.73 | 0 s | 258.75 / 135.93 / 133.72 | 187 s, 1695 ops (0 failed) |
| 5 | A' | 58.98 / 104.62 / 121.88 | 210 s | 144.55 / 141.54 / 136.07 | 187 s, 1678 ops (0 failed) |
| 5 | A | 53.95 / 119.04 / 128.94 | 135 s | 224.83 / 182.8 / 154.27 | 190 s, 1699 ops (0 failed) |
| 6 | A | 58.43 / 139.52 / 144.13 | 210 s | 184.22 / 148.47 / 145.59 | 184 s, 1674 ops (0 failed) |
| 6 | A' | 55.74 / 151.97 / 164.31 | 585 s | 10.58 / 88.44 / 135.38 | 177 s, 1666 ops (0 failed) |

## Per view and n

T = the median paired difference over rounds, MAD its spread, z = |T| ÷ (1.858·MAD/√R). The A/A arm is the noise: its z should stay near 2 or below.

### n = 10 · list

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.80 | 16.70 | -0.10 | 0.00 | ∞ |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 0.11 | 0.10 | -0.02 | 0.04 | 0.7 |
| view commits / s | 11.90 | 11.40 | 0.00 | 0.10 | 0.0 |
| view render (ms / s) | 9.32 | 10.33 | 0.22 | 0.43 | 0.7 |
| all React commits / s | 12.80 | 12.30 | 0.00 | 0.20 | 0.0 |

### n = 10 · rain

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.80 | 16.80 | 0.00 | 0.00 | 0.0 |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 19.15 | 19.26 | 0.46 | 0.47 | 1.4 |
| view commits / s | 12.30 | 11.90 | -0.40 | 0.40 | 1.4 |
| view render (ms / s) | 2.02 | 1.97 | 0.03 | 0.19 | 0.2 |
| all React commits / s | 13.20 | 12.60 | -0.40 | 0.30 | 1.9 |

### n = 10 · swarm

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.70 | 16.80 | 0.00 | 0.00 | 0.0 |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 34.03 | 33.72 | 0.77 | 1.21 | 0.9 |
| view commits / s | 12.30 | 12.30 | 0.10 | 0.10 | 1.4 |
| view render (ms / s) | 2.46 | 2.30 | 0.02 | 0.05 | 0.6 |
| all React commits / s | 13.20 | 13.20 | 0.00 | 0.10 | 0.0 |

### n = 10 · timeline

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.70 | 16.80 | 0.10 | 0.00 | ∞ |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 7.76 | 7.89 | 0.34 | 0.36 | 1.3 |
| view commits / s | 11.50 | 11.60 | -0.10 | 0.10 | 1.4 |
| view render (ms / s) | 12.44 | 11.82 | 0.45 | 0.25 | 2.6 |
| all React commits / s | 12.40 | 12.40 | -0.10 | 0.20 | 0.7 |

### n = 20 · list

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.80 | 16.70 | -0.10 | 0.00 | ∞ |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 0.18 | 0.17 | 0.01 | 0.03 | 0.5 |
| view commits / s | 20.20 | 20.20 | 0.30 | 0.40 | 1.1 |
| view render (ms / s) | 19.77 | 22.01 | -0.68 | 1.63 | 0.6 |
| all React commits / s | 21.10 | 21.10 | 0.40 | 0.60 | 0.9 |

### n = 20 · rain

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.70 | 16.80 | 0.00 | 0.10 | 0.0 |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 30.43 | 29.70 | -0.42 | 1.65 | 0.4 |
| view commits / s | 23.50 | 22.10 | -1.00 | 0.40 | 3.6 |
| view render (ms / s) | 5.22 | 5.00 | -0.18 | 0.14 | 1.8 |
| all React commits / s | 24.40 | 23.00 | -1.00 | 0.40 | 3.6 |

### n = 20 · swarm

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.80 | 16.80 | 0.00 | 0.00 | 0.0 |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 53.88 | 54.34 | 0.74 | 1.04 | 1.0 |
| view commits / s | 20.00 | 20.10 | 0.20 | 0.30 | 0.9 |
| view render (ms / s) | 5.10 | 5.07 | -0.06 | 0.14 | 0.6 |
| all React commits / s | 20.90 | 21.00 | 0.20 | 0.20 | 1.4 |

### n = 20 · timeline

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 11.30 | 11.08 | 0.16 | 0.25 | 0.9 |
| view commits / s | 23.50 | 23.60 | -0.30 | 0.50 | 0.9 |
| view render (ms / s) | 25.88 | 27.13 | 0.24 | 0.62 | 0.6 |
| all React commits / s | 24.40 | 24.30 | -0.30 | 0.50 | 0.9 |

### n = 60 · list

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 0.47 | 0.60 | 0.07 | 0.13 | 0.8 |
| view commits / s | 58.90 | 59.90 | 0.00 | 4.20 | 0.0 |
| view render (ms / s) | 107.70 | 111.56 | 2.66 | 7.69 | 0.5 |
| all React commits / s | 59.80 | 60.70 | 0.00 | 4.20 | 0.0 |

### n = 60 · rain

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.70 | 16.80 | 0.10 | 0.00 | ∞ |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 39.12 | 38.97 | -0.06 | 0.90 | 0.1 |
| view commits / s | 73.50 | 66.60 | -0.30 | 2.40 | 0.2 |
| view render (ms / s) | 25.48 | 24.28 | 0.14 | 0.76 | 0.3 |
| all React commits / s | 74.40 | 67.30 | -0.30 | 2.40 | 0.2 |

### n = 60 · swarm

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| long animation frames / 10 s | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF duration (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 145.61 | 145.42 | 0.35 | 2.92 | 0.2 |
| view commits / s | 61.60 | 59.50 | -0.70 | 1.80 | 0.6 |
| view render (ms / s) | 23.49 | 22.79 | 0.19 | 1.41 | 0.2 |
| all React commits / s | 62.50 | 60.40 | -0.90 | 1.90 | 0.7 |

### n = 60 · timeline

| metric | A | A′ | A′ − A: T | MAD | z |
|---|---|---|---|---|---|
| frame p50 (ms) | 16.70 | 16.70 | 0.00 | 0.00 | 0.0 |
| frame p95 (ms) — weather | 50.00 | 66.60 | 0.00 | 0.00 | 0.0 |
| long animation frames / 10 s | 32.00 | 48.00 | -2.00 | 4.00 | 0.7 |
| LoAF duration (ms / s) | 232.50 | 319.29 | -20.88 | 15.66 | 1.9 |
| LoAF blocking (ms / s) | 0.00 | 0.00 | 0.00 | 0.00 | 0.0 |
| rAF work (ms / s) | 27.28 | 29.97 | 1.46 | 2.42 | 0.9 |
| view commits / s | 63.00 | 62.40 | 0.50 | 2.30 | 0.3 |
| view render (ms / s) | 126.32 | 127.32 | -2.24 | 2.78 | 1.1 |
| all React commits / s | 63.70 | 63.30 | 0.60 | 2.30 | 0.4 |

