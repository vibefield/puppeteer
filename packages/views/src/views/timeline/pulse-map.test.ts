import { describe, expect, it } from 'vitest';
import { PULSE_GEOMETRY, addCoverage, pulseMap, pulseScales, smooth, type PulseRow } from './pulse-map.js';

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

describe('pulseMap', () => {
  const rows: PulseRow[] = [
    {
      color: 'violet',
      recordedFromMs: 0,
      endMs: NOW,
      spans: [
        { status: 'working', fromMs: 0, toMs: 60 * MIN },
        { status: 'blocked', fromMs: 60 * MIN },
      ],
    },
    { color: 'green', recordedFromMs: 0, endMs: NOW, spans: [{ status: 'working', fromMs: 40 * MIN, toMs: 50 * MIN }] },
    { color: 'violet', recordedFromMs: 0, endMs: NOW, spans: [{ status: 'unseen', fromMs: 20 * MIN }] },
  ];
  const map = pulseMap(rows, START, NOW, { fromMs: 40 * MIN, toMs: NOW }, { ...PULSE_GEOMETRY, width: 200 });

  it('stacks one band per project colour, the one that worked most on the line', () => {
    expect(map.work.map((band) => band.color)).toEqual(['violet', 'green']);
    const i = map.xs.findIndex((x) => x > 10);
    // The lowest band sits on the line and rises above it (y grows downward).
    expect(map.work[0]!.bottom[i]).toBeCloseTo(map.base);
    expect(map.work[0]!.top[i]).toBeLessThan(map.base);
    expect(map.work[1]!.bottom[i]).toBeCloseTo(map.work[0]!.top[i]!);
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

  it('points its crest at work and its dip at a wait inside the window', () => {
    expect(map.crest.y).toBeLessThan(map.base);
    expect(map.dip.y).toBeGreaterThan(map.base);
    expect(map.dip.x).toBeGreaterThan(200 * 0.4 - 1);
  });
});
