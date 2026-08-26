import { describe, expect, it } from 'vitest';
import { createEnvelopeStamper, type AgentEventEnvelope } from '@vibecook/puppeteer-core';
import { AgentStateService } from './state-service.js';

const envelope = (event: Parameters<ReturnType<typeof createEnvelopeStamper>['next']>[0]['event']) =>
  createEnvelopeStamper().next({
    sessionId: 'session-1',
    timestamp: '2026-08-25T00:00:00.000Z',
    monotonicTime: 1,
    source: 'native-protocol',
    confidence: 'authoritative',
    event,
  });

describe('AgentStateService', () => {
  it('owns reducer state and ignores monitor-category projection input', () => {
    const service = new AgentStateService();
    service.consume(envelope({ type: 'turn:started', turnId: 'turn-1' }));
    expect(service.snapshot()).toMatchObject({ lifecycle: 'running', activeTurn: { id: 'turn-1' } });

    const before = service.snapshot();
    const monitorOnly = {
      ...envelope({ type: 'session:ready' }),
      type: 'monitor:batch',
      category: 'monitor',
    } as unknown as AgentEventEnvelope;
    service.consume(monitorOnly);

    expect(service.snapshot()).toEqual(before);
  });

  it('returns defensive snapshots instead of exposing reducer-owned collections', () => {
    const service = new AgentStateService();
    service.consume(
      envelope({ type: 'tool:requested', toolCallId: 'tool-1', tool: 'Read', input: { path: '/original' } }),
    );

    const exposed = service.snapshot();
    (exposed.tools.get('tool-1')?.input as { path: string }).path = '/forged';
    exposed.tools.clear();
    exposed.counters.toolsCompleted = 99;

    expect(service.snapshot()).toMatchObject({ counters: { toolsCompleted: 0 } });
    expect(service.snapshot().tools.has('tool-1')).toBe(true);
    expect(service.snapshot().tools.get('tool-1')?.input).toEqual({ path: '/original' });
  });
});
