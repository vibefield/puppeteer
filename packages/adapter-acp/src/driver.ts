/**
 * Generic ACP structured-driver composition.
 *
 * Category normalizers translate `session/update`; capability services own
 * approvals, elicitations, prompt framing, and candidate publication. This
 * file wires those pieces to one ACP connection and owns bootstrap/teardown.
 */

import {
  type AgentAdapterBinding,
  type AgentEvent,
  type AgentEventConfidence,
  type AgentEventSource,
  type ObservationLevel,
  type PromptSubmission,
} from '@vibecook/puppeteer-core';
import type { AdapterMonitorObservationBatch } from '@vibecook/puppeteer-core/monitor-spi';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  Agent,
  Client,
  ClientCapabilities,
  CreateElicitationResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AcpAgentConnection, AcpConnector } from './transport/connection.js';
import { AcpMonitorEvidence } from './normalization/monitor.js';
import { acpModelIdentity } from './normalization/model.js';
import { AcpNotificationNormalizer } from './normalization/pipeline.js';
import { AcpApprovalService, type AcpApprovalDecision, type AcpApprovalRequest } from './services/approvals.js';
import { AcpElicitationService, type AcpElicitationRequest } from './services/elicitation.js';
import { AcpEventSource } from './services/event-source.js';
import { AcpPromptService } from './services/prompt.js';

export type { AcpApprovalDecision, AcpApprovalRequest } from './services/approvals.js';
export type { AcpElicitationRequest } from './services/elicitation.js';

export interface CreateAcpSessionOptions {
  cwd: string;
  /** Agent-specific transport. ACP itself does not define a command to spawn. */
  connector: AcpConnector;
  /** Resume an existing ACP session by id (`session/load`, replays history). */
  resume?: string;
  /** Default: filesystem disabled, identified plan notifications enabled. */
  clientCapabilities?: ClientCapabilities;
  /** Decide structured permission requests. Default: deny. */
  onApproval?: (request: AcpApprovalRequest) => AcpApprovalDecision | Promise<AcpApprovalDecision>;
  /** Answer ACP's experimental structured elicitation request. */
  onElicitation?: (request: AcpElicitationRequest) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
  /** Agent-specific ACP extension notifications that have stable semantics. */
  onExtensionNotification?: (method: string, params: Record<string, unknown>) => readonly AgentEvent[];
}

/** No adapter-specific extras yet; the shared contract is the whole surface. */
export type AcpSession = AgentAdapterBinding;

