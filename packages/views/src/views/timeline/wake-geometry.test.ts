import { describe, expect, it } from 'vitest';
import type { MonitorPastSpan } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import { historyLanes, laneFor, type TimelineLane } from './timeline-lanes.js';
import {
  capsRun,
  capsStart,
  neck,
  unrecordedStretches,
  wakeGradient,
  wakeOutline,
  wakeRadius,
  wakeRuns,
  wakeSeam,
  wakeSegments,
  wakeSheens,
  type WakeSegment,
} from './wake-geometry.js';

const MIN = 60_000;
const NOW = 10_000 * MIN;

/** A lane born an hour ago, working for the last 20 minutes, unless told otherwise. */
function lane(overrides: AgentViewFixturePartial = {}): TimelineLane {
  return laneFor(
    agentViewFixture({
      id: 'a',
      createdAt: NOW - 60 * MIN,
      status: 'working',
      statusSince: NOW - 20 * MIN,
      ...overrides,
    }),
    NOW,
  );
}

/** A run of segments as history would give them (rosettad, later): the shape functions take any run. */
function run(k: number, t0: number, parts: readonly [WakeSegment['status'], number, number][]): WakeSegment[] {
  return parts.map(([status, a, b]) => ({
    a,
    b,
    x0: (a - t0) * k,
    x1: (b - t0) * k,
    status,
    r: wakeRadius('agent', status, 30),
  }));
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
    expect(wakeRadius('terminal', 'idle', 18)).toBe(0.6);
  });
});

describe('wakeSegments (runtime only: the current state alone)', () => {
  const k = 600 / (60 * MIN);

  it('draws the current state from where it began to the head', () => {
    const segments = wakeSegments(lane(), NOW - 60 * MIN, NOW, k, 30, NOW);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ a: NOW - 20 * MIN, b: NOW, status: 'working' });
    expect(segments[0]!.x0).toBeCloseTo(400);
    expect(segments[0]!.x1).toBeCloseTo(600);
  });

  it('enters from 30 px off-canvas when the state began before the window', () => {
    const segments = wakeSegments(lane(), NOW - 10 * MIN, NOW, k, 30, NOW);
    expect(segments[0]!.x0).toBeCloseTo(-30);
  });

  it('stops at the head when it is held back, and draws nothing before the state began', () => {
    const held = wakeSegments(lane(), NOW - 70 * MIN, NOW - 10 * MIN, k, 30, NOW);
    expect(held[0]!.b).toBe(NOW - 10 * MIN);
    expect(wakeSegments(lane(), NOW - 90 * MIN, NOW - 30 * MIN, k, 30, NOW)).toEqual([]);
  });

  it('caps the start where the state begins inside the window, and not where it enters from off-canvas', () => {
    const inside = wakeSegments(lane(), NOW - 60 * MIN, NOW, k, 30, NOW);
    expect(capsStart(lane(), inside[0]!)).toBe(true);
    const entering = wakeSegments(lane(), NOW - 10 * MIN, NOW, k, 30, NOW);
    expect(capsStart(lane(), entering[0]!)).toBe(false);
  });

  it('is one closed outline with a round cap, one colour and one sheen', () => {
    const segments = wakeSegments(lane(), NOW - 60 * MIN, NOW, k, 30, NOW);
    const commands = wakeOutline(segments, 15, true);
    expect(commands.map((command) => command.op)).toEqual(['M', 'A', 'L', 'L', 'Z']);
    expect(wakeGradient(segments, (segment) => segment.status)).toEqual([
      { offset: 0, color: 'working' },
      { offset: 1, color: 'working' },
    ]);
    expect(wakeSheens(segments, 15)).toHaveLength(1);
  });
});

