/**
 * Opt-in live test — drives the REAL `codex app-server` through the hand-written
 * client + driver (not a scripted transport). Skipped unless CODEX_LIVE=1.
 * Isolated: the exact codex PUPPETEER_CODEX_BIN names, a throwaway HOME and
 * CODEX_HOME, and the loopback Responses endpoint, so no account or model
 * provider is reached (codex's own curated-plugin `git` sync still goes out,
 * findings). Read-only sandbox + approval "never": the turn cannot write,
 * network, or prompt.
 *
 *   CODEX_LIVE=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex pnpm --filter @vibefield/puppeteer-adapter-codex test
 */

import { describe, it, expect, vi } from 'vitest';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { createCodexSession } from './driver.js';
import { CODEX_LIVE_MODEL, CODEX_LIVE_RESPONSE_MARKER } from './test-support/live-model.js';
import { createCodexLiveProfile, requireCodexLiveExecutable } from './test-support/live-profile.js';
import { spawnAppServerTransport } from './transport/app-server-client.js';

const live = process.env.CODEX_LIVE === '1';

describe.skipIf(!live)('createCodexSession (live codex app-server)', () => {
  it('drives a real turn and observes the assistant reply', async () => {
    const executable = requireCodexLiveExecutable('CODEX_LIVE');
    const profile = await createCodexLiveProfile('codex-live-');
    let session: Awaited<ReturnType<typeof createCodexSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      session = await createCodexSession({
        cwd: profile.cwd,
        transport: spawnAppServerTransport({ executable, env: profile.environment }),
        model: CODEX_LIVE_MODEL,
        sandbox: 'read-only',
        approvalPolicy: 'never',
      });
      projection = projectAgentEvents(session);
      expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);
      expect(session.observationLevel()).toBe('structured');

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${CODEX_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt.status).toBe('confirmed');

      // Wait for the turn to complete via the observed event stream.
      await vi.waitFor(
        () =>
          expect(
            projection!.envelopes.some(({ event }) => event.type === 'turn:completed' || event.type === 'turn:failed'),
          ).toBe(true),
        { timeout: 60_000, interval: 50 },
      );

      expect(projection.state.lastAssistantMessage).toContain(CODEX_LIVE_RESPONSE_MARKER);
      expect(session.threadPath()).toContain(profile.codexHome);
      expect(profile.provider!.requests.filter(({ kind }) => kind === 'turn')).toHaveLength(1);
      await attestLiveAdapter({ vendor: 'codex', artifact: executable, testId: 'codex:app-server' });
    } finally {
      projection?.dispose();
      await session?.dispose();
      await profile.dispose();
    }
  }, 70_000);
});
