import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '../events.js';
import {
  AdapterEventCandidateSchema,
  BufferedAdapterEventSource,
  createAdapterEventCandidate,
} from './event-candidate.js';

function turnStarted(turnId: string) {
  return createAdapterEventCandidate({
    sessionId: 'native-1',
    timestamp: '2026-08-25T00:00:00.000Z',
    monotonicTime: 1,
    source: 'native-protocol',
    confidence: 'authoritative',
    event: { type: 'turn:started', turnId },
  });
}

describe('BufferedAdapterEventSource', () => {
  it('always derives the public route from the normalized event', () => {
    const fields = {
      sessionId: 'native-1',
      timestamp: '2026-08-25T00:00:00.000Z',
      monotonicTime: 1,
      source: 'native-protocol' as const,
      confidence: 'authoritative' as const,
      event: { type: 'turn:started' as const, turnId: 'turn-1' },
      // A JavaScript or compatibility caller can carry excess properties.
      type: 'tool:started',
    };

    expect(createAdapterEventCandidate(fields).type).toBe('turn:started');
  });

  it('rejects ambiguous timestamps and invalid source cursor ranges at ingress', () => {
    expect(
      AdapterEventCandidateSchema.safeParse({ ...turnStarted('turn-1'), timestamp: 'August 25, 2026' }).success,
    ).toBe(false);
    expect(
      AdapterEventCandidateSchema.safeParse({
        ...turnStarted('turn-1'),
        sourceEventRef: { namespace: 'transcript', eventId: 'row-1', cursorStart: 20, cursorEnd: 10 },
      }).success,
    ).toBe(false);
    expect(
      AdapterEventCandidateSchema.safeParse({
        ...turnStarted('turn-1'),
        eventId: 'row-1',
        sourceEventRef: { namespace: 'transcript', eventId: 'row-2' },
      }).success,
    ).toBe(false);
  });

  it('buffers candidates and gives runtime ingress no adapter-owned sequence', () => {
    const source = new BufferedAdapterEventSource();
    const seen: Array<ReturnType<typeof turnStarted>> = [];
    source.emit(turnStarted('turn-1'));

    source.onCandidate((candidate) => seen.push(candidate as ReturnType<typeof turnStarted>));

    expect(seen.map((candidate) => candidate.type)).toEqual(['turn:started']);
    expect('sequence' in seen[0]!).toBe(false);
    expect('service' in seen[0]!).toBe(false);
  });

  it('keeps one compatibility envelope for all direct adapter listeners', () => {
    const source = new BufferedAdapterEventSource();
    const first: unknown[] = [];
    const second: unknown[] = [];
    source.onEvent((envelope) => first.push(envelope));
    source.onEvent((envelope) => second.push(envelope));

    source.emit(turnStarted('turn-1'));

    expect(first[0]).toBe(second[0]);
    expect(first[0]).toMatchObject({ type: 'turn:started', service: 'turn', sequence: 1 });
    expect(Object.isFrozen(first[0])).toBe(true);
  });

  it('replays bounded bootstrap events independently to candidate and compatibility rails', () => {
    const source = new BufferedAdapterEventSource();
    const legacy: unknown[] = [];
    const candidates: unknown[] = [];
    source.onEvent((envelope) => legacy.push(envelope));
    source.emit(turnStarted('turn-1'));

    source.onCandidate((candidate) => candidates.push(candidate));

    expect(legacy).toHaveLength(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ type: 'turn:started', event: { turnId: 'turn-1' } });
  });

  it('bounds an unattached compatibility rail', () => {
    const source = new BufferedAdapterEventSource({ pendingCapacity: 2 });
    source.onCandidate(() => undefined);
    source.emit(turnStarted('turn-1'));
    source.emit(turnStarted('turn-2'));
    source.emit(turnStarted('turn-3'));
    const legacy: AgentEventEnvelope[] = [];

    source.onEvent((envelope) => legacy.push(envelope));

    expect(legacy.map(({ event }) => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-3']);
  });
});
