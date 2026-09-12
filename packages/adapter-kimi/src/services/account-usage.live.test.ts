/**
 * Read-only opt-in coverage of the locally authenticated Kimi Code account.
 *
 *   KIMI_ACCOUNT_USAGE_LIVE=1 pnpm exec vitest run src/services/account-usage.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { fetchKimiAccountUsage } from './account-usage.js';

const live = process.env.KIMI_ACCOUNT_USAGE_LIVE === '1';

describe.skipIf(!live)('Kimi account usage (live)', () => {
  it('returns a typed snapshot without exposing credentials', async () => {
    const result = await fetchKimiAccountUsage({ timeoutMs: 15_000 });
    expect(['available', 'unauthenticated']).toContain(result.status);
    if (result.status === 'available') {
      expect(result.snapshot.provider).toBe('kimi');
      expect(result.snapshot.metrics.length + (result.snapshot.credits ? 1 : 0)).toBeGreaterThan(0);
      for (const metric of result.snapshot.metrics) {
        expect(metric.usedPercent).toBeGreaterThanOrEqual(0);
      }
    }
    expect(JSON.stringify(result)).not.toMatch(/Bearer|access[_-]?token/i);
  }, 20_000);
});
