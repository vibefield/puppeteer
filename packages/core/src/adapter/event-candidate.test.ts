import { describe, expect, it } from 'vitest';
import { BufferedAdapterEventSource, createAdapterEventCandidate } from './event-candidate.js';

function turnStarted(turnId: string) {
  return createAdapterEventCandidate({
    sessionId: 'native-1',
    timestamp: '2026-08-25T00:00:00.000Z',
    monotonicTime: 1,
    source: 'native-protocol',
    confidence: 'authoritative',
    event: { type: 'turn.started', turnId },
  });
}

describe('BufferedAdapterEventSource', () => {
  it('buffers candidates and gives runtime ingress no adapter-owned sequence', () => {
    const source = new BufferedAdapterEventSource();
    const seen: Array<ReturnType<typeof turnStarted>> = [];
    source.emit(turnStarted('turn-1'));

    source.onCandidate((candidate) => seen.push(candidate as ReturnType<typeof turnStarted>));

    expect(seen.map((candidate) => candidate.type)).toEqual(['state:turn-started']);
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
    expect(first[0]).toMatchObject({ type: 'state:turn-started', service: 'state', sequence: 1 });
  });
});
