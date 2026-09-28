import { describe, expect, it } from 'vitest';
import { EventIdSet, withEventId } from './event-id-set.js';

describe('persistent monitor event IDs', () => {
  it('keeps exact deduplication and insertion order without changing older snapshots', () => {
    let ids = new EventIdSet();
    const expected = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const value = String((i * 7919) % 20_000);
      ids = ids.add(value);
      expected.add(value);
    }
    expect(ids.size).toBe(20_000);
    expect([...ids]).toEqual([...expected]);
    for (const id of expected) expect(ids.has(id)).toBe(true);
    expect(ids.has('missing')).toBe(false);
    expect(ids.add('0')).toBe(ids);
    const branch = ids.add('branch');
    expect(ids.has('branch')).toBe(false);
    expect(branch.has('branch')).toBe(true);
    expect([...branch].at(-1)).toBe('branch');
  });
  it('accepts a restored native Set and supports the readonly Set contract', () => {
    const old = new Set(['b', 'a']);
    const next = withEventId(old, 'c');
    expect([...old]).toEqual(['b', 'a']);
    expect([...next.keys()]).toEqual(['b', 'a', 'c']);
    expect([...next.entries()]).toEqual([
      ['b', 'b'],
      ['a', 'a'],
      ['c', 'c'],
    ]);
    const values: string[] = [];
    next.forEach((value, key, set) => {
      expect(key).toBe(value);
      expect(set).toBe(next);
      values.push(value);
    });
    expect(values).toEqual(['b', 'a', 'c']);
  });
});
