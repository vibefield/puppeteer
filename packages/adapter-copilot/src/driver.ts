import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { AgentAdapterBinding, AgentEvent, AgentTuiSessionOptions, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolveCopilotExecutable } from './detection.js';
import { copilotCapabilitiesBatch, copilotObservationDegradedBatch } from './normalization/monitor.js';
import { createCopilotSessionObserver } from './observation/session-observer.js';
import {
  captureCopilotReplayBoundary,
  copilotSessionLocation,
  resolveCopilotHome,
} from './observation/session-store.js';
import { CopilotEventSource } from './services/event-source.js';
import { CopilotPromptService } from './services/prompt.js';

export interface CreateCopilotTuiSessionOptions extends AgentTuiSessionOptions {
  executable?: string;
  env?: Record<string, string>;
  copilotHome?: string;
  model?: string;
  effort?: string;
  title?: string;
  mode?: 'interactive' | 'plan' | 'autopilot';
  allowAll?: boolean;
  agent?: string;
  context?: string;
  pollIntervalMs?: number;
  maxReplayBytes?: number;
  promptConfirmationTimeoutMs?: number;
}
export interface CopilotTuiSession extends AgentAdapterBinding {
  sessionDirectory(): string;
}
export interface PreparedCopilotTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<CopilotTuiSession>;
  dispose(): Promise<void>;
}
export function buildCopilotTuiArgs(
  options: Pick<
    CreateCopilotTuiSessionOptions,
    'resume' | 'title' | 'model' | 'effort' | 'mode' | 'allowAll' | 'agent' | 'context'
  >,
  sessionId: string,
): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--reasoning-effort', options.effort);
  if (options.mode) args.push('--mode', options.mode);
  if (options.allowAll) args.push('--allow-all');
  if (options.agent) args.push('--agent', options.agent);
  if (options.context) args.push('--context', options.context);
  if (options.title && !options.resume) args.push('--name', options.title);
  if (options.resume) args.push(`--resume=${options.resume}`);
  else args.push('--session-id', sessionId);
  return args;
}
export async function prepareCopilotTuiSession(
  options: CreateCopilotTuiSessionOptions,
): Promise<PreparedCopilotTuiSession> {
  const executable = resolveCopilotExecutable(options.executable);
  const home = resolveCopilotHome(options.copilotHome ?? options.env?.COPILOT_HOME);
  const sessionId = options.resume ?? randomUUID();
  const location = copilotSessionLocation(home, sessionId);
  if (options.resume) {
    try {
      await access(location.eventsPath);
    } catch {
      throw new Error(`Copilot session ${options.resume} was not found under ${home}`);
    }
  }
  const replayBoundary = options.resume ? await captureCopilotReplayBoundary(location) : 0;
  const env = { ...(options.env ?? {}), COPILOT_HOME: home };
  const launch: TerminalSpec = {
    command: executable,
    args: buildCopilotTuiArgs(options, sessionId),
    cwd: options.cwd,
    env,
  };
  let disposed = false,
    adopted: CopilotTuiSession | undefined;
  return {
    sessionId,
    launch,
    async adopt(runtimeSessionId) {
      if (disposed) throw new Error('prepared Copilot session is disposed');
      if (adopted) return adopted;
      const observer = createCopilotSessionObserver({
        location,
        replayBoundary,
        pollIntervalMs: options.pollIntervalMs,
        maxReplayBytes: options.maxReplayBytes,
      });
      const events = new CopilotEventSource(sessionId);
      let sessionDisposed = false;
      const prompts = new CopilotPromptService({
        host: options.host,
        runtimeSessionId,
        observer,
        confirmationTimeoutMs: options.promptConfirmationTimeoutMs,
        isDisposed: () => sessionDisposed,
      });
      const publish = (event: AgentEvent, meta: Parameters<CopilotEventSource['publish']>[1]) =>
        events.publish(event, meta);
      let monitorSequence = 0;
      const unsubscribeEvent = observer.onEvent((observed) => publish(observed.event, observed));
      const unsubscribeError = observer.onError((error) => {
        const observedAt = new Date().toISOString();
        publish(
          {
            type: 'monitor:batch',
            batch: copilotObservationDegradedBatch(sessionId, observedAt, ++monitorSequence),
          },
          { source: 'runtime', confidence: 'authoritative' },
        );
        publish(
          {
            type: 'adapter:native-event',
            adapter: 'copilot',
            nativeType: 'session-observer-error',
            diagnostic: { code: 'COPILOT_OBSERVER_ERROR', message: error.message },
          },
          { source: 'runtime', confidence: 'authoritative', nativeEvent: { message: error.message } },
        );
      });
      publish(
        {
          type: 'monitor:batch',
          batch: copilotCapabilitiesBatch(sessionId, new Date().toISOString(), ++monitorSequence),
        },
        { source: 'runtime', confidence: 'authoritative' },
      );
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
      if (options.allowAll)
        publish(
          {
            type: 'mode:updated',
            intent: 'configured',
            modeKind: 'provider-permission',
            mode: { raw: 'allow-all', normalized: 'auto' },
          },
          { source: 'runtime', confidence: 'authoritative' },
        );
      const session: CopilotTuiSession = {
        sessionId,
        runtimeSessionId,
        observationLevel: () => 'native-log',
        sessionDirectory: () => location.sessionDir,
        events: { onCandidate: (listener) => (sessionDisposed ? () => undefined : events.onCandidate(listener)) },
        services: { prompt: { submit: (submission) => prompts.submit(submission) } },
        async dispose() {
          if (sessionDisposed) return;
          await observer.stop();
          sessionDisposed = true;
          unsubscribeEvent();
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
export async function createCopilotTuiSession(options: CreateCopilotTuiSessionOptions): Promise<CopilotTuiSession> {
  const prepared = await prepareCopilotTuiSession(options);
  try {
    const { runtimeSessionId } = await options.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}
