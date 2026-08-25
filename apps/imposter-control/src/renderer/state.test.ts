import { describe, expect, it } from 'vitest';
import type { NormalizationSnapshot, NormalizationTrace, SessionView } from './types.js';
import {
  MAX_VISIBLE_RECORDS,
  controlStateReducer,
  initialControlState,
  mergeNativeRecords,
  sessionKey,
} from './state.js';

const session: SessionView = {
  vendor: 'claude',
  version: '1.0.0',
  sessionId: 'session-1',
  pid: 42,
  cwd: '/work',
  channels: ['hooks'],
  nativeBehavior: {
    behaviorVersion: 1,
    title: 'Native hooks',
    lanes: [{ id: 'session', label: 'Session' }],
    nodes: [
      {
        id: 'start',
        event: 'SessionStart',
        confidence: 'verified-headless',
        lane: 'session',
        order: 0,
      },
    ],
    relations: [],
  },
  nativeEvents: [
    {
      event: 'SessionStart',
      fields: [],
      channel: 'hooks',
      channels: ['hooks'],
      confidence: 'verified-headless',
    },
  ],
  ops: [],
  runflows: [],
  scenarioDriver: { state: 'ready', enabled: [], offModel: 0, applied: 0, heartbeats: 0 },
  joinedAt: '2026-08-09T00:00:00.000Z',
};

function trace(sequence: number): NormalizationTrace {
  return {
    id: `trace-${sequence}`,
    nativeSequence: sequence,
    native: { at: '2026-08-09T00:00:00.000Z', sequence, event: 'SessionStart' },
    ruleId: 'session-start',
    disposition: 'mapped',
    explanation: 'mapped for test',
    events: [],
    stateBefore: {},
    stateAfter: { lifecycle: 'ready' },
    changes: [],
  };
}

function snapshot(revision: number): NormalizationSnapshot {
  return {
    projection: 'normalization',
    mode: 'pure-normalizer',
    vendor: session.vendor,
    version: session.version,
    sessionId: session.sessionId,
    revision,
    supported: true,
    complete: true,
    processedThroughSequence: 2,
    observedThroughSequence: 2,
    windowStartSequence: 2,
    windowEndSequence: 2,
    gaps: [],
    limitations: [],
    traces: [trace(2)],
    state: { lifecycle: 'ready' },
    coverage: {
      total: 1,
      mapped: 1,
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

describe('renderer control state', () => {
  it('deduplicates native records by sequence and bounds the presentation window', () => {
    const records = Array.from({ length: MAX_VISIBLE_RECORDS + 1 }, (_, index) => ({
      at: '2026-08-09T00:00:00.000Z',
      sequence: index + 1,
      event: 'SessionStart',
    }));
    const merged = mergeNativeRecords(records, [{ ...records.at(-1)!, event: 'Updated' }]);
    expect(merged).toHaveLength(MAX_VISIBLE_RECORDS);
    expect(merged[0]?.sequence).toBe(2);
    expect(merged.at(-1)?.event).toBe('Updated');
  });

  it('keeps projection revisions monotonic and aligns native evidence to its window', () => {
    const key = sessionKey(session);
    let state = controlStateReducer(initialControlState, { type: 'sessions', sessions: [session] });
    state = controlStateReducer(state, {
      type: 'records',
      key,
      records: [
        { at: '2026-08-09T00:00:00.000Z', sequence: 1, event: 'SessionStart' },
        { at: '2026-08-09T00:00:01.000Z', sequence: 2, event: 'SessionStart' },
      ],
    });
    state = controlStateReducer(state, { type: 'normalization-snapshot', key, snapshot: snapshot(2) });
    state = controlStateReducer(state, { type: 'normalization-snapshot', key, snapshot: snapshot(1) });
    expect(state.normalizations[key]?.revision).toBe(2);
    expect(state.records[key]?.map((record) => record.sequence)).toEqual([2]);
  });

  it('updates driver state without replacing session-owned renderer data', () => {
    const key = sessionKey(session);
    let state = controlStateReducer(initialControlState, { type: 'sessions', sessions: [session] });
    state = controlStateReducer(state, {
      type: 'scenario-driver',
      key,
      driver: { state: 'turn.thinking', enabled: ['tool.start'], offModel: 0, applied: 1, heartbeats: 0 },
    });
    expect(state.sessions[0]?.scenarioDriver.state).toBe('turn.thinking');
    expect(state.sessions[0]?.nativeBehavior).toBe(session.nativeBehavior);
  });
});
