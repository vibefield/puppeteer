import { describe, expect, it } from 'vitest';
import type { AgentView } from '@vibefield/puppeteer-view-sdk';
import { agentViewFixture } from '@vibefield/puppeteer-view-sdk/testing';
import { SPEND_STEP_MS, SPEND_WINDOW_MS } from './spend-scale.js';
import {
  lineAt,
  lineOf,
  meterOf,
  rateAt,
  spendAt,
  spendMeters,
  spendOf,
  spendSet,
  spentAt,
  spentPoints,
  valueAt,
  windowPoints,
} from './spend-series.js';

const MIN = 60_000;
const STEP = SPEND_STEP_MS;
/** On a 30 s boundary: the current bucket has just begun, so it has spent nothing yet. */
const NOW = Math.floor(Date.parse('2026-10-02T17:00:00.000Z') / STEP) * STEP;
const TA = NOW - SPEND_WINDOW_MS;

/**
 * A live row: its cost's total and Core's last ten minutes, the given buckets the newest (the rest quiet), the last
 * begun at `lastStepAt` (the bucket now is in, unless told); `peer` is another desktop's row, its cut a total alone
 * unless `steps` are given.
 */
function row(
  id: string,
  spec: {
    born: number;
    usd?: number;
    steps?: number[];
    partial?: boolean;
    unavailable?: boolean;
    peer?: boolean;
    lastStepAt?: number;
    now?: number;
  },
): AgentView {
  const now = spec.now ?? NOW;
  const steps = spec.steps ?? [];
  const series =
    spec.peer && spec.steps === undefined
      ? undefined
      : {
          stepMs: STEP,
          steps: [...new Array<number>(20 - steps.length).fill(0), ...steps],
          lastStepAt: spec.lastStepAt ?? Math.floor(now / STEP) * STEP,
        };
  return agentViewFixture({
    id,
    project: { name: id },
    status: 'working',
    createdAt: spec.born,
    ...(spec.peer ? { device: { id: 'tower', name: 'tower', self: false } } : {}),
    ...(spec.usd === undefined
      ? {}
      : {
          cost: {
            usd: spec.usd,
            coverage: spec.unavailable ? 'unavailable' : spec.partial ? 'partial' : 'complete',
            ...(series ? { series } : {}),
          },
        }),
  });
}

