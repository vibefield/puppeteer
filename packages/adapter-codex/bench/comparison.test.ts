import { expect, it } from 'vitest';
import { compareStartup } from './comparison.js';
const pair = (round: number, baseline: number, current: number, control: number) => [
  { round, arm: 'baseline', readyMs: baseline },
  { round, arm: 'current', readyMs: current },
  { round, arm: 'null', readyMs: control },
];
it('refuses a win for an incomplete experiment, even with a large apparent saving', () => {
  expect(compareStartup(pair(0, 4000, 1000, 4100), 2).verdict).toBe('incomplete');
});
it('refuses a win after failed cleanup even when readiness was recorded', () => {
  const rows = pair(0, 4000, 1000, 4100).map((row) => ({
    ...row,
    ...(row.arm === 'current' ? { failure: 'archive-failed' } : {}),
  }));
  expect(compareStartup(rows, 1).verdict).toBe('incomplete');
});
it('qualifies a saving against the unchanged control and excludes warmup', () => {
  const warmup = { round: -1, arm: 'baseline', readyMs: 100000 };
  expect(compareStartup([warmup, ...pair(0, 1200, 1150, 1500)], 1).verdict).toBe('below-null-noise');
  expect(compareStartup([warmup, ...pair(0, 4000, 1000, 4100)], 1)).toMatchObject({
    verdict: 'median-improvement-resolved',
    pairedMedianSavingsMs: 3000,
    nullP95DifferenceMs: 100,
  });
  expect(compareStartup(pair(0, 1000, 4000, 1100), 1).verdict).toBe('median-regression-resolved');
});
