import { describe, expect, it } from 'vitest';
import { createEnvelopeStamper } from './index.js';

describe('createEnvelopeStamper', () => {
  it('assigns strictly increasing sequence numbers starting at 1', () => {
    const stamper = createEnvelopeStamper();
    const base = {
      sessionId: 's-1',
      timestamp: '2026-07-12T00:00:00.000Z',
      monotonicTime: 0,
      source: 'native-hook' as const,
      confidence: 'authoritative' as const,
      event: { type: 'session.started' as const },
    };
    const a = stamper.next(base);
    const b = stamper.next(base);
    const c = stamper.next(base);
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 3]);
  });

  it('keeps independent counters per stamper (one per session)', () => {
    const s1 = createEnvelopeStamper();
    const s2 = createEnvelopeStamper();
    const base = {
      sessionId: 's',
      timestamp: 't',
      monotonicTime: 0,
      source: 'runtime' as const,
      confidence: 'derived' as const,
      event: { type: 'session.ready' as const },
    };
    s1.next(base);
    expect(s2.next(base).sequence).toBe(1);
  });

  it('retains stable source event and revision references while assigning delivery order', () => {
    const envelope = createEnvelopeStamper().next({
      eventId: 'provider-event-1',
      sourceEventRef: {
        namespace: 'provider-semantic',
        eventId: 'provider-event-1',
        revisionKey: 'response-1:2',
        sourceGeneration: 4,
        cursorStart: 10,
        cursorEnd: 20,
      },
      sessionId: 's',
      timestamp: 't',
      monotonicTime: 0,
      source: 'native-protocol',
      confidence: 'authoritative',
      event: { type: 'session.ready' },
    });

    expect(envelope).toMatchObject({
      sequence: 1,
      eventId: 'provider-event-1',
      sourceEventRef: { eventId: 'provider-event-1', revisionKey: 'response-1:2', sourceGeneration: 4 },
    });
  });
});
