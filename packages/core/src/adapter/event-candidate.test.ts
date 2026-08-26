import { describe, expect, it } from 'vitest';
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
    expect('category' in seen[0]!).toBe(false);
  });

  it('bounds bootstrap candidates before runtime ingress attaches', () => {
    const source = new BufferedAdapterEventSource({ pendingCapacity: 2 });
    source.emit(turnStarted('turn-1'));
    source.emit(turnStarted('turn-2'));
    source.emit(turnStarted('turn-3'));
    const candidates: ReturnType<typeof turnStarted>[] = [];
    source.onCandidate((candidate) => candidates.push(candidate as ReturnType<typeof turnStarted>));

    expect(candidates.map(({ event }) => event.turnId)).toEqual(['turn-2', 'turn-3']);
  });
});
