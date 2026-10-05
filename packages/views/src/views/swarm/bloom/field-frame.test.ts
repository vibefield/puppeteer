import { describe, expect, it } from 'vitest';
import { agentViewFixture } from '@vibecook/puppeteer-view-sdk/testing';
import { approximateBloomMeasure } from './canvas-measure.js';
import { BLOOM } from './constants.js';
import {
  approach,
  arrivalFrom,
  bloomFieldMemory,
  departure,
  stepBloomField,
  stepLit,
  veiledOpacity,
  type BloomFieldMemory,
} from './field-frame.js';
import { cancelBloom, commitBloom, isInstant, openBloom, pointBloom, type BloomEnv, type BloomState } from './model.js';
import { BLOOM_SCENARIOS } from './scenarios.js';

const env = (now = 1000): BloomEnv => ({ field: { w: 1000, h: 600 }, measure: approximateBloomMeasure, now });
const P = { x: 500, y: 350 };

function open(id: keyof typeof BLOOM_SCENARIOS = 'two'): BloomState {
  const opened = openBloom(env(), P, 'hold', BLOOM_SCENARIOS[id]);
  if (isInstant(opened)) throw new Error('expected a bloom');
  return opened;
}

/** Run the field for `ms` at 60 fps. */
function run(memory: BloomFieldMemory, state: BloomState | null, ms: number, from = 0, closedAt = 0) {
  let frame = stepBloomField(memory, { state, closedAt, now: from, dtMs: 0, reduced: false });
  for (let t = 16; t <= ms; t += 16) {
    frame = stepBloomField(memory, { state, closedAt, now: from + t, dtMs: 16, reduced: false });
  }
  return frame;
}

describe('the prototype’s ease', () => {
  it('goes 1 − exp(−dt/τ) of the way, snaps the last 0.004, and arrives at once under reduced motion', () => {
    expect(approach(0, 1, 60, 60)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(approach(0.997, 1, 16, 60)).toBe(1);
    expect(approach(0, 0.8, 16, 60, true)).toBe(0.8);
  });
});

describe('the field under a bloom', () => {
  it('veils the field while the bloom is open and lifts the veil once it closes', () => {
    const memory = bloomFieldMemory();
    const s = open();
    expect(run(memory, s, 400).veil).toBeCloseTo(BLOOM.veil, 2);
    const closed = cancelBloom(env(1500), s);
    expect(run(memory, closed, 400, 2000, 2000).veil).toBe(0);
  });

  it('clears the ground under ring one, ring two and the words, fading each in', () => {
    const memory = bloomFieldMemory();
    const s = open();
    const first = stepBloomField(memory, { state: s, closedAt: 0, now: 0, dtMs: 16, reduced: false });
    expect(first.clearings.map((c) => c.clearing.kind)).toEqual(['circle', 'rect']);
    expect(first.clearings[0]?.opacity).toBeGreaterThan(0);
    expect(first.clearings[0]?.opacity).toBeLessThan(1);
    // reach mini: its ring's clearing joins
    const mini = s.l1.find((b) => b.item.device.id === 'mini');
    if (!mini) throw new Error('no mini');
    const reached = pointBloom(env(1100), s, { x: P.x + (mini.x - P.x) * 1.02, y: P.y + (mini.y - P.y) * 1.02 });
    const frame = run(memory, reached, 400);
    expect(frame.clearings).toHaveLength(3);
    expect(frame.clearings.every((c) => c.opacity === 1)).toBe(true);
  });

  it('after a commit keeps only the words’ clearing, for sayHold, then fades it', () => {
    const memory = bloomFieldMemory();
    const s = open('one-three');
    run(memory, s, 300);
    const demo = s.l1.find((b) => b.item.profile?.id === 'demo');
    if (!demo) throw new Error('no demo');
    const done = commitBloom(env(1300), pointBloom(env(1300), s, { x: demo.x, y: demo.y })).state;
    const held = run(memory, done, 300, 5000, 5000);
    expect(held.clearings.map((c) => c.clearing.kind)).toEqual(['rect']);
    expect(held.clearings[0]?.opacity).toBe(1);
    const gone = run(memory, done, 400, 5000 + BLOOM.sayHold, 5000);
    expect(gone.clearings).toEqual([]);
  });

  it('lights what it points at and nothing once closed', () => {
    const memory = bloomFieldMemory();
    const s = open('one-three');
    const work = s.l1.find((b) => b.item.profile?.id === 'work');
    if (!work) throw new Error('no work');
    const pointing = pointBloom(env(1100), s, { x: work.x, y: work.y });
    const row = agentViewFixture({ id: 'r', profileSet: 'work' });
    expect(run(memory, pointing, 16).lit(row)).toBe(true);
    expect(run(memory, cancelBloom(env(1200), pointing), 16).lit(row)).toBe(false);
  });
});

describe('a body under the veil', () => {
  it('rises above the veil over ~70ms and sinks back, forgotten at 0', () => {
    const memory = bloomFieldMemory();
    let lit = 0;
    for (let t = 0; t < 400; t += 16) lit = stepLit(memory, 'a', true, 16, false);
    expect(lit).toBe(1);
    for (let t = 0; t < 600; t += 16) lit = stepLit(memory, 'a', false, 16, false);
    expect(lit).toBe(0);
    expect(memory.lit.has('a')).toBe(false);
  });

  it('keeps its own opacity lit, and the veil’s share unlit', () => {
    expect(veiledOpacity(1, 0.8, 0)).toBeCloseTo(0.2, 6);
    expect(veiledOpacity(1, 0.8, 1)).toBe(1);
    expect(veiledOpacity(0.5, 0, 0)).toBe(0.5);
  });
});

describe('a birth', () => {
  it('from nothing is the swarm’s own arrival; from a bud it is whole at once and grows on', () => {
    expect(arrivalFrom(0, 0, 720)).toEqual({ scale: 0, opacity: 0 });
    expect(arrivalFrom(720 * 0.52, 0, 720).scale).toBeCloseTo(1.2, 6);
    expect(arrivalFrom(720, 0, 720)).toEqual({ scale: 1, opacity: 1 });
    const from = (48 * BLOOM.hot) / 100;
    expect(arrivalFrom(0, from, 720)).toEqual({ scale: from, opacity: 1 });
    expect(arrivalFrom(10, from, 720).scale).toBeGreaterThan(from);
    expect(arrivalFrom(10, from, 720).opacity).toBe(1);
  });

  it('that never came shrinks away over the retract', () => {
    expect(departure(0)).toEqual({ scale: 1, opacity: 1 });
    expect(departure(BLOOM.retract).scale).toBe(0);
  });
});
