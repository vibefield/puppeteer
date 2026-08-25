/**
 * Codex session driver — the structured-driver composition (M5 C4; DESIGN
 * ADR-006 `structured` driver). The counterpart to Claude's hook+PTY
 * `createClaudeSession`, but Codex's native surface IS a structured protocol,
 * so observation and control both run over the app-server JSON-RPC:
 *
 *   initialize → initialized → thread/start   (identity: thread.sessionId is the
 *                                              spaghetti join key; thread.path is
 *                                              the rollout file)
 *     → onNotification → normalizer → normalized event stream
 *     → onServerRequest → structured approvals (observe + answer)
 *     → submitPrompt = turn/start + exact echoed client id confirmation
 *
 * There is NO PTY here: the structured driver observes and drives via the
 * protocol. `observationLevel()` is honestly `'structured'`. Hosting the native
 * TUI beside it (via `codex --remote`) is the desktop host's job (C6);
 * Native-TUI automation is owned by the host's ordered semantic input path.
 */

import { performance } from 'node:perf_hooks';
import {
  BufferedAgentEventSource,
  createEnvelopeStamper,
  PUPPETEER_VERSION,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentAdapterSession,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { approvalResponse } from './control/approvals.js';
import {
  AppServerClient,
  AppServerRequestTimeoutError,
  spawnAppServerTransport,
  type Transport,
} from './transport/app-server-client.js';
import { CodexNotificationNormalizer } from './normalizer.js';
import { CodexMonitorEvidence } from './observation/monitor-evidence.js';

const CLIENT_INFO = { name: 'puppeteer', version: PUPPETEER_VERSION } as const;

export type CodexApprovalDecision = 'approved' | 'denied';

export interface CodexApprovalRequest {
  /** The server-request method, e.g. an exec/apply-patch/permission approval. */
  method: string;
  params: Record<string, unknown> | undefined;
  requestId: number | string;
}

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

export interface CodexSession extends AgentAdapterSession {
  /** Absolute path to this session's rollout JSONL (the Codex transcript analog). */
  threadPath(): string | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

interface PendingInjection {
  resolve: (receipt: PromptReceipt) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export async function createCodexSession(options: CreateCodexSessionOptions): Promise<CodexSession> {
  const transport = options.transport ?? spawnAppServerTransport({ executable: options.executable });
  const client = new AppServerClient(transport);
  const modelNames = new Map<string, string>();
  const normalizer = new CodexNotificationNormalizer((modelId) => modelNames.get(modelId));
  const monitorEvidence = new CodexMonitorEvidence({
    nativeSessionId: () => sessionId || undefined,
    modelDisplayName: (modelId) => modelNames.get(modelId),
  });
  const stamper = createEnvelopeStamper();

  const events = new BufferedAgentEventSource();
  let sessionId = '';
  let runtimeSessionId = '';
  let threadPath: string | undefined;
  let currentTurnId: string | undefined;
  let injectionCounter = 0;
  let disposed = false;
  let bootstrapping = true;
  let observation: ObservationLevel = 'structured';
  const pendingInjections = new Map<string, PendingInjection>();

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch | null): void {
    if (!batch) return;
    apply({ type: 'monitor.batch', batch }, 'native-protocol', batch);
  }

  const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
  emitMonitorBatch(capabilitiesBatch);

  function settleInjection(clientUserMessageId: string, receipt: PromptReceipt): void {
    const pending = pendingInjections.get(clientUserMessageId);
    if (!pending) return;
    pendingInjections.delete(clientUserMessageId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(receipt);
  }

  function apply(event: AgentEvent, source: AgentEventEnvelope['source'], nativeEvent?: unknown): void {
    if (disposed) return;
    const envelope = stamper.next({
      sessionId,
      nativeSessionId: sessionId,
      turnId: currentTurnId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source,
      confidence: 'authoritative',
      event,
      nativeEvent,
    });
    events.emit(envelope);
  }

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
      settleInjection(norm.userMessageClientId, { status: 'confirmed', turnId: norm.turnId });
    }
    for (const event of norm.events) {
      const source =
        event.type.startsWith('context-window.') || event.type === 'session.environment.updated'
          ? 'native-protocol'
          : 'native-hook';
      apply(event, source, { method, params });
    }
  });

  client.onServerRequest(async (method, params, id) => {
    if (disposed) throw new Error('codex session is disposed');
    // Structured approval: observe it, decide, answer, record the resolution.
    const requestId = String(id);
    apply(
      { type: 'permission.requested', requestId, tool: method, input: params, presentation: 'host-ui' },
      'native-hook',
      { method, params, id },
    );
    const decision = options.onApproval ? await options.onApproval({ method, params, requestId: id }) : 'denied';
    apply(
      { type: 'permission.resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
      'native-hook',
      { method, params, id },
    );
    // Translated to this method's own response shape; `{decision}` verbatim was
    // valid on none of them (approvals.ts). Non-approval server requests throw,
    // which the client turns into a JSON-RPC error.
    return approvalResponse(method, decision);
  });

  client.onClose(({ code, signal }) => {
    if (disposed) return;
    for (const clientUserMessageId of [...pendingInjections.keys()]) {
      settleInjection(clientUserMessageId, {
        status: 'uncertain',
        reason: 'app-server transport closed before matching clientUserMessageId arrived',
      });
    }
    observation = 'terminal-only';
    const observedAt = new Date().toISOString();
    const detail = signal ? `signal:${signal}` : code === null ? 'transport closed' : `exit:${code}`;
    emitMonitorBatch(monitorEvidence.railUnavailableBatch(observedAt, detail));
    apply(
      {
        type: 'adapter.native-event',
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
    apply(
      {
        type: 'session.environment.updated',
        currentCwd,
        ...(modelId
          ? {
              model: {
                id: modelId,
                ...(modelNames.get(modelId) ? { displayName: modelNames.get(modelId) } : {}),
                ...(modelProvider ? { provider: modelProvider } : {}),
              },
            }
          : {}),
      },
      'native-protocol',
      { response: startResult, bootstrap: options.resume ? 'thread/resume' : 'thread/start' },
    );
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
    onEvent(listener) {
      if (disposed) return () => undefined;
      return events.onEvent(listener);
    },
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      if (disposed) return { status: 'rejected', reason: 'codex session is disposed' };
      // A successful turn/start means the server accepted the request, but the
      // exact clientUserMessageId echo is the deterministic confirmation that
      // this session observed OUR input. Do not claim another concurrent
      // prompt, or a server that accepted then lost the item, as confirmed.
      const clientUserMessageId = `puppeteer-inj-${++injectionCounter}`;
      let resolveReceipt!: (receipt: PromptReceipt) => void;
      const receipt = new Promise<PromptReceipt>((resolve) => {
        resolveReceipt = resolve;
      });
      pendingInjections.set(clientUserMessageId, { resolve: resolveReceipt });
      try {
        await client.request('turn/start', {
          threadId: runtimeSessionId,
          input: [{ type: 'text', text: submission.text }],
          clientUserMessageId,
        });
        const pending = pendingInjections.get(clientUserMessageId);
        if (pending) {
          const timeoutMs = submission.confirmationTimeoutMs ?? 5000;
          pending.timer = setTimeout(() => {
            settleInjection(clientUserMessageId, {
              status: 'uncertain',
              reason: `turn/start succeeded but no matching clientUserMessageId arrived within ${timeoutMs}ms`,
            });
          }, timeoutMs);
          pending.timer.unref?.();
        }
        return await receipt;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        settleInjection(
          clientUserMessageId,
          err instanceof AppServerRequestTimeoutError
            ? { status: 'uncertain', reason }
            : { status: 'rejected', reason },
        );
        // A concurrent transport close or dispose may already have settled a
        // more precise uncertain outcome before request() rejected.
        return await receipt;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const clientUserMessageId of [...pendingInjections.keys()]) {
        settleInjection(clientUserMessageId, {
          status: 'uncertain',
          reason: 'codex session disposed before matching clientUserMessageId arrived',
        });
      }
      events.close();
      await client.close();
    },
  };
}
