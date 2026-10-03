import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCount,
  formatElapsed,
  formatEstimate,
  formatPercent,
  formatRatePerHour,
  formatShort,
  formatTokens,
  formatUsd,
  formatWords,
} from './format.js';

describe('money', () => {
  it('keeps a small estimate distinct from a known zero', () => {
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0004)).toBe('<$0.001');
    expect(formatUsd(0.0042)).toBe('$0.004');
    expect(formatUsd(7.034)).toBe('$7.03');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('prints an estimate with a tilde, a plus while partly priced, and a dash with no price lane', () => {
    expect(formatEstimate({ usd: 7.034, coverage: 'complete' })).toBe('~$7.03');
    expect(formatEstimate({ usd: 7.034, coverage: 'partial' })).toBe('~$7.03+');
    expect(formatEstimate({ usd: 0, coverage: 'unavailable' })).toBe('—');
    expect(formatEstimate(undefined)).toBe('—');
  });

  it('prices a burn by the hour', () => {
    expect(formatRatePerHour(undefined)).toBe('—/hr');
    expect(formatRatePerHour(12.4)).toBe('$12/hr');
    expect(formatRatePerHour(1.54)).toBe('$1.5/hr');
    expect(formatRatePerHour(0.45)).toBe('$0.45/hr');
    expect(formatRatePerHour(0.0042)).toBe('$0.004/hr');
  });
});

describe('lengths of time', () => {
  it('counts elapsed time to the second, then hours, then days', () => {
    expect(formatElapsed(-5)).toBe('0:00');
    expect(formatElapsed(279_000)).toBe('4:39');
    expect(formatElapsed(7_500_000)).toBe('2h 05m');
    expect(formatElapsed(97_380_000)).toBe('1d 03h');
  });

  it("keeps the swarm's day-less form on request", () => {
    expect(formatElapsed(97_380_000, { days: false })).toBe('27h 03m');
    expect(formatElapsed(279_000, { days: false })).toBe('4:39');
  });

  it('prints a compact length', () => {
    expect(formatShort(45_000)).toBe('45s');
    expect(formatShort(660_000)).toBe('11m');
    expect(formatShort(8_040_000)).toBe('2h 14m');
    expect(formatShort(7_200_000)).toBe('2h');
  });

  it('says a length in words', () => {
    expect(formatWords(20_000)).toBe('under a minute');
    expect(formatWords(60_000)).toBe('1 minute');
    expect(formatWords(3_840_000)).toBe('1 hour 4 minutes');
    expect(formatWords(7_200_000)).toBe('2 hours');
  });

  it('reads the local wall clock', () => {
    const at = new Date(2026, 9, 3, 14, 5, 9).getTime();
    expect(formatClock(at)).toBe('14:05');
    expect(formatClock(at, true)).toBe('14:05:09');
  });
});

describe('counts', () => {
  it('groups a whole count', () => {
    expect(formatCount(1204.4)).toBe('1,204');
  });

  it('compacts a token count', () => {
    expect([820, 8100, 24_000, 384_400, 1_200_000, 24_000_000].map(formatTokens)).toEqual([
      '820',
      '8.1k',
      '24k',
      '384k',
      '1.2M',
      '24M',
    ]);
  });

  it('floors a share, and says what it was told when there is none', () => {
    expect(formatPercent(42.9)).toBe('42%');
    expect(formatPercent(undefined)).toBe('—');
    expect(formatPercent(Number.NaN, '--')).toBe('--');
  });
});
