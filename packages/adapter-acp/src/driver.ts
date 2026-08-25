/**
 * Generic ACP session driver (M6 / A3) — the structured-driver composition for
 * any Agent Client Protocol agent. Sibling
 * of the Codex `createCodexSession`: Codex speaks its own app-server JSON-RPC,
 * ACP speaks the standardized protocol, but both are `structured` drivers —
 * observation AND control run over the protocol, there is no PTY.
 *
 *   initialize → newSession (or loadSession, resume)   (identity: the ACP
 *                                                        sessionId is the
 *                                                        spaghetti join key)
 *     → sessionUpdate → normalizer → normalized event stream
 *     → requestPermission → structured approvals (observe + answer)
 *     → submitPrompt = session/prompt (deterministic — no `uncertain` receipt)
 *
 * TURN FRAMING lives here, not the normalizer: ACP has no turn-boundary
 * notification — `session/prompt` is one request that resolves with a
 * `stopReason`. So `submitPrompt` synthesizes `turn.started` before the request
 * and `turn.completed`/`turn.failed` when it settles. It does NOT await the
 * request (which resolves only at end-of-turn); the receipt confirms acceptance,
 * the turn completes later via events — same contract as the Codex driver.
 *
 * `observationLevel()` is honestly `'structured'`. Hosting a native TUI beside
 * this driver is an agent-specific composition outside this package.
 */

