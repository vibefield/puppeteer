import { describe, expect, it } from 'vitest';
import type { TimelineLane } from './timeline-lanes.js';
import {
  capsStart,
  neck,
  wakeGradient,
  wakeLabels,
  wakeOutline,
  wakeRadius,
  wakeSegments,
  wakeSheens,
} from './wake-geometry.js';

const MIN = 60_000;
const NOW = 10_000 * MIN;

function lane(overrides: Partial<TimelineLane> = {}): TimelineLane {
  return {
    id: 'a',
    agent: {
      id: 'a',
      createdAtMs: NOW - 60 * MIN,
      status: 'blocked',
      project: 'p',
      detail: '',
      color: '#123456',
      active: false,
    },
    kind: 'agent',
    receded: false,
    bornMs: NOW - 60 * MIN,
    recordedFromMs: NOW - 60 * MIN,
    spans: [
      { status: 'working', fromMs: NOW - 60 * MIN, toMs: NOW - 30 * MIN },
      { status: 'idle', fromMs: NOW - 30 * MIN, toMs: NOW - 20 * MIN },
      { status: 'blocked', fromMs: NOW - 20 * MIN, blocker: { kind: 'question' } },
    ],
    ...overrides,
  };
}

describe('wakeRadius', () => {
  it('is wide for work, a thread for a wait you owe, a hair for rest (DESIGN §8 numbers)', () => {
    expect(wakeRadius('agent', 'working', 30) * 2).toBeCloseTo(13.2);
    expect(wakeRadius('agent', 'working', 100) * 2).toBe(15);
    expect(wakeRadius('agent', 'working', 10) * 2).toBe(8);
    expect(wakeRadius('agent', 'blocked', 24) * 2).toBeCloseTo(5.52);
    expect(wakeRadius('agent', 'unseen', 100) * 2).toBeCloseTo(7.6);
    expect(wakeRadius('agent', 'idle', 30) * 2).toBeCloseTo(1.7);
    expect(wakeRadius('terminal', 'working', 18)).toBe(1.8);
  });
});

describe('wakeSegments', () => {
  it('cuts the spans to the window and marks the open one', () => {
    const k = 600 / (60 * MIN);
    const segments = wakeSegments(lane(), NOW - 40 * MIN, NOW, k, 30, NOW);
    expect(segments.map((segment) => segment.status)).toEqual(['working', 'idle', 'blocked']);
    // The first starts 30 px before the window, so the wake enters from off-canvas.
    expect(segments[0]!.x0).toBeCloseTo(-30);
    expect(segments[2]!.x1).toBeCloseTo(400);
    expect(segments.map((segment) => segment.open)).toEqual([false, false, true]);
  });

  it('starts no earlier than the record and stops at the end', () => {
    const k = 1 / MIN;
    const segments = wakeSegments(
      lane({ recordedFromMs: NOW - 25 * MIN, endedAtMs: NOW - 5 * MIN }),
      NOW - 60 * MIN,
      NOW,
      k,
      30,
      NOW,
    );
    expect(segments[0]!.a).toBe(NOW - 25 * MIN);
    expect(segments[segments.length - 1]!.b).toBe(NOW - 5 * MIN);
    expect(segments.every((segment) => !segment.open)).toBe(true);
  });
});

describe('wakeOutline', () => {
  const k = 600 / (60 * MIN);
  const segments = wakeSegments(lane(), NOW - 60 * MIN, NOW, k, 30, NOW);

  it('is one closed outline, an S-curve at each change of thickness', () => {
    const commands = wakeOutline(segments, 15, true);
    expect(commands[0]!.op).toBe('M');
    expect(commands[1]!.op).toBe('A');
    expect(commands[commands.length - 1]!.op).toBe('Z');
    // Two changes, each drawn on the top and the bottom edge.
    expect(commands.filter((command) => command.op === 'C')).toHaveLength(4);
  });

  it('pinches into a wait: the S-curve lands on the next span’s radius', () => {
    const commands = wakeOutline(segments, 15, false);
    const firstCurve = commands.find((command) => command.op === 'C');
    expect(firstCurve && firstCurve.op === 'C' && firstCurve.y).toBeCloseTo(15 - segments[1]!.r);
  });

  it('necks never more than 5 px nor 40% of either span', () => {
    expect(neck(segments, 0)).toBe(5);
    const tight = wakeSegments(
      lane({
        spans: [
          { status: 'working', fromMs: NOW - 60 * MIN, toMs: NOW - 59.9 * MIN },
          { status: 'idle', fromMs: NOW - 59.9 * MIN },
        ],
      }),
      NOW - 60 * MIN,
      NOW,
      k,
      30,
      NOW,
    );
    expect(neck(tight, 0)).toBeCloseTo(0.5);
  });

  it('caps the start only where the record begins inside the window', () => {
    expect(capsStart(lane(), segments[0]!)).toBe(true);
    const late = wakeSegments(lane(), NOW - 20 * MIN, NOW, k, 30, NOW);
    expect(capsStart(lane(), late[0]!)).toBe(false);
  });

  it('turns colour where the shape turns', () => {
    const stops = wakeGradient(segments, (segment) => segment.status);
    expect(stops[0]).toEqual({ offset: 0, color: 'working' });
    expect(stops[stops.length - 1]).toEqual({ offset: 1, color: 'blocked' });
    for (let index = 1; index < stops.length; index += 1) {
      expect(stops[index]!.offset).toBeGreaterThanOrEqual(stops[index - 1]!.offset);
    }
  });

  it('runs a sheen along work only', () => {
    const sheens = wakeSheens(segments, 15);
    expect(sheens).toHaveLength(1);
    expect(sheens[0]!.y).toBeLessThan(15);
  });
});

describe('wakeLabels', () => {
  it('prints each closed span that fits, inside the work or above a wait', () => {
    const k = 600 / (60 * MIN);
    const segments = wakeSegments(lane(), NOW - 60 * MIN, NOW, k, 30, NOW);
    const labels = wakeLabels(
      segments,
      15,
      0,
      592,
      (text) => text.length * 5,
      (ms) => `${Math.round(ms / MIN)}m`,
    );
    expect(labels.map((label) => [label.text, label.inside])).toEqual([
      ['30m', true],
      ['10m', false],
    ]);
    expect(labels[1]!.y).toBeLessThan(15);
  });
});
