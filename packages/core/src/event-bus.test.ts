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

    bus.emit(envelope({ type: 'context-window.updated', usedTokens: 10, capacityTokens: 100 }));

    expect(exact).toEqual(['context-window.updated']);
    expect(service).toEqual(['context-window:updated']);
    expect(all).toEqual(['context-window']);
  });

  it('isolates listener failures', () => {
    const onListenerError = vi.fn();
    const bus = new AgentEventBus({ onListenerError });
    const received: string[] = [];
    bus.on('state:*', () => {
      throw new Error('listener failed');
    });
    bus.on('state:turn-started', (event) => received.push(event.event.type));

    const emitted = envelope({ type: 'turn.started', turnId: 'turn-1' });
    bus.emit(emitted);

    expect(received).toEqual(['turn.started']);
    expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), emitted);
  });
});

describe('BufferedAgentEventSource', () => {
  it('replays bootstrap events to the first runtime consumer, then streams live events', () => {
    const source = new BufferedAgentEventSource();
    const events: string[] = [];
    source.emit(envelope({ type: 'session.started' }));
    source.emit(envelope({ type: 'session.ready' }));

    source.onEvent((event) => events.push(event.type));
    source.emit(envelope({ type: 'turn.started', turnId: 'turn-1' }));

    expect(events).toEqual(['state:session-started', 'state:session-ready', 'state:turn-started']);
  });
});
