import type {
  AgentEvent,
  AgentEventForType,
  AgentEventEnvelope,
  AgentEventService,
  AgentEventServiceOf,
  AgentServiceEventType,
} from './events.js';
import { agentEventService, agentServiceEventType } from './events.js';

type EnvelopeForService<Event extends AgentEvent, Service extends AgentEventService> = Event extends AgentEvent
  ? AgentEventServiceOf<Event> extends Service
    ? AgentEventEnvelope<Event>
    : never
  : never;

/** Exact listener payload inferred from the schema registered for `Type`. */
export type AgentEnvelopeForType<Type extends AgentServiceEventType> = AgentEventEnvelope<AgentEventForType<Type>>;
export type AgentEnvelopeForService<Service extends AgentEventService> = EnvelopeForService<AgentEvent, Service>;
export type AgentEventSelector = '*' | `${AgentEventService}:*` | AgentServiceEventType;
export type AgentEnvelopeForSelector<Selector extends AgentEventSelector> = Selector extends '*'
  ? AgentEventEnvelope
  : Selector extends `${infer Service extends AgentEventService}:*`
    ? AgentEnvelopeForService<Service>
    : Selector extends AgentServiceEventType
      ? AgentEnvelopeForType<Selector>
      : never;
export type AgentEventListener<Envelope extends AgentEventEnvelope = AgentEventEnvelope> = (envelope: Envelope) => void;

export interface AgentEventBusOptions {
  onListenerError?: (error: unknown, envelope: AgentEventEnvelope) => void;
}

/** Freeze schema-owned payload structure while leaving opaque tool data alone. */
function freezeNormalizedEvent(event: AgentEvent): void {
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) freeze(item);
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (key !== 'input' && key !== 'output') freeze(item);
      }
    }
    Object.freeze(value);
  };
  freeze(event);
}

/**
 * Synchronous, provider-neutral event bus for one live agent.
 *
 * Exact routes (`context-window:updated`), category routes (`tool:*`), and the
 * catch-all route (`*`) all observe the same immutable envelope. A listener
 * failure is isolated from ingestion and from the other services.
 */
export class AgentEventBus {
  readonly #all = new Set<AgentEventListener>();
  readonly #services = new Map<AgentEventService, Set<AgentEventListener>>();
  readonly #types = new Map<AgentServiceEventType, Set<AgentEventListener>>();
  readonly #onListenerError?: AgentEventBusOptions['onListenerError'];

  constructor(options: AgentEventBusOptions = {}) {
    this.#onListenerError = options.onListenerError;
  }

  on<Selector extends AgentEventSelector>(
    selector: Selector,
    listener: AgentEventListener<AgentEnvelopeForSelector<Selector>>,
  ): () => void {
    const listeners = this.listenersFor(selector, true)!;
    listeners.add(listener as AgentEventListener);
    return () => {
      listeners.delete(listener as AgentEventListener);
    };
  }

  emit(envelope: AgentEventEnvelope): void {
    const canonicalType = agentServiceEventType(envelope.event);
    const canonicalService = agentEventService(envelope.event);
    if (envelope.type !== canonicalType || envelope.service !== canonicalService) {
      throw new TypeError(
        `agent event envelope route mismatch: expected ${canonicalType} (${canonicalService}), received ${envelope.type} (${envelope.service})`,
      );
    }
    // All selector scopes receive this exact object. Freeze the public
    // normalized shell so an earlier listener cannot alter what later
    // listeners observe. Opaque nested provider evidence remains untouched.
    if (envelope.sourceEventRef) Object.freeze(envelope.sourceEventRef);
    freezeNormalizedEvent(envelope.event);
    Object.freeze(envelope);
    this.deliver(this.#all, envelope);
    this.deliver(this.#services.get(envelope.service), envelope);
    this.deliver(this.#types.get(envelope.type), envelope);
  }

  clear(): void {
    this.#all.clear();
    this.#services.clear();
    this.#types.clear();
  }

  private listenersFor(selector: AgentEventSelector, create: boolean): Set<AgentEventListener> | undefined {
    if (selector === '*') return this.#all;
    if (selector.endsWith(':*')) {
      const service = selector.slice(0, -2) as AgentEventService;
      let listeners = this.#services.get(service);
      if (!listeners && create) {
        listeners = new Set();
        this.#services.set(service, listeners);
      }
      return listeners;
    }
    let listeners = this.#types.get(selector as AgentServiceEventType);
    if (!listeners && create) {
      listeners = new Set();
      this.#types.set(selector as AgentServiceEventType, listeners);
    }
    return listeners;
  }

  private deliver(listeners: Set<AgentEventListener> | undefined, envelope: AgentEventEnvelope): void {
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(envelope);
      } catch (error) {
        try {
          this.#onListenerError?.(error, envelope);
        } catch {
          // Diagnostic hooks are listeners too; their failure cannot break fan-out.
        }
      }
    }
  }
}

export interface AgentEventStreamSource {
  onEvent(listener: AgentEventListener): () => void;
}

/**
 * Adapter-side source that retains bootstrap events until the runtime Agent
 * attaches. After that first attachment it is a normal live fan-out stream;
 * adapters never need a private Core state snapshot to preserve early facts.
 */
export class BufferedAgentEventSource implements AgentEventStreamSource {
  readonly #listeners = new Set<AgentEventListener>();
  readonly #pendingCapacity: number;
  #pending: AgentEventEnvelope[] = [];
  #attached = false;
  #closed = false;

  constructor(options: { pendingCapacity?: number } = {}) {
    this.#pendingCapacity = options.pendingCapacity ?? 256;
    if (!Number.isSafeInteger(this.#pendingCapacity) || this.#pendingCapacity < 1) {
      throw new RangeError('agent event pendingCapacity must be a positive safe integer');
    }
  }

  emit(envelope: AgentEventEnvelope): void {
    if (this.#closed) return;
    if (envelope.sourceEventRef) Object.freeze(envelope.sourceEventRef);
    freezeNormalizedEvent(envelope.event);
    Object.freeze(envelope);
    if (!this.#attached) {
      this.#pending.push(envelope);
      if (this.#pending.length > this.#pendingCapacity) {
        this.#pending.splice(0, this.#pending.length - this.#pendingCapacity);
      }
      return;
    }
    this.deliver(envelope);
  }

  onEvent(listener: AgentEventListener): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    if (!this.#attached) {
      this.#attached = true;
      const pending = this.#pending;
      this.#pending = [];
      for (const envelope of pending) this.deliver(envelope);
    }
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    this.#pending = [];
    this.#listeners.clear();
  }

  private deliver(envelope: AgentEventEnvelope): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(envelope);
      } catch {
        // Adapter ingestion cannot be affected by a consumer fault.
      }
    }
  }
}
