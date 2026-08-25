/** Complete OpenCode native-TUI recipe: private backend + REST/SSE + exact attach. */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentSession,
  type AgentTuiSessionOptions,
  type PromptReceipt,
  type PromptSubmission,
  type SessionRuntimeState,
  type TerminalSpec,
} from '@vibecook/chopsticks-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/chopsticks-core/monitor-spi';
import { startOpenCodeBackend, type OpenCodeBackend } from './backend.js';
import {
  OpenCodeClient,
  OpenCodeHttpError,
  type OpenCodeModelSelection,
  type OpenCodePermissionRequest,
  type OpenCodeQuestionRequest,
  type OpenCodeSessionInfo,
} from './client.js';
import { OPENCODE_LAUNCH_FLAGS, resolveOpenCodeExecutable } from './detection.js';
import { OpenCodeEventStream, type OpenCodeSseRecord } from './event-stream.js';
import {
  projectOpenCodeChild,
  projectOpenCodeHistory,
  projectOpenCodePermission,
  projectOpenCodeQuestion,
  projectOpenCodeStatus,
} from './history.js';
import { OpenCodeNormalizer, type NormalizeOpenCodeOptions, type OpenCodeNormalizedEvent } from './normalizer.js';
import { OpenCodeMonitorEvidence } from './monitor-evidence.js';

export interface CreateOpenCodeTuiSessionOptions extends AgentTuiSessionOptions {
  /** OpenCode executable (default `CHOPSTICKS_OPENCODE_BIN`, then `opencode`). */
  executable?: string;
  /** Extra environment shared by the private backend and attached native TUI. */
  env?: Record<string, string>;
  title?: string;
  agent?: string;
  model?: OpenCodeModelSelection;
  permission?: unknown[];
  contextWindowCapacityTokens?: number;
  promptConfirmationTimeoutMs?: number;
  backendStartupTimeoutMs?: number;
  backendShutdownTimeoutMs?: number;
  reconnectDelayMs?: number;
}

export interface OpenCodeTuiSession extends AgentSession {
  backendOrigin(): string;
  backendPid(): number | undefined;
  backendRunning(): boolean;
  reconcile(): Promise<void>;
  abort(): Promise<boolean>;
  replyPermission(requestID: string, reply: 'once' | 'always' | 'reject'): Promise<boolean>;
  replyQuestion(requestID: string, answers: string[][]): Promise<boolean>;
  rejectQuestion(requestID: string): Promise<boolean>;
  trackedDiff(): Promise<unknown[]>;
}

export interface PreparedOpenCodeTuiSession {
  readonly sessionId: string;
  readonly launch: TerminalSpec;
  adopt(runtimeSessionId: string): Promise<OpenCodeTuiSession>;
  dispose(): Promise<void>;
}

interface PromptConfirmation {
  matched: boolean;
  turnId?: string;
  reason?: string;
}

interface PendingPromptConfirmation {
  promise: Promise<PromptConfirmation>;
  cancel(reason: string): void;
}

/** Exact-ID confirmation primitive, exported so timeout/correlation behavior is unit-testable. */
export class OpenCodePromptConfirmationGate {
  private readonly pending = new Map<string, { resolve(result: PromptConfirmation): void; timer: NodeJS.Timeout }>();

  expect(messageID: string, timeoutMs: number): PendingPromptConfirmation {
    if (this.pending.has(messageID)) throw new Error(`OpenCode prompt ${messageID} is already awaiting confirmation`);
    let settle!: (result: PromptConfirmation) => void;
    const promise = new Promise<PromptConfirmation>((resolvePromise) => {
      settle = resolvePromise;
    });
    const finish = (result: PromptConfirmation): void => {
      const entry = this.pending.get(messageID);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(messageID);
      entry.resolve(result);
    };
    const timer = setTimeout(
      () => finish({ matched: false, reason: `no message.updated echo for ${messageID} within ${timeoutMs}ms` }),
      timeoutMs,
    );
    this.pending.set(messageID, { resolve: settle, timer });
    return {
      promise,
      cancel: (reason) => finish({ matched: false, reason }),
    };
  }

