/**
 * Opt-in proof of Hermes's complete adapter-owned composition: one private
 * gateway, structured prompt control, the reconstructed native TUI in a PTY,
 * normalized events, durable session history, and native resume. Provider
 * traffic and user state remain isolated and local.
 *
 *   HERMES_LIVE=1 PUPPETEER_HERMES_BIN=/path/to/hermes \
 *     HERMES_PYTHON=/path/to/python HERMES_TUI_DIR=/path/to/ui-tui pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { probeHermesVersion, resolveHermesExecutable } from './detection.js';
import { createHermesTuiSession } from './driver.js';
import { resolveHermesPython } from './launch/gateway-host.js';
import { waitFor } from './test-support/live-harness.js';
import {
  HERMES_LIVE_RESPONSE_MARKER,
  isHermesLiveTurnRequest,
  isolatedHermesLiveEnvironment,
  startHermesLoopbackProvider,
} from './test-support/live-model.js';
import { HermesLivePtyHost } from './test-support/live-pty-host.js';

const live = process.env.HERMES_LIVE === '1';

describe.runIf(live)('Hermes adapter through real native TUI (live)', () => {
  it('shares one exact session across private gateway, native TUI, and resume', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-hermes-live-')));
    const cwd = join(root, 'workspace');
    const home = join(root, 'hermes-home');
    const tuiDirectory = process.env.HERMES_TUI_DIR;
    if (!tuiDirectory) throw new Error('HERMES_TUI_DIR is required for the locked native-TUI live lane');
    mkdirSync(cwd, { recursive: true });
    const provider = await startHermesLoopbackProvider();
    const environment = isolatedHermesLiveEnvironment(root, home, tuiDirectory, provider.baseUrl);
    const executable = resolveHermesExecutable();
    const python = resolveHermesPython();
    const host = new HermesLivePtyHost();
    let session: Awaited<ReturnType<typeof createHermesTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof createHermesTuiSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect(await probeHermesVersion(executable)).toEqual({ version: '0.20.0', releaseTag: '2026.8.3' });
      session = await createHermesTuiSession({
        cwd,
        host,
        executable,
        python,
        hermesHome: home,
        env: environment,
        promptConfirmationTimeoutMs: 45_000,
      });
      projection = projectAgentEvents(session);
      const sessionId = session.sessionId;
      expect(sessionId).toBeTruthy();
      expect(session.liveSessionId()).toBeTruthy();
      expect(session.storedSessionId()).toBe(sessionId);
      expect(session.observationLevel()).toBe('structured');
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).toEqual(expect.arrayContaining(['--tui', '--resume', sessionId]));

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${HERMES_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({ status: 'confirmed' });
      try {
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'normalized Hermes turn completion',
        );
        await waitFor(
          () => host.output(session!.runtimeSessionId).includes(HERMES_LIVE_RESPONSE_MARKER),
          'response in the real native TUI',
        );
      } catch (cause) {
        throw new Error(
          `Hermes native-TUI diagnostics: events=${JSON.stringify(projection.envelopes.map(({ event }) => event.type))} ` +
            `requests=${JSON.stringify(provider.requests)} ` +
            `tui=${JSON.stringify(host.output(session.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(projection.state.lastAssistantMessage).toContain(HERMES_LIVE_RESPONSE_MARKER);

      const originalRuntimeSessionId = session.runtimeSessionId;
      projection.dispose();
      projection = undefined;
      await host.disposeTerminal(originalRuntimeSessionId);
      await session.dispose();
      session = undefined;

      resumed = await createHermesTuiSession({
        cwd,
        host,
        executable,
        python,
        hermesHome: home,
        env: environment,
        resume: sessionId,
        promptConfirmationTimeoutMs: 45_000,
      });
      resumedProjection = projectAgentEvents(resumed);
      expect(resumed.sessionId).toBe(sessionId);
      expect(resumed.storedSessionId()).toBe(sessionId);
      expect(resumed.liveSessionId()).toBeTruthy();
      expect(resumed.observationLevel()).toBe('structured');
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['--tui', '--resume', sessionId]));
      try {
        await waitFor(
          () => (resumedProjection!.state.lastAssistantMessage ?? '').includes(HERMES_LIVE_RESPONSE_MARKER),
          'resumed normalized gateway history',
        );
        await waitFor(
          () => host.output(resumed!.runtimeSessionId).includes(HERMES_LIVE_RESPONSE_MARKER),
          'resumed history in the real native TUI',
        );
      } catch (cause) {
        throw new Error(
          `Hermes resume diagnostics: events=${JSON.stringify(
            resumedProjection.envelopes.map(({ event, source, replay }) => ({ type: event.type, source, replay })),
          )} requests=${JSON.stringify(provider.requests)} ` +
            `tui=${JSON.stringify(host.output(resumed.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(resumedProjection.envelopes.some(({ source, replay }) => source === 'native-protocol' && replay)).toBe(
        true,
      );
      expect(provider.requests.filter(isHermesLiveTurnRequest)).toHaveLength(1);
      const promotionArtifact = process.env.PUPPETEER_LIVE_ARTIFACT ?? executable;
      await attestLiveAdapter({
        vendor: 'hermes',
        artifact: promotionArtifact,
        testId: 'hermes:native-tui-gateway',
      });
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
  }, 180_000);
});
