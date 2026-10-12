import {
  agentEventCategory,
  agentEventType,
  type AgentEvent,
  type AgentEventCategory,
  type AgentEventEnvelope,
  type AgentEventListener,
  type AgentEventSelector,
  type AgentEventType,
  type AgentEnvelopeForSelector,
} from '@vibefield/puppeteer-core';

export interface AgentEventBusOptions {
  onListenerError?: ((error: unknown, envelope: AgentEventEnvelope) => void) | undefined;
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
 * Private synchronous event rail for one runtime Agent.
 *
 * Runtime ingress is the only emitter. Applications observe the rail through
 * `Agent.on()`, so adapters cannot bypass validation, ordering, or projections.
 */
export class AgentEventBus {
  readonly #all = new Set<AgentEventListener>();
  readonly #categories = new Map<AgentEventCategory, Set<AgentEventListener>>();
  readonly #types = new Map<AgentEventType, Set<AgentEventListener>>();
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
    return () => listeners.delete(listener as AgentEventListener);
  }

  emit(envelope: AgentEventEnvelope): void {
    const canonicalType = agentEventType(envelope.event);
    const canonicalCategory = agentEventCategory(envelope.event);
    if (envelope.type !== canonicalType || envelope.category !== canonicalCategory) {
      throw new TypeError(
        `agent event envelope route mismatch: expected ${canonicalType} (${canonicalCategory}), received ${envelope.type} (${envelope.category})`,
      );
    }
    if (envelope.sourceEventRef) Object.freeze(envelope.sourceEventRef);
    freezeNormalizedEvent(envelope.event);
    Object.freeze(envelope);
    this.deliver(this.#all, envelope);
    this.deliver(this.#categories.get(envelope.category), envelope);
    this.deliver(this.#types.get(envelope.type), envelope);
  }

  clear(): void {
    this.#all.clear();
    this.#categories.clear();
    this.#types.clear();
  }

  private listenersFor(selector: AgentEventSelector, create: boolean): Set<AgentEventListener> | undefined {
    if (selector === '*') return this.#all;
    if (selector.endsWith(':*')) {
      const category = selector.slice(0, -2) as AgentEventCategory;
      let listeners = this.#categories.get(category);
      if (!listeners && create) {
        listeners = new Set();
        this.#categories.set(category, listeners);
      }
      return listeners;
    }
    let listeners = this.#types.get(selector as AgentEventType);
    if (!listeners && create) {
      listeners = new Set();
      this.#types.set(selector as AgentEventType, listeners);
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
