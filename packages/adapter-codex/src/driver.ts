/**
 * Codex session driver — the structured-driver composition (M5 C4; DESIGN
 * ADR-006 `structured` driver). The counterpart to Claude's hook+PTY
 * `createClaudeSession`, but Codex's native surface IS a structured protocol,
 * so observation and control both run over the app-server JSON-RPC:
 *
 *   initialize → initialized → thread/start   (identity: thread.sessionId is the
 *                                              runtime/native correlation key;
 *                                              thread.path is the rollout file)
 *     → onNotification → normalizer → normalized event stream
 *     → onServerRequest → structured approvals (observe + answer)
 *     → submitPrompt = turn/start + exact echoed client id confirmation
 *
 * There is NO PTY here: the structured driver observes and drives via the
 * protocol. `observationLevel()` is honestly `'structured'`. Hosting the native
 * TUI beside it (via `codex --remote`) is the desktop host's job (C6);
 * Native-TUI automation is owned by the host's ordered semantic input path.
 */

import {
  PUPPETEER_VERSION,
  type AgentEvent,
  type AgentEventSource,
  type AgentAdapterBinding,
  type ObservationLevel,
  type PromptSubmission,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { AppServerClient, spawnAppServerTransport, type Transport } from './transport/app-server-client.js';
import { CodexNotificationNormalizer } from './normalization/pipeline.js';
import { CodexMonitorEvidence } from './observation/monitor-evidence.js';
import { CodexApprovalService, type CodexApprovalDecision, type CodexApprovalRequest } from './services/approvals.js';
import { CodexEventSource } from './services/event-source.js';
import { CodexPromptService } from './services/prompt.js';

export type { CodexApprovalDecision, CodexApprovalRequest } from './services/approvals.js';

const CLIENT_INFO = { name: 'puppeteer', version: PUPPETEER_VERSION } as const;

export interface CreateCodexSessionOptions {
  cwd: string;
  /** Transport override (tests). Defaults to spawning `codex app-server`. */
  transport?: Transport;
  executable?: string;
  /** Model id applied when starting a fresh thread. */
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'untrusted';
  /** Resume an existing thread by id (`thread/resume`) instead of starting fresh. */
  resume?: string;
  /**
   * Decide structured approval requests. Default: deny (safe) — a runtime that
   * wants the agent to act must supply a policy.
   */
  onApproval?: (req: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>;
}

export interface CodexSession extends AgentAdapterBinding {
  /** Absolute path to this session's rollout JSONL (the Codex transcript analog). */
  threadPath(): string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export async function createCodexSession(options: CreateCodexSessionOptions): Promise<CodexSession> {
  const transport = options.transport ?? spawnAppServerTransport({ executable: options.executable });
  const client = new AppServerClient(transport);
  const modelNames = new Map<string, string>();
  const normalizer = new CodexNotificationNormalizer((modelId) => modelNames.get(modelId));
  let sessionId = '';
  let runtimeSessionId = '';
  let threadPath: string | undefined;
  let currentTurnId: string | undefined;
  let disposed = false;
  let bootstrapping = true;
  let observation: ObservationLevel = 'structured';
  const monitorEvidence = new CodexMonitorEvidence({
    nativeSessionId: () => sessionId || undefined,
    modelDisplayName: (modelId) => modelNames.get(modelId),
  });
  const events = new CodexEventSource({
    sessionId: () => sessionId,
    turnId: () => currentTurnId,
  });
  const prompts = new CodexPromptService({
    request: (method, params) => client.request(method, params),
    runtimeSessionId: () => runtimeSessionId,
    isDisposed: () => disposed,
  });

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch | null): void {
    if (!batch) return;
    apply({ type: 'monitor:batch', batch }, 'native-protocol', batch);
  }

  const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
  emitMonitorBatch(capabilitiesBatch);

  function apply(event: AgentEvent, source: AgentEventSource, nativeEvent?: unknown): void {
    if (disposed) return;
    events.publish(event, source, nativeEvent);
  }

  const approvals = new CodexApprovalService({
    decide: options.onApproval,
    publish: (event, nativeEvent) => apply(event, 'native-hook', nativeEvent),
    isDisposed: () => disposed,
  });

  client.onNotification((method, params) => {
    if (disposed) return;
    // Capture identity as early as the thread/started notification (it arrives
    // during the thread/start request, before its response resolves).
    if (method === 'thread/started') {
      const thread = rec(params?.thread);
      if (thread) {
        sessionId ||= str(thread.sessionId) ?? str(thread.id) ?? '';
        runtimeSessionId ||= str(thread.id) ?? sessionId;
        threadPath ??= str(thread.path);
      }
    }
    const observedAt = new Date().toISOString();
    emitMonitorBatch(
      monitorEvidence.notificationBatch({ method, params }, observedAt, bootstrapping ? 'bootstrap' : 'live'),
    );
    const notificationThreadId = str(params?.threadId) ?? str(rec(params?.thread)?.id);
    if (notificationThreadId && sessionId && notificationThreadId !== sessionId) return;
    const norm = normalizer.normalize({ method, params });
    if (norm.turnId) currentTurnId = norm.turnId;
    if (norm.userMessageClientId) {
      prompts.confirm(norm.userMessageClientId, norm.turnId);
    }
    for (const event of norm.events) {
      const source =
        event.type.startsWith('context-window:') ||
        ['environment:updated', 'model:updated', 'effort:updated', 'mode:updated'].includes(event.type)
          ? 'native-protocol'
          : 'native-hook';
      apply(event, source, { method, params });
    }
  });

  client.onServerRequest((method, params, id) => approvals.handle(method, params, id));

  client.onClose(({ code, signal }) => {
    if (disposed) return;
    prompts.transportClosed();
    observation = 'terminal-only';
    const observedAt = new Date().toISOString();
    const detail = signal ? `signal:${signal}` : code === null ? 'transport closed' : `exit:${code}`;
    emitMonitorBatch(monitorEvidence.railUnavailableBatch(observedAt, detail));
    apply(
      {
        type: 'adapter:native-event',
        adapter: 'codex',
        nativeType: 'app-server.transport.closed',
      },
      'runtime',
      { code, signal },
    );
  });

  try {
    await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
    client.notify('initialized');
    try {
      const catalog = rec(await client.request('model/list', {}));
      const models = Array.isArray(catalog?.data) ? catalog.data : Array.isArray(catalog?.models) ? catalog.models : [];
      for (const value of models) {
        const model = rec(value);
        const displayName = str(model?.displayName);
        if (!displayName) continue;
        const id = str(model?.id);
        const wireModel = str(model?.model);
        if (id) modelNames.set(id, displayName);
        if (wireModel) modelNames.set(wireModel, displayName);
      }
    } catch {
      // Catalog enrichment is optional; stable model ids remain available.
    }

    const startResult = options.resume
      ? await client.request('thread/resume', { threadId: options.resume })
      : await client.request('thread/start', {
          cwd: options.cwd,
          model: options.model,
          sandbox: options.sandbox ?? 'workspace-write',
          approvalPolicy: options.approvalPolicy ?? 'on-request',
        });

    const response = rec(startResult);
    const thread = rec(response?.thread);
    if (thread) {
      sessionId = str(thread.sessionId) ?? str(thread.id) ?? sessionId;
      runtimeSessionId = str(thread.id) ?? (runtimeSessionId || sessionId);
      threadPath = str(thread.path) ?? threadPath;
    }
    const currentCwd = str(response?.cwd) ?? str(thread?.cwd) ?? options.cwd;
    const modelId = str(response?.model) ?? options.model;
    const modelProvider = str(response?.modelProvider);
    emitMonitorBatch(
      monitorEvidence.bootstrapResponseBatch(
        { ...response, cwd: currentCwd, ...(modelId ? { model: modelId } : {}) },
        new Date().toISOString(),
        options.resume ? 'thread/resume' : 'thread/start',
        {
          ...(options.model ? { model: options.model } : {}),
          approvalPolicy: options.approvalPolicy ?? 'on-request',
          sandboxPolicy: options.sandbox ?? 'workspace-write',
        },
      ),
    );
    const bootstrapEvidence = { response: startResult, bootstrap: options.resume ? 'thread/resume' : 'thread/start' };
    apply({ type: 'environment:updated', currentCwd }, 'native-protocol', bootstrapEvidence);
    if (modelId) {
      apply(
        {
          type: 'model:updated',
          model: {
            id: modelId,
            ...(modelNames.get(modelId) ? { displayName: modelNames.get(modelId) } : {}),
            ...(modelProvider ? { provider: modelProvider } : {}),
          },
        },
        'native-protocol',
        bootstrapEvidence,
      );
    }
    bootstrapping = false;
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Codex session bootstrap and app-server cleanup both failed');
    }
    throw error;
  }

  return {
    sessionId,
    runtimeSessionId,
    observationLevel: () => observation,
    threadPath: () => threadPath,
    events: {
      onCandidate(listener) {
        if (disposed) return () => undefined;
        return events.onCandidate(listener);
      },
    },
    services: {
      prompt: {
        submit(submission: PromptSubmission) {
          return prompts.submit(submission);
        },
      },
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      prompts.dispose();
      events.close();
      await client.close();
    },
  };
}
