/** Complete native-TUI and durable-journal resume proof against the acquired Pi release bundle. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { createPiTuiSession } from './driver.js';
import { detectPiInstallation, resolvePiExecutable } from './detection.js';
import { waitFor } from './test-support/live-harness.js';
import { PiLivePtyHost } from './test-support/live-pty-host.js';
import {
  isolatedPiLiveEnvironment,
  PI_LIVE_MODEL,
  PI_LIVE_RESPONSE_MARKER,
  startPiLoopbackProvider,
} from './test-support/live-model.js';

describe.runIf(process.env.PI_LIVE === '1')('Pi adapter through the real native TUI (live)', () => {
  it('submits one native turn and resumes its exact durable session', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-pi-live-')));
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    mkdirSync(cwd, { recursive: true });
    const provider = await startPiLoopbackProvider();
    const env = isolatedPiLiveEnvironment(root, agentDir, provider.baseUrl);
    const executable = resolvePiExecutable();
    const promotionArtifact = process.env.PUPPETEER_LIVE_ARTIFACT ?? executable;
    const host = new PiLivePtyHost();
    let session: Awaited<ReturnType<typeof createPiTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect(await detectPiInstallation(executable, { env })).toMatchObject({ exactTarget: true, version: '1.5.0' });
      session = await createPiTuiSession({
        cwd,
        host,
        executable,
        env,
        piAgentDir: agentDir,
        provider: 'mock',
        model: PI_LIVE_MODEL,
        pollIntervalMs: 25,
      });
      projection = projectAgentEvents(session);
      const sessionId = session.sessionId;
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).toEqual(expect.arrayContaining(['--session-id', sessionId]));
      expect(await session.services.prompt.submit({ text: `Reply exactly ${PI_LIVE_RESPONSE_MARKER}.` })).toMatchObject(
        { status: 'uncertain' },
      );
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'normalized Pi turn completion',
      );
      expect(projection.state.lastAssistantMessage).toContain(PI_LIVE_RESPONSE_MARKER);
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(PI_LIVE_RESPONSE_MARKER),
        'response in the native Pi TUI',
      );
      expect(session.durableRecordSeen()).toBe(true);
      expect(session.observationLevel()).toBe('native-log');
      projection.dispose();
      projection = undefined;
      await host.disposeTerminal(session.runtimeSessionId);
      await session.dispose();
      session = undefined;
      session = await createPiTuiSession({
        cwd,
        host,
        executable,
        env,
        piAgentDir: agentDir,
        resume: sessionId,
        pollIntervalMs: 25,
      });
      projection = projectAgentEvents(session);
      expect(session.sessionId).toBe(sessionId);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['--session', sessionId]));
      await waitFor(
        () => (projection!.state.lastAssistantMessage ?? '').includes(PI_LIVE_RESPONSE_MARKER),
        'resumed Pi journal history',
      );
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(PI_LIVE_RESPONSE_MARKER),
        'resumed history in native Pi TUI',
      );
      expect(projection.envelopes.some(({ replay, source }) => replay && source === 'native-log')).toBe(true);
      expect(provider.requests).toHaveLength(1);
      await attestLiveAdapter({
        vendor: 'pi',
        artifact: promotionArtifact,
        testId: 'pi:native-tui-journal',
      });
    } catch (cause) {
      throw new Error(
        `Pi live: events=${JSON.stringify(projection?.envelopes.map(({ event }) => event.type))} tui=${JSON.stringify(session ? host.output(session.runtimeSessionId).slice(-5000) : '')}`,
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
