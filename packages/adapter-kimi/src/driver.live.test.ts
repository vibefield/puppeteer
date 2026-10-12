/**
 * Opt-in proof of Kimi's complete adapter-owned composition: the exact native
 * TUI in a PTY, adapter prompt control, durable-wire normalization, and native
 * resume. Model traffic and user state are isolated, so the lane needs no
 * credentials or external model access.
 *
 *   KIMI_LIVE=1 PUPPETEER_KIMI_BIN=/absolute/path/to/kimi pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { detectKimiInstallation, resolveKimiExecutable } from './detection.js';
import { createKimiTuiSession } from './driver.js';
import {
  isolatedKimiLiveEnvironment,
  KIMI_LIVE_RESPONSE_MARKER,
  startKimiLoopbackProvider,
} from './test-support/live-model.js';
import { KimiLivePtyHost } from './test-support/live-pty-host.js';
import { waitFor } from './test-support/live-harness.js';

const live = process.env.KIMI_LIVE === '1';

describe.runIf(live)('Kimi adapter through real native TUI (live)', () => {
  it('shares one exact session across native TUI, durable wire, and resume', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-kimi-live-')));
    const kimiHome = join(root, 'kimi-home');
    const cwd = join(root, 'workspace');
    mkdirSync(kimiHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const provider = await startKimiLoopbackProvider();
    const environment = isolatedKimiLiveEnvironment(root, kimiHome, provider.baseUrl);
    const executable = resolveKimiExecutable();
    const host = new KimiLivePtyHost();
    let session: Awaited<ReturnType<typeof createKimiTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof createKimiTuiSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      const installation = await detectKimiInstallation(executable, { env: environment, timeoutMs: 15_000 });
      expect(installation.exactTarget).toBe(true);

      session = await createKimiTuiSession({
        cwd,
        host,
        executable,
        env: environment,
        kimiHome,
        pollIntervalMs: 25,
        promptConfirmationTimeoutMs: 30_000,
      });
      projection = projectAgentEvents(session);
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).not.toContain('--session');

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${KIMI_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toEqual({ status: 'confirmed' });
      try {
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'normalized durable turn completion',
        );
        await waitFor(
          () => host.output(session!.runtimeSessionId).includes(KIMI_LIVE_RESPONSE_MARKER),
          'response in the real native TUI',
        );
      } catch (cause) {
        throw new Error(
          `Kimi native-TUI diagnostics: events=${JSON.stringify(projection.envelopes.map(({ event }) => event.type))} ` +
            `requests=${JSON.stringify(provider.requests)} ` +
            `tui=${JSON.stringify(host.output(session.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(projection.state.lastAssistantMessage).toContain(KIMI_LIVE_RESPONSE_MARKER);
      expect(projection.envelopes.some(({ source }) => source === 'native-log')).toBe(true);
      expect(session.observationLevel()).toBe('native-log');
      const sessionDirectory = session.sessionDirectory();
      expect(sessionDirectory).toBeDefined();
      expect(relative(kimiHome, sessionDirectory!)).not.toMatch(/^\.\.(?:[/\\]|$)/);

      const sessionId = session.sessionId;
      const originalRuntimeSessionId = session.runtimeSessionId;
      projection.dispose();
      projection = undefined;
      await host.disposeTerminal(originalRuntimeSessionId);
      await session.dispose();
      session = undefined;

      resumed = await createKimiTuiSession({
        cwd,
        host,
        executable,
        env: environment,
        kimiHome,
        resume: sessionId,
        pollIntervalMs: 25,
        promptConfirmationTimeoutMs: 30_000,
      });
      resumedProjection = projectAgentEvents(resumed);
      expect(resumed.sessionId).toBe(sessionId);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['--session', sessionId]));
      try {
        await waitFor(
          () => (resumedProjection!.state.lastAssistantMessage ?? '').includes(KIMI_LIVE_RESPONSE_MARKER),
          'resumed normalized durable history',
        );
        await waitFor(
          () => host.output(resumed!.runtimeSessionId).includes(KIMI_LIVE_RESPONSE_MARKER),
          'resumed history in the real native TUI',
        );
      } catch (cause) {
        throw new Error(
          `Kimi resume diagnostics: events=${JSON.stringify(
            resumedProjection.envelopes.map(({ event, source, replay }) => ({ type: event.type, source, replay })),
          )} requests=${JSON.stringify(provider.requests)} ` +
            `tui=${JSON.stringify(host.output(resumed.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(resumedProjection.envelopes.some(({ source, replay }) => source === 'native-log' && replay)).toBe(true);
      expect(provider.requests).toHaveLength(1);
      await attestLiveAdapter({ vendor: 'kimi', artifact: executable, testId: 'kimi:native-tui-wire' });
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
  }, 90_000);
});
