import { describe, expect, it } from 'vitest';
import { freezeJson, sameJson } from './json.js';

describe('sameJson', () => {
  it('compares what a transport would carry, not object identity', () => {
    const value = { id: 'a', project: { name: 'alpha', seq: 2 }, cost: { usd: 1.25, series: { steps: [0, 1, 2] } } };
    expect(sameJson(value, JSON.parse(JSON.stringify(value)))).toBe(true);
    expect(sameJson(value, { ...value, cost: { usd: 1.25, series: { steps: [0, 1, 3] } } })).toBe(false);
    expect(sameJson(value, { ...value, extra: true })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson('1', 1)).toBe(false);
  });

  it('reads a property holding undefined as an absent one, and NaN as itself', () => {
    expect(sameJson({ id: 'a', branch: undefined }, { id: 'a' })).toBe(true);
    expect(sameJson({ id: 'a' }, { id: 'a', branch: undefined })).toBe(true);
    expect(sameJson({ id: 'a', branch: null }, { id: 'a' })).toBe(false);
    expect(sameJson({ at: Number.NaN }, { at: Number.NaN })).toBe(true);
    expect(sameJson(0, Number.NaN)).toBe(false);
  });
});

describe('freezeJson', () => {
  it('freezes the whole tree, below an already frozen parent too', () => {
    const inner = { steps: [1, 2] };
    const tree = Object.freeze({ cost: { series: inner } });
    expect(freezeJson(tree)).toBe(tree);
    expect(Object.isFrozen(tree.cost)).toBe(true);
    expect(Object.isFrozen(inner)).toBe(true);
    expect(Object.isFrozen(inner.steps)).toBe(true);
    expect(freezeJson('text')).toBe('text');
  });
});
