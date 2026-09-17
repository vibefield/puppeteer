import { describe, expect, it } from 'vitest';
import type { AgentEventSource } from '../events/contract.js';
import { createMonitorAccumulatorState, reduceMonitorAccumulator, translateAgentEventEnvelope } from './reduce.js';
import { projectAgentMonitorState } from './project.js';
import type { MonitorFamilyUpdate, RuntimeMonitorObservationBatch } from './internal-types.js';

const T0 = '2026-09-16T12:00:00.000Z';
const initial = () =>
  createMonitorAccumulatorState({
    runtimeRunId: 'run',
    runtimeEpoch: 1,
    providerId: 'test',
    executionMode: 'native-tui',
    observationLevel: 'structured',
    allocatedAt: T0,
  });
const usage = (usd: number): MonitorFamilyUpdate => ({
  family: 'usage',
  operation: 'upsert',
  key: 'request',
  value: { kind: 'usage', usageId: 'request', origin: 'protocol', boundary: 'response', canonical: true, costUsd: usd },
});
const batch = (
  id: number,
  phase: RuntimeMonitorObservationBatch['phase'],
  updates: MonitorFamilyUpdate[],
  epoch = 'epoch',
): RuntimeMonitorObservationBatch => ({
  kind: 'semantic',
  schemaVersion: 1,
  runtimeRunId: 'run',
  runtimeEpoch: 1,
  batchId: String(id),
  producer: { id: 'provider', epoch, sequence: id },
  phase,
  observedAt: new Date(Date.parse(T0) + id * 1000).toISOString(),
  updates,
  quality: 'exact',
  completeness: 'complete',
  provisional: false,
  evidence: [],
  sourceWatermarks: [],
});

describe('transcript-free usage boundary and USD projection', () => {
  it.each([
    'native-transcript',
    'native-log',
    'native-statusline',
    'terminal-inference',
    'workspace',
  ] as AgentEventSource[])('rejects token and cost claims from %s', (source) => {
    const input = translateAgentEventEnvelope({
      runtimeRunId: 'run',
      runtimeEpoch: 1,
      envelope: {
        type: 'usage:tokens-used',
        category: 'usage',
        sequence: 1,
        sessionId: 'session',
        timestamp: T0,
        monotonicTime: 0,
        source,
        confidence: 'authoritative',
        event: {
          type: 'usage:tokens-used',
          usageId: 'request',
          canonical: true,
          boundary: 'response',
          totalTokens: 100,
          costUsd: 10,
        },
      },
    });
    expect(input.updates).toEqual([]);
  });
  it('requires explicit live provenance and rejects bootstrap and resync usage', () => {
    for (const phase of ['bootstrap', 'resync'] as const) {
      const state = reduceMonitorAccumulator(initial(), batch(1, phase, [usage(1)])).state;
      expect(projectAgentMonitorState(state, { asOf: T0 }).usage.costUsd).toBeUndefined();
    }
    const update = usage(1);
    if (update.operation !== 'upsert' || update.family !== 'usage') throw new Error('fixture');
    const { origin: _, ...unmarked } = update.value;
    const state = reduceMonitorAccumulator(initial(), batch(1, 'live', [{ ...update, value: unmarked }])).state;
    expect(projectAgentMonitorState(state, { asOf: T0 }).usage.costUsd).toBeUndefined();
  });
  it('keeps cost-only observations, deduplicates delivery, and corrects at the original time', () => {
    const first = batch(1, 'live', [usage(0.8)]);
    let state = reduceMonitorAccumulator(initial(), first).state;
    state = reduceMonitorAccumulator(state, first).state;
    state = reduceMonitorAccumulator(state, batch(90, 'correction', [usage(0.2)])).state;
    const projected = projectAgentMonitorState(state, { asOf: '2026-09-16T12:01:30.000Z' });
    expect(projected.usage).toMatchObject({
      costUsd: 0.2,
      costRatePerMin: 0,
      costCoverage: 'complete',
      pricedObservations: 1,
    });
    expect(projected.usage.costHistory?.slice(-4).map((bucket) => bucket.costUsd)).toEqual([0.2, 0, 0, 0]);
  });
  it('prevents complete history replacements, retractions, and epoch resyncs from erasing live spend', () => {
    let state = reduceMonitorAccumulator(initial(), batch(1, 'live', [usage(0.8)])).state;
    state = reduceMonitorAccumulator(
      state,
      batch(2, 'bootstrap', [{ family: 'usage', operation: 'retract', key: 'request' }]),
    ).state;
    state = reduceMonitorAccumulator(
      state,
      batch(3, 'live', [{ family: 'usage', operation: 'replace', coverage: 'complete', values: [] }]),
    ).state;
    state = reduceMonitorAccumulator(state, batch(4, 'resync', [usage(900)], 'epoch-2')).state;
    expect(projectAgentMonitorState(state, { asOf: '2026-09-16T12:00:10Z' }).usage.costUsd).toBe(0.8);
  });
  it('keeps missing prices visible instead of treating unknown work as free', () => {
    const missing: MonitorFamilyUpdate = {
      family: 'usage',
      operation: 'upsert',
      key: 'unknown',
      value: {
        kind: 'usage',
        usageId: 'unknown',
        origin: 'protocol',
        boundary: 'response',
        canonical: true,
        totalTokens: 100,
      },
    };
    const state = reduceMonitorAccumulator(initial(), batch(1, 'live', [usage(0.8), missing])).state;
    expect(projectAgentMonitorState(state, { asOf: '2026-09-16T12:00:10Z' }).usage).toMatchObject({
      costUsd: 0.8,
      costCoverage: 'partial',
      pricedObservations: 1,
      unpricedObservations: 1,
    });
  });
  it('retains the original cost time when a live observation repeats after a producer reconnect', () => {
    let state = reduceMonitorAccumulator(initial(), batch(1, 'live', [usage(0.8)])).state;
    state = reduceMonitorAccumulator(state, batch(90, 'resync', [], 'epoch-2')).state;
    state = reduceMonitorAccumulator(state, batch(91, 'live', [usage(0.2)], 'epoch-2')).state;
    const projected = projectAgentMonitorState(state, { asOf: '2026-09-16T12:01:32Z' });
    expect(projected.usage).toMatchObject({ costUsd: 0.2, costRatePerMin: 0, pricedObservations: 1 });
  });
  it('does not lose unsplit provider cost when the same chart bucket also contains catalog cost', () => {
    const split: MonitorFamilyUpdate = {
      family: 'usage',
      operation: 'upsert',
      key: 'calculated',
      value: {
        kind: 'usage',
        usageId: 'calculated',
        origin: 'protocol',
        canonical: true,
        boundary: 'response',
        costUsd: 0.2,
        cost: { basis: 'api-equivalent', source: 'catalog', inputUsd: 0.05, outputUsd: 0.15 },
      },
    };
    for (const updates of [
      [usage(0.8), split],
      [split, usage(0.8)],
    ]) {
      const state = reduceMonitorAccumulator(initial(), batch(1, 'live', updates)).state;
      const bucket = projectAgentMonitorState(state, { asOf: '2026-09-16T12:00:10Z' }).usage.costHistory?.at(-1);
      expect(bucket).toEqual({ at: T0, costUsd: 1 });
    }
  });
});
