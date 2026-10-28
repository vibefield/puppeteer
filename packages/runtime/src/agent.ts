import {
  type AgentAdapterBinding,
  type AgentEventEnvelope,
  type AgentEventListener,
  type AgentEventSelector,
  type AgentEnvelopeForSelector,
  type AgentMonitorHandle,
  type AgentMonitorState,
  type AgentMonitorStatus,
  type AgentTurnStop,
  type AgentTurnStopReceipt,
  type ObservationLevel,
  type PromptReceipt,
  type PromptSubmission,
  type SessionLifecycle,
  type SessionRuntimeState,
  type AdapterDisposeOptions,
} from '@vibefield/puppeteer-core';
import { AgentEventBus } from './events/event-bus.js';
import type { AgentMonitorService } from './services/monitor-service.js';
import { AgentStateService } from './services/state-service.js';
import type { AgentSessionInfo, RuntimeAgentEventEnvelope } from './types.js';

export interface AgentOptions {
  adapter: AgentAdapterBinding;
  info: AgentSessionInfo;
  monitor: AgentMonitorService;
  submitPrompt: (submission: PromptSubmission) => Promise<PromptReceipt>;
  onListenerError?: ((error: unknown, envelope: AgentEventEnvelope) => void) | undefined;
}

export interface AgentIngestResult {
  previousState: SessionRuntimeState;
  state: SessionRuntimeState;
}

const RUNTIME_AGENT_CONSTRUCTOR = Symbol('puppeteer.runtime-agent-constructor');

/**
 * The observation levels that witness an agent's turns: under them `idle` is the
 * agent's own word, not an absence of evidence.
 */
const TURN_OBSERVING_LEVELS: ReadonlySet<ObservationLevel> = new Set<ObservationLevel>([
  'structured',
  'native-hooks',
  'native-log',
]);

interface AgentInternals {
  adapter: AgentAdapterBinding;
  info: AgentSessionInfo;
  events: AgentEventBus;
  state: AgentStateService;
  monitor: AgentMonitorService;
  submitPrompt: (submission: PromptSubmission) => Promise<PromptReceipt>;
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
    provider: { ...info.provider },
    nativeSession: { ...info.nativeSession },
    continuation: { ...info.continuation },
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
      monitor: options.monitor,
      submitPrompt: options.submitPrompt,
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

  /** Detailed process/session lifecycle; orthogonal to the three-state operational status. */
  get lifecycle(): SessionLifecycle {
    return internals(this).state.currentState().lifecycle;
  }

  /** Host-owned process liveness. Adapter observation loss never changes this value by itself. */
  get alive(): boolean {
    return internals(this).monitor.current().alive;
  }

  /** Product-facing state machine derived from normalized evidence: idle, working, or blocked. */
  get status(): AgentMonitorStatus {
    return internals(this).monitor.current().status;
  }

  /** Immutable, renderer-safe monitor snapshot for this run. */
  get monitor(): AgentMonitorState {
    return internals(this).monitor.current();
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
    return internals(this).submitPrompt(submission);
  }

  /**
   * The stop that ends a turn in this agent's own TUI without quitting it, as
   * its adapter names it; undefined while the adapter names none, and then
   * what a stop sends is the host's to decide and to say.
   */
  get turnStop(): AgentTurnStop | undefined {
    return internals(this).adapter.services.turnStop?.stop;
  }

  /**
   * Send the adapter's turn stop. An adapter that names none is refused, never given a guessed key. An idle agent
   * has no turn to stop, so it is refused too and nothing is pressed: on an idle TUI the stop key is that TUI's own
   * verb (Claude's second Esc opens its rewind menu, which then takes the next prompt's keys). Only an observed idle
   * is refused: an adapter that cannot see turns reads idle for want of evidence, and its stop is sent.
   */
  stopTurn(): Promise<AgentTurnStopReceipt> {
    const service = internals(this).adapter.services.turnStop;
    if (!service) return Promise.resolve({ accepted: false, reason: 'the adapter names no turn stop' });
    if (this.status === 'idle' && TURN_OBSERVING_LEVELS.has(this.observationLevel)) {
      return Promise.resolve({ accepted: false, reason: 'idle' });
    }
    return service.submit();
  }

  observeMonitor(): AgentMonitorHandle {
    return internals(this).monitor.observe();
  }

  acknowledgeFailureBlocker(blockerId: string): boolean {
    return internals(this).monitor.acknowledgeFailure(blockerId);
  }
}

export interface AgentController {
  agent: Agent;
  accept(
    envelope: RuntimeAgentEventEnvelope,
    options?: {
      projectMonitor?: boolean | undefined;
      projectState?: boolean | undefined;
      publish?: boolean | undefined;
      hostProcessEvidence?: boolean | undefined;
    },
  ): AgentIngestResult;
  dispose(options?: AdapterDisposeOptions): Promise<void>;
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
        internal.monitor.consume(envelope, { hostProcessEvidence: acceptOptions.hostProcessEvidence });
      }
      if (acceptOptions.projectState !== false) internal.state.consume(envelope);
      if (acceptOptions.publish !== false) internal.events.emit(envelope);
      return { previousState, state: internal.state.currentState() };
    },
    async dispose(options) {
      const internal = internals(agent);
      if (internal.disposed) return;
      internal.disposed = true;
      internal.events.clear();
      await internal.adapter.dispose(options);
    },
  };
}
