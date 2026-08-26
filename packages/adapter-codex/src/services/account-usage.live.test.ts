/**
 * Read-only opt-in coverage of the real authenticated Codex app-server.
 *
 *   CODEX_ACCOUNT_USAGE_LIVE=1 pnpm exec vitest run src/account-usage.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { fetchCodexAccountUsage } from './account-usage.js';

const live = process.env.CODEX_ACCOUNT_USAGE_LIVE === '1';

describe.skipIf(!live)('Codex account usage (live)', () => {
  it('returns at least one duration-labelled metered window', async () => {
    const result = await fetchCodexAccountUsage({ requestTimeoutMs: 20_000 });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;

    expect(result.snapshot.provider).toBe('codex');
    expect(result.snapshot.metrics.length).toBeGreaterThan(0);
    for (const metric of result.snapshot.metrics) {
      expect(metric.usedPercent).toBeGreaterThanOrEqual(0);
      if (metric.durationMinutes !== undefined) expect(metric.durationMinutes).toBeGreaterThan(0);
      if (metric.resetsAt !== undefined) expect(Number.isFinite(Date.parse(metric.resetsAt))).toBe(true);
    }
  }, 25_000);
});
