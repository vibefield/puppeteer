/**
 * Read-only opt-in coverage of the locally authenticated Grok Build account.
 *
 *   GROK_ACCOUNT_USAGE_LIVE=1 pnpm exec vitest run src/services/account-usage.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { fetchGrokAccountUsage } from './account-usage.js';

const live = process.env.GROK_ACCOUNT_USAGE_LIVE === '1';

describe.skipIf(!live)('Grok account usage (live)', () => {
  it('returns the weekly SuperGrok window without exposing credentials', async () => {
    const result = await fetchGrokAccountUsage({ requestTimeoutMs: 20_000 });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;

    expect(result.snapshot.provider).toBe('grok');
    expect(result.snapshot.source).toEqual({ kind: 'native-protocol', stability: 'experimental' });
    expect(result.snapshot.metrics.some((metric) => metric.label === '7D')).toBe(true);
    for (const metric of result.snapshot.metrics) {
      expect(metric.usedPercent).toBeGreaterThanOrEqual(0);
      if (metric.durationMinutes !== undefined) expect(metric.durationMinutes).toBeGreaterThan(0);
      if (metric.resetsAt !== undefined) expect(Number.isFinite(Date.parse(metric.resetsAt))).toBe(true);
    }
    expect(JSON.stringify(result)).not.toMatch(/Bearer|access[_-]?token|auth\.json/i);
  }, 25_000);
});
