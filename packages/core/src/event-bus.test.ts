import { describe, expect, it, vi } from 'vitest';
import { AgentEventBus, BufferedAgentEventSource } from './event-bus.js';
import { createEnvelopeStamper, type AgentEvent, type AgentEventEnvelope } from './events.js';

const stamper = () => createEnvelopeStamper();

function envelope(event: AgentEvent): AgentEventEnvelope {
  return stamper().next({
    sessionId: 'native-1',
    timestamp: '2026-08-25T00:00:00.000Z',
    monotonicTime: 1,
    source: 'native-protocol',
    confidence: 'authoritative',
    event,
  });
}

describe('AgentEventBus', () => {
  it('routes one envelope by exact event, owning service, and catch-all', () => {
    const bus = new AgentEventBus();
    const exact: string[] = [];
    const service: string[] = [];
    const all: string[] = [];

    bus.on('context-window:updated', (event) => exact.push(event.event.type));
    bus.on('context-window:*', (event) => service.push(event.type));
    bus.on('*', (event) => all.push(event.service));

    bus.emit(envelope({ type: 'context-window:updated', usedTokens: 10, capacityTokens: 100 }));

    expect(exact).toEqual(['context-window:updated']);
    expect(service).toEqual(['context-window:updated']);
    expect(all).toEqual(['context-window']);
  });

  it('isolates listener failures', () => {
    const onListenerError = vi.fn();
    const bus = new AgentEventBus({ onListenerError });
    const received: string[] = [];
    bus.on('turn:*', () => {
      throw new Error('listener failed');
    });
    bus.on('turn:started', (event) => received.push(event.event.type));

    const emitted = envelope({ type: 'turn:started', turnId: 'turn-1' });
    bus.emit(emitted);

    expect(received).toEqual(['turn:started']);
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), emitted);
  });

  it('isolates failures in the listener-error reporter itself', () => {
    const bus = new AgentEventBus({
      onListenerError() {
        throw new Error('reporter failed');
      },
    });
    const received: string[] = [];
    bus.on('turn:*', () => {
      throw new Error('listener failed');
    });
    bus.on('turn:started', ({ type }) => received.push(type));

    expect(() => bus.emit(envelope({ type: 'turn:started', turnId: 'turn-1' }))).not.toThrow();
    expect(received).toEqual(['turn:started']);
  });

  it('rejects an envelope whose derived routing fields do not match its event', () => {
    const bus = new AgentEventBus();
    const forged = {
      ...envelope({ type: 'turn:started', turnId: 'turn-1' }),
      type: 'tool:started',
      service: 'tool',
    } as AgentEventEnvelope;

    expect(() => bus.emit(forged)).toThrow(/route mismatch/);
  });

  it('prevents one selector scope from mutating the normalized event seen by another', () => {
    const onListenerError = vi.fn();
    const bus = new AgentEventBus({ onListenerError });
    const received: Array<string | undefined> = [];
    bus.on('*', (value) => {
      (value.event as { turnId?: string }).turnId = 'mutated';
    });
    bus.on('turn:started', ({ event }) => received.push(event.turnId));

    const emitted = envelope({ type: 'turn:started', turnId: 'turn-1' });
    bus.emit(emitted);

    expect(Object.isFrozen(emitted)).toBe(true);
    expect(Object.isFrozen(emitted.event)).toBe(true);
    expect(received).toEqual(['turn-1']);
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  it('freezes schema-owned nested payloads while preserving the same envelope', () => {
    const onListenerError = vi.fn();
    const bus = new AgentEventBus({ onListenerError });
    const prompts: string[] = [];
    bus.on('*', ({ event }) => {
      if (event.type === 'interaction:question-requested') event.questions[0]!.prompt = 'mutated';
    });
    bus.on('interaction:question-requested', ({ event }) => prompts.push(event.questions[0]!.prompt));

    const emitted = envelope({
      type: 'interaction:question-requested',
      requestId: 'request-1',
      questions: [{ prompt: 'Keep me stable', options: [{ label: 'Yes' }] }],
    });
    bus.emit(emitted);

    expect(Object.isFrozen(emitted.event)).toBe(true);
    expect(emitted.event.type === 'interaction:question-requested' && Object.isFrozen(emitted.event.questions)).toBe(
      true,
    );
    expect(prompts).toEqual(['Keep me stable']);
    expect(onListenerError).toHaveBeenCalledOnce();
  });
});

describe('BufferedAgentEventSource', () => {
  it('replays bootstrap events to the first runtime consumer, then streams live events', () => {
    const source = new BufferedAgentEventSource();
    const events: string[] = [];
    source.emit(envelope({ type: 'session:started' }));
    source.emit(envelope({ type: 'session:ready' }));

    source.onEvent((event) => events.push(event.type));
    source.emit(envelope({ type: 'turn:started', turnId: 'turn-1' }));

    expect(events).toEqual(['session:started', 'session:ready', 'turn:started']);
  });

  it('bounds bootstrap envelopes before the first consumer attaches', () => {
    const source = new BufferedAgentEventSource({ pendingCapacity: 2 });
    const events: string[] = [];
    source.emit(envelope({ type: 'session:started' }));
    source.emit(envelope({ type: 'session:ready' }));
    source.emit(envelope({ type: 'turn:started', turnId: 'turn-1' }));

    source.onEvent((event) => events.push(event.type));

    expect(events).toEqual(['session:ready', 'turn:started']);
  });
});
