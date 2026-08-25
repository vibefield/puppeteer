/** Native Kimi TUI launch/adoption recipe backed by durable wire observation. */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BufferedAgentEventSource,
  createEnvelopeStamper,
  type AgentEvent,
  type AgentHost,
  type AgentAdapterSession,
  type AgentTuiSessionOptions,
  type PromptReceipt,
  type PromptSubmission,
  type TerminalSpec,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { KimiMonitorEvidence, type KimiConfiguredIntent } from './monitor-evidence.js';
import { createKimiSessionObserver, type KimiObservedEvent, type KimiObservedRecord } from './session-observer.js';
import {
  captureKimiJournalOffsets,
  findKimiSession,
  listKimiSessionsForCwd,
  resolveKimiHome,
  type KimiSessionLocation,
} from './session-store.js';

export type KimiPermissionMode = 'manual' | 'yolo' | 'auto';

export interface CreateKimiTuiSessionOptions extends AgentTuiSessionOptions {
  /** Kimi executable (default `kimi`). */
  executable?: string;
  /** Extra environment for the native process. */
  env?: Record<string, string>;
  /** Explicit Kimi data root. Must agree with env.KIMI_CODE_HOME when both are supplied. */
  kimiHome?: string;
  model?: string;
  permissionMode?: KimiPermissionMode;
  plan?: boolean;
  /** Profile selection is valid only for a new session. */
  agent?: string;
  /** Agent markdown selection is valid only for a new session. */
  agentFile?: string;
  pollIntervalMs?: number;
  maxReplayBytes?: number;
  promptConfirmationTimeoutMs?: number;
}

export interface KimiTuiSession extends AgentAdapterSession {
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
  const executable = options.executable ?? 'kimi';
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
      const events = new BufferedAgentEventSource();
      const stamper = createEnvelopeStamper();
      const monitorEvidence = new KimiMonitorEvidence({
        nativeSessionId: () => observer.sessionId() ?? provisionalSessionId,
      });
      let sessionDisposed = false;
      let promptInFlight = false;

      const publishEvent = (
        event: AgentEvent,
        meta: Pick<KimiObservedEvent, 'promptId' | 'turnId' | 'timestamp' | 'source' | 'confidence' | 'replay'> & {
          nativeEvent?: unknown;
        },
      ): void => {
        if (sessionDisposed) return;
        const nativeSessionId = observer.sessionId();
        events.emit(
          stamper.next({
            sessionId: nativeSessionId ?? provisionalSessionId,
            ...(nativeSessionId ? { nativeSessionId } : {}),
            ...(meta.promptId ? { promptId: meta.promptId } : {}),
            ...(meta.turnId ? { turnId: meta.turnId } : {}),
            timestamp: meta.timestamp ?? new Date().toISOString(),
            monotonicTime: performance.now(),
            source: meta.source,
            confidence: meta.confidence,
            ...(meta.replay !== undefined ? { replay: meta.replay } : {}),
            event,
            nativeEvent: meta.nativeEvent,
          }),
        );
      };

      const emitMonitorBatch = (batch: AdapterMonitorObservationBatch | null): void => {
        if (!batch || sessionDisposed) return;
        publishEvent(
          { type: 'monitor.batch', batch },
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
          event: { type: 'adapter.native-event', adapter: 'kimi', nativeType: 'wire-observer-error' },
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
        onEvent(listener) {
          if (sessionDisposed) return () => undefined;
          return events.onEvent(listener);
        },
        async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
          if (sessionDisposed) return { status: 'rejected', reason: 'Kimi session observation is disposed' };
          if (promptInFlight) return { status: 'rejected', reason: 'another Kimi prompt submission is awaiting echo' };

          if (submission.mode === 'paste-only') {
            const staged = await options.host.automateTerminal(runtimeSessionId, {
              kind: 'paste',
              text: submission.text,
              submit: false,
            });
            return staged.accepted
              ? { status: 'uncertain', reason: 'prompt text was staged but not submitted' }
              : { status: 'rejected', reason: staged.reason };
          }

          promptInFlight = true;
          const expectation = observer.expectPrompt(
            submission.text,
            submission.confirmationTimeoutMs ?? options.promptConfirmationTimeoutMs ?? 10_000,
          );
          try {
            const injected = await options.host.automateTerminal(runtimeSessionId, {
              kind: 'paste',
              text: submission.text,
              submit: true,
            });
            if (!injected.accepted) {
              expectation.cancel();
              return { status: 'rejected', reason: injected.reason };
            }
            // Prompt confirmation is intentionally tied to Kimi's durable
            // `turn.prompt` echo, not to terminal acceptance or rendered text.
            void observer.poll();
            const echo = await expectation.promise;
            return echo.matched ? { status: 'confirmed' } : { status: 'uncertain', reason: echo.reason };
          } finally {
            promptInFlight = false;
          }
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
      // launch cannot race past normalized event ingestion.
      void observer.poll();
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
