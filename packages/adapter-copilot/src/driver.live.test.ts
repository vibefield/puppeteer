/** Complete native-TUI and durable-journal resume proof against the acquired Copilot executable. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { createCopilotTuiSession } from './driver.js';
import { detectCopilotInstallation, resolveCopilotExecutable } from './detection.js';
import { waitFor } from './test-support/live-harness.js';
import { CopilotLivePtyHost } from './test-support/live-pty-host.js';
import {
  isolatedCopilotLiveEnvironment,
  COPILOT_LIVE_MODEL,
  COPILOT_LIVE_RESPONSE_MARKER,
  startCopilotLoopbackProvider,
} from './test-support/live-model.js';

describe.runIf(process.env.COPILOT_LIVE === '1')('Copilot adapter through the real native TUI (live)', () => {
  it('submits one native turn and resumes its exact durable session', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-copilot-live-')));
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    mkdirSync(cwd, { recursive: true });
    const provider = await startCopilotLoopbackProvider();
    const env = isolatedCopilotLiveEnvironment(root, agentDir, provider.baseUrl);
    const executable = resolveCopilotExecutable();
    const host = new CopilotLivePtyHost();
    let session: Awaited<ReturnType<typeof createCopilotTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect(await detectCopilotInstallation(executable, { env })).toMatchObject({
        exactTarget: true,
        version: '1.0.105',
      });
      session = await createCopilotTuiSession({
        cwd,
        host,
        executable,
        env,
        copilotHome: agentDir,
        model: COPILOT_LIVE_MODEL,
        pollIntervalMs: 25,
      });
      projection = projectAgentEvents(session);
      const sessionId = session.sessionId;
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).toEqual(expect.arrayContaining(['--session-id', sessionId]));
      expect(
        await session.services.prompt.submit({ text: `Reply exactly ${COPILOT_LIVE_RESPONSE_MARKER}.` }),
      ).toMatchObject({ status: 'confirmed' });
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'normalized Copilot turn completion',
      );
      expect(projection.state.lastAssistantMessage).toContain(COPILOT_LIVE_RESPONSE_MARKER);
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(COPILOT_LIVE_RESPONSE_MARKER),
        'response in the native Copilot TUI',
      );
      expect(session.durableRecordSeen()).toBe(true);
      expect(session.observationLevel()).toBe('native-log');
      projection.dispose();
      projection = undefined;
      await host.disposeTerminal(session.runtimeSessionId);
      await session.dispose();
      session = undefined;
      session = await createCopilotTuiSession({
        cwd,
        host,
        executable,
        env,
        copilotHome: agentDir,
        resume: sessionId,
        pollIntervalMs: 25,
      });
      projection = projectAgentEvents(session);
      expect(session.sessionId).toBe(sessionId);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining([`--resume=${sessionId}`]));
      await waitFor(
        () => (projection!.state.lastAssistantMessage ?? '').includes(COPILOT_LIVE_RESPONSE_MARKER),
        'resumed Copilot journal history',
      );
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(COPILOT_LIVE_RESPONSE_MARKER),
        'resumed history in native Copilot TUI',
      );
      expect(projection.envelopes.some(({ replay, source }) => replay && source === 'native-log')).toBe(true);
      expect(provider.requests).toHaveLength(1);
      await attestLiveAdapter({
        vendor: 'copilot',
        artifact: executable,
        testId: 'copilot:native-tui-journal',
      });
    } catch (cause) {
      throw new Error(
        `Copilot live: events=${JSON.stringify(projection?.envelopes.map(({ event }) => event.type))} tui=${JSON.stringify(session ? host.output(session.runtimeSessionId).slice(-5000) : '')}`,
        { cause },
      );
    } finally {
      projection?.dispose();
      if (session) await host.disposeTerminal(session.runtimeSessionId);
      await session?.dispose();
      await host.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 150_000);
});
