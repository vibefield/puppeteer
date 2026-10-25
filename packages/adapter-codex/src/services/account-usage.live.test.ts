/**
 * Opt-in coverage of the exact codex PUPPETEER_CODEX_BIN names, in a throwaway HOME and CODEX_HOME that
 * hold no account: what the real app-server answers `account/rateLimits/read` with is read as the typed
 * unauthenticated outcome, not a failure. An authenticated read needs a real account, which a live test
 * never borrows (findings, Known gaps).
 *
 *   CODEX_ACCOUNT_USAGE_LIVE=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex \
 *     pnpm exec vitest run src/services/account-usage.live.test.ts
 */

import { describe, expect, it } from 'vitest';
import { createCodexLiveProfile, requireCodexLiveExecutable } from '../test-support/live-profile.js';
import { fetchCodexAccountUsage } from './account-usage.js';

const live = process.env.CODEX_ACCOUNT_USAGE_LIVE === '1';

describe.skipIf(!live)('Codex account usage (live)', () => {
  it('reports a profile without an account as unauthenticated', async () => {
    const executable = requireCodexLiveExecutable('CODEX_ACCOUNT_USAGE_LIVE');
    const profile = await createCodexLiveProfile('codex-usage-', 'none');
    try {
      const result = await fetchCodexAccountUsage({
        executable,
        env: profile.environment,
        requestTimeoutMs: 20_000,
      });
      expect(result).toEqual({
        status: 'unauthenticated',
        provider: 'codex',
        message: 'Codex is not authenticated with a supported account',
        retryable: false,
      });
    } finally {
      await profile.dispose();
    }
  }, 25_000);
});
