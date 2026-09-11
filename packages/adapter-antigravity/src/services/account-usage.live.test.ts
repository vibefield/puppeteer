/**
 * Read-only opt-in coverage of the locally authenticated Antigravity account.
 *
 *   ANTIGRAVITY_ACCOUNT_USAGE_LIVE=1 pnpm exec vitest run src/services/account-usage.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { fetchAntigravityAccountUsage } from './account-usage.js';

const live = process.env.ANTIGRAVITY_ACCOUNT_USAGE_LIVE === '1';

describe.skipIf(!live)('Antigravity account usage (live)', () => {
  it('returns at least one duration-labelled metered window', async () => {
    const result = await fetchAntigravityAccountUsage({ timeoutMs: 20_000 });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;

    expect(result.snapshot.provider).toBe('antigravity');
    expect(result.snapshot.metrics.length).toBeGreaterThan(0);
    expect(result.snapshot.metrics.some((metric) => metric.label === '5H' || metric.label === '7D')).toBe(true);
    for (const metric of result.snapshot.metrics) {
      expect(metric.usedPercent).toBeGreaterThanOrEqual(0);
      if (metric.durationMinutes !== undefined) expect(metric.durationMinutes).toBeGreaterThan(0);
      if (metric.resetsAt !== undefined) expect(Number.isFinite(Date.parse(metric.resetsAt))).toBe(true);
    }
    expect(JSON.stringify(result)).not.toMatch(/Bearer|access[_-]?token/i);
  }, 25_000);
});
