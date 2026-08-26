/**
 * Read-only opt-in coverage of the locally authenticated Claude Code account.
 *
 *   CLAUDE_ACCOUNT_USAGE_LIVE=1 pnpm exec vitest run src/account-usage.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { fetchClaudeAccountUsage } from './account-usage.js';

const live = process.env.CLAUDE_ACCOUNT_USAGE_LIVE === '1';

describe.skipIf(!live)('Claude account usage (live)', () => {
  it('returns subscription windows without exposing credentials', async () => {
    const result = await fetchClaudeAccountUsage();
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;

    expect(result.snapshot.provider).toBe('claude');
    expect(result.snapshot.metrics.some((metric) => metric.label === '5H')).toBe(true);
    expect(result.snapshot.metrics.some((metric) => metric.label === '7D')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Bearer|access[_-]?token/i);
  }, 15_000);
});
