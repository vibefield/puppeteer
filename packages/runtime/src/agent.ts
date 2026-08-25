import {
  AgentEventBus,
  createInitialSessionState,
  reduceSessionState,
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
import { AgentConversationProjector, type AgentConversationSnapshot } from './conversation.js';
import type { AgentSessionInfo } from './types.js';

export interface AgentOptions {
  adapter: AgentAdapterSession;
  info: AgentSessionInfo;
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
  conversation: AgentConversationProjector;
  state: SessionRuntimeState;
  disposed: boolean;
}

const INTERNALS = new WeakMap<Agent, AgentInternals>();

function internals(agent: Agent): AgentInternals {
  const value = INTERNALS.get(agent);
  if (!value) throw new Error('Agent is not initialized');
  return value;
}

/**
 * One runtime-owned agent instance per provider spawn.
 *
 * Adapters publish normalized envelopes; this object is their first consumer.
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
      conversation: new AgentConversationProjector(),
      state: createInitialSessionState(),
      disposed: false,
    });
  }

  get info(): Readonly<AgentSessionInfo> {
    return internals(this).info;
  }

  get runtimeRunId(): string {
    return internals(this).info.runtimeRunId;
  }

  get terminalSessionId(): string {
    return internals(this).info.terminalSessionId;
  }

  get state(): SessionRuntimeState {
    return internals(this).state;
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
    envelope: AgentEventEnvelope,
    options?: { projectState?: boolean; projectConversation?: boolean; publish?: boolean },
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
      const previousState = internal.state;
      if (acceptOptions.projectState !== false && envelope.service !== 'monitor') {
        internal.state = reduceSessionState(internal.state, envelope);
      }
      if (acceptOptions.projectConversation !== false && envelope.service !== 'monitor') {
        internal.conversation.consume(envelope);
      }
      if (acceptOptions.publish !== false) internal.events.emit(envelope);
      return { previousState, state: internal.state };
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
