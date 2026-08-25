import { describe, expect, it } from 'vitest';
import type { NormalizationSnapshot, NormalizationTrace } from '../../types.js';
import { deriveNormalizedLifecycleState } from './NormalizedLifecycleGraph.js';

function trace(sequence: number, before: string, after: string): NormalizationTrace {
  return {
    id: `trace-${sequence}`,
    nativeSequence: sequence,
    native: {
      at: '2026-08-09T00:00:00.000Z',
      sequence,
      event: `event-${sequence}`,
    },
    ruleId: `rule-${sequence}`,
    disposition: 'mapped',
    explanation: 'mapped for lifecycle graph test',
    events: [],
    stateBefore: { lifecycle: before },
    stateAfter: { lifecycle: after },
    changes: [],
  };
}

function snapshot(): NormalizationSnapshot {
  return {
    projection: 'normalization',
    mode: 'pure-normalizer',
    vendor: 'claude',
    version: '1.0.0',
    sessionId: 'session-1',
    revision: 3,
    supported: true,
    complete: true,
    processedThroughSequence: 3,
    observedThroughSequence: 3,
    windowStartSequence: 1,
    windowEndSequence: 3,
    gaps: [],
    limitations: [],
    traces: [trace(1, 'preparing', 'ready'), trace(2, 'ready', 'running'), trace(3, 'running', 'ready')],
    state: { lifecycle: 'ready' },
    coverage: {
      total: 3,
      mapped: 3,
      retainedNative: 0,
      buffered: 0,
      noOutput: 0,
      driverOwned: 0,
      unsupported: 0,
      blocked: 0,
      errors: 0,
    },
  };
}

describe('normalized lifecycle graph state', () => {
  it('defaults to the Core preparing lifecycle before evidence arrives', () => {
    const state = deriveNormalizedLifecycleState(undefined, null);
    expect(state.current).toBe('preparing');
    expect([...state.observed]).toEqual(['preparing']);
    expect(state.traversed.size).toBe(0);
  });

  it('time-travels the current node and traversed edges with the selected native fold', () => {
    const historical = deriveNormalizedLifecycleState(snapshot(), 2);
    expect(historical.current).toBe('running');
    expect(historical.traversed).toEqual(new Set(['preparing\0ready', 'ready\0running']));

    const live = deriveNormalizedLifecycleState(snapshot(), null);
    expect(live.current).toBe('ready');
    expect(live.traversed.has('running\0ready')).toBe(true);
  });
});