describe('the wake’s shape over a run of states', () => {
  const k = 600 / (60 * MIN);
  const t0 = NOW - 60 * MIN;
  const segments = run(k, t0, [
    ['working', NOW - 60 * MIN, NOW - 30 * MIN],
    ['idle', NOW - 30 * MIN, NOW - 20 * MIN],
    ['blocked', NOW - 20 * MIN, NOW],
  ]);

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
    const tight = run(k, t0, [
      ['working', NOW - 60 * MIN, NOW - 59.9 * MIN],
      ['idle', NOW - 59.9 * MIN, NOW],
    ]);
    expect(neck(tight, 0)).toBeCloseTo(0.5);
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

describe("the wake with the record's past (T3)", () => {
  const k = 600 / (60 * MIN);
  const t0 = NOW - 60 * MIN;
  const ago = (kind: MonitorPastSpan['kind'], from: number, to: number): MonitorPastSpan => ({
    kind,
    from: NOW - from * MIN,
    to: NOW - to * MIN,
  });
  /** Worked, quiet, a silence inside a turn, the bounds alone, worked up to the seam, then working now. */
  const recorded = [
    ago('worked', 55, 45),
    ago('quiet', 45, 40),
    ago('unrecorded', 40, 30),
    ago('bounds', 30, 25),
    ago('worked', 25, 20),
  ];
  const withPast = laneFor(
    agentViewFixture({ id: 'a', createdAt: NOW - 50 * MIN, status: 'working', statusSince: NOW - 20 * MIN }),
    NOW,
    recorded,
  );

  it("draws worked at work's width, quiet at rest's hair, the bounds flat at a thread's, then the current state", () => {
    const segments = wakeSegments(withPast, t0, NOW, k, 30, NOW);
    expect(segments.map((segment) => segment.status)).toEqual(['working', 'idle', 'bounds', 'working', 'working']);
    expect(segments.map((segment) => segment.r)).toEqual([
      wakeRadius('agent', 'working', 30),
      0.85,
      wakeRadius('agent', 'blocked', 30),
      wakeRadius('agent', 'working', 30),
      wakeRadius('agent', 'working', 30),
    ]);
    expect(wakeRadius('agent', 'bounds', 30)).toBeLessThan(wakeRadius('agent', 'working', 30));
    // The current state keeps its own arithmetic: from where it began to the head.
    expect(segments[4]).toMatchObject({ a: NOW - 20 * MIN, b: NOW });
  });

  it('breaks where the record does not cover the lane: a run before the silence, a run after', () => {
    const runs = wakeRuns(wakeSegments(withPast, t0, NOW, k, 30, NOW));
    expect(runs.map((run) => run.map((segment) => segment.status))).toEqual([
      ['working', 'idle'],
      ['bounds', 'working', 'working'],
    ]);
    // Each run starts inside the window, so each is capped; one entering from off-canvas is not.
    expect(runs.every((run) => capsRun(run[0]!))).toBe(true);
    const entering = wakeSegments(withPast, NOW - 50 * MIN, NOW, k, 30, NOW);
    expect(capsRun(entering[0]!)).toBe(false);
  });

  it('cuts the seam where the record runs up to the current state, and none across a gap', () => {
    const segments = wakeSegments(withPast, t0, NOW, k, 30, NOW);
    expect(wakeSeam(withPast, segments)).toEqual({ x: segments[4]!.x0, r: wakeRadius('agent', 'working', 30) });
    // The status moved on since the read: a gap before the current state, which the dotted thread already shows.
    const movedOn = laneFor(
      agentViewFixture({ id: 'a', createdAt: NOW - 50 * MIN, status: 'idle', statusSince: NOW - 15 * MIN }),
      NOW,
      recorded,
    );
    expect(wakeSeam(movedOn, wakeSegments(movedOn, t0, NOW, k, 30, NOW))).toBeUndefined();
    // A lane with no record has no seam.
    expect(wakeSeam(lane(), wakeSegments(lane(), t0, NOW, k, 30, NOW))).toBeUndefined();
  });

  it("lays the dotted thread over every stretch of the lane's life no recorded span covers, a silence included", () => {
    // Born at its record\'s first span (55 min ago); the silence (40–30) is not recorded; the record runs to the seam.
    expect(unrecordedStretches(withPast, t0, NOW)).toEqual([{ a: NOW - 40 * MIN, b: NOW - 30 * MIN }]);
    const born = laneFor(
      agentViewFixture({ id: 'b', createdAt: NOW - 50 * MIN, status: 'working', statusSince: NOW - 10 * MIN }),
      NOW,
      [ago('worked', 30, 20)],
    );
    expect(unrecordedStretches(born, t0, NOW)).toEqual([
      { a: NOW - 50 * MIN, b: NOW - 30 * MIN },
      { a: NOW - 20 * MIN, b: NOW - 10 * MIN },
    ]);
    // Only inside the window asked for.
    expect(unrecordedStretches(born, NOW - 25 * MIN, NOW - 12 * MIN)).toEqual([
      { a: NOW - 20 * MIN, b: NOW - 12 * MIN },
    ]);
  });

  it("ends an ended run's wake at its last activity, with no current state", () => {
    const [ended] = historyLanes({
      sinceMs: NOW - 24 * 60 * MIN,
      untilMs: NOW,
      readAt: NOW,
      fidelity: 'bounds',
      state: 'complete',
      live: [],
      ended: [
        {
          id: 'past:claude:x',
          project: { name: 'notes', seq: 1 },
          device: { id: 'here', name: 'here', self: true },
          startedAt: NOW - 50 * MIN,
          endedAt: NOW - 20 * MIN,
          spans: [ago('bounds', 50, 20)],
          colour: 'teal',
          receded: false,
        },
      ],
    }).ended;
    const segments = wakeSegments(ended!, t0, NOW, k, 30, NOW);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ a: NOW - 50 * MIN, b: NOW - 20 * MIN, status: 'bounds' });
    expect(capsStart(ended!, segments[0]!)).toBe(true);
    expect(unrecordedStretches(ended!, t0, NOW)).toEqual([]);
    expect(wakeSeam(ended!, segments)).toBeUndefined();
  });
});
