/** Complete OpenCode native-TUI recipe: private backend + REST/SSE + exact attach. */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  type AgentEvent,
  type AgentAdapterBinding,
  type AgentTuiSessionOptions,
  type TerminalSpec,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { startOpenCodeBackend, type OpenCodeBackend } from './launch/backend.js';
import {
  OpenCodeClient,
  type OpenCodeModelSelection,
  type OpenCodePermissionRequest,
  type OpenCodeQuestionRequest,
  type OpenCodeSessionInfo,
} from './transport/client.js';
import { OPENCODE_LAUNCH_FLAGS, resolveOpenCodeExecutable } from './detection.js';
import { OpenCodeEventStream, type OpenCodeSseRecord } from './transport/event-stream.js';
import {
  projectOpenCodeChild,
  projectOpenCodeHistory,
  projectOpenCodePermission,
  projectOpenCodeQuestion,
  projectOpenCodeStatus,
} from './observation/history.js';
import {
  OpenCodeNormalizer,
  type NormalizeOpenCodeOptions,
  type OpenCodeNormalizedEvent,
} from './normalization/pipeline.js';
import { OpenCodeMonitorEvidence } from './normalization/monitor.js';
import { OpenCodeEventSource, runtimeOpenCodeEvent } from './services/event-source.js';
import { OpenCodePromptService } from './services/prompt.js';

export { OpenCodePromptConfirmationGate } from './services/prompt.js';

export interface CreateOpenCodeTuiSessionOptions extends AgentTuiSessionOptions {
  /** OpenCode executable (default `PUPPETEER_OPENCODE_BIN`, then `opencode`). */
  executable?: string | undefined;
  /** Extra environment shared by the private backend and attached native TUI. */
  env?: Record<string, string> | undefined;
  title?: string | undefined;
  agent?: string | undefined;
  model?: OpenCodeModelSelection | undefined;
  permission?: unknown[] | undefined;
  contextWindowCapacityTokens?: number | undefined;
  promptConfirmationTimeoutMs?: number | undefined;
  backendStartupTimeoutMs?: number | undefined;
  backendShutdownTimeoutMs?: number | undefined;
  reconnectDelayMs?: number | undefined;
}

export interface OpenCodeTuiSession extends AgentAdapterBinding {
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
    const provisionalSessionID = `opencode-pending-${randomUUID()}`;
    let sessionInfo: OpenCodeSessionInfo | undefined;
    let normalizer: OpenCodeNormalizer | undefined;
    let liveReady = false;
    let promptModel = options.model;
    let promptAgent = options.agent ?? 'build';
    const events = new OpenCodeEventSource({
      sessionId: () => sessionInfo?.id ?? provisionalSessionID,
      nativeSessionId: () => sessionInfo?.id,
    });
    const prompts = new OpenCodePromptService({
      client,
      sessionId: () => sessionInfo?.id ?? provisionalSessionID,
      agent: () => promptAgent,
      model: () => promptModel,
      confirmationTimeoutMs: options.promptConfirmationTimeoutMs,
      isDisposed: () => disposed,
    });
    const confirmationGate = prompts.confirmations;
    let droppedBufferedRecords = 0;
    const bufferedRecords: OpenCodeSseRecord[] = [];
    const MAX_BUFFERED_RECORDS = 4096;
    const monitorEvidence = new OpenCodeMonitorEvidence({
      nativeSessionId: () => sessionInfo?.id,
      contextWindowCapacityTokens: options.contextWindowCapacityTokens,
    });

    const emitMonitorBatch = (batch: AdapterMonitorObservationBatch | null): void => {
      if (!batch || disposed) return;
      events.publish({
        event: { type: 'monitor:batch', batch },
        timestamp: batch.observedAt,
        source: 'native-protocol',
        confidence: 'authoritative',
        nativeEvent: batch,
      });
    };

    const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
    emitMonitorBatch(capabilitiesBatch);
    emitMonitorBatch(
      monitorEvidence.configuredBatch(
        { cwd: options.cwd, agent: options.agent ?? 'build', ...(options.model ? { model: options.model } : {}) },
        new Date().toISOString(),
      ),
    );

    const publishNormalized = (normalized: OpenCodeNormalizedEvent): void => {
      if (disposed) return;
      if (normalized.event.type === 'turn:started' && normalized.promptId) {
        confirmationGate.confirm(normalized.promptId, normalized.turnId ?? normalized.promptId);
      }
      events.publish(normalized);
    };

    const publishRuntime = (event: AgentEvent, nativeEvent: unknown): void => {
      if (!disposed) events.publish(runtimeOpenCodeEvent(event, nativeEvent));
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
          { type: 'adapter:native-event', adapter: 'opencode', nativeType: 'malformed-sse-record' },
          { data, error: error.message },
        );
      },
      onError(error) {
        emitMonitorBatch(monitorEvidence.railUnavailableBatch(new Date().toISOString(), error.message));
        publishRuntime(
          { type: 'adapter:native-event', adapter: 'opencode', nativeType: 'sse-disconnected' },
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
        { type: 'adapter:native-event', adapter: 'opencode', nativeType: 'initial-sse-buffer-overflow' },
        { droppedRecords: droppedBufferedRecords },
      );
    }
    publishRuntime({ type: 'session:ready' }, { type: 'opencode-adapter-ready', origin: backend.origin });

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
      prompts.dispose();
      await stream?.stop();
      await backend?.dispose();
      events.close();
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
          observationLevel: () => 'structured',
          events: {
            onCandidate(listener) {
              if (disposed) return () => undefined;
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
