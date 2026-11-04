/** Native-TUI and durable-journal proof; terms consent is explicit and data collection stays off. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { createAntigravityTuiSession } from './driver.js';
import { detectAntigravityInstallation, resolveAntigravityExecutable } from './detection.js';
import { waitFor } from './test-support/live-harness.js';
import { AntigravityLivePtyHost } from './test-support/live-pty-host.js';
import {
  isolatedAntigravityLiveEnvironment,
  ANTIGRAVITY_LIVE_MARKER,
  startAntigravityLoopbackProvider,
} from './test-support/live-model.js';

describe.runIf(process.env.ANTIGRAVITY_LIVE === '1')('Antigravity adapter through the real native TUI (live)', () => {
  it('submits one native turn and resumes its exact durable session', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-antigravity-live-')));
    const cwd = join(root, 'workspace');
    const home = join(root, 'home');
    mkdirSync(cwd, { recursive: true });
    const provider = await startAntigravityLoopbackProvider();
    const env = isolatedAntigravityLiveEnvironment(root, home, provider.baseUrl);
    const executable = resolveAntigravityExecutable();
    const host = new AntigravityLivePtyHost();
    const digest = () => createHash('sha256').update(readFileSync(executable)).digest('hex');
    const before = digest();
    let session: Awaited<ReturnType<typeof createAntigravityTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect(await detectAntigravityInstallation(executable, { env })).toMatchObject({
        exactTarget: true,
        version: '1.1.20',
      });
      session = await createAntigravityTuiSession({
        cwd,
        host,
        executable,
        env,
        antigravityHome: home,
        pollIntervalMs: 25,
      });
      projection = projectAgentEvents(session);
      expect(host.launches).toHaveLength(1);
      expect(await session.services.prompt.submit({ text: `Reply exactly ${ANTIGRAVITY_LIVE_MARKER}.` })).toMatchObject(
        { status: 'confirmed' },
      );
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'normalized Antigravity turn completion',
      );
      expect(projection.state.lastAssistantMessage).toContain(ANTIGRAVITY_LIVE_MARKER);
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(ANTIGRAVITY_LIVE_MARKER),
        'response in the native Antigravity TUI',
      );
      expect(session.durableRecordSeen()).toBe(true);
      expect(session.observationLevel()).toBe('native-log');
      const sessionId = session.sessionId;
      expect(sessionId).not.toContain('pending');
      projection.dispose();
      projection = undefined;
      await host.disposeTerminal(session.runtimeSessionId);
      await session.dispose();
      session = undefined;
      // The first process can finish a checkpoint-summary request while shutting down.
      // Snapshot after it exits so the count isolates requests made by the resumed process.
      const requestCount = provider.requests.length;
      expect(requestCount).toBeGreaterThan(0);
      session = await createAntigravityTuiSession({
        cwd,
        host,
        executable,
        env,
        antigravityHome: home,
        resume: sessionId,
        pollIntervalMs: 25,
      });
      projection = projectAgentEvents(session);
      expect(session.sessionId).toBe(sessionId);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['--conversation', sessionId]));
      await waitFor(
        () => (projection!.state.lastAssistantMessage ?? '').includes(ANTIGRAVITY_LIVE_MARKER),
        'resumed Antigravity journal history',
      );
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(ANTIGRAVITY_LIVE_MARKER),
        'resumed history in native Antigravity TUI',
      );
      expect(projection.envelopes.some(({ replay, source }) => replay && source === 'native-log')).toBe(true);
      expect(provider.requests).toHaveLength(requestCount);
      expect(digest()).toBe(before);
      await attestLiveAdapter({
        vendor: 'antigravity',
        artifact: executable,
        testId: 'antigravity:native-tui-journal',
      });
    } catch (cause) {
      throw new Error(
        `Antigravity live: events=${JSON.stringify(projection?.envelopes.map(({ event }) => event.type))} tui=${JSON.stringify(session ? host.output(session.runtimeSessionId).slice(-5000) : '')}`,
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
