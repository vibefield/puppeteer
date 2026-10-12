/** Native Kimi TUI launch/adoption recipe backed by durable wire observation. */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  type AgentEvent,
  type AgentHost,
  type AgentAdapterBinding,
  type AgentTuiSessionOptions,
  type TerminalSpec,
} from '@vibefield/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibefield/puppeteer-core/monitor-spi';
import { resolveKimiExecutable } from './detection.js';
import { KimiMonitorEvidence, type KimiConfiguredIntent } from './normalization/monitor.js';
import {
  createKimiSessionObserver,
  type KimiObservedEvent,
  type KimiObservedRecord,
} from './observation/session-observer.js';
import { KimiEventSource } from './services/event-source.js';
import { KimiPromptService } from './services/prompt.js';
import {
  captureKimiJournalOffsets,
  findKimiSession,
  listKimiSessionsForCwd,
  resolveKimiHome,
  type KimiSessionLocation,
} from './observation/session-store.js';

export type KimiPermissionMode = 'manual' | 'yolo' | 'auto';

export interface CreateKimiTuiSessionOptions extends AgentTuiSessionOptions {
  /** Kimi executable (default `kimi`). */
  executable?: string | undefined;
  /** Extra environment for the native process. */
  env?: Record<string, string> | undefined;
  /** Explicit Kimi data root. Must agree with env.KIMI_CODE_HOME when both are supplied. */
  kimiHome?: string | undefined;
  model?: string | undefined;
  permissionMode?: KimiPermissionMode | undefined;
  plan?: boolean | undefined;
  /** Profile selection is valid only for a new session. */
  agent?: string | undefined;
  /** Agent markdown selection is valid only for a new session. */
  agentFile?: string | undefined;
  pollIntervalMs?: number | undefined;
  maxReplayBytes?: number | undefined;
  promptConfirmationTimeoutMs?: number | undefined;
}

export interface KimiTuiSession extends AgentAdapterBinding {
  /** Absolute native session directory once Kimi lazily creates and binds it. */
  sessionDirectory(): string | undefined;
}

export interface PreparedKimiTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<KimiTuiSession>;
  dispose(): Promise<void>;
}

export function buildKimiTuiArgs(
  options: Pick<CreateKimiTuiSessionOptions, 'resume' | 'model' | 'permissionMode' | 'plan' | 'agent' | 'agentFile'>,
): string[] {
  if (options.resume && (options.agent || options.agentFile)) {
    throw new Error('Kimi cannot combine --session with --agent or --agent-file');
  }
  if (options.agent && options.agentFile) throw new Error('Kimi accepts --agent or --agent-file, not both');

  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  if (options.permissionMode === 'yolo') args.push('--yolo');
  if (options.permissionMode === 'auto') args.push('--auto');
  if (options.plan) args.push('--plan');
  if (options.agent) args.push('--agent', options.agent);
  if (options.agentFile) args.push('--agent-file', options.agentFile);
  if (options.resume) args.push('--session', options.resume);
  return args;
}

function resolvedLaunchEnvironment(
  options: CreateKimiTuiSessionOptions,
  kimiHome: string,
): Record<string, string> | undefined {
  const extra = options.env ? { ...options.env } : undefined;
  if (options.kimiHome) {
    const fromEnv = extra?.KIMI_CODE_HOME;
    if (fromEnv && resolve(fromEnv) !== resolve(options.kimiHome)) {
      throw new Error('kimiHome and env.KIMI_CODE_HOME must resolve to the same directory');
    }
    return { ...(extra ?? {}), KIMI_CODE_HOME: kimiHome };
  }
  return extra;
}

