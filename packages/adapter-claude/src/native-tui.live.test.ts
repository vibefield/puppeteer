/**
 * Opt-in proof of Claude's complete adapter-owned composition: the exact native
 * TUI in a PTY, generated hooks, normalized events, terminal prompt control,
 * durable transcript observation, and resume. Model traffic and user state are
 * isolated, so the lane needs no credentials or external model access.
 *
 *   CLAUDE_NATIVE_TUI_LIVE=1 PUPPETEER_CLAUDE_BIN=/absolute/path/to/claude pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { attestLiveAdapter } from '@vibecook/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { detectClaude } from './detection.js';
import { createClaudeSession } from './driver.js';
import { CLAUDE_SURFACE_VERSION } from './generated/registry.js';
import {
  CLAUDE_LIVE_MODEL,
  CLAUDE_LIVE_RESPONSE_MARKER,
  isolatedClaudeLiveEnvironment,
  startClaudeLoopbackProvider,
} from './test-support/live-model.js';
import { ClaudeLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.CLAUDE_NATIVE_TUI_LIVE === '1';

function executablePath(): string {
  const configured = process.env.PUPPETEER_CLAUDE_BIN ?? 'claude';
  return isAbsolute(configured) || configured.includes('/') || configured.includes('\\')
    ? resolve(configured)
    : configured;
}

describe.runIf(live)('Claude adapter through real native TUI (live)', () => {
  it('shares one exact session across hooks, transcript observation, TUI, and resume', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-claude-live-')));
    const configDir = join(root, 'claude-config');
    const cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'CLAUDE.md'), 'Native-TUI adapter fixture. Do not use tools.\n', 'utf8');
    const provider = await startClaudeLoopbackProvider();
    const environment = isolatedClaudeLiveEnvironment(root, configDir, cwd, provider.baseUrl);
    const executable = executablePath();
    const host = new ClaudeLivePtyHost();
    let session: Awaited<ReturnType<typeof createClaudeSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof createClaudeSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      const detection = await detectClaude({ executable });
      expect(detection.version, detection.warnings.join('\n')).toBe(CLAUDE_SURFACE_VERSION);

      session = await createClaudeSession({
        cwd,
        executable,
        env: environment,
        configDir,
        providerVersion: detection.version,
        model: CLAUDE_LIVE_MODEL,
        permissionMode: 'dontAsk',
        settingSources: ['project'],
        observeOtlpUsage: false,
        observeSubagentStatus: false,
        ports: {
          spawn: (prepared) => host.spawnTerminal(prepared),
          automate: (runtimeSessionId, operation) => host.automateTerminal(runtimeSessionId, operation),
        },
      });
      projection = projectAgentEvents(session);
      const sessionId = session.sessionId;
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).toEqual(expect.arrayContaining(['--session-id', sessionId]));
      try {
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'session:ready'),
          'normalized native-hook readiness',
          30_000,
        );
      } catch (cause) {
        throw new Error(
          `Claude startup diagnostics: events=${JSON.stringify(projection.envelopes.map(({ event }) => event.type))} ` +
            `tui=${JSON.stringify(host.output(session.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(session.observationLevel()).toBe('native-hooks');

      const prompt = `Reply with exactly ${CLAUDE_LIVE_RESPONSE_MARKER} and do not use tools.`;
      const receipt = await session.services.prompt.submit({ text: prompt, confirmationTimeoutMs: 15_000 });
      expect(receipt, host.output(session.runtimeSessionId)).toEqual({
        status: 'confirmed',
        turnId: expect.any(String),
      });
      try {
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'normalized native-hook turn completion',
          60_000,
        );
        await waitFor(
          () => host.output(session!.runtimeSessionId).includes(CLAUDE_LIVE_RESPONSE_MARKER),
          'response in the real native TUI',
          60_000,
        );
        await waitFor(
          async () => {
            await session!.pollTranscript();
            return projection!.envelopes.some(({ source }) => source === 'native-transcript');
          },
          'durable transcript append',
          15_000,
        );
        expect(projection.state.lastAssistantMessage).toContain(CLAUDE_LIVE_RESPONSE_MARKER);
      } catch (cause) {
        throw new Error(
          `Claude native-TUI diagnostics: requests=${JSON.stringify(provider.requests.map(({ method, url, kind }) => ({ method, url, kind })))} ` +
            `events=${JSON.stringify(projection.envelopes.map(({ event }) => event.type))} ` +
            `transcript=${JSON.stringify(session.transcriptPath())} ` +
            `tui=${JSON.stringify(host.output(session.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(session.transcriptPath()).toBeDefined();
      expect(relative(configDir, session.transcriptPath()!)).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(projection.envelopes.some(({ source }) => source === 'native-transcript')).toBe(true);

      const originalRuntimeSessionId = session.runtimeSessionId;
      projection.dispose();
      projection = undefined;
      await host.disposeTerminal(originalRuntimeSessionId);
      await session.dispose();
      session = undefined;

      resumed = await createClaudeSession({
        cwd,
        resume: sessionId,
        executable,
        env: environment,
        configDir,
        providerVersion: detection.version,
        model: CLAUDE_LIVE_MODEL,
        permissionMode: 'dontAsk',
        settingSources: ['project'],
        observeOtlpUsage: false,
        observeSubagentStatus: false,
        ports: {
          spawn: (prepared) => host.spawnTerminal(prepared),
          automate: (runtimeSessionId, operation) => host.automateTerminal(runtimeSessionId, operation),
        },
      });
      resumedProjection = projectAgentEvents(resumed);
      expect(resumed.sessionId).toBe(sessionId);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['--resume', sessionId]));
      expect(host.launches[1]?.args).not.toContain('--session-id');
      try {
        await waitFor(() => resumed!.observationLevel() === 'native-hooks', 'resumed native-hook observation', 30_000);
        await waitFor(() => resumed!.transcriptPath() !== undefined, 'resumed transcript attachment', 30_000);
        await resumed.pollTranscript();
        await waitFor(
          () => (resumedProjection!.state.lastAssistantMessage ?? '').includes(CLAUDE_LIVE_RESPONSE_MARKER),
          'resumed normalized transcript history',
          15_000,
        );
        await waitFor(
          () => host.output(resumed!.runtimeSessionId).includes(CLAUDE_LIVE_RESPONSE_MARKER),
          'resumed history in the real native TUI',
        );
      } catch (cause) {
        throw new Error(
          `Claude resume diagnostics: events=${JSON.stringify(
            resumedProjection.envelopes.map(({ event, source, replay }) => ({ type: event.type, source, replay })),
          )} transcript=${JSON.stringify(resumed.transcriptPath())} ` +
            `requests=${JSON.stringify(provider.requests.map(({ method, url, kind }) => ({ method, url, kind })))} ` +
            `tui=${JSON.stringify(host.output(resumed.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }

      const turnRequests = provider.requests.filter(({ kind }) => kind === 'turn');
      expect(turnRequests, `unexpected loopback requests: ${JSON.stringify(provider.requests)}`).toHaveLength(1);
      expect(turnRequests[0]).toMatchObject({ method: 'POST', url: expect.stringMatching(/^\/v1\/messages/) });
      expect(
        provider.requests.every(({ kind }) => kind !== 'unsupported'),
        `unexpected loopback routes: ${JSON.stringify(provider.requests.map(({ method, url, kind }) => ({ method, url, kind })))}`,
      ).toBe(true);
      await attestLiveAdapter({ vendor: 'claude', artifact: executable, testId: 'claude:native-tui-hooks' });
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
