/**
 * Opt-in proof of Codex's complete adapter-owned composition: the exact native
 * TUI in a PTY, one private app-server, structured observation, terminal prompt
 * control, and resume. Model traffic and user state remain isolated, so the
 * lane needs no credentials or external model access.
 *
 *   CODEX_NATIVE_TUI_LIVE=1 PUPPETEER_CODEX_BIN=/absolute/path/to/codex pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEventEnvelope } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { createCodexTuiSession } from './launch/tui-session.js';
import type { AppServerTransportKind } from './transport/app-server-process.js';
import {
  CODEX_LIVE_MODEL,
  CODEX_LIVE_COMMAND_MARKER,
  CODEX_LIVE_RESPONSE_MARKER,
  isolatedCodexLiveEnvironment,
  startCodexLoopbackProvider,
  writeCodexLiveConfiguration,
} from './test-support/live-model.js';
import { removeCodexLiveRoot, requireCodexLiveExecutable } from './test-support/live-profile.js';
import { CodexLivePtyHost, delay, waitFor } from './test-support/live-pty-host.js';

const live = process.env.CODEX_NATIVE_TUI_LIVE === '1';

/**
 * Native events about a deprecated call. 0.158.0 and later answer every full-history hydration with
 * one (findings C8); the observer reads history the paginated way, and an older app-server sends none.
 */
function nativeDeprecations(envelopes: readonly AgentEventEnvelope[]): string[] {
  return envelopes.flatMap(({ event }) =>
    event.type === 'adapter:native-event' && /deprecat/iu.test(event.nativeType ?? '') ? [event.nativeType ?? ''] : [],
  );
}

function requestedAppServerTransport(): AppServerTransportKind | undefined {
  const value = process.env.CODEX_NATIVE_TUI_TRANSPORT;
  if (value === undefined || value === '') return undefined;
  if (value === 'unix' || value === 'websocket') return value;
  throw new Error(`CODEX_NATIVE_TUI_TRANSPORT must be unix or websocket, got ${value}`);
}

