/**
 * Opt-in proof of Claude's complete adapter-owned composition: the exact native
 * TUI in a PTY, generated hooks, normalized events, terminal prompt control,
 * durable transcript observation, and resume. Model traffic and user state are
 * isolated, so the lane needs no credentials or external model access. The artifact must be named
 * explicitly: the lane never falls back to `claude` on PATH.
 *
 *   CLAUDE_NATIVE_TUI_LIVE=1 PUPPETEER_CLAUDE_BIN=/absolute/path/to/claude pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { removeLiveRoot } from '@vibefield/puppeteer-testing/live-cleanup';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
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
import { isolatedClaudeExec, requireClaudeLiveExecutable } from './test-support/live-executable.js';
import { ClaudeLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.CLAUDE_NATIVE_TUI_LIVE === '1';

describe.runIf(live)('Claude adapter through real native TUI (live)', () => {
  it('shares one exact session across hooks, transcript observation, TUI, and resume', async () => {
    const executable = requireClaudeLiveExecutable();
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-claude-live-')));
    const configDir = join(root, 'claude-config');
    const cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'CLAUDE.md'), 'Native-TUI adapter fixture. Do not use tools.\n', 'utf8');
    const provider = await startClaudeLoopbackProvider();
    const environment = isolatedClaudeLiveEnvironment(root, configDir, cwd, provider.baseUrl);
    const host = new ClaudeLivePtyHost();
    let session: Awaited<ReturnType<typeof createClaudeSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof createClaudeSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      const detection = await detectClaude({ executable, exec: isolatedClaudeExec(environment) });
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
        // 2.1.300+ records request bookkeeping (`api-request-blob` carries a message role) beside the
        // conversation: no transcript message may be keyed to one of those rows.
        expect(
          projection.envelopes
            .filter(
              ({ source, event }) => source === 'native-transcript' && event.type === 'conversation:assistant-message',
            )
            .map(({ event }) => (event as { messageId: string }).messageId),
        ).not.toContainEqual(expect.stringMatching(/:line-\d+$/));

        // `/model` is a slash command: no UserPromptSubmit, but PreModelSwitch then PostModelSwitch.
        const switched = () =>
          projection!.envelopes.find(
            ({ source, event, nativeEvent }) =>
              source === 'native-hook' &&
              event.type === 'model:updated' &&
              (nativeEvent as { hook_event_name?: unknown } | undefined)?.hook_event_name === 'PostModelSwitch',
          );
        await host.automateTerminal(session.runtimeSessionId, {
          kind: 'text',
          text: '/model claude-opus-4-1-20250805',
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await host.automateTerminal(session.runtimeSessionId, { kind: 'text', text: '\r' });
        try {
          await waitFor(() => switched() !== undefined, 'normalized PostModelSwitch', 5_000);
        } catch {
          // A confirmation (a warm prompt cache) or the slash-command picker takes the first Enter;
          // the next accepts the highlighted default.
          await host.automateTerminal(session.runtimeSessionId, { kind: 'text', text: '\r' });
          await waitFor(() => switched() !== undefined, 'normalized PostModelSwitch after confirmation', 10_000);
        }
        const landed = switched()!;
        const target = (landed.nativeEvent as { to_model: string }).to_model;
        expect(landed.event).toEqual({
          type: 'model:updated',
          intent: 'observed',
          model: { id: target, provider: 'anthropic' },
        });
        expect(target).not.toBe(CLAUDE_LIVE_MODEL);
        expect(projection.state.environment.model?.value.id).toBe(target);
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
          () => host.output(resumed!.runtimeSessionId).includes(CLAUDE_LIVE_RESPONSE_MARKER),
          'resumed history in the real native TUI',
        );
        expect(resumedProjection.state.lastAssistantMessage).toBeUndefined();
        expect(
          resumedProjection.envelopes.filter(
            ({ event }) => event.type.startsWith('turn:') || event.type.startsWith('conversation:'),
          ),
        ).toEqual([]);

        const resumedReceipt = await resumed.services.prompt.submit({
          text: prompt,
          confirmationTimeoutMs: 15_000,
        });
        expect(resumedReceipt, host.output(resumed.runtimeSessionId)).toEqual({
          status: 'confirmed',
          turnId: expect.any(String),
        });
        await waitFor(
          () => resumedProjection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'new native-hook turn completion after resume',
          60_000,
        );
        expect(resumedProjection.state.lastAssistantMessage).toContain(CLAUDE_LIVE_RESPONSE_MARKER);
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
      expect(turnRequests, `unexpected loopback requests: ${JSON.stringify(provider.requests)}`).toHaveLength(2);
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
      // On Windows the TUI can outlive its pseudoconsole with the workspace as its working directory, which
      // blocks removal (EBUSY); the shared cleanup stops what still names the root before removing it.
      await removeLiveRoot(root, 'claude live');
    }
  }, 120_000);
});