/** Prepare the launch recipe and immutable discovery/replay baseline without spawning a PTY. */
export async function prepareKimiTuiSession(options: CreateKimiTuiSessionOptions): Promise<PreparedKimiTuiSession> {
  const executable = resolveKimiExecutable(options.executable);
  const configuredHome = options.kimiHome ?? options.env?.KIMI_CODE_HOME;
  const kimiHome = resolveKimiHome(configuredHome);
  const env = resolvedLaunchEnvironment(options, kimiHome);
  const launch: TerminalSpec = {
    command: executable,
    args: buildKimiTuiArgs(options),
    cwd: options.cwd,
    ...(env ? { env } : {}),
  };

  let location: KimiSessionLocation | undefined;
  let replayOffsets = new Map<string, number>();
  let baselineSessionIds = new Set<string>();
  if (options.resume) {
    location = await findKimiSession(kimiHome, options.resume, options.cwd);
    if (!location) throw new Error(`Kimi session ${options.resume} was not found for ${options.cwd}`);
    replayOffsets = await captureKimiJournalOffsets(location.sessionDir);
  } else {
    baselineSessionIds = new Set((await listKimiSessionsForCwd(kimiHome, options.cwd)).map((item) => item.sessionId));
  }

  const provisionalSessionId = location?.sessionId ?? `kimi-pending-${randomUUID()}`;
  let disposed = false;
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: KimiTuiSession | undefined;

  return {
    sessionId: provisionalSessionId,
    launch,
    async adopt(runtimeSessionId): Promise<KimiTuiSession> {
      if (disposed) throw new Error('prepared Kimi session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Kimi session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;

      const observer = createKimiSessionObserver({
        kimiHome,
        cwd: options.cwd,
        location,
        baselineSessionIds,
        replayOffsets,
        pollIntervalMs: options.pollIntervalMs,
        maxReplayBytes: options.maxReplayBytes,
      });
      const events = new KimiEventSource({
        sessionId: () => observer.sessionId() ?? provisionalSessionId,
        nativeSessionId: () => observer.sessionId(),
      });
      const monitorEvidence = new KimiMonitorEvidence({
        nativeSessionId: () => observer.sessionId() ?? provisionalSessionId,
      });
      let sessionDisposed = false;
      const prompts = new KimiPromptService({
        host: options.host,
        runtimeSessionId,
        observer,
        confirmationTimeoutMs: options.promptConfirmationTimeoutMs,
        isDisposed: () => sessionDisposed,
      });

      const publishEvent = (
        event: AgentEvent,
        meta: Pick<KimiObservedEvent, 'promptId' | 'turnId' | 'timestamp' | 'source' | 'confidence' | 'replay'> & {
          nativeEvent?: unknown;
        },
      ): void => {
        if (sessionDisposed) return;
        events.publish(event, meta);
      };

      const emitMonitorBatch = (batch: AdapterMonitorObservationBatch | null): void => {
        if (!batch || sessionDisposed) return;
        publishEvent(
          { type: 'monitor:batch', batch },
          { timestamp: batch.observedAt, source: 'native-log', confidence: 'authoritative' },
        );
      };

      const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
      emitMonitorBatch(capabilitiesBatch);
      const configured: KimiConfiguredIntent = {
        cwd: options.cwd,
        model: options.model,
        permissionMode: options.permissionMode,
        plan: options.plan,
      };
      let configuredEmitted = false;
      const publishConfigured = (): void => {
        if (configuredEmitted) return;
        configuredEmitted = true;
        emitMonitorBatch(monitorEvidence.configuredBatch(configured, new Date().toISOString()));
      };

      const publish = (observed: KimiObservedEvent): void => {
        if (sessionDisposed) return;
        emitMonitorBatch(monitorEvidence.observerEventBatch(observed, new Date().toISOString()));
        publishEvent(observed.event, observed);
      };

      const unsubscribeEvent = observer.onEvent(publish);
      const unsubscribeRecord = observer.onRecord((observed: KimiObservedRecord) => {
        emitMonitorBatch(monitorEvidence.recordBatch(observed, new Date().toISOString()));
      });
      const unsubscribeBind = observer.onBind(publishConfigured);
      const unsubscribeError = observer.onError((error) => {
        const observedAt = new Date().toISOString();
        emitMonitorBatch(monitorEvidence.observerDegradedBatch(observedAt));
        publish({
          event: { type: 'adapter:native-event', adapter: 'kimi', nativeType: 'wire-observer-error' },
          source: 'runtime',
          confidence: 'authoritative',
          nativeEvent: { message: error.message },
        });
      });

      const session: KimiTuiSession = {
        get sessionId(): string {
          return observer.sessionId() ?? provisionalSessionId;
        },
        runtimeSessionId,
        observationLevel: () => 'native-log',
        sessionDirectory: () => observer.sessionDirectory(),
        events: {
          onCandidate(listener) {
            if (sessionDisposed) return () => undefined;
            return events.onCandidate(listener);
          },
        },
        services: {
          prompt: {
            submit(submission) {
              return prompts.submit(submission);
            },
          },
        },
        async dispose() {
          if (sessionDisposed) return;
          // Keep the normalized event stream connected through the observer's
          // final bounded poll so durable records at host teardown are not lost.
          await observer.stop();
          sessionDisposed = true;
          unsubscribeEvent();
          unsubscribeRecord();
          unsubscribeBind();
          unsubscribeError();
          events.close();
        },
      };
      adoptedSession = session;
      // Listener wiring precedes the first read so replay and a fast native
      // launch cannot race past normalized event ingestion. Adoption does not
      // complete until the bounded bootstrap read has populated the buffered
      // candidate stream, so resumed sessions are ready deterministically.
      await observer.poll();
      return session;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await adoptedSession?.dispose();
    },
  };
}

export async function createKimiTuiSession(options: CreateKimiTuiSessionOptions): Promise<KimiTuiSession> {
  const prepared = await prepareKimiTuiSession(options);
  try {
    const { runtimeSessionId } = await options.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}