async function bounded<T>(operation: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out during ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.runIf(live)('Codex adapter through real native TUI (live)', () => {
  it.each(['accept', 'decline'] as const)(
    'leaves approval to the real native TUI: %s',
    async (decision) => {
      const executable = requireCodexLiveExecutable('CODEX_NATIVE_TUI_LIVE');
      const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'puppeteer-codex-approval-')));
      const codexHome = join(root, 'codex-home');
      const cwd = join(root, 'workspace');
      mkdirSync(cwd, { recursive: true });
      const provider = await startCodexLoopbackProvider({ requestApproval: true });
      writeCodexLiveConfiguration(codexHome, cwd, provider.baseUrl);
      const environment = isolatedCodexLiveEnvironment(root, codexHome);
      const host = new CodexLivePtyHost();
      let session: Awaited<ReturnType<typeof createCodexTuiSession>> | undefined;
      let projection: ReturnType<typeof projectAgentEvents> | undefined;
      try {
        const appServerTransport = requestedAppServerTransport();
        session = await bounded(
          createCodexTuiSession({
            cwd,
            executable,
            host,
            env: environment,
            appServerEnv: environment,
            ...(appServerTransport ? { appServerTransport } : {}),
            model: CODEX_LIVE_MODEL,
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
          }),
          'native approval composition',
        );
        projection = projectAgentEvents(session);
        const receipt = await session.services.prompt.submit({ text: 'Run the harmless echo approval probe.' });
        expect(receipt).toMatchObject({ status: 'confirmed', turnId: expect.any(String) });
        await waitFor(
          () =>
            projection!.envelopes.some(
              ({ event }) => event.type === 'interaction:permission-requested' || event.type === 'turn:completed',
            ),
          'structured approval observation',
        );
        expect(projection.envelopes.some(({ event }) => event.type === 'interaction:permission-requested')).toBe(true);
        await waitFor(
          () => host.output(session!.runtimeSessionId).includes('Would you like to run the following command'),
          'native approval prompt',
        );
        // A passive observer must leave the request pending, including while the
        // person at the terminal takes time to read it.
        await delay(500);
        expect(projection.envelopes.some(({ event }) => event.type === 'interaction:permission-resolved')).toBe(false);
        await host.automateTerminal(session.runtimeSessionId, {
          kind: 'text',
          text: decision === 'accept' ? 'y\r' : 'n\r',
        });
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'turn after native approval',
        );
        expect(
          projection.envelopes.some(
            ({ event }) => event.type === 'interaction:permission-resolved' && event.outcome === 'unknown',
          ),
        ).toBe(true);
        const commands = projection.envelopes.flatMap(({ nativeEvent }) => {
          const event = nativeEvent as
            | { method?: string; params?: { item?: { type?: string; status?: string; aggregatedOutput?: string } } }
            | undefined;
          return event?.method === 'item/completed' && event.params?.item?.type === 'commandExecution'
            ? [event.params.item]
            : [];
        });
        expect(commands).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ status: decision === 'accept' ? 'completed' : 'declined' }),
          ]),
        );
        if (decision === 'accept')
          expect(commands.some((command) => command.aggregatedOutput?.includes(CODEX_LIVE_COMMAND_MARKER))).toBe(true);
        else
          expect(commands.every((command) => !command.aggregatedOutput?.includes(CODEX_LIVE_COMMAND_MARKER))).toBe(
            true,
          );
      } catch (cause) {
        throw new Error(
          `Native approval (${decision}) diagnostics: requests=${JSON.stringify(
            provider.requests.map((request) => {
              const body = request.body as {
                tools?: { type?: string; name?: string; tools?: { name?: string }[] }[];
                input?: { type?: string; output?: unknown }[];
              };
              return {
                kind: request.kind,
                tools: body.tools?.map((tool) => ({
                  type: tool.type,
                  name: tool.name,
                  nested: tool.tools?.map((nested) => nested.name),
                })),
                outputs: body.input?.filter((item) => item.type?.endsWith('_output')),
              };
            }),
          )} events=${JSON.stringify(projection?.envelopes.map(({ event }) => event.type))} tui=${JSON.stringify(session ? host.output(session.runtimeSessionId).slice(-6000) : '')}`,
          { cause },
        );
      } finally {
        projection?.dispose();
        await session?.dispose();
        await host.dispose();
        await provider.close();
        await removeCodexLiveRoot(root);
      }
    },
    90_000,
  );

  it('shares one exact thread across app-server, structured observation, TUI, and resume', async () => {
    const executable = requireCodexLiveExecutable('CODEX_NATIVE_TUI_LIVE');
    // The native spelling: Codex reports its rollout path without Windows 8.3 short names (RUNNER~1).
    const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'puppeteer-codex-live-')));
    const codexHome = join(root, 'codex-home');
    const cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const provider = await startCodexLoopbackProvider();
    writeCodexLiveConfiguration(codexHome, cwd, provider.baseUrl);
    const environment = isolatedCodexLiveEnvironment(root, codexHome);
    const appServerTransport = requestedAppServerTransport();
    const host = new CodexLivePtyHost();
    let session: Awaited<ReturnType<typeof createCodexTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    let resumed: Awaited<ReturnType<typeof createCodexTuiSession>> | undefined;
    let resumedProjection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      session = await bounded(
        createCodexTuiSession({
          cwd,
          executable,
          host,
          env: environment,
          appServerEnv: environment,
          ...(appServerTransport ? { appServerTransport } : {}),
          model: CODEX_LIVE_MODEL,
          sandbox: 'read-only',
          approvalPolicy: 'never',
        }),
        'fresh native-TUI composition',
      );
      projection = projectAgentEvents(session);
      const threadId = session.sessionId;
      expect(host.launches).toHaveLength(1);
      expect(host.launches[0]?.args).toEqual(expect.arrayContaining(['resume', threadId, '--remote']));
      expect(session.observationLevel()).toBe('structured');

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${CODEX_LIVE_RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({
        status: 'confirmed',
        turnId: expect.any(String),
      });
      try {
        await waitFor(
          () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
          'normalized structured turn completion',
          60_000,
        );
        await waitFor(
          () => host.output(session!.runtimeSessionId).includes(CODEX_LIVE_RESPONSE_MARKER),
          'response in the real native TUI',
          60_000,
        );
      } catch (cause) {
        throw new Error(
          `Codex native-TUI diagnostics: requests=${JSON.stringify(provider.requests)} ` +
            `events=${JSON.stringify(projection.envelopes.map(({ event }) => event.type))} ` +
            `tui=${JSON.stringify(host.output(session.runtimeSessionId).slice(-4_000))}`,
          { cause },
        );
      }
      expect(projection.state.lastAssistantMessage).toContain(CODEX_LIVE_RESPONSE_MARKER);
      expect(session.threadPath()).toContain(codexHome);
      expect(nativeDeprecations(projection.envelopes)).toEqual([]);

      const originalRuntimeSessionId = session.runtimeSessionId;
      projection.dispose();
      projection = undefined;
      await session.dispose();
      session = undefined;
      await host.disposeTerminal(originalRuntimeSessionId);

      resumed = await bounded(
        createCodexTuiSession({
          cwd,
          resume: threadId,
          executable,
          host,
          env: environment,
          appServerEnv: environment,
          ...(appServerTransport ? { appServerTransport } : {}),
        }),
        'resumed native-TUI composition',
      );
      resumedProjection = projectAgentEvents(resumed);
      expect(resumed.sessionId).toBe(threadId);
      expect(host.launches).toHaveLength(2);
      expect(host.launches[1]?.args).toEqual(expect.arrayContaining(['resume', threadId, '--remote']));
      await waitFor(
        () => (resumedProjection!.state.lastAssistantMessage ?? '').includes(CODEX_LIVE_RESPONSE_MARKER),
        'resumed structured history',
      );
      await waitFor(
        () => host.output(resumed!.runtimeSessionId).includes(CODEX_LIVE_RESPONSE_MARKER),
        'resumed history in the real native TUI',
      );
      // The resumed answer is history the observer read and replayed, not a live event.
      const replayed = resumedProjection.envelopes.find(
        ({ event }) =>
          event.type === 'conversation:assistant-message' && event.text.includes(CODEX_LIVE_RESPONSE_MARKER),
      );
      expect(replayed?.replay).toBe(true);
      expect(nativeDeprecations(resumedProjection.envelopes)).toEqual([]);

      const turnRequests = provider.requests.filter(({ kind }) => kind === 'turn');
      expect(turnRequests, `unexpected loopback requests: ${JSON.stringify(provider.requests)}`).toHaveLength(1);
      expect(turnRequests[0]).toMatchObject({ method: 'POST', url: '/v1/responses' });
      expect(provider.requests.every(({ kind }) => kind === 'turn' || kind === 'thread-title')).toBe(true);
      await attestLiveAdapter({ vendor: 'codex', artifact: executable, testId: 'codex:native-tui-app-server' });
    } finally {
      resumedProjection?.dispose();
      await resumed?.dispose();
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      await provider.close();
      // The app-server's plugin sync outlives it (findings C8): stop it before removing the root, and on
      // Windows never let a leftover handle replace this test's own result.
      await removeCodexLiveRoot(root);
    }
  }, 120_000);
});
