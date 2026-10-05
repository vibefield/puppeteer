import { describe, expect, it } from 'vitest';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import { laneFor } from './timeline-lanes.js';
import {
  PULSE_GEOMETRY,
  addCoverage,
  pulseMap,
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
