import { describe, expect, it } from 'vitest';
import type { MonitorHistory, MonitorPastSpan } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import { laneFor, timelineLanes } from './timeline-lanes.js';
import {
  PULSE_GEOMETRY,
  addCoverage,
  pulseMap,
  pulsePastFor,
  pulseRowsFor,
  pulseScales,
  smooth,
  type PulseRow,
} from './pulse-map.js';

const MIN = 60_000;
const START = 0;
const NOW = 100 * MIN;

describe('addCoverage', () => {
  it('adds the fraction of each bucket a span covers', () => {
    const into = new Float32Array(4);
    addCoverage(into, 0, 10, 5, 25);
    expect([...into]).toEqual([0.5, 1, 0.5, 0]);
  });
});

describe('smooth', () => {
  it('keeps the total and rolls a step into a slope', () => {
    const step = new Float32Array(60);
    for (let index = 30; index < 60; index += 1) step[index] = 1;
    const out = smooth(step);
    expect(out[29]).toBeGreaterThan(0.3);
    expect(out[29]).toBeLessThan(0.7);
    expect(out[5]).toBeCloseTo(0);
    expect(out[55]).toBeCloseTo(1);
  });
});

describe('pulseScales', () => {
  it('fills work’s zone at no more than 6 px an agent, and never draws a wait larger than work', () => {
    expect(pulseScales(7, 1, 21, 10)).toEqual({ kUp: 3, kDn: 3 });
    expect(pulseScales(1, 1, 21, 10)).toEqual({ kUp: 6, kDn: 6 });
    expect(pulseScales(1, 5, 21, 10)).toEqual({ kUp: 6, kDn: 2 });
  });
});

describe('pulseMap (runtime only: each agent’s current state, from when it began to now)', () => {
  const rows: PulseRow[] = [
    { color: 'violet', status: 'working', fromMs: 10 * MIN, endMs: NOW },
    { color: 'green', status: 'working', fromMs: 60 * MIN, endMs: NOW },
    { color: 'violet', status: 'blocked', fromMs: 70 * MIN, endMs: NOW },
    { color: 'amber', status: 'unseen', fromMs: 80 * MIN, endMs: NOW },
    { color: 'slate', status: 'idle', fromMs: 0, endMs: NOW },
  ];
  const map = pulseMap(rows, START, NOW, { ...PULSE_GEOMETRY, width: 200 });

  it('stacks one band per project colour, the one that worked most on the line; a resting project’s is empty', () => {
    expect(map.work.map((band) => band.color)).toEqual(['violet', 'green', 'amber', 'slate']);
    const i = map.xs.findIndex((x) => x > 190);
    // The lowest band sits on the line and rises above it (y grows downward).
    expect(map.work[0]!.bottom[i]).toBeCloseTo(map.base);
    expect(map.work[0]!.top[i]).toBeLessThan(map.base);
    expect(map.work[1]!.bottom[i]).toBeCloseTo(map.work[0]!.top[i]!);
    expect(map.work[3]!.top[i]).toBeCloseTo(map.work[3]!.bottom[i]!);
  });

  it('claims nothing before a state began: the ridge rises only where the current stretches are', () => {
    const rise = (index: number): number => map.base - map.work[map.work.length - 1]!.top[index]!;
    expect(rise(0)).toBeLessThan(0.05 * rise(map.xs.length - 1));
  });

  it('hangs the waits below the line, orange then blue', () => {
    const last = map.xs.length - 1;
    expect(map.blocked.top[last]).toBeCloseTo(map.base);
    expect(map.blocked.bottom[last]).toBeGreaterThan(map.base);
    expect(map.unseen.top[last]).toBeCloseTo(map.blocked.bottom[last]!);
    expect(map.unseen.bottom[last]).toBeGreaterThan(map.unseen.top[last]!);
  });

  it('keeps the ridge inside its zones', () => {
    for (let index = 0; index < map.xs.length; index += 1) {
      const top = map.work[map.work.length - 1]!.top[index]!;
      expect(top).toBeGreaterThanOrEqual(map.base - PULSE_GEOMETRY.up - 1e-3);
      expect(map.unseen.bottom[index]!).toBeLessThanOrEqual(map.base + PULSE_GEOMETRY.down + 1e-3);
    }
  });
});