describe('the spend lines (runtime only, the backend’s cost)', () => {
  it('reads the meter the row reports: its cost’s total, and nothing for no price', () => {
    expect(spendOf(row('a', { born: NOW - MIN, usd: 3.5, partial: true }))).toEqual({ usd: 3.5, partial: true });
    expect(spendOf(row('b', { born: NOW - MIN, usd: 2 }))).toEqual({ usd: 2, partial: false });
    // A run that could not be priced reports nothing, never $0.
    expect(spendOf(row('c', { born: NOW - MIN, usd: 0, unavailable: true }))).toBeUndefined();
    expect(spendOf(row('d', { born: NOW - MIN }))).toBeUndefined();
  });

  it("draws the agent's actual meter back from its total through Core's buckets: the head is the total", () => {
    const steps = [...new Array<number>(19).fill(0.5), 0];
    const line = lineOf(row('a', { born: NOW - 60 * MIN, usd: 30, steps }), NOW)!;
    expect(line.recorded).toBe(true);
    expect(line.total).toBe(30);
    expect(line.points.at(-1)).toEqual({ t: NOW, v: 30 });
    expect(valueAt(line, NOW)).toBe(line.total);
    // The oldest bucket's start: the total less every bucket since.
    expect(line.points[0]).toEqual({ t: NOW - 19 * STEP, v: 20.5 });
    expect(valueAt(line, NOW - 5 * MIN)).toBeCloseTo(25);
    expect(valueAt(line, NOW - 5 * MIN - 15_000)).toBeCloseTo(24.75);
    // $5 over the last five minutes: a dollar a minute.
    expect(rateAt(line, NOW)).toBeCloseTo(1);
  });

  it('reaches back over the whole window at every moment of a bucket', () => {
    for (const into of [0, 10_000, 29_999]) {
      const now = NOW + into;
      const agent = row('a', { born: now - 60 * MIN, usd: 9, steps: new Array<number>(20).fill(0.1), now });
      const line = lineOf(agent, now)!;
      expect(line.points[0]!.t).toBeLessThanOrEqual(now - SPEND_WINDOW_MS);
      expect(valueAt(line, now - SPEND_WINDOW_MS)).toBeDefined();
    }
  });

  it('lays the buckets where the backend began them: the newest at `lastStepAt`, whatever the clock says now', () => {
    // A series the backend has not stepped yet reads its own buckets, a bucket behind now's (the model's fact, MV-7).
    const behind = NOW - STEP;
    const line = lineOf(row('a', { born: NOW - 60 * MIN, usd: 10, steps: [1, 1], lastStepAt: behind }), NOW + 5_000)!;
    expect(line.points.at(-2)).toEqual({ t: behind, v: 9 });
    expect(line.points.at(-3)).toEqual({ t: behind - STEP, v: 8 });
    expect(line.points.at(-1)).toEqual({ t: NOW + 5_000, v: 10 });
  });

  it("draws what a run spent in the window: $0 at the window's left edge, its head the total less the meter there (SV-D2)", () => {
    const steps = [...new Array<number>(19).fill(0.5), 0];
    const line = lineOf(row('a', { born: NOW - 60 * MIN, usd: 30, steps }), NOW)!;
    expect(spentAt(line, TA, TA)).toBe(0);
    const points = spentPoints(line, TA, NOW);
    expect(points[0]).toEqual({ t: TA, v: 0 });
    // The window begins 9.5 minutes back, at the oldest bucket's start: the meter read $20.50 there.
    expect(points.at(-1)).toEqual({ t: NOW, v: 9.5 });
    expect(spentAt(line, TA, NOW)).toBe(line.total - valueAt(line, TA)!);
    expect(spentAt(line, TA, NOW - 5 * MIN)).toBeCloseTo(4.5);
    // The row's own figure is still the run's total.
    expect(valueAt(line, NOW)).toBe(30);
  });

  it('starts a run born inside the window at $0 at its birth (SV-D2)', () => {
    // Born 3 m 10 s ago, inside the bucket that began 3 m 30 s ago; it has spent $0.20 a bucket since.
    const born = NOW - 190_000;
    const line = lineOf(row('young', { born, usd: 1.4, steps: [...new Array<number>(7).fill(0.2), 0] }), NOW)!;
    expect(line.points[0]).toEqual({ t: born, v: 0 });
    expect(line.points[1]!.t).toBe(NOW - 6 * STEP);
    expect(line.points[1]!.v).toBeCloseTo(0.2);
    expect(valueAt(line, born - 1)).toBeUndefined();
    expect(spentAt(line, TA, born - 1)).toBeUndefined();
    expect(spentAt(line, TA, born)).toBe(0);
    expect(spentPoints(line, TA, NOW)[0]).toEqual({ t: born, v: 0 });
    expect(spentAt(line, TA, NOW)).toBeCloseTo(1.4);
  });

  it("starts a resumed run at $0 at its birth too: what its earlier runs carried is not the window's spend", () => {
    const born = NOW - 130_000;
    const line = lineOf(row('resumed', { born, usd: 12.3, steps: [0.1, 0.1, 0.1, 0] }), NOW)!;
    // The meter carried $12 into it; the row prints the whole $12.30.
    expect(line.points[0]!.t).toBe(born);
    expect(line.points[0]!.v).toBeCloseTo(12);
    expect(valueAt(line, NOW)).toBe(12.3);
    expect(spentAt(line, TA, born)).toBe(0);
    expect(spentPoints(line, TA, NOW)[0]).toEqual({ t: born, v: 0 });
    expect(spentAt(line, TA, NOW)).toBeCloseTo(0.3);
  });

  it("draws nothing for another desktop's row: a total and no window spend, no line and no dot (SV-D2)", () => {
    for (const steps of [undefined, [0.2, 0.3, 0]]) {
      // A peer's cut is a total alone; and a cut that carried buckets would still draw no line: a peer has none.
      const line = lineOf(
        row('peer', { born: NOW - 60 * MIN, usd: 4.2, peer: true, ...(steps ? { steps } : {}) }),
        NOW,
      )!;
      expect(line.recorded).toBe(false);
      expect(line.points).toEqual([{ t: NOW, v: 4.2 }]);
      // Its row keeps the total, now and only now.
      expect(valueAt(line, NOW)).toBe(4.2);
      expect(valueAt(line, NOW - MIN)).toBeUndefined();
      expect(rateAt(line, NOW)).toBeUndefined();
      expect(spentAt(line, TA, NOW)).toBeUndefined();
      expect(spentPoints(line, TA, NOW)).toEqual([]);
      expect(windowPoints(line, TA, NOW)).toEqual([]);
    }
  });

  it('never draws a meter falling: a correction reads flat, and the head stays the total', () => {
    const line = lineOf(row('a', { born: NOW - 60 * MIN, usd: 3, steps: [0.5, -0.3, 0.4, 0] }), NOW)!;
    const values = line.points.map((point) => point.v);
    for (let i = 1; i < values.length; i += 1) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    expect(values.at(-1)).toBe(3);
  });

  it('measures the burn over the last five minutes, or over what a young run has had of them', () => {
    // Born on a bucket's start two minutes ago, $0.10 a bucket since: twenty cents a minute, its own pace.
    const line = lineOf(row('young', { born: NOW - 4 * STEP, usd: 0.4, steps: [0.1, 0.1, 0.1, 0.1, 0] }), NOW)!;
    expect(rateAt(line, NOW)).toBeCloseTo(0.2);
    // Under a minute old: nothing to measure yet.
    const newborn = lineOf(row('newborn', { born: NOW - 40_000, usd: 0.05, steps: [0.05, 0] }), NOW)!;
    expect(rateAt(newborn, NOW)).toBeUndefined();
  });

  it('cuts a line to the window by its own straight pieces, the head at now', () => {
    const steps = [...new Array<number>(19).fill(0.5), 0];
    const line = lineOf(row('a', { born: NOW - 60 * MIN, usd: 30, steps }), NOW)!;
    const ta = NOW - 19 * STEP + 15_000;
    const points = windowPoints(line, ta, NOW);
    expect(points[0]!.t).toBe(ta);
    expect(points[0]!.v).toBeCloseTo(20.75);
    expect(points.at(-1)).toEqual({ t: NOW, v: 30 });
    expect(points.every((point) => point.t >= ta && point.t <= NOW)).toBe(true);
  });

  it('names an agent with no price apart, and leaves terminals out (SV-D5)', () => {
    const priced = row('priced', { born: NOW - 10 * MIN, usd: 1 });
    const none = row('none', { born: NOW - 10 * MIN });
    const terminal = agentViewFixture({ id: 'shell', kind: 'terminal', project: { name: 'shell' } });
    const set = spendSet([priced, none, terminal], NOW);
    expect(set.lines.map((line) => line.id)).toEqual(['priced']);
    expect(set.unpriced.map((entry) => entry.id)).toEqual(['none']);
  });

  it('reads a row back through its buckets once: a model that kept the row keeps its meter (MV-D21, M64)', () => {
    const kept = row('kept', { born: NOW - 60 * MIN, usd: 5, steps: [0.1, 0.2, 0] });
    const moved = row('moved', { born: NOW - 60 * MIN, usd: 7, steps: [0.3, 0] });
    const none = row('none', { born: NOW - 10 * MIN });
    const first = spendMeters([kept, moved, none]);
    // The next model keeps two rows' objects and replaces one, as a replica does.
    const movedAgain = { ...moved, cost: { ...moved.cost!, usd: 7.5 } };
    const second = spendMeters([kept, movedAgain, none]);
    expect(second.lines[0]).toBe(first.lines[0]);
    expect(second.lines[1]).not.toBe(first.lines[1]);
    expect(second.lines[1]!.total).toBe(7.5);
    expect(second.unpriced[0]!.agent).toBe(first.unpriced[0]!.agent);
    // The clock moves only the head: the meter's own readings are the same object at every moment.
    const early = spendAt(second, NOW);
    const later = spendAt(second, NOW + 20_000);
    expect(early.lines[0]!.points.at(-1)).toEqual({ t: NOW, v: 5 });
    expect(later.lines[0]!.points.at(-1)).toEqual({ t: NOW + 20_000, v: 5 });
    expect(later.lines[0]!.points.slice(0, -1)).toEqual(second.lines[0]!.points);
    expect(meterOf(kept)).toEqual(first.lines[0]);
  });

  it('begins a birth the clock has not reached yet at now: nothing is older than it', () => {
    const meter = meterOf(row('ahead', { born: NOW + 4_000, usd: 0.3, steps: [0.1, 0] }))!;
    const line = lineAt(meter, NOW);
    expect(line.bornMs).toBe(NOW);
    expect(line.points.every((point) => point.t <= NOW)).toBe(true);
    expect(line.points.at(-1)).toEqual({ t: NOW, v: 0.3 });
  });
});
