/**
 * Opt-in live test — the full C6 transport foundation against the REAL
 * `codex app-server`: spawn its platform-local endpoint, connect the normalized
 * transport, and drive createCodexSession through it. Skipped unless
 * CODEX_LIVE=1.
 *
 *   CODEX_LIVE=1 pnpm --filter @vibecook/puppeteer-adapter-codex test
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { createCodexSession } from '../driver.js';
import { spawnAppServer } from './app-server-process.js';
import { connectAppServerEndpoint } from './ws-transport.js';

const live = process.env.CODEX_LIVE === '1';

describe.skipIf(!live)('createCodexSession over a local WebSocket (live app-server)', () => {
  it('spawns a platform-local app-server and drives a real turn over WebSocket', async () => {
    const server = spawnAppServer();
    await server.ready();
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'codex-uds-'));

    const session = await createCodexSession({
      cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      transport: connectAppServerEndpoint(server.endpoint()),
    });
    const projection = projectAgentEvents(session);
    try {
      expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);
      expect(session.observationLevel()).toBe('structured');
      expect(session.threadPath()).toContain('.codex/sessions/');

      const receipt = await session.services.prompt.submit({
        text: 'Reply with exactly the single word: pong. Do not run any commands or use any tools.',
      });
      expect(receipt.status).toBe('confirmed');

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no turn:completed within 60s')), 60_000);
        session.events.onCandidate((e) => {
          if (e.event.type === 'turn:completed' || e.event.type === 'turn:failed') {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      expect(projection.state.lastAssistantMessage?.toLowerCase()).toContain('pong');
    } finally {
      projection.dispose();
      await session.dispose();
      await server.dispose();
    }
  }, 70_000);
});