import { performance } from 'node:perf_hooks';
import {
  BufferedAgentEventSource,
  createEnvelopeStamper,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentAdapterSession,
  type AgentStructuredQuestion,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  Agent,
  Client,
  ClientCapabilities,
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { AcpNotificationNormalizer, acpModelIdentity } from './normalizer.js';
import { AcpMonitorEvidence, acpElicitationQuestions } from './monitor-evidence.js';
import type { AcpConnector } from './connection.js';

export type AcpApprovalDecision = 'approved' | 'denied';

export interface AcpApprovalRequest {
  toolCallId: string;
  tool?: string;
  input?: unknown;
  options: PermissionOption[];
}

export interface AcpElicitationRequest {
  interactionId: string;
  request: CreateElicitationRequest;
  questions: AgentStructuredQuestion[];
}

export interface CreateAcpSessionOptions {
  cwd: string;
  /** Agent-specific transport. ACP itself does not define a command to spawn. */
  connector: AcpConnector;
  /** Resume an existing ACP session by id (`session/load`, replays history). */
  resume?: string;
  /** Default: filesystem disabled, identified plan notifications enabled. */
  clientCapabilities?: ClientCapabilities;
  /**
   * Decide structured permission requests. Default: deny (safe) — a runtime
   * that wants the agent to act must supply a policy.
   */
  onApproval?: (req: AcpApprovalRequest) => AcpApprovalDecision | Promise<AcpApprovalDecision>;
  /**
   * Answer ACP's experimental structured elicitation request. Supplying this
   * callback advertises form and URL elicitation capabilities automatically.
   * Without it, an unsolicited request is declined safely.
   */
  onElicitation?: (req: AcpElicitationRequest) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
  /** Agent-specific ACP extension notifications that have stable semantics. */
  onExtensionNotification?: (method: string, params: Record<string, unknown>) => readonly AgentEvent[];
}

/** No adapter-specific extras yet; the shared contract is the whole surface. */
export type AcpSession = AgentAdapterSession;

/** Pick the ACP permission option matching an approve/deny decision. */
function decideOutcome(decision: AcpApprovalDecision, options: PermissionOption[]): RequestPermissionResponse {
  const prefix = decision === 'approved' ? 'allow' : 'reject';
  const chosen = options.find((o) => o.kind.startsWith(prefix));
  // No matching option offered → cancel (which the agent treats as "not allowed").
  if (!chosen) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
}

export async function createAcpSession(options: CreateAcpSessionOptions): Promise<AcpSession> {
  const normalizer = new AcpNotificationNormalizer();
  const stamper = createEnvelopeStamper();
  const events = new BufferedAgentEventSource();

  let sessionId = options.resume ?? '';
  let currentTurnId: string | undefined;
  let turnCounter = 0;
  let turnAssistantText = '';
  let disposed = false;
  let bootstrapping = true;
  let controlDegraded = false;
  let elicitationCounter = 0;
  let observation: ObservationLevel = 'structured';
  const urlElicitations = new Map<string, string>();
  const monitorEvidence = new AcpMonitorEvidence({ nativeSessionId: () => sessionId || undefined });

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch | null): void {
    if (!batch || disposed) return;
    apply({ type: 'monitor.batch', batch }, 'native-protocol', { nativeEvent: batch });
  }

  const capabilitiesBatch = monitorEvidence.capabilitiesBatch(new Date().toISOString());
  emitMonitorBatch(capabilitiesBatch);

  function apply(
    event: AgentEvent,
    source: AgentEventEnvelope['source'],
    meta: { confidence?: AgentEventEnvelope['confidence']; nativeEvent?: unknown } = {},
  ): void {
    if (disposed) return;
    const envelope = stamper.next({
      sessionId,
      nativeSessionId: sessionId,
      turnId: currentTurnId,
      timestamp: new Date().toISOString(),
      monotonicTime: performance.now(),
      source,
      confidence: meta.confidence ?? 'authoritative',
      event,
      nativeEvent: meta.nativeEvent,
    });
    events.emit(envelope);
  }

  function settleUrlElicitations(outcome: 'failed' | 'superseded', nativeEvent: unknown): void {
    for (const interactionId of urlElicitations.values()) {
      apply({ type: 'question.resolved', requestId: interactionId, outcome }, 'native-hook', { nativeEvent });
    }
    urlElicitations.clear();
  }

  const buildClient = (_agent: Agent): Client => ({
    sessionUpdate(params: SessionNotification): void {
      const observedAt = new Date().toISOString();
      emitMonitorBatch(monitorEvidence.sessionUpdateBatch(params, observedAt, bootstrapping ? 'bootstrap' : 'live'));
      const { events } = normalizer.normalize(params);
      const closesReasoning = events.some((event) =>
        ['assistant.message', 'tool.requested', 'tool.started', 'tool.completed', 'tool.failed'].includes(event.type),
      );
      if (closesReasoning) {
        const reasoning = normalizer.completeReasoning();
        if (reasoning.active) {
          apply({ type: 'reasoning.completed', reasoningId: reasoning.reasoningId }, 'native-hook', {
            confidence: 'derived',
            nativeEvent: params,
          });
        }
      }
      for (const event of events) {
        // Track the running assistant text so turn.completed can seal
        // lastAssistantMessage (ACP has no per-message `final` marker).
        if (event.type === 'assistant.message') turnAssistantText = event.text;
        apply(
          event,
          event.type.startsWith('context-window.') || event.type === 'session.environment.updated'
            ? 'native-protocol'
            : 'native-hook',
          {
            nativeEvent: params,
          },
        );
      }
    },
    extNotification(method, params): void {
      const events = options.onExtensionNotification?.(method, params) ?? [
        { type: 'adapter.native-event', adapter: 'acp', nativeType: method } as const,
      ];
      for (const event of events) apply(event, 'native-protocol', { nativeEvent: { method, params } });
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const requestId = params.toolCall.toolCallId;
      const tool = params.toolCall.title ?? params.toolCall.kind ?? undefined;
      apply(
        {
          type: 'permission.requested',
          requestId,
          toolCallId: requestId,
          tool,
          input: params.toolCall.rawInput,
          presentation: 'host-ui',
        },
        'native-hook',
        { nativeEvent: params },
      );
      const decision = options.onApproval
        ? await options.onApproval({
            toolCallId: requestId,
            tool,
            input: params.toolCall.rawInput,
            options: params.options,
          })
        : 'denied';
      apply(
        { type: 'permission.resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
        'native-hook',
        { nativeEvent: params },
      );
      return decideOutcome(decision, params.options);
    },
    async unstable_createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
      const nativeId =
        params.mode === 'url' && 'elicitationId' in params && typeof params.elicitationId === 'string'
          ? params.elicitationId
          : '';
      const interactionId = nativeId ? `acp-elicitation:${nativeId}` : `acp-elicitation-${++elicitationCounter}`;
      if (nativeId) urlElicitations.set(nativeId, interactionId);
      const questions = acpElicitationQuestions(params);
      apply({ type: 'question.requested', requestId: interactionId, questions }, 'native-hook', {
        nativeEvent: params,
      });
      try {
        const response = options.onElicitation
          ? await options.onElicitation({ interactionId, request: params, questions })
          : ({ action: 'decline' } as const);
        if (response.action === 'accept') {
          // URL elicitations remain pending until elicitation/complete. Form
          // responses are complete when the accepted content is returned.
          if (params.mode !== 'url') {
            apply({ type: 'question.resolved', requestId: interactionId, outcome: 'answered' }, 'native-hook', {
              nativeEvent: { request: params, response },
            });
          }
        } else if (response.action === 'decline' || response.action === 'cancel') {
          if (nativeId) urlElicitations.delete(nativeId);
          apply({ type: 'question.resolved', requestId: interactionId, outcome: 'cancelled' }, 'native-hook', {
            nativeEvent: { request: params, response },
          });
        } else {
          if (nativeId) urlElicitations.delete(nativeId);
          apply({ type: 'question.resolved', requestId: interactionId, outcome: 'failed' }, 'native-hook', {
            nativeEvent: { request: params, response },
          });
        }
        return response;
      } catch (error) {
        if (nativeId) urlElicitations.delete(nativeId);
        apply({ type: 'question.resolved', requestId: interactionId, outcome: 'failed' }, 'native-hook', {
          nativeEvent: params,
        });
        throw error;
      }
    },
    unstable_completeElicitation(params): void {
      const interactionId = urlElicitations.get(params.elicitationId);
      if (!interactionId) return;
      urlElicitations.delete(params.elicitationId);
      apply({ type: 'question.resolved', requestId: interactionId, outcome: 'answered' }, 'native-hook', {
        nativeEvent: params,
      });
    },
  });

  const conn = options.connector(buildClient);

  conn.onClose(({ code, signal }) => {
    if (disposed || controlDegraded) return;
    controlDegraded = true;
    observation = 'terminal-only';
    const observedAt = new Date().toISOString();
    emitMonitorBatch(monitorEvidence.railUnavailableBatch(observedAt));
    apply({ type: 'adapter.native-event', adapter: 'acp', nativeType: 'transport.closed' }, 'runtime', {
      nativeEvent: { code, signal },
    });
  });

  const baseClientCapabilities: ClientCapabilities = options.clientCapabilities ?? {
    fs: { readTextFile: false, writeTextFile: false },
    // This client understands the experimental identified plan replacement
    // notifications in addition to the standard root plan snapshot.
    plan: {},
  };
  const clientCapabilities: ClientCapabilities = options.onElicitation
    ? {
        ...baseClientCapabilities,
        elicitation: {
          ...(baseClientCapabilities.elicitation ?? {}),
          form: {},
          url: {},
        },
      }
    : baseClientCapabilities;
  await conn.agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities,
  });

  let configOptions: readonly SessionConfigOption[] | null | undefined;
  let modes: SessionModeState | null | undefined;
  if (options.resume) {
    // `loadSession` is optional in ACP (advertised via capability). Resume works
    // only against agents that support it — surface that plainly rather than
    // silently starting a fresh session under the caller's resume id.
    if (!conn.agent.loadSession) {
      conn.close();
      throw new Error('ACP agent does not support session/load — cannot resume');
    }
    sessionId = options.resume;
    try {
      const response = await conn.agent.loadSession({ sessionId: options.resume, cwd: options.cwd, mcpServers: [] });
      configOptions = response?.configOptions;
      modes = response?.modes;
      if (turnAssistantText) {
        // ACP replays durable history as ordinary session/update chunks while
        // session/load is in flight. The request boundary is the only native
        // signal that the replayed assistant message is complete.
        apply(
          { type: 'assistant.message', text: turnAssistantText, final: true, displayOnly: false },
          'native-protocol',
          { confidence: 'derived', nativeEvent: { method: 'session/load' } },
        );
        turnAssistantText = '';
      }
    } catch (err) {
      // Close the transport so a caller retrying resume (e.g. attaching to a
      // session another client is still registering) doesn't leak a subprocess.
      conn.close();
      throw err;
    }
  } else {
    const res = await conn.agent.newSession({ cwd: options.cwd, mcpServers: [] });
    sessionId = res.sessionId;
    configOptions = res.configOptions;
    modes = res.modes;
  }

  const model = acpModelIdentity(configOptions);
  apply(
    { type: 'session.environment.updated', currentCwd: options.cwd, ...(model ? { model } : {}) },
    'native-protocol',
    { nativeEvent: { bootstrap: options.resume ? 'session/load' : 'session/new', configOptions } },
  );
  apply({ type: 'session.started', nativeSessionId: sessionId }, 'native-hook');
  emitMonitorBatch(
    monitorEvidence.bootstrapBatch({ cwd: options.cwd, modes, configOptions }, new Date().toISOString()),
  );
  bootstrapping = false;

  return {
    sessionId,
    runtimeSessionId: sessionId,
    observationLevel: () => observation,
    onEvent(listener) {
      if (disposed) return () => undefined;
      return events.onEvent(listener);
    },
    async submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
      const turnId = `acp-turn-${++turnCounter}`;
      currentTurnId = turnId;
      turnAssistantText = '';
      apply({ type: 'turn.started', turnId, prompt: submission.text }, 'native-hook');
      // Fire-and-observe: session/prompt resolves only at END of turn, so we do
      // NOT await it. The synthesized turn.completed (below) fires when it does.
      // (`prompt` returns MaybePromise — normalize with Promise.resolve.)
      void Promise.resolve(conn.agent.prompt({ sessionId, prompt: [{ type: 'text', text: submission.text }] }))
        .then((res: PromptResponse) => {
          const reasoning = normalizer.completeReasoning();
          if (reasoning.active) {
            apply({ type: 'reasoning.completed', reasoningId: reasoning.reasoningId }, 'native-hook', {
              confidence: 'derived',
              nativeEvent: res,
            });
          }
          // A completed owning turn cannot still be waiting for its URL
          // elicitation. ACP normally sends elicitation/complete first; this
          // closes a missing-notification edge without guessing an answer.
          settleUrlElicitations('superseded', res);
          apply(
            {
              type: 'turn.completed',
              turnId,
              stopReason: res.stopReason,
              lastAssistantMessage: turnAssistantText || undefined,
            },
            'native-hook',
            { nativeEvent: res },
          );
        })
        .catch((err: unknown) => {
          const reasoning = normalizer.completeReasoning();
          if (reasoning.active) {
            apply({ type: 'reasoning.completed', reasoningId: reasoning.reasoningId }, 'native-hook', {
              confidence: 'derived',
            });
          }
          settleUrlElicitations('failed', { method: 'session/prompt', outcome: 'failed' });
          apply(
            { type: 'turn.failed', turnId, error: err instanceof Error ? err.message : String(err) },
            'native-hook',
          );
        });
      // ACP injection is structured and atomic — deterministic confirmation.
      return { status: 'confirmed', turnId };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      events.close();
      conn.close();
    },
  };
}
