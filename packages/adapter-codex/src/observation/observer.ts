/**
 * Codex thread observer (M5 C6) — attach to a thread and feed the shared
 * normalizer and publish one normalized stream. Two attach modes:
 *
 * 1. **Passive (legacy Model B):** wait for `thread/started` from another
 *    connection (e.g. a bare `codex --remote` TUI), then `thread/resume` until
 *    the rollout materializes. Used by live tests that drive a separate
 *    `createCodexSession`.
 *
 * 2. **Controller-owned (desktop-host default):** this connection
 *    `thread/start`s (or resumes a known id), materializes with an empty
 *    `thread/inject_items` so resume/TUI work without a user prompt, then
 *    opens the live stream. Proven 2026-07-15
 *    (`packages/surface/vendors/codex/probes/codex@0.147.0/controller-owned-thread-probe.mjs`): empty inject writes
 *    the rollout without a model turn, so the panel can go `ready` immediately
 *    and the TUI joins via `codex resume <id> --remote`.
 *
 * Observe-from-attach replays the completed turns returned by `thread/resume`
 * before reducing live notifications. A resumed native TUI must therefore
 * project the conversation it resumed, not appear as an empty new session.
 */

import {
  PUPPETEER_VERSION,
  type AgentAdapterEventSource,
  type AgentEvent,
  type AgentEventSource,
  type AgentModelIdentity,
  type ObservationLevel,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { AppServerClient, type Transport } from '../transport/app-server-client.js';
import { approvalResponse } from '../services/approvals.js';
import type { CodexApprovalDecision, CodexApprovalRequest } from '../driver.js';
import { CodexNotificationNormalizer } from '../normalization/pipeline.js';
import { CodexEventSource } from '../services/event-source.js';
import { readLastCodexContextWindow } from './rollout-context.js';
import { CodexMonitorEvidence, type CodexConfiguredIntent } from '../normalization/monitor.js';

const CLIENT_INFO = { name: 'puppeteer-observer', version: PUPPETEER_VERSION } as const;

/** Empty inject materializes a rollout without a model turn (probe 3). */
const MATERIALIZE_ITEMS = [{ type: 'text', text: '' }] as const;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export interface CreateCodexObserverOptions {
  transport: Transport;
  /** Decide structured approval requests. Default: deny. */
  onApproval?: ((req: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>) | undefined;
  /** Choose which thread to attach to when several appear. Default: the first. */
  selectThread?: ((threadId: string) => boolean) | undefined;
  /**
   * Attach immediately to this existing thread (resume path) instead of waiting
   * for `thread/started`. The thread must already be materializable (has a
   * rollout) — real Codex resumes always do.
   */
  threadId?: string | undefined;
  /**
   * Create + materialize a fresh thread on this connection so the session is
   * ready before any TUI attaches. Mutually exclusive with {@link threadId}.
   */
  start?:
    | {
        cwd: string;
        model?: string | undefined;
        sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined;
        approvalPolicy?: 'never' | 'on-request' | 'untrusted' | undefined;
        /**
         * Who decides a sandbox or approval policy left unset here: `'adapter'` (the
         * default) starts the thread with workspace-write and on-request; `'configuration'`
         * leaves it out of `thread/start`, and the app-server takes it from its own
         * configuration, as it does for a typed `codex`.
         */
        permissionDefaults?: 'adapter' | 'configuration' | undefined;
      }
    | undefined;
}

export interface CodexThreadInfo {
  threadId: string;
  path?: string | undefined;
}

export interface CodexObserver {
  /** The observed thread's native correlation id (undefined until one attaches). */
  readonly sessionId: string | undefined;
  observationLevel(): ObservationLevel;
  threadPath(): string | undefined;
  readonly events: AgentAdapterEventSource;
  /** Fires once a thread is picked up and its live stream is open. */
  onThread(listener: (info: CodexThreadInfo) => void): () => void;
  /** Bind a thread discovered by a native TUI resume request. */
  attachThread(threadId: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function createCodexObserver(opts: CreateCodexObserverOptions): Promise<CodexObserver> {
  if (opts.threadId && opts.start) {
    throw new Error('createCodexObserver: pass threadId OR start, not both');
  }

  const client = new AppServerClient(opts.transport);
  const modelNames = new Map<string, string>();
  let currentModel: AgentModelIdentity | null = null;
  const normalizer = new CodexNotificationNormalizer((modelId) => modelNames.get(modelId));
  const monitorEvidence = new CodexMonitorEvidence({
    nativeSessionId: () => sessionId,
    pendingModelCatalog: true,
    modelDisplayName: (modelId) => modelNames.get(modelId),
  });
  let sessionId: string | undefined;
  let threadPath: string | undefined;
  let currentTurnId: string | undefined;
  let attached = false;
  let attaching = false;
  let disposed = false;
  let railClosed = false;
  let contextWindowObserved = false;
  let observation: ObservationLevel = 'structured';
  const events = new CodexEventSource({
    sessionId: () => sessionId ?? '',
    turnId: () => currentTurnId,
  });
  const threadListeners = new Set<(info: CodexThreadInfo) => void>();
  const queuedLiveNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  let hasEventSubscriber = false;
  let historyReplayed = false;
  let pendingHistoryReplay: (() => void) | undefined;
  let pendingRailClosure: (() => void) | undefined;

  function flushHistoryReplay(): void {
    if (!hasEventSubscriber || !pendingHistoryReplay) return;
    const replay = pendingHistoryReplay;
    pendingHistoryReplay = undefined;
    replay();
  }

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch | null): void {
    if (!batch) return;
    apply({ type: 'monitor:batch', batch }, 'native-protocol', batch);
  }

  const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
  emitMonitorBatch(capabilitiesBatch);

  function apply(event: AgentEvent, source: AgentEventSource, nativeEvent?: unknown, replay = false): void {
    if (event.type === 'model:updated') currentModel = event.model;
    if (event.type === 'context-window:updated') contextWindowObserved = true;
    if (event.type === 'context-window:invalidated') contextWindowObserved = false;
    events.publish(event, source, nativeEvent, 'authoritative', replay);
  }

  function enrichCurrentModelName(): void {
    const model = currentModel;
    const displayName = model && modelNames.get(model.id);
    if (model && displayName && model.displayName !== displayName) {
      apply({ type: 'model:updated', model: { ...model, displayName } }, 'native-protocol', { method: 'model/list' });
    }
  }

  function consumeNotification(method: string, params: Record<string, unknown>, replayed = false): void {
    const observedAt = new Date().toISOString();
    emitMonitorBatch(
      monitorEvidence.notificationBatch({ method, params }, observedAt, replayed ? 'bootstrap' : 'live'),
    );
    const tid = str(params.threadId) ?? str(rec(params.thread)?.id);
    if (tid && tid !== sessionId) return;
    const norm = normalizer.normalize({ method, params });
    if (norm.turnId) currentTurnId = norm.turnId;
    for (const event of norm.events) {
      const source =
        event.type.startsWith('context-window:') ||
        ['environment:updated', 'model:updated', 'effort:updated', 'mode:updated'].includes(event.type)
          ? 'native-protocol'
          : 'native-hook';
      apply(event, source, replayed ? { method, params, replayed: true } : { method, params }, replayed);
    }
  }

  function notificationTurnId(params: Record<string, unknown>): string | undefined {
    return str(params.turnId) ?? str(rec(params.turn)?.id);
  }

  function isTurnStreamNotification(method: string): boolean {
    return method === 'turn/started' || method === 'turn/completed' || method.startsWith('item/');
  }

  function applyEnvironmentFromResponse(
    response: Record<string, unknown> | undefined,
    fallbackCwd?: string,
    fallbackModel?: string,
    configured: CodexConfiguredIntent = {},
    usageStartsAtZero = false,
  ): void {
    const thread = rec(response?.thread);
    const currentCwd = str(response?.cwd) ?? str(thread?.cwd) ?? fallbackCwd;
    const modelId = str(response?.model) ?? fallbackModel;
    const provider = str(response?.modelProvider);
    emitMonitorBatch(
      monitorEvidence.bootstrapResponseBatch(
        { ...response, ...(currentCwd ? { cwd: currentCwd } : {}) },
        new Date().toISOString(),
        'thread-response',
        configured,
        usageStartsAtZero,
      ),
    );
    if (!currentCwd && !modelId) return;
    const evidence = { response, bootstrap: 'thread-response' };
    if (currentCwd) apply({ type: 'environment:updated', currentCwd }, 'native-protocol', evidence);
    if (modelId) {
      apply(
        {
          type: 'model:updated',
          model: {
            id: modelId,
            ...(modelNames.get(modelId) ? { displayName: modelNames.get(modelId) } : {}),
            ...(provider ? { provider } : {}),
          },
        },
        'native-protocol',
        evidence,
      );
    }
  }

  function replayCompletedTurns(resumed: Record<string, unknown> | undefined): Set<string> {
    const replayedTurnIds = new Set<string>();
    const thread = rec(resumed?.thread);
    const legacyTurns = Array.isArray(thread?.turns) ? thread.turns : [];
    const page = rec(resumed?.initialTurnsPage);
    const paginatedTurns = Array.isArray(page?.data) ? page.data : [];
    const turns = paginatedTurns.length > 0 ? paginatedTurns : legacyTurns;
    for (const value of turns) {
      const turn = rec(value);
      const turnId = str(turn?.id);
      const status = str(turn?.status);
      if (!turn || !turnId || status === 'inProgress') continue;
      replayedTurnIds.add(turnId);
      consumeNotification('turn/started', { threadId: sessionId, turn }, true);
      for (const value of Array.isArray(turn.items) ? turn.items : []) {
        const item = rec(value);
        if (!item) continue;
        const params = { threadId: sessionId, turnId, item };
        consumeNotification('item/started', params, true);
        consumeNotification('item/completed', params, true);
      }
      consumeNotification('turn/completed', { threadId: sessionId, turn }, true);
    }
    return replayedTurnIds;
  }

  /**
   * Open the live stream for `threadId` via `thread/resume`, then mark ready.
   * Retries while the rollout is missing (passive mode: TUI's first turn is
   * still writing it). Controller-owned mode materializes first so this is a
   * single success.
   */
  async function attach(threadId: string, thread: Record<string, unknown> | undefined, fresh = false): Promise<void> {
    if (attached || attaching) return;
    attaching = true;
    sessionId = threadId;
    threadPath = str(thread?.path) ?? threadPath;
    if (thread) applyEnvironmentFromResponse({ thread });
    // A thread isn't materializable until it has a rollout. Passive-created threads
    // only write one on the first user message; controller-owned threads write
    // one via empty inject_items before calling attach. Retry until it takes,
    // the connection drops, or we're disposed — a bounded one-shot was the
    // "stuck at preparing, no messages" bug when a slow first turn missed it.
    let delay = 200;
    while (!attached && !disposed && !railClosed) {
      try {
        const resumed = rec(await client.request('thread/resume', { threadId })); // opens the live stream
        threadPath = str(rec(resumed?.thread)?.path) ?? threadPath;
        let history = resumed;
        applyEnvironmentFromResponse(resumed);
        if (!fresh) {
          try {
            history = rec(await client.request('thread/read', { threadId, includeTurns: true })) ?? resumed;
            threadPath = str(rec(history?.thread)?.path) ?? threadPath;
          } catch {
            // History enrichment must never prevent live resume attachment.
          }
        }
        // A thread this connection just created has no prior turns or usage.
        // Existing and externally discovered threads retain the replay barrier.
        const contextWindow = !fresh && threadPath ? await readLastCodexContextWindow(threadPath) : undefined;
        apply({ type: 'session:started', nativeSessionId: threadId }, 'native-hook');
        // A resumed history can exceed the event source's 256-event startup
        // buffer and evict session:started (leaving the monitor "Starting").
        // Replay only once the runtime has subscribed, so history streams
        // directly to its consumer without dropping bootstrap metadata.
        pendingHistoryReplay = () => {
          const replayedTurnIds = replayCompletedTurns(history);
          if (contextWindow && !contextWindowObserved) {
            emitMonitorBatch(
              monitorEvidence.contextBootstrapBatch(contextWindow, new Date().toISOString(), 'rollout-token-count'),
            );
            apply(contextWindow, 'native-log', { path: threadPath, bootstrap: 'rollout-token-count' });
          }
          historyReplayed = true;
          // Keep live traffic behind the replay barrier, including traffic
          // received between attachment and the first runtime subscription.
          // A completed turn already in thread/read must not be reduced twice.
          for (const notification of queuedLiveNotifications.splice(0)) {
            const turnId = notificationTurnId(notification.params);
            if (turnId && replayedTurnIds.has(turnId) && isTurnStreamNotification(notification.method)) continue;
            consumeNotification(notification.method, notification.params);
          }
          pendingRailClosure?.();
          pendingRailClosure = undefined;
        };
        attached = true;
        attaching = false;
        flushHistoryReplay();
      } catch {
        if (disposed || railClosed) break;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(Math.floor(delay * 1.5), 2000);
      }
    }
    if (!attached) {
      attaching = false; // disposed before the thread ever materialized
      return;
    }
    for (const l of threadListeners) l({ threadId, path: threadPath });
  }

  client.onNotification((method, params) => {
    if (!attached) {
      const notificationParams = params ?? {};
      if (attaching) {
        queuedLiveNotifications.push({ method, params: notificationParams });
        return;
      }
      // Passive mode only: wait for another client (the TUI) to create a thread.
      // Controller-owned start/resume never relies on this path.
      if (!opts.threadId && !opts.start && method === 'thread/started') {
        const thread = rec(params?.thread);
        const tid = str(thread?.id);
        if (tid && (!opts.selectThread || opts.selectThread(tid))) void attach(tid, thread);
      }
      return; // ignore everything until we've attached to a thread
    }
    if (!historyReplayed) {
      queuedLiveNotifications.push({ method, params: params ?? {} });
      return;
    }
    // Only our thread's notifications drive the normalized stream (avoid cross-thread bleed).
    consumeNotification(method, params ?? {});
  });

  client.onServerRequest(async (method, params, id) => {
    const requestId = String(id);
    apply(
      { type: 'interaction:permission-requested', requestId, tool: method, input: params, presentation: 'host-ui' },
      'native-hook',
      { method, params, id },
    );
    const decision = opts.onApproval ? await opts.onApproval({ method, params, requestId: id }) : 'denied';
    apply(
      { type: 'interaction:permission-resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
      'native-hook',
      { method, params, id },
    );
    // Per-method response shape; see approvals.ts.
    return approvalResponse(method, decision);
  });

  client.onClose(({ code, signal }) => {
    if (disposed) return;
    railClosed = true; // let any in-flight attach retry loop exit without ending the host process
    observation = 'terminal-only';
    const observedAt = new Date().toISOString();
    const detail = signal ? `signal:${signal}` : code === null ? 'transport closed' : `exit:${code}`;
    const publishClosure = () => {
      emitMonitorBatch(monitorEvidence.railUnavailableBatch(observedAt, detail));
      if (attached) {
        apply(
          { type: 'adapter:native-event', adapter: 'codex', nativeType: 'app-server.transport.closed' },
          'runtime',
          {
            code,
            signal,
          },
        );
      }
    };
    if (attached && !historyReplayed) pendingRailClosure = publishClosure;
    else publishClosure();
  });

  await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
  client.notify('initialized');
  // Display names are optional metadata. Neither a slow catalog nor its request
  // timeout belongs on the native thread's ready path.
  void (async () => {
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
      // A missing/older model-list method must not prevent session attachment.
    }
    // Release retained claims even when the transport closed during lookup.
    const catalogBatch = monitorEvidence.modelCatalogBatch(new Date().toISOString());
    if (disposed || railClosed) return;
    emitMonitorBatch(catalogBatch);
    enrichCurrentModelName();
  })();

  // Controller-owned bootstrap: create + materialize, or resume a known id,
  // before returning so callers can spawn `codex resume <id> --remote` with a
  // ready join key and the panel can leave `preparing` immediately.
  if (opts.start) {
    // The one place a managed thread's unset permissions are decided. Left out of
    // thread/start, they come from the app-server's own configuration, and the model is
    // told exactly what a typed `codex` tells it (0.157.1 probes S24/S25 and S27/S28:
    // identical permission text). The explicit defaults override a config.toml (S26
    // measured it), so they stay only for a caller that is not a typed launch.
    const fromConfiguration = opts.start.permissionDefaults === 'configuration';
    const sandbox = opts.start.sandbox ?? (fromConfiguration ? undefined : 'workspace-write');
    const approvalPolicy = opts.start.approvalPolicy ?? (fromConfiguration ? undefined : 'on-request');
    const startResult = await client.request('thread/start', {
      cwd: opts.start.cwd,
      model: opts.start.model,
      ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    });
    const thread = rec(rec(startResult)?.thread);
    const tid = str(thread?.id) ?? str(thread?.sessionId);
    if (!tid) {
      await client.close();
      throw new Error('codex thread/start returned no thread id');
    }
    threadPath = str(thread?.path);
    // Empty text item materializes the rollout without a model turn (probe 3).
    // Without this, thread/resume and `codex resume --remote` fail with
    // "no rollout found" until the user types.
    await client.request('thread/inject_items', { threadId: tid, items: [...MATERIALIZE_ITEMS] });
    await attach(tid, thread, true);
    if (!attached) {
      await client.close();
      throw new Error(`codex observer failed to attach to owned thread ${tid}`);
    }
    applyEnvironmentFromResponse(
      rec(startResult),
      opts.start.cwd,
      opts.start.model,
      {
        ...(opts.start.model ? { model: opts.start.model } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandbox ? { sandboxPolicy: sandbox } : {}),
      },
      true,
    );
  } else if (opts.threadId) {
    await attach(opts.threadId, undefined);
    if (!attached) {
      await client.close();
      throw new Error(`codex observer failed to attach to thread ${opts.threadId}`);
    }
  }

  return {
    get sessionId() {
      return sessionId;
    },
    observationLevel: () => observation,
    threadPath: () => threadPath,
    events: {
      onCandidate(listener) {
        const unsubscribe = events.onCandidate(listener);
        hasEventSubscriber = true;
        flushHistoryReplay();
        return unsubscribe;
      },
    },
    onThread(listener) {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    attachThread: (threadId) => attach(threadId, undefined),
    async dispose() {
      disposed = true; // stop the attach retry loop if it is still running
      pendingHistoryReplay = undefined;
      pendingRailClosure = undefined;
      queuedLiveNotifications.length = 0;
      events.close();
      await client.close();
    },
  };
}
