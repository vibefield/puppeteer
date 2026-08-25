import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MONITOR_FRESHNESS_POLICY,
  classifyMonitorFamilyFreshness,
  classifyMonitorRecency,
} from './freshness.js';

const NOW = Date.parse('2026-08-16T12:00:30.000Z');

describe('monitor freshness', () => {
  it('uses one injected-clock threshold policy', () => {
    expect(DEFAULT_MONITOR_FRESHNESS_POLICY).toEqual({ staleAfterMs: 30_000 });
    expect(classifyMonitorRecency('2026-08-16T12:00:00.000Z', NOW)).toEqual({
      recency: 'fresh',
      ageMs: 30_000,
    });
    expect(classifyMonitorRecency('2026-08-16T11:59:59.999Z', NOW)).toEqual({
      recency: 'stale',
      ageMs: 30_001,
    });
  });

  it('keeps unsupported, degraded, stale, and unknown concepts honest', () => {
    expect(classifyMonitorFamilyFreshness(undefined, NOW)).toEqual({
      support: 'unknown',
      availability: 'unknown',
      recency: 'unknown',
    });
    expect(classifyMonitorFamilyFreshness({ support: 'unsupported' }, NOW)).toEqual({
      support: 'unsupported',
      availability: 'unavailable',
      recency: 'unknown',
    });
    expect(classifyMonitorFamilyFreshness({ support: 'degraded', asOf: '2026-08-16T11:59:00.000Z' }, NOW)).toEqual({
      support: 'degraded',
      availability: 'available',
      recency: 'stale',
      ageMs: 90_000,
    });
    expect(
      classifyMonitorFamilyFreshness(
        { support: 'supported', availability: 'partial', asOf: '2026-08-16T12:00:20.000Z' },
        NOW,
      ),
    ).toMatchObject({ support: 'supported', availability: 'partial', recency: 'fresh' });
  });

  it('treats invalid timestamps and clocks as unknown and future skew as age zero', () => {
    expect(classifyMonitorRecency('not-a-date', NOW)).toEqual({ recency: 'unknown' });
    expect(classifyMonitorRecency('2026-08-16T12:01:00.000Z', NOW)).toEqual({ recency: 'fresh', ageMs: 0 });
    expect(classifyMonitorRecency('2026-08-16T12:00:00.000Z', Number.NaN)).toEqual({ recency: 'unknown' });
  });

  it('rejects an invalid shared policy', () => {
    expect(() => classifyMonitorRecency('2026-08-16T12:00:00.000Z', NOW, { staleAfterMs: -1 })).toThrow(RangeError);
  });
});
