import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { AgentAdapterBinding, AgentEvent, AgentTuiSessionOptions, TerminalSpec } from '@vibefield/puppeteer-core';
import { resolveAntigravityExecutable } from './detection.js';
import { antigravityCapabilitiesBatch, antigravityObservationDegradedBatch } from './normalization/monitor.js';
import { createAntigravitySessionObserver } from './observation/session-observer.js';
import {
  antigravitySessionLocation,
  captureAntigravityReplayBoundary,
  listAntigravitySessions,
  resolveAntigravityDataRoot,
} from './observation/session-store.js';
import { AntigravityEventSource } from './services/event-source.js';
import { AntigravityPromptService } from './services/prompt.js';
export interface CreateAntigravityTuiSessionOptions extends AgentTuiSessionOptions {
  executable?: string | undefined;
  env?: Record<string, string> | undefined;
  antigravityHome?: string | undefined;
  dataRoot?: string | undefined;
  model?: string | undefined;
  effort?: 'low' | 'medium' | 'high' | undefined;
  mode?: 'default' | 'accept-edits' | 'plan' | undefined;
  skipPermissions?: boolean | undefined;
  sandbox?: boolean | undefined;
  agent?: string | undefined;
  project?: string | undefined;
  addDirs?: string[] | undefined;
  pollIntervalMs?: number | undefined;
  maxReplayBytes?: number | undefined;
  promptConfirmationTimeoutMs?: number | undefined;
}
export interface AntigravityTuiSession extends AgentAdapterBinding {
  sessionDirectory(): string | undefined;
}
export interface PreparedAntigravityTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<AntigravityTuiSession>;
  dispose(): Promise<void>;
}
export function buildAntigravityTuiArgs(
  options: Pick<
    CreateAntigravityTuiSessionOptions,
    'resume' | 'model' | 'effort' | 'mode' | 'skipPermissions' | 'sandbox' | 'agent' | 'project' | 'addDirs'
  >,
): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.mode) args.push('--mode', options.mode);
  if (options.skipPermissions) args.push('--dangerously-skip-permissions');
  if (options.sandbox) args.push('--sandbox');
  if (options.agent) args.push('--agent', options.agent);
  if (options.project) args.push('--project', options.project);
  for (const directory of options.addDirs ?? []) args.push('--add-dir', directory);
  if (options.resume) args.push('--conversation', options.resume);
  return args;
}
export async function prepareAntigravityTuiSession(
  options: CreateAntigravityTuiSessionOptions,
): Promise<PreparedAntigravityTuiSession> {
  const executable = resolveAntigravityExecutable(options.executable);
  const configuredHome = options.antigravityHome ?? options.env?.PUPPETEER_ANTIGRAVITY_HOME;
  const root = resolveAntigravityDataRoot({
    home: configuredHome,
    dataRoot: options.dataRoot ?? options.env?.PUPPETEER_ANTIGRAVITY_DATA_ROOT,
  });
  const location = options.resume ? antigravitySessionLocation(root, options.resume) : undefined;
  if (location) {
    try {
      await access(location.transcriptPath);
    } catch {
      throw new Error(`Antigravity conversation ${options.resume} was not found under ${root}`);
    }
  }
  const replayBoundary = location ? await captureAntigravityReplayBoundary(location) : 0;
  const baselineSessionIds = new Set(
    location ? [] : (await listAntigravitySessions(root)).map((item) => item.sessionId),
  );
  const provisionalSessionId = location?.sessionId ?? `antigravity-pending-${randomUUID()}`;
  const env = {
    ...(options.env ?? {}),
    ...(configuredHome ? { HOME: configuredHome, PUPPETEER_ANTIGRAVITY_HOME: configuredHome } : {}),
  };
  const launch: TerminalSpec = {
    command: executable,
    args: buildAntigravityTuiArgs(options),
    cwd: options.cwd,
    ...(Object.keys(env).length ? { env } : {}),
  };
  let disposed = false,
    adopted: AntigravityTuiSession | undefined;
  return {
    sessionId: provisionalSessionId,
    launch,
    async adopt(runtimeSessionId) {
      if (disposed) throw new Error('prepared Antigravity session is disposed');
      if (adopted) return adopted;
      const observer = createAntigravitySessionObserver({
        root,
        location,
        replayBoundary,
        baselineSessionIds,
        pollIntervalMs: options.pollIntervalMs,
        maxReplayBytes: options.maxReplayBytes,
      });
      const events = new AntigravityEventSource({
        sessionId: () => observer.sessionId() ?? provisionalSessionId,
        nativeSessionId: () => observer.sessionId(),
      });
      let sessionDisposed = false;
      const prompts = new AntigravityPromptService({
        host: options.host,
        runtimeSessionId,
        observer,
        confirmationTimeoutMs: options.promptConfirmationTimeoutMs,
        isDisposed: () => sessionDisposed,
      });
      const publish = (event: AgentEvent, meta: Parameters<AntigravityEventSource['publish']>[1]) =>
        events.publish(event, meta);
      let monitorSequence = 0;
      const publishBinding = (nativeSessionId: string) => {
        publish(
          {
            type: 'session:started',
            nativeSessionId,
            startSource: options.resume ? 'conversation-resume' : 'transcript-bind',
          },
          { source: 'native-log', confidence: 'authoritative' },
        );
        publish(
          {
            type: 'monitor:batch',
            batch: antigravityCapabilitiesBatch(nativeSessionId, new Date().toISOString(), ++monitorSequence),
          },
          { source: 'runtime', confidence: 'authoritative' },
        );
      };
      const unsubscribeEvent = observer.onEvent((observed) => publish(observed.event, observed));
      const unsubscribeBind = observer.onBind((bound) => publishBinding(bound.sessionId));
      const unsubscribeError = observer.onError((error) => {
        const observedAt = new Date().toISOString();
        const nativeSessionId = observer.sessionId() ?? provisionalSessionId;
        publish(
          {
            type: 'monitor:batch',
            batch: antigravityObservationDegradedBatch(nativeSessionId, observedAt, ++monitorSequence),
          },
          { source: 'runtime', confidence: 'authoritative' },
        );
        publish(
          {
            type: 'adapter:native-event',
            adapter: 'antigravity',
            nativeType: 'transcript-observer-error',
            diagnostic: { code: 'ANTIGRAVITY_OBSERVER_ERROR', message: error.message },
          },
          { source: 'runtime', confidence: 'authoritative', nativeEvent: { message: error.message } },
        );
      });
      publish(
        { type: 'environment:updated', currentCwd: options.cwd },
        { source: 'runtime', confidence: 'authoritative' },
      );
      if (options.model)
        publish(
          { type: 'model:updated', intent: 'configured', model: { id: options.model } },
          { source: 'runtime', confidence: 'authoritative' },
        );
      if (options.effort)
        publish(
          { type: 'effort:updated', intent: 'configured', effort: options.effort },
          { source: 'runtime', confidence: 'authoritative' },
        );
      if (options.mode)
        publish(
          {
            type: 'mode:updated',
            intent: 'configured',
            modeKind: 'provider-session',
            mode: { raw: options.mode, normalized: options.mode },
          },
          { source: 'runtime', confidence: 'authoritative' },
        );
      if (options.skipPermissions)
        publish(
          {
            type: 'mode:updated',
            intent: 'configured',
            modeKind: 'provider-permission',
            mode: { raw: 'dangerously-skip-permissions', normalized: 'auto' },
          },
          { source: 'runtime', confidence: 'authoritative' },
        );
      const session: AntigravityTuiSession = {
        get sessionId() {
          return observer.sessionId() ?? provisionalSessionId;
        },
        runtimeSessionId,
        observationLevel: () => 'native-log',
        sessionDirectory: () => observer.sessionDirectory(),
        events: { onCandidate: (listener) => (sessionDisposed ? () => undefined : events.onCandidate(listener)) },
        services: { prompt: { submit: (submission) => prompts.submit(submission) } },
        async dispose() {
          if (sessionDisposed) return;
          await observer.stop();
          sessionDisposed = true;
          unsubscribeEvent();
          unsubscribeBind();
          unsubscribeError();
          events.close();
        },
      };
      adopted = session;
      await observer.poll();
      return session;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await adopted?.dispose();
    },
  };
}
export async function createAntigravityTuiSession(
  options: CreateAntigravityTuiSessionOptions,
): Promise<AntigravityTuiSession> {
  const prepared = await prepareAntigravityTuiSession(options);
  try {
    const { runtimeSessionId } = await options.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}