export async function createAcpSession(options: CreateAcpSessionOptions): Promise<AcpSession> {
  const normalizer = new AcpNotificationNormalizer();
  let sessionId = options.resume ?? '';
  let disposed = false;
  let bootstrapping = true;
  let controlDegraded = false;
  let observation: ObservationLevel = 'structured';
  let connection!: AcpAgentConnection;
  let prompts!: AcpPromptService;

  const monitorEvidence = new AcpMonitorEvidence({ nativeSessionId: () => sessionId || undefined });
  const eventSource = new AcpEventSource({
    sessionId: () => sessionId,
    turnId: () => prompts.currentTurnId(),
  });

  function apply(
    event: AgentEvent,
    source: AgentEventSource,
    meta: { confidence?: AgentEventConfidence; nativeEvent?: unknown } = {},
  ): void {
    if (disposed) return;
    eventSource.publish(event, source, meta.nativeEvent, meta.confidence);
  }

  function emitMonitorBatch(batch: AdapterMonitorObservationBatch | null): void {
    if (!batch || disposed) return;
    apply({ type: 'monitor:batch', batch }, 'native-protocol', { nativeEvent: batch });
  }

  const elicitations = new AcpElicitationService({
    respond: options.onElicitation,
    publish: (event, nativeEvent) => apply(event, 'native-hook', { nativeEvent }),
  });
  const approvals = new AcpApprovalService({
    decide: options.onApproval,
    publish: (event, nativeEvent) => apply(event, 'native-hook', { nativeEvent }),
  });
  prompts = new AcpPromptService({
    sessionId: () => sessionId,
    request: (params) => connection.agent.prompt(params),
    completeReasoning: () => normalizer.completeReasoning(),
    settleElicitations: (outcome, nativeEvent) => elicitations.settlePending(outcome, nativeEvent),
    publish: (event, source, nativeEvent, confidence) => apply(event, source, { nativeEvent, confidence }),
  });

  emitMonitorBatch(monitorEvidence.capabilitiesBatch(new Date().toISOString()));

  const buildClient = (_agent: Agent): Client => ({
    sessionUpdate(params: SessionNotification): void {
      const observedAt = new Date().toISOString();
      emitMonitorBatch(monitorEvidence.sessionUpdateBatch(params, observedAt, bootstrapping ? 'bootstrap' : 'live'));
      const normalized = normalizer.normalize(params);
      const closesReasoning = normalized.events.some((event) =>
        ['conversation:assistant-message', 'tool:requested', 'tool:started', 'tool:completed', 'tool:failed'].includes(
          event.type,
        ),
      );
      if (closesReasoning) prompts.closeReasoning(params);

      for (const event of normalized.events) {
        prompts.observe(event);
        const source =
          event.type.startsWith('context-window:') ||
          ['environment:updated', 'model:updated', 'effort:updated', 'mode:updated'].includes(event.type)
            ? 'native-protocol'
            : 'native-hook';
        apply(event, source, { nativeEvent: params });
      }
    },

    extNotification(method, params): void {
      const normalized = options.onExtensionNotification?.(method, params) ?? [
        { type: 'adapter:native-event', adapter: 'acp', nativeType: method } as const,
      ];
      for (const event of normalized) apply(event, 'native-protocol', { nativeEvent: { method, params } });
    },

    requestPermission: (params) => approvals.handle(params),
    unstable_createElicitation: (params) => elicitations.handle(params),
    unstable_completeElicitation(params): void {
      elicitations.complete(params.elicitationId, params);
    },
  });

  connection = options.connector(buildClient);
  connection.onClose(({ code, signal }) => {
    if (disposed || controlDegraded) return;
    controlDegraded = true;
    observation = 'terminal-only';
    emitMonitorBatch(monitorEvidence.railUnavailableBatch(new Date().toISOString()));
    apply({ type: 'adapter:native-event', adapter: 'acp', nativeType: 'transport.closed' }, 'runtime', {
      nativeEvent: { code, signal },
    });
  });

  const baseClientCapabilities: ClientCapabilities = options.clientCapabilities ?? {
    fs: { readTextFile: false, writeTextFile: false },
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
  await connection.agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities });

  let configOptions: readonly SessionConfigOption[] | null | undefined;
  let modes: SessionModeState | null | undefined;
  if (options.resume) {
    if (!connection.agent.loadSession) {
      connection.close();
      throw new Error('ACP agent does not support session/load — cannot resume');
    }
    sessionId = options.resume;
    try {
      const response = await connection.agent.loadSession({
        sessionId: options.resume,
        cwd: options.cwd,
        mcpServers: [],
      });
      configOptions = response?.configOptions;
      modes = response?.modes;
      prompts.sealReplayedAssistant({ method: 'session/load' });
    } catch (error) {
      connection.close();
      throw error;
    }
  } else {
    const response = await connection.agent.newSession({ cwd: options.cwd, mcpServers: [] });
    sessionId = response.sessionId;
    configOptions = response.configOptions;
    modes = response.modes;
  }

  const model = acpModelIdentity(configOptions);
  const bootstrapEvidence = { bootstrap: options.resume ? 'session/load' : 'session/new', configOptions };
  apply({ type: 'environment:updated', currentCwd: options.cwd }, 'native-protocol', {
    nativeEvent: bootstrapEvidence,
  });
  if (model) apply({ type: 'model:updated', model }, 'native-protocol', { nativeEvent: bootstrapEvidence });
  apply({ type: 'session:started', nativeSessionId: sessionId }, 'native-hook');
  emitMonitorBatch(
    monitorEvidence.bootstrapBatch({ cwd: options.cwd, modes, configOptions }, new Date().toISOString()),
  );
  bootstrapping = false;

  return {
    sessionId,
    runtimeSessionId: sessionId,
    observationLevel: () => observation,
    events: {
      onCandidate(listener) {
        if (disposed) return () => undefined;
        return eventSource.onCandidate(listener);
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
      eventSource.close();
      connection.close();
    },
  };
}
