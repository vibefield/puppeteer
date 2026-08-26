import { createEnvelopeStamper, type AgentEvent, type AgentEventEnvelope } from '@vibecook/puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { AgentEventBus } from './event-bus.js';

function envelope(event: AgentEvent): AgentEventEnvelope {
  return createEnvelopeStamper().next({
    sessionId: 'native-1',
    timestamp: '2026-08-25T00:00:00.000Z',
    monotonicTime: 1,
    source: 'native-protocol',
    confidence: 'authoritative',
    event,
  });
}

describe('AgentEventBus', () => {
  it('routes one envelope by exact event, owning category, and catch-all', () => {
    const bus = new AgentEventBus();
    const exact: string[] = [];
    const category: string[] = [];
    const all: string[] = [];

    bus.on('context-window:updated', (event) => exact.push(event.event.type));
    bus.on('context-window:*', (event) => category.push(event.type));
    bus.on('*', (event) => all.push(event.category));
    bus.emit(envelope({ type: 'context-window:updated', usedTokens: 10, capacityTokens: 100 }));

    expect(exact).toEqual(['context-window:updated']);
    expect(category).toEqual(['context-window:updated']);
    expect(all).toEqual(['context-window']);
  });

  it('isolates listener and diagnostic failures', () => {
    const onListenerError = vi.fn(() => {
      throw new Error('reporter failed');
    });
    const bus = new AgentEventBus({ onListenerError });
    const received: string[] = [];
    bus.on('turn:*', () => {
      throw new Error('listener failed');
    });
    bus.on('turn:started', ({ type }) => received.push(type));

    expect(() => bus.emit(envelope({ type: 'turn:started', turnId: 'turn-1' }))).not.toThrow();
    expect(received).toEqual(['turn:started']);
    expect(onListenerError).toHaveBeenCalledOnce();
  });

  it('rejects forged routing fields', () => {
    const bus = new AgentEventBus();
    const forged = {
      ...envelope({ type: 'turn:started', turnId: 'turn-1' }),
      type: 'tool:started',
      category: 'tool',
    } as AgentEventEnvelope;
    expect(() => bus.emit(forged)).toThrow(/route mismatch/);
  });

  it('freezes schema-owned nested payloads before fan-out', () => {
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

    expect(Object.isFrozen(emitted)).toBe(true);
    expect(Object.isFrozen(emitted.event)).toBe(true);
    expect(prompts).toEqual(['Keep me stable']);
    expect(onListenerError).toHaveBeenCalledOnce();
  });
});