describe('pulseRowsFor', () => {
  const lane = (id: string, overrides: AgentViewFixturePartial = {}) =>
    laneFor(
      agentViewFixture({ id, colour: id, status: 'working', createdAt: 0, statusSince: 5 * MIN, ...overrides }),
      NOW,
    );

  it('counts what the stage counts: no receded lane, no bare terminal', () => {
    const rows = pulseRowsFor([lane('a'), lane('b', { receded: true }), lane('t', { kind: 'terminal' })], NOW);
    expect(rows).toEqual([{ color: 'a', status: 'working', fromMs: 5 * MIN, endMs: NOW }]);
  });

  it('gives each agent its current state from when it began', () => {
    const rows = pulseRowsFor([lane('u', { status: 'idle', unread: true, statusSince: 30 * MIN })], NOW);
    expect(rows).toEqual([{ color: 'u', status: 'unseen', fromMs: 30 * MIN, endMs: NOW }]);
  });
});

describe("the record's work on the map (T6)", () => {
  const at = (kind: MonitorPastSpan['kind'], from: number, to: number): MonitorPastSpan => ({
    kind,
    from: from * MIN,
    to: to * MIN,
  });
  const row = (id: string, overrides: AgentViewFixturePartial = {}) =>
    agentViewFixture({ id, colour: id, status: 'working', createdAt: 0, statusSince: 60 * MIN, ...overrides });
  const history: MonitorHistory = {
    sinceMs: NOW - 24 * 60 * MIN,
    untilMs: NOW,
    readAt: NOW,
    fidelity: 'turns',
    state: 'complete',
    live: [
      { id: 'a', seamAt: 60 * MIN, spans: [at('worked', 10, 20), at('quiet', 20, 30), at('worked', 30, 60)] },
      { id: 'r', seamAt: 60 * MIN, spans: [at('worked', 10, 60)] },
    ],
    ended: [
      {
        id: 'past:claude:e',
        project: { name: 'e', seq: 3 },
        device: { id: 'here', name: 'here', self: true },
        startedAt: 0,
        endedAt: 50 * MIN,
        spans: [at('worked', 0, 15), at('unrecorded', 15, 30), at('worked', 30, 50)],
        colour: 'ended-colour',
        receded: false,
      },
      {
        id: 'past:claude:b',
        project: { name: 'b', seq: 4 },
        device: { id: 'here', name: 'here', self: true },
        startedAt: 5 * MIN,
        endedAt: 45 * MIN,
        spans: [at('bounds', 5, 45)],
        colour: 'bounds-colour',
        receded: false,
      },
    ],
  };
  const lanes = timelineLanes([row('a'), row('r', { receded: true })], NOW, history).agents;

  it("counts each lane's worked stretches in its own colour, but a receded lane's; quiet and bounds count nothing", () => {
    const past = pulsePastFor(lanes);
    expect(past.map((lane) => [lane.color, lane.spans.map((span) => span.kind)])).toEqual([
      ['a', ['worked', 'worked']],
      ['ended-colour', ['worked', 'worked']],
    ]);
    // The rows\' waits and current states are their own, as before.
    expect(pulseRowsFor(lanes, NOW)).toEqual([{ color: 'a', status: 'working', fromMs: 60 * MIN, endMs: NOW }]);
  });

  it('adds that work to the ridge, and leaves the ridge as it was without it', () => {
    const rows = pulseRowsFor(lanes, NOW);
    const geometry = { ...PULSE_GEOMETRY, width: 200 };
    const bare = pulseMap(rows, START, NOW, geometry);
    expect(pulseMap(rows, START, NOW, geometry, [])).toEqual(bare);
    const map = pulseMap(rows, START, NOW, geometry, pulsePastFor(lanes));
    expect(map.work.map((band) => band.color).sort()).toEqual(['a', 'ended-colour']);
    // Before any row\'s current state the bare ridge is flat; with the record it rises where the lanes worked.
    const early = map.xs.findIndex((x) => x > 30);
    const rise = (of: typeof map) => of.base - of.work[of.work.length - 1]!.top[early]!;
    expect(rise(bare)).toBeCloseTo(0);
    expect(rise(map)).toBeGreaterThan(1);
    expect(map.blocked.bottom[early]).toBeCloseTo(map.base);
  });
});
