/**
 * Opt-in proof of Grok's complete adapter-owned composition: the exact native
 * TUI in a PTY, one shared leader, ACP control, durable-log normalization, and
 * resume. Model traffic and user state remain isolated, so the lane needs no
 * credentials or external model access.
 *
 *   GROK_LIVE=1 PUPPETEER_GROK_BIN=/absolute/path/to/grok pnpm test
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AcpApprovalRequest } from '@vibefield/puppeteer-adapter-acp';
import {
  createMonitorAccumulatorState,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  type AdapterMonitorObservationBatch,
} from '@vibefield/puppeteer-core/monitor-spi';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { attestLiveAdapter } from '@vibefield/puppeteer-testing/live-attestation';
import { describe, expect, it } from 'vitest';
import { detectGrokInstallation, resolveGrokExecutable } from './detection.js';
import { createGrokBackend } from './driver.js';
import {
  classifyGrokLiveModelRequest,
  GROK_LIVE_MODEL,
  GROK_LIVE_RESPONSE_MARKER,
  GROK_LIVE_TOOL_FILE,
  GROK_LIVE_TOOL_TRIGGER,
  isolatedGrokLiveEnvironment,
  startGrokLoopbackProvider,
  writeGrokLiveConfiguration,
} from './test-support/live-model.js';
import { GrokLivePtyHost, waitFor } from './test-support/live-pty-host.js';

const live = process.env.GROK_LIVE === '1';

/** Standing native allow/deny rules Grok writes when an `*_always` option is selected. */
function persistedPermissionRules(grokHome: string): string[] {
  try {
    return readdirSync(join(grokHome, 'sessions'), { recursive: true, encoding: 'utf8' })
      .map((entry) => basename(entry))
      .filter((name) => name.startsWith('permission__'));
  } catch {
    return [];
  }
}

/** Live `_x.ai/session_notification` updates of one kind, as the binding retained them. */
function liveNotifications(projection: ReturnType<typeof projectAgentEvents>, kind: string) {
  return projection.envelopes.flatMap(({ event, nativeEvent }) => {
    const carrier = nativeEvent as
      | { method?: string; params?: { update?: { sessionUpdate?: string; usage?: { totalTokens?: number } } } }
      | undefined;
    return event.type === 'adapter:native-event' &&
      carrier?.method === '_x.ai/session_notification' &&
      carrier.params?.update?.sessionUpdate === kind
      ? [carrier.params.update]
      : [];
  });
}

function monitorUsage(batches: readonly AdapterMonitorObservationBatch[]) {
  let state = createMonitorAccumulatorState({
    runtimeRunId: 'live',
    runtimeEpoch: 1,
    providerId: 'grok',
    executionMode: 'native-tui',
    observationLevel: 'native-log',
    allocatedAt: batches[0]!.observedAt,
  });
  for (const batch of batches) {
    state = reduceMonitorAccumulator(state, {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'live',
      runtimeEpoch: 1,
    }).state;
  }
  return projectAgentMonitorState(state, { asOf: batches.at(-1)!.observedAt }).usage;
}

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

      const approvals: AcpApprovalRequest[] = [];
      session = await backend.createSession({
        cwd,
        model: GROK_LIVE_MODEL,
        permissionMode: 'default',
        onApproval: (request) => {
          approvals.push(request);
          return 'approved';
        },
      });
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
      // 1.0.70 writes signals.json asynchronously after the prompt result, so a
      // context sample may trail turn completion; wait for it instead of asserting.
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'context-window:updated'),
        'context sample after the turn',
      );

      // A mutating command: 1.0.70 offers always-allow first, and a host
      // approval must answer only this request (allow_once), persisting no rule.
      const toolReceipt = await session.services.prompt.submit({
        text: `${GROK_LIVE_TOOL_TRIGGER}: run the command, then reply with exactly ${GROK_LIVE_RESPONSE_MARKER}.`,
      });
      expect(toolReceipt, host.output(session.runtimeSessionId)).toEqual({
        status: 'confirmed',
        turnId: expect.any(String),
      });
      await waitFor(
        () => projection!.envelopes.filter(({ event }) => event.type === 'turn:completed').length >= 2,
        'normalized completion of the approved tool turn',
      );
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.options.map(({ kind }) => kind)).toEqual([
        'allow_always',
        'allow_once',
        'reject_once',
        'reject_always',
      ]);
      expect(readFileSync(join(cwd, GROK_LIVE_TOOL_FILE), 'utf8').trim()).toBe(`${GROK_LIVE_TOOL_TRIGGER}_OK`);
      expect(persistedPermissionRules(grokHome)).toEqual([]);
      expect(
        projection.envelopes.flatMap(({ event }) =>
          event.type === 'interaction:permission-resolved' ? [event.outcome] : [],
        ),
      ).toEqual(['allowed']);

      // 1.0.70's live response_completed carries no signature or eventId. Each
      // response is still published once, inside its running native prompt, and
      // the turn totals reconcile them exactly.
      await waitFor(() => liveNotifications(projection!, 'turn_completed').length >= 2, 'live usage of both turns');
      const responses = liveNotifications(projection, 'response_completed');
      expect(responses.length).toBeGreaterThanOrEqual(3);
      expect(responses.every((update) => !('signature' in update))).toBe(true);
      const responseKeys = projection.monitorBatches.flatMap(({ updates }) =>
        updates.flatMap((update) =>
          update.family === 'usage' && update.operation === 'upsert' && update.key.includes(':response:')
            ? [update.key]
            : [],
        ),
      );
      expect(new Set(responseKeys).size).toBe(responses.length);
      expect(responseKeys.every((key) => key.startsWith(`grok-turn:${sessionId}:`))).toBe(true);
      expect(monitorUsage(projection.monitorBatches).cumulativeTokens).toBe(
        liveNotifications(projection, 'turn_completed').reduce(
          (sum, update) => sum + (update.usage?.totalTokens ?? 0),
          0,
        ),
      );

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
      const turnShapes = semanticTurnRequests.map(({ body }) => {
        const messages = (body as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
        return {
          roles: messages.map(({ role }) => role).join(','),
          lastUser: JSON.stringify([...messages].reverse().find(({ role }) => role === 'user')?.content ?? '').slice(
            0,
            160,
          ),
          tools: Array.isArray((body as { tools?: unknown }).tools),
        };
      });
      // The plain turn, then the tool turn's call and its post-tool reply.
      expect(semanticTurnRequests, JSON.stringify(turnShapes)).toHaveLength(3);
      expect(semanticTurnRequests[0]?.body).toMatchObject({ model: GROK_LIVE_MODEL, stream: true });
      expect(
        provider.requests.every(({ url }) =>
          ['/v1/chat/completions', '/v1/responses', '/v1/models'].some((route) => url?.startsWith(route)),
        ),
      ).toBe(true);
      // The 1.0.70 origin probe is a bare GET of the provider origin, never a model call.
      expect(provider.originProbes.every(({ method, body }) => method === 'GET' && body === undefined)).toBe(true);
      await attestLiveAdapter({ vendor: 'grok', artifact: executable, testId: 'grok:native-tui-leader' });
    } finally {
      resumedProjection?.dispose();
      await resumed?.dispose();
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      // The 1.0.70 leader drains for ~2 s after SIGTERM; wait for it before
      // removing the GROK_HOME it is still writing.
      await backend.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 120_000);
});
