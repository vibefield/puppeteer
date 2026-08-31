import { randomUUID } from 'node:crypto';
import type { AgentAdapterBinding, AgentEvent, AgentTuiSessionOptions, TerminalSpec } from '@vibecook/puppeteer-core';
import { resolvePiExecutable } from './detection.js';
import { piCapabilitiesBatch, piObservationDegradedBatch } from './normalization/monitor.js';
import { createPiSessionObserver } from './observation/session-observer.js';
import {
  capturePiReplayBoundary,
  findPiSession,
  resolvePiAgentDir,
  resolvePiSessionDir,
} from './observation/session-store.js';
import { PiEventSource } from './services/event-source.js';
import { PiPromptService } from './services/prompt.js';

export interface CreatePiTuiSessionOptions extends AgentTuiSessionOptions {
  executable?: string;
  env?: Record<string, string>;
  piAgentDir?: string;
  sessionDir?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  name?: string;
  pollIntervalMs?: number;
  maxReplayBytes?: number;
}
export interface PiTuiSession extends AgentAdapterBinding {
  sessionFile(): string | undefined;
}
export interface PreparedPiTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<PiTuiSession>;
  dispose(): Promise<void>;
}

export function buildPiTuiArgs(
  options: Pick<CreatePiTuiSessionOptions, 'resume' | 'provider' | 'model' | 'thinking' | 'name'>,
  sessionId: string,
  sessionDir: string,
): string[] {
  const args = ['--session-dir', sessionDir];
  if (options.provider) args.push('--provider', options.provider);
  if (options.model) args.push('--model', options.model);
  if (options.thinking) args.push('--thinking', options.thinking);
  if (options.name) args.push('--name', options.name);
  if (options.resume) args.push('--session', options.resume);
  else args.push('--session-id', sessionId);
  return args;
}

export async function preparePiTuiSession(options: CreatePiTuiSessionOptions): Promise<PreparedPiTuiSession> {
  const executable = resolvePiExecutable(options.executable);
  const agentDir = resolvePiAgentDir(options.piAgentDir ?? options.env?.PI_CODING_AGENT_DIR);
  const sessionDir = resolvePiSessionDir(
    options.cwd,
    agentDir,
    options.sessionDir ?? options.env?.PI_CODING_AGENT_SESSION_DIR,
  );
  const location = options.resume ? await findPiSession(sessionDir, options.resume) : undefined;
  if (options.resume && !location) throw new Error(`Pi session ${options.resume} was not found in ${sessionDir}`);
  const sessionId = location?.sessionId ?? randomUUID();
  const replayBoundary = location ? await capturePiReplayBoundary(location) : 0;
  const env = { ...(options.env ?? {}), PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir };
  const launch: TerminalSpec = {
    command: executable,
    args: buildPiTuiArgs(location ? { ...options, resume: location.sessionId } : options, sessionId, sessionDir),
    cwd: options.cwd,
    env,
  };
  let disposed = false;
  let adopted: PiTuiSession | undefined;
  return {
    sessionId,
    launch,
    async adopt(runtimeSessionId) {
      if (disposed) throw new Error('prepared Pi session is disposed');
      if (adopted) return adopted;
      const observer = createPiSessionObserver({
        sessionDir,
        sessionId,
        location,
        replayBoundary,
        pollIntervalMs: options.pollIntervalMs,
        maxReplayBytes: options.maxReplayBytes,
      });
      const events = new PiEventSource({ sessionId: () => sessionId });
      let sessionDisposed = false;
      const prompts = new PiPromptService({ host: options.host, runtimeSessionId, isDisposed: () => sessionDisposed });
      const publish = (event: AgentEvent, meta: Parameters<PiEventSource['publish']>[1]) => events.publish(event, meta);
      let monitorSequence = 0;
      const unsubscribeEvent = observer.onEvent((observed) => publish(observed.event, observed));
      const unsubscribeError = observer.onError((error) => {
        const observedAt = new Date().toISOString();
        publish(
          { type: 'monitor:batch', batch: piObservationDegradedBatch(sessionId, observedAt, ++monitorSequence) },
          { source: 'runtime', confidence: 'authoritative' },
        );
        publish(
          {
            type: 'adapter:native-event',
            adapter: 'pi',
            nativeType: 'session-observer-error',
            diagnostic: { code: 'PI_OBSERVER_ERROR', message: error.message },
          },
          { source: 'runtime', confidence: 'authoritative', nativeEvent: { message: error.message } },
        );
      });
      publish(
        {
          type: 'monitor:batch',
          batch: piCapabilitiesBatch(sessionId, new Date().toISOString(), ++monitorSequence),
        },
        { source: 'runtime', confidence: 'authoritative' },
      );
      publish(
        { type: 'environment:updated', currentCwd: options.cwd },
        { source: 'runtime', confidence: 'authoritative' },
      );
      if (options.model)
        publish(
          {
            type: 'model:updated',
            intent: 'configured',
            model: { id: options.model, ...(options.provider ? { provider: options.provider } : {}) },
          },
          { source: 'runtime', confidence: 'authoritative' },
        );
      if (options.thinking)
        publish(
          { type: 'effort:updated', intent: 'configured', effort: options.thinking },
          { source: 'runtime', confidence: 'authoritative' },
        );
      const session: PiTuiSession = {
        sessionId,
        runtimeSessionId,
        observationLevel: () => 'native-log',
        sessionFile: () => observer.sessionFile(),
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

export async function createPiTuiSession(options: CreatePiTuiSessionOptions): Promise<PiTuiSession> {
  const prepared = await preparePiTuiSession(options);
  try {
    const { runtimeSessionId } = await options.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}