  confirm(messageID: string, turnId = messageID): boolean {
    const entry = this.pending.get(messageID);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(messageID);
    entry.resolve({ matched: true, turnId });
    return true;
  }

  rejectAll(reason: string): void {
    for (const [messageID, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(messageID);
      entry.resolve({ matched: false, reason });
    }
  }
}

function toPromptModel(model: OpenCodeSessionInfo['model']): OpenCodeModelSelection | undefined {
  if (!model) return undefined;
  return {
    providerID: model.providerID,
    modelID: model.id,
    ...(model.variant ? { variant: model.variant } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function userMessageID(record: OpenCodeSseRecord): string | undefined {
  if (record.type !== 'message.updated') return undefined;
  const info = isRecord(record.properties.info) ? record.properties.info : undefined;
  return info?.role === 'user' && typeof info.id === 'string' ? info.id : undefined;
}

function recordSessionID(record: OpenCodeSseRecord): string | undefined {
  const info = isRecord(record.properties.info) ? record.properties.info : undefined;
  const direct =
    typeof record.properties.sessionID === 'string'
      ? record.properties.sessionID
      : typeof info?.sessionID === 'string'
        ? info.sessionID
        : undefined;
  if (direct) return direct;
  if (
    typeof info?.id === 'string' &&
    (record.type === 'session.created' || record.type === 'session.updated' || record.type === 'session.deleted')
  ) {
    return info.id;
  }
  return undefined;
}

function sessionModelFromRecord(record: OpenCodeSseRecord): OpenCodeModelSelection | undefined {
  if (record.type !== 'session.updated' && record.type !== 'session.created') return undefined;
  const info = isRecord(record.properties.info) ? record.properties.info : undefined;
  const model = isRecord(info?.model) ? info.model : undefined;
  if (typeof model?.providerID !== 'string' || typeof model.id !== 'string') return undefined;
  return {
    providerID: model.providerID,
    modelID: model.id,
    ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
  };
}

/** Prepare the private service, exact native session, observer, and attach recipe. */
export async function prepareOpenCodeTuiSession(
  options: CreateOpenCodeTuiSessionOptions,
): Promise<PreparedOpenCodeTuiSession> {
  const executable = resolveOpenCodeExecutable(options.executable);
  let backend: OpenCodeBackend | undefined;
  let stream: OpenCodeEventStream | undefined;
  let disposed = false;

  try {
    backend = await startOpenCodeBackend({
      executable,
      env: options.env,
      startupTimeoutMs: options.backendStartupTimeoutMs,
      shutdownTimeoutMs: options.backendShutdownTimeoutMs,
    });
    const client = new OpenCodeClient({
      origin: backend.origin,
      directory: options.cwd,
      username: backend.username,
      password: backend.password,
    });
    const stamper = createEnvelopeStamper();
    const listeners = new Set<(event: AgentEventEnvelope) => void>();
    const monitorListeners = new Set<(batch: AdapterMonitorObservationBatch) => void>();
    const pendingMonitorBatches: AdapterMonitorObservationBatch[] = [];
    const confirmationGate = new OpenCodePromptConfirmationGate();
    const provisionalSessionID = `opencode-pending-${randomUUID()}`;
    let state = createInitialSessionState();
    let sessionInfo: OpenCodeSessionInfo | undefined;
    let normalizer: OpenCodeNormalizer | undefined;
    let liveReady = false;
    let promptInFlight = false;
    let promptModel = options.model;
    let promptAgent = options.agent ?? 'build';
    let droppedBufferedRecords = 0;
    const bufferedRecords: OpenCodeSseRecord[] = [];
    const MAX_BUFFERED_RECORDS = 4096;
    const monitorEvidence = new OpenCodeMonitorEvidence({
      nativeSessionId: () => sessionInfo?.id,
      contextWindowCapacityTokens: options.contextWindowCapacityTokens,
    });

    const emitMonitorBatch = (batch: AdapterMonitorObservationBatch | null): void => {
      if (!batch || disposed) return;
      if (monitorListeners.size === 0) {
        pendingMonitorBatches.push(batch);
        if (pendingMonitorBatches.length > 512) {
          pendingMonitorBatches.splice(0, pendingMonitorBatches.length - 512);
        }
        return;
      }
      for (const listener of monitorListeners) {
        try {
          listener(batch);
        } catch {
          // Monitor consumers cannot affect native observation.
        }
      }
    };

    const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
    emitMonitorBatch(capabilitiesBatch);
    emitMonitorBatch(
      monitorEvidence.configuredBatch(
        { cwd: options.cwd, agent: options.agent ?? 'build', ...(options.model ? { model: options.model } : {}) },
        new Date().toISOString(),
      ),
    );

    const publishEnvelope = (envelope: AgentEventEnvelope): void => {
      if (disposed) return;
      state = reduceSessionState(state, envelope);
      if (envelope.event.type === 'turn.started' && envelope.promptId) {
        confirmationGate.confirm(envelope.promptId, envelope.turnId ?? envelope.promptId);
      }
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch {
          // Listener failures cannot break native observation or Core reduction.
        }
      }
    };

    const publishNormalized = (normalized: OpenCodeNormalizedEvent): void => {
      const nativeSessionID = sessionInfo?.id;
      publishEnvelope(
        stamper.next({
          sessionId: nativeSessionID ?? provisionalSessionID,
          ...(nativeSessionID ? { nativeSessionId: nativeSessionID } : {}),
          ...(normalized.promptId ? { promptId: normalized.promptId } : {}),
          ...(normalized.turnId ? { turnId: normalized.turnId } : {}),
          timestamp: normalized.timestamp,
          monotonicTime: performance.now(),
          source: normalized.source,
          confidence: normalized.confidence,
          ...(normalized.replay === undefined ? {} : { replay: normalized.replay }),
          event: normalized.event,
          nativeEvent: normalized.nativeEvent,
        }),
      );
    };

    const publishRuntime = (event: AgentEvent, nativeEvent: unknown): void => {
      const nativeSessionID = sessionInfo?.id;
      publishEnvelope(
        stamper.next({
          sessionId: nativeSessionID ?? provisionalSessionID,
          ...(nativeSessionID ? { nativeSessionId: nativeSessionID } : {}),
          timestamp: new Date().toISOString(),
          monotonicTime: performance.now(),
          source: 'runtime',
          confidence: 'derived',
          event,
          nativeEvent,
        }),
      );
    };

    const ingest = (
      record: OpenCodeSseRecord,
      normalizeOptions: NormalizeOpenCodeOptions = {},
      monitorPhase: 'bootstrap' | 'live' | 'resync' = normalizeOptions.replay ? 'bootstrap' : 'live',
    ): void => {
      const exactPromptID = userMessageID(record);
      if (exactPromptID) confirmationGate.confirm(exactPromptID);
      const rootRecord = recordSessionID(record) === sessionInfo?.id;
      const changedModel = rootRecord ? sessionModelFromRecord(record) : undefined;
      if (changedModel) promptModel = changedModel;
      const info = isRecord(record.properties.info) ? record.properties.info : undefined;
      if (rootRecord && typeof info?.agent === 'string') promptAgent = info.agent;
      emitMonitorBatch(monitorEvidence.recordBatch(record, new Date().toISOString(), monitorPhase));
      for (const normalized of normalizer?.normalize(record, normalizeOptions) ?? []) publishNormalized(normalized);
    };

    const reconcile = async (phase: 'bootstrap' | 'resync' = liveReady ? 'resync' : 'bootstrap'): Promise<void> => {
      if (!normalizer || !sessionInfo || disposed) return;
      const [info, messages, statuses, permissions, questions, children] = await Promise.all([
        client.getSession(sessionInfo.id),
        client.listMessages(sessionInfo.id),
        client.getStatuses(),
        client.listPermissions(),
        client.listQuestions(),
        client.listChildren(sessionInfo.id),
      ]);
      if (info.id !== sessionInfo.id) throw new Error(`OpenCode hydration returned unexpected session ${info.id}`);
      const currentChildren = children.filter((child) => child.parentID === info.id);
      const childMessages = await Promise.all(currentChildren.map((child) => client.listMessages(child.id)));
      sessionInfo = info;
      promptModel = options.model ?? toPromptModel(info.model) ?? promptModel;
      if (info.agent) promptAgent = info.agent;
      emitMonitorBatch(monitorEvidence.sessionBatch(info, new Date().toISOString(), phase));
      for (const normalized of normalizer.normalizeSession(info, {
        replay: true,
        nativeEvent: { type: 'http/session.get', body: info },
      })) {
        publishNormalized(normalized);
      }
      for (const child of currentChildren) {
        const projection = projectOpenCodeChild(child);
        ingest(projection.record, { replay: true, nativeEvent: projection.nativeEvent }, phase);
      }
      for (const projection of projectOpenCodeHistory(messages)) {
        ingest(projection.record, { replay: true, nativeEvent: projection.nativeEvent }, phase);
      }
      for (let index = 0; index < currentChildren.length; index++) {
        const child = currentChildren[index]!;
        for (const projection of projectOpenCodeHistory(childMessages[index] ?? [])) {
          ingest(projection.record, { replay: true, nativeEvent: projection.nativeEvent }, phase);
        }
        const childStatus = projectOpenCodeStatus(child.id, statuses[child.id]);
        ingest(childStatus.record, { replay: true, nativeEvent: childStatus.nativeEvent }, phase);
      }
      const observedSessions = new Set([info.id, ...currentChildren.map((child) => child.id)]);
      for (const request of permissions.filter((entry: OpenCodePermissionRequest) =>
        observedSessions.has(entry.sessionID),
      )) {
        const projection = projectOpenCodePermission(request);
        ingest(projection.record, { replay: true, nativeEvent: projection.nativeEvent }, phase);
      }
      for (const request of questions.filter((entry: OpenCodeQuestionRequest) =>
        observedSessions.has(entry.sessionID),
      )) {
        const projection = projectOpenCodeQuestion(request);
        ingest(projection.record, { replay: true, nativeEvent: projection.nativeEvent }, phase);
      }
      const status = projectOpenCodeStatus(info.id, statuses[info.id]);
      ingest(status.record, { replay: true, nativeEvent: status.nativeEvent }, phase);
      emitMonitorBatch(
        monitorEvidence.childrenSnapshotBatch(currentChildren, statuses, new Date().toISOString(), phase),
      );
      emitMonitorBatch(
        monitorEvidence.historySnapshotBatch([...messages, ...childMessages.flat()], new Date().toISOString(), phase),
      );
    };

    const resynchronize = async (): Promise<void> => {
      emitMonitorBatch(monitorEvidence.railRecoveringBatch(new Date().toISOString()));
      try {
        await reconcile('resync');
        emitMonitorBatch(monitorEvidence.railReadyBatch(new Date().toISOString()));
      } catch (error) {
        emitMonitorBatch(
          monitorEvidence.railUnavailableBatch(
            new Date().toISOString(),
            `OpenCode durable resync failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        throw error;
      }
    };

    stream = new OpenCodeEventStream({
      client,
      reconnectDelayMs: options.reconnectDelayMs,
      async onOpen({ reconnect }) {
        if (reconnect && normalizer) await resynchronize();
      },
      onRecord(record) {
        if (!liveReady) {
          if (bufferedRecords.length >= MAX_BUFFERED_RECORDS) {
            bufferedRecords.shift();
            droppedBufferedRecords += 1;
          }
          bufferedRecords.push(record);
          return;
        }
        ingest(record);
      },
      onMalformed(data, error) {
        publishRuntime(
          { type: 'adapter.native-event', adapter: 'opencode', nativeType: 'malformed-sse-record' },
          { data, error: error.message },
        );
      },
      onError(error) {
        emitMonitorBatch(monitorEvidence.railUnavailableBatch(new Date().toISOString(), error.message));
        publishRuntime(
          { type: 'adapter.native-event', adapter: 'opencode', nativeType: 'sse-disconnected' },
          { message: error.message },
        );
      },
    });
    await stream.start();

    if (options.resume) {
      sessionInfo = await client.getSession(options.resume);
      if (resolve(sessionInfo.directory) !== resolve(options.cwd)) {
        throw new Error(`OpenCode session ${options.resume} belongs to ${sessionInfo.directory}, not ${options.cwd}`);
      }
    } else {
      sessionInfo = await client.createSession({
        ...(options.title ? { title: options.title } : {}),
        ...(options.model
          ? {
              model: {
                providerID: options.model.providerID,
                id: options.model.modelID,
                ...(options.model.variant ? { variant: options.model.variant } : {}),
              },
            }
          : {}),
        ...(options.permission ? { permission: options.permission } : {}),
      });
    }
    normalizer = new OpenCodeNormalizer({
      sessionID: sessionInfo.id,
      contextWindowCapacityTokens: options.contextWindowCapacityTokens,
    });
    promptModel = options.model ?? toPromptModel(sessionInfo.model);
    if (sessionInfo.agent) promptAgent = sessionInfo.agent;
    emitMonitorBatch(monitorEvidence.sessionBatch(sessionInfo, new Date().toISOString(), 'bootstrap'));
    for (const normalized of normalizer.normalizeSession(sessionInfo, {
      replay: options.resume !== undefined,
      nativeEvent: {
        type: options.resume ? 'http/session.get' : 'http/session.create',
        body: sessionInfo,
      },
    })) {
      publishNormalized(normalized);
    }
    await reconcile('bootstrap');
    liveReady = true;
    for (const record of bufferedRecords.splice(0)) ingest(record, {}, 'bootstrap');
    if (droppedBufferedRecords > 0) {
      publishRuntime(
        { type: 'adapter.native-event', adapter: 'opencode', nativeType: 'initial-sse-buffer-overflow' },
        { droppedRecords: droppedBufferedRecords },
      );
    }
    publishRuntime({ type: 'session.ready' }, { type: 'opencode-adapter-ready', origin: backend.origin });

    const sessionID = sessionInfo.id;
    const launchEnvironment: Record<string, string> = {
      ...options.env,
      OPENCODE_SERVER_USERNAME: backend.username,
      OPENCODE_SERVER_PASSWORD: backend.password,
    };
    const launch: TerminalSpec = {
      command: executable,
      args: [
        OPENCODE_LAUNCH_FLAGS.attach,
        backend.origin,
        OPENCODE_LAUNCH_FLAGS.directory,
        options.cwd,
        OPENCODE_LAUNCH_FLAGS.session,
        sessionID,
        OPENCODE_LAUNCH_FLAGS.pure,
      ],
      cwd: options.cwd,
      env: launchEnvironment,
    };

    let adoptedRuntimeSessionId: string | undefined;
    let adoptedSession: OpenCodeTuiSession | undefined;

    const disposeOwned = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      confirmationGate.rejectAll('OpenCode session observation was disposed');
      await stream?.stop();
      await backend?.dispose();
      listeners.clear();
      monitorListeners.clear();
      pendingMonitorBatches.length = 0;
    };

    return {
      sessionId: sessionID,
      launch,
      async adopt(runtimeSessionId): Promise<OpenCodeTuiSession> {
        if (disposed) throw new Error('prepared OpenCode session is disposed');
        if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
          throw new Error(`prepared OpenCode session is already adopted by ${adoptedRuntimeSessionId}`);
        }
        if (adoptedSession) return adoptedSession;
        adoptedRuntimeSessionId = runtimeSessionId;
        adoptedSession = {
          sessionId: sessionID,
          runtimeSessionId,
          state: (): SessionRuntimeState => state,
          observationLevel: () => 'structured',
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          onMonitorBatch(listener) {
            if (disposed) return () => undefined;
            monitorListeners.add(listener);
            const pending = pendingMonitorBatches.splice(0);
            if (!pending.includes(capabilitiesBatch)) {
              try {
                listener(capabilitiesBatch);
              } catch {
                // Initial delivery has the same isolation guarantee as live fan-out.
              }
            }
            for (const batch of pending) {
              try {
                listener(batch);
              } catch {
                // Initial delivery has the same isolation guarantee as live fan-out.
              }
            }
            return () => monitorListeners.delete(listener);
          },
          async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
            if (disposed) return { status: 'rejected', reason: 'OpenCode session observation is disposed' };
            if (promptInFlight) {
              return { status: 'rejected', reason: 'another OpenCode prompt is awaiting exact message-ID echo' };
            }
            promptInFlight = true;
            const messageID = `msg_chopsticks_${randomUUID().replaceAll('-', '')}`;
            const expectation = confirmationGate.expect(
              messageID,
              submission.confirmationTimeoutMs ?? options.promptConfirmationTimeoutMs ?? 10_000,
            );
            try {
              try {
                await client.submitPrompt(sessionID, {
                  messageID,
                  agent: promptAgent,
                  ...(promptModel ? { model: promptModel } : {}),
                  parts: [{ type: 'text', text: submission.text }],
                });
              } catch (error) {
                expectation.cancel('OpenCode prompt request did not complete');
                if (error instanceof OpenCodeHttpError && error.status >= 400 && error.status < 500) {
                  return { status: 'rejected', reason: `OpenCode rejected the prompt with status ${error.status}` };
                }
                return {
                  status: 'uncertain',
                  reason: `OpenCode prompt acceptance could not be determined: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                };
              }
              const confirmation = await expectation.promise;
              return confirmation.matched
                ? { status: 'confirmed', ...(confirmation.turnId ? { turnId: confirmation.turnId } : {}) }
                : { status: 'uncertain', reason: confirmation.reason ?? 'exact OpenCode prompt echo was not observed' };
            } finally {
              promptInFlight = false;
            }
          },
          backendOrigin: () => backend!.origin,
          backendPid: () => backend!.pid,
          backendRunning: () => backend!.running(),
          reconcile: resynchronize,
          abort: () => client.abort(sessionID),
          replyPermission: (requestID, reply) => client.replyPermission(requestID, reply),
          replyQuestion: (requestID, answers) => client.replyQuestion(requestID, answers),
          rejectQuestion: (requestID) => client.rejectQuestion(requestID),
          trackedDiff: () => client.getTrackedDiff(),
          dispose: disposeOwned,
        };
        return adoptedSession;
      },
      dispose: disposeOwned,
    };
  } catch (error) {
    disposed = true;
    await stream?.stop().catch(() => undefined);
    await backend?.dispose().catch(() => undefined);
    throw error;
  }
}

export async function createOpenCodeTuiSession(options: CreateOpenCodeTuiSessionOptions): Promise<OpenCodeTuiSession> {
  const prepared = await prepareOpenCodeTuiSession(options);
  try {
    const { runtimeSessionId } = await options.host.spawnTerminal(prepared.launch);
    return await prepared.adopt(runtimeSessionId);
  } catch (error) {
    await prepared.dispose();
    throw error;
  }
}
