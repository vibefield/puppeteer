/**
 * Opt-in proof of Grok's complete adapter-owned composition: the exact native
 * TUI in a PTY, one shared leader, ACP control, durable-log normalization, and
 * resume. Model traffic and user state remain isolated, so the lane needs no
 * credentials or external model access.
 *
 *   GROK_LIVE=1 PUPPETEER_GROK_BIN=/absolute/path/to/grok pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { attestLiveAdapter } from '@vibecook/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { detectGrokInstallation, resolveGrokExecutable } from './detection.js';
import { createGrokBackend } from './driver.js';
import {
  classifyGrokLiveModelRequest,
  GROK_LIVE_MODEL,
  GROK_LIVE_RESPONSE_MARKER,
  isolatedGrokLiveEnvironment,
  startGrokLoopbackProvider,
  writeGrokLiveConfiguration,
} from './test-support/live-model.js';
import { GrokLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.GROK_LIVE === '1';

describe.runIf(live)('Grok adapter through real native TUI (live)', () => {
  it('shares one exact session across leader, ACP, durable observation, TUI, and resume', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-live-')));
    const grokHome = join(root, 'grok-home');
    const cwd = join(root, 'workspace');
    for (const directory of [grokHome, cwd, join(root, 'tmp')]) mkdirSync(directory, { recursive: true });
    const provider = await startGrokLoopbackProvider();
    writeGrokLiveConfiguration(grokHome, provider.baseUrl);
    const environment = isolatedGrokLiveEnvironment(root, grokHome, provider.baseUrl);
    const executable = resolveGrokExecutable();
    const host = new GrokLivePtyHost();
    const backend = createGrokBackend({ executable, host, appServerEnv: environment });
    let session: Awaited<ReturnType<typeof backend.createSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof backend.createSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      const installation = await detectGrokInstallation(executable, { env: environment });
      expect(installation.exactTarget).toBe(true);

      session = await backend.createSession({ cwd, model: GROK_LIVE_MODEL, permissionMode: 'default' });
      projection = projectAgentEvents(session);
      const sessionId = session.sessionId;
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).toEqual(
        expect.arrayContaining(['--model', GROK_LIVE_MODEL, '--leader', '--resume', sessionId]),
      );
      expect(session.observationLevel()).toBe('native-log');

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${GROK_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toEqual({
        status: 'confirmed',
        turnId: expect.any(String),
      });
      try {
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'normalized durable turn completion',
        );
      } catch (cause) {
        const requestSummary = provider.requests.map(({ url, body }) => ({
          url,
          model: body && typeof body === 'object' ? (body as { model?: unknown }).model : undefined,
          kind: classifyGrokLiveModelRequest(body),
        }));
        throw new Error(
          `Grok durable completion diagnostics: requests=${JSON.stringify(requestSummary)} ` +
            `events=${JSON.stringify(projection.envelopes.map(({ event }) => event.type))} ` +
            `tui=${JSON.stringify(host.output(session.runtimeSessionId).slice(-2_000))}`,
          { cause },
        );
      }
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(GROK_LIVE_RESPONSE_MARKER),
        'response in the real native TUI',
      );
      expect(projection.state.lastAssistantMessage).toContain(GROK_LIVE_RESPONSE_MARKER);
      expect(projection.envelopes.some(({ source }) => source === 'native-transcript')).toBe(true);

      const originalRuntimeSessionId = session.runtimeSessionId;
      projection.dispose();
      projection = undefined;
      await session.dispose();
      session = undefined;
      await host.disposeTerminal(originalRuntimeSessionId);

      resumed = await backend.createSession({
        cwd,
        resume: sessionId,
        model: GROK_LIVE_MODEL,
        permissionMode: 'default',
      });
      resumedProjection = projectAgentEvents(resumed);
      expect(resumed.sessionId).toBe(sessionId);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['--resume', sessionId]));
      await waitFor(
        () => (resumedProjection!.state.lastAssistantMessage ?? '').includes(GROK_LIVE_RESPONSE_MARKER),
        'resumed durable history',
      );
      await waitFor(
        () => host.output(resumed!.runtimeSessionId).includes(GROK_LIVE_RESPONSE_MARKER),
        'resumed history in the real native TUI',
      );

      const semanticTurnRequests = provider.requests.filter(
        ({ url, body }) => url?.startsWith('/v1/chat/completions') && classifyGrokLiveModelRequest(body) === 'turn',
      );
      expect(semanticTurnRequests).toHaveLength(1);
      expect(semanticTurnRequests[0]?.body).toMatchObject({ model: GROK_LIVE_MODEL, stream: true });
      expect(
        provider.requests.every(({ url }) =>
          ['/v1/chat/completions', '/v1/responses', '/v1/models'].some((route) => url?.startsWith(route)),
        ),
      ).toBe(true);
      await attestLiveAdapter({ vendor: 'grok', artifact: executable, testId: 'grok:native-tui-leader' });
    } finally {
      resumedProjection?.dispose();
      await resumed?.dispose();
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      backend.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 120_000);
});
