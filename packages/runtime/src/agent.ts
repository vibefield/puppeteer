import {
  AgentEventBus,
  type AgentAdapterSession,
  type AgentEventEnvelope,
  type AgentEventListener,
  type AgentEventSelector,
  type AgentEnvelopeForSelector,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
  type SessionRuntimeState,
} from '@vibecook/puppeteer-core';
import { AgentConversationService, type AgentConversationSnapshot } from './services/conversation-service.js';
import type { AgentMonitorService } from './services/monitor-service.js';
import { AgentStateService } from './services/state-service.js';
import type { AgentSessionInfo, RuntimeAgentEventEnvelope } from './types.js';

export interface AgentOptions {
  adapter: AgentAdapterSession;
  info: AgentSessionInfo;
  monitor?: AgentMonitorService;
  onListenerError?: (error: unknown, envelope: AgentEventEnvelope) => void;
}

export interface AgentIngestResult {
  previousState: SessionRuntimeState;
  state: SessionRuntimeState;
}

const RUNTIME_AGENT_CONSTRUCTOR = Symbol('puppeteer.runtime-agent-constructor');

interface AgentInternals {
  adapter: AgentAdapterSession;
  info: AgentSessionInfo;
  events: AgentEventBus;
  state: AgentStateService;
  conversation: AgentConversationService;
  monitor?: AgentMonitorService;
  disposed: boolean;
}

const INTERNALS = new WeakMap<Agent, AgentInternals>();

function internals(agent: Agent): AgentInternals {
  const value = INTERNALS.get(agent);
  if (!value) throw new Error('Agent is not initialized');
  return value;
}

export function cloneAgentSessionInfo(info: AgentSessionInfo): AgentSessionInfo {
  return {
    ...info,
    nativeSession: { ...info.nativeSession },
    externalRefs: info.externalRefs.map((reference) => ({ ...reference })),
    workspace: {
      ...info.workspace,
      ...(info.workspace.repositoryDigest ? { repositoryDigest: { ...info.workspace.repositoryDigest } } : {}),
    },
  };
}

/**
 * One runtime-owned agent instance per provider spawn.
 *
 * Adapters publish normalized candidates; runtime ingress validates and stamps
 * envelopes before this object consumes them.
 * It owns service projection and exposes one `.on(...)` observation surface to
 * applications. No adapter carries a duplicate Core state reducer.
 */
export class Agent {
  constructor(options: AgentOptions, runtimeConstructor: typeof RUNTIME_AGENT_CONSTRUCTOR) {
    if (runtimeConstructor !== RUNTIME_AGENT_CONSTRUCTOR) {
      throw new Error('Agent instances are created by AgentRuntime.spawn()');
    }
    INTERNALS.set(this, {
      adapter: options.adapter,
      info: options.info,
      events: new AgentEventBus({ onListenerError: options.onListenerError }),
      state: new AgentStateService(),
      conversation: new AgentConversationService(),
      monitor: options.monitor,
      disposed: false,
    });
  }

  get info(): Readonly<AgentSessionInfo> {
    return cloneAgentSessionInfo(internals(this).info);
  }

  get runtimeRunId(): string {
    return internals(this).info.runtimeRunId;
  }

  get terminalSessionId(): string {
    return internals(this).info.terminalSessionId;
  }

  get state(): SessionRuntimeState {
    return internals(this).state.snapshot();
  }

  get conversation(): AgentConversationSnapshot {
    return internals(this).conversation.snapshot();
  }

  get observationLevel(): ObservationLevel {
    return internals(this).adapter.observationLevel();
  }

  on<Selector extends AgentEventSelector>(
    selector: Selector,
    listener: AgentEventListener<AgentEnvelopeForSelector<Selector>>,
  ): () => void {
    return internals(this).events.on(selector, listener);
  }

  submitPrompt(submission: PromptSubmission): Promise<PromptReceipt> {
    return internals(this).adapter.submitPrompt(submission);
  }
}

export interface AgentController {
  agent: Agent;
  accept(
    envelope: RuntimeAgentEventEnvelope,
    options?: {
      projectMonitor?: boolean;
      projectState?: boolean;
      projectConversation?: boolean;
      publish?: boolean;
      hostProcessEvidence?: boolean;
    },
  ): AgentIngestResult;
  dispose(): Promise<void>;
}

/** @internal Runtime-only ingress kept off the application-facing Agent class. */
export function createAgentController(options: AgentOptions): AgentController {
  const agent = new Agent(options, RUNTIME_AGENT_CONSTRUCTOR);
  return {
    agent,
    accept(envelope, acceptOptions = {}) {
      const internal = internals(agent);
      const previousState = internal.state.currentState();
      if (acceptOptions.projectMonitor !== false) {
        internal.monitor?.consume(envelope, { hostProcessEvidence: acceptOptions.hostProcessEvidence });
      }
      if (acceptOptions.projectState !== false) internal.state.consume(envelope);
      if (acceptOptions.projectConversation !== false) internal.conversation.consume(envelope);
      if (acceptOptions.publish !== false) internal.events.emit(envelope);
      return { previousState, state: internal.state.currentState() };
    },
    async dispose() {
      const internal = internals(agent);
      if (internal.disposed) return;
      internal.disposed = true;
      internal.events.clear();
      await internal.adapter.dispose();
    },
  };
}
