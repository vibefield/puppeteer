/**
 * Opt-in live test — the full C6 transport foundation against the REAL
 * `codex app-server`: spawn its platform-local endpoint, connect the normalized
 * transport, and drive createCodexSession through it. Skipped unless
 * CODEX_LIVE=1. Isolated: the exact codex PUPPETEER_CODEX_BIN names, a
 * throwaway HOME and CODEX_HOME, and the loopback Responses endpoint, so no
 * account or model provider is reached (codex's own curated-plugin `git` sync
 * still goes out, findings).
 *
 *   CODEX_LIVE=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex pnpm --filter @vibefield/puppeteer-adapter-codex test
 */

import { describe, it, expect, vi } from 'vitest';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { createCodexSession } from '../driver.js';
import { CODEX_LIVE_MODEL, CODEX_LIVE_RESPONSE_MARKER } from '../test-support/live-model.js';
import { createCodexLiveProfile, requireCodexLiveExecutable } from '../test-support/live-profile.js';
import { spawnAppServer } from './app-server-process.js';
import { connectAppServerEndpoint } from './ws-transport.js';

const live = process.env.CODEX_LIVE === '1';

describe.skipIf(!live)('createCodexSession over a local WebSocket (live app-server)', () => {
  it('spawns a platform-local app-server and drives a real turn over WebSocket', async () => {
    const executable = requireCodexLiveExecutable('CODEX_LIVE');
    const profile = await createCodexLiveProfile('codex-uds-');
    const server = spawnAppServer({ executable, env: profile.environment });
    let session: Awaited<ReturnType<typeof createCodexSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      await server.ready();
      session = await createCodexSession({
        cwd: profile.cwd,
        model: CODEX_LIVE_MODEL,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        transport: connectAppServerEndpoint(server.endpoint()),
      });
      projection = projectAgentEvents(session);
      expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);
      expect(session.observationLevel()).toBe('structured');
      expect(session.threadPath()).toContain(profile.codexHome);

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${CODEX_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt.status).toBe('confirmed');

      await vi.waitFor(
        () =>
          expect(
            projection!.envelopes.some(({ event }) => event.type === 'turn:completed' || event.type === 'turn:failed'),
          ).toBe(true),
        { timeout: 60_000, interval: 50 },
      );

      expect(projection.state.lastAssistantMessage).toContain(CODEX_LIVE_RESPONSE_MARKER);
    } finally {
      projection?.dispose();
      await session?.dispose();
      await server.dispose();
      await profile.dispose();
    }
  }, 70_000);
});
