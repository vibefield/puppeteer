/**
 * Opt-in proof of OpenCode's complete adapter-owned composition: the exact
 * private backend and session, structured prompt control, HTTP/SSE observation,
 * the real native TUI in a PTY, and native resume. Model traffic and user state
 * remain isolated, so the lane needs no credentials or external model access.
 *
 *   OPENCODE_LIVE=1 PUPPETEER_OPENCODE_BIN=/absolute/path/to/opencode pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { attestLiveAdapter } from '@vibecook/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { probeOpenCodeVersion, resolveOpenCodeExecutable } from './detection.js';
import { createOpenCodeTuiSession } from './driver.js';
import { waitFor } from './test-support/live-harness.js';
import {
  isolatedOpenCodeLiveEnvironment,
  OPENCODE_LIVE_MODEL,
  OPENCODE_LIVE_RESPONSE_MARKER,
  startOpenCodeLoopbackProvider,
} from './test-support/live-model.js';
import { OpenCodeLivePtyHost } from './test-support/live-pty-host.js';

const live = process.env.OPENCODE_LIVE === '1';

describe.runIf(live)('OpenCode adapter through real native TUI (live)', () => {
  it('shares one exact session across private backend, HTTP/SSE, native TUI, and resume', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-opencode-live-')));
    const cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const provider = await startOpenCodeLoopbackProvider();
    const environment = isolatedOpenCodeLiveEnvironment(root, provider.baseUrl);
    const executable = resolveOpenCodeExecutable();
    const host = new OpenCodeLivePtyHost();
    let session: Awaited<ReturnType<typeof createOpenCodeTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof createOpenCodeTuiSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect(await probeOpenCodeVersion(executable)).toBe('1.18.16');
      session = await createOpenCodeTuiSession({
        cwd,
        host,
        executable,
        env: environment,
        title: 'Puppeteer Native TUI Proof',
        model: { providerID: 'test', modelID: OPENCODE_LIVE_MODEL },
        permission: [{ permission: '*', pattern: '*', action: 'allow' }],
        promptConfirmationTimeoutMs: 30_000,
      });
      projection = projectAgentEvents(session);
      const sessionId = session.sessionId;
      expect(sessionId).toMatch(/^ses_/);
      expect(session.observationLevel()).toBe('structured');
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).toEqual(expect.arrayContaining(['attach', '--session', sessionId]));

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${OPENCODE_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({ status: 'confirmed' });
      try {
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'normalized OpenCode turn completion',
        );
        await waitFor(
          () => host.output(session!.runtimeSessionId).includes(OPENCODE_LIVE_RESPONSE_MARKER),
          'response in the real native TUI',
        );
      } catch (cause) {
        throw new Error(
          `OpenCode native-TUI diagnostics: events=${JSON.stringify(projection.envelopes.map(({ event }) => event.type))} ` +
            `requests=${JSON.stringify(provider.requests)} ` +
            `tui=${JSON.stringify(host.output(session.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(projection.state.lastAssistantMessage).toContain(OPENCODE_LIVE_RESPONSE_MARKER);

      const originalRuntimeSessionId = session.runtimeSessionId;
      projection.dispose();
      projection = undefined;
      await host.disposeTerminal(originalRuntimeSessionId);
      await session.dispose();
      session = undefined;

      resumed = await createOpenCodeTuiSession({
        cwd,
        host,
        executable,
        env: environment,
        resume: sessionId,
        promptConfirmationTimeoutMs: 30_000,
      });
      resumedProjection = projectAgentEvents(resumed);
      expect(resumed.sessionId).toBe(sessionId);
      expect(resumed.observationLevel()).toBe('structured');
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['attach', '--session', sessionId]));
      try {
        await waitFor(
          () => (resumedProjection!.state.lastAssistantMessage ?? '').includes(OPENCODE_LIVE_RESPONSE_MARKER),
          'resumed normalized HTTP history',
        );
        await waitFor(
          () => host.output(resumed!.runtimeSessionId).includes(OPENCODE_LIVE_RESPONSE_MARKER),
          'resumed history in the real native TUI',
        );
      } catch (cause) {
        throw new Error(
          `OpenCode resume diagnostics: events=${JSON.stringify(
            resumedProjection.envelopes.map(({ event, source, replay }) => ({ type: event.type, source, replay })),
          )} requests=${JSON.stringify(provider.requests)} ` +
            `tui=${JSON.stringify(host.output(resumed.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(resumedProjection.envelopes.some(({ source, replay }) => source === 'native-protocol' && replay)).toBe(
        true,
      );
      expect(provider.requests.filter(({ url }) => url?.startsWith('/v1/chat/completions'))).toHaveLength(1);
      await attestLiveAdapter({ vendor: 'opencode', artifact: executable, testId: 'opencode:native-tui-wire' });
    } finally {
      resumedProjection?.dispose();
      if (resumed) await host.disposeTerminal(resumed.runtimeSessionId);
      await resumed?.dispose();
      projection?.dispose();
      if (session) await host.disposeTerminal(session.runtimeSessionId);
      await session?.dispose();
      await host.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 120_000);
});
