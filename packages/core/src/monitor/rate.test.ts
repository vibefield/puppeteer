import { describe, expect, it } from 'vitest';
import type { MonitorStoredEntry, MonitorUsageFamilyValue } from './internal-types.js';
import { projectMonitorUsageLedger } from './rate.js';

const T0 = Date.parse('2026-08-16T12:00:00.000Z');

function usageEntry(
  key: string,
  seconds: number,
  value: Omit<MonitorUsageFamilyValue, 'kind' | 'usageId'>,
  options: { phase?: MonitorStoredEntry['phase']; rateEligible?: boolean } = {},
): MonitorStoredEntry {
  const at = new Date(T0 + seconds * 1_000).toISOString();
  return {
    storageKey: `usage:${key}`,
    plane: 'semantic',
    ownerId: 'semantic',
    ownerEpoch: 'epoch-1',
    scopeKey: '',
    family: 'usage',
    key,
    value: { kind: 'usage', usageId: key, ...value },
    observedAt: at,
    effectiveAt: at,
    source: { id: 'semantic', kind: 'test' },
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    phase: options.phase ?? 'live',
    evidence: [],
    rateEligible: options.rateEligible ?? options.phase !== 'bootstrap',
    rateAt: at,
  };
}

describe('projectMonitorUsageLedger', () => {
  it('installs a bootstrap baseline without manufacturing a burn spike', () => {
    const projection = projectMonitorUsageLedger(
      [
        usageEntry(
          'response-1',
          0,
          { boundary: 'response', canonical: true, deltaTokens: 100 },
          { phase: 'bootstrap' },
        ),
      ],
      T0,
    );
    expect(projection.usage).toMatchObject({ cumulativeTokens: 100 });
    expect(projection.usage.burnRatePerMin).toBeUndefined();
  });

  it('reprojects a downward response correction without a negative rate', () => {
    const actor = { rootSessionKey: 'session', runKey: 'child-1', role: 'child' as const };
    const corrected = usageEntry('response-1', 20, {
      boundary: 'response',
      canonical: true,
      deltaTokens: 40,
      actor,
    });
    const projection = projectMonitorUsageLedger([corrected], T0 + 30_000);
    expect(projection.usage).toMatchObject({ cumulativeTokens: 40, burnRatePerMin: 40, burnRateBoundary: 'response' });
    expect(projection.usage.burnRatePerMin).toBeGreaterThanOrEqual(0);
    expect(projection.actorTotals.get('child-1')).toBe(40);
    expect(projection.actorBurnRates.get('child-1')).toBe(40);
  });

  it('keeps settled work, operational meter, and token buckets distinct', () => {
    const projection = projectMonitorUsageLedger(
      [
        usageEntry('otel-response', 20, {
          boundary: 'response',
          canonical: true,
          totalTokens: 150,
          meterTokens: 25,
          inputTokens: 20,
          freshInputTokens: 20,
          outputTokens: 5,
          cacheReadTokens: 100,
          cacheCreationTokens: 25,
          costUsd: 0.01,
        }),
      ],
      T0 + 30_000,
    );

    expect(projection.usage).toMatchObject({
      cumulativeTokens: 150,
      burnRatePerMin: 25,
      burnRateBoundary: 'response',
      inputTokens: 20,
      freshInputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheCreationTokens: 25,
      costUsd: 0.01,
    });
  });

  it('derives a sample-boundary rate without adding samples to canonical response usage', () => {
    const sampleProjection = projectMonitorUsageLedger(
      [
        usageEntry(
          'sample-1',
          0,
          { boundary: 'sample', canonical: false, cumulativeTokens: 100 },
          { phase: 'bootstrap' },
        ),
        usageEntry('sample-2', 30, { boundary: 'sample', canonical: false, cumulativeTokens: 160 }),
      ],
      T0 + 30_000,
    );
    expect(sampleProjection.usage).toMatchObject({
      cumulativeTokens: 160,
      burnRatePerMin: 120,
      burnRateBoundary: 'sample',
    });

    const canonicalProjection = projectMonitorUsageLedger(
      [
        ...Array.from({ length: 2 }, (_, index) =>
          usageEntry(`response-${index}`, index * 10, {
            boundary: 'response',
            canonical: true,
            deltaTokens: 25,
          }),
        ),
        usageEntry('sample-cross-check', 30, { boundary: 'sample', canonical: false, cumulativeTokens: 9_999 }),
      ],
      T0 + 30_000,
    );
    expect(canonicalProjection.usage.cumulativeTokens).toBe(50);
    expect(canonicalProjection.usage.burnRateBoundary).toBe('response');
  });

  it('keeps per-actor samples out of an available root aggregate timeline', () => {
    const actor = { rootSessionKey: 'session', runKey: 'child-1', role: 'child' as const };
    const projection = projectMonitorUsageLedger(
      [
        usageEntry(
          'root-1',
          0,
          { boundary: 'sample', canonical: false, cumulativeTokens: 100 },
          { phase: 'bootstrap' },
        ),
        usageEntry('root-2', 30, { boundary: 'sample', canonical: false, cumulativeTokens: 160 }),
        usageEntry('child-1', 40, {
          boundary: 'sample',
          canonical: false,
          cumulativeTokens: 25,
          actor,
        }),
      ],
      T0 + 40_000,
    );

    expect(projection.usage).toMatchObject({
      cumulativeTokens: 160,
      burnRatePerMin: 120,
      burnRateBoundary: 'sample',
    });
    expect(projection.actorTotals.get('child-1')).toBe(25);
  });

  it('sums independent child sample streams when no provider root aggregate exists', () => {
    const childA = { rootSessionKey: 'session', runKey: 'child-a', role: 'child' as const };
    const childB = { rootSessionKey: 'session', runKey: 'child-b', role: 'child' as const };
    const projection = projectMonitorUsageLedger(
      [
        usageEntry(
          'a-1',
          0,
          { boundary: 'sample', canonical: false, cumulativeTokens: 100, actor: childA },
          { phase: 'bootstrap' },
        ),
        usageEntry(
          'b-1',
          0,
          { boundary: 'sample', canonical: false, cumulativeTokens: 200, actor: childB },
          { phase: 'bootstrap' },
        ),
        usageEntry('a-2', 30, { boundary: 'sample', canonical: false, cumulativeTokens: 160, actor: childA }),
        usageEntry('b-2', 30, { boundary: 'sample', canonical: false, cumulativeTokens: 260, actor: childB }),
      ],
      T0 + 30_000,
    );

    expect(projection.usage).toMatchObject({
      cumulativeTokens: 420,
      burnRatePerMin: 240,
      burnRateBoundary: 'sample',
    });
    expect(projection.actorTotals).toEqual(
      new Map([
        ['child-a', 160],
        ['child-b', 260],
      ]),
    );
  });

  it('separates the explicit root actor from the whole run aggregate', () => {
    const root = { rootSessionKey: 'session', runKey: 'root', role: 'root' as const };
    const child = {
      rootSessionKey: 'session',
      runKey: 'child',
      role: 'child' as const,
      parentRunKey: 'root',
    };
    const projection = projectMonitorUsageLedger(
      [
        usageEntry('root-response', 20, {
          boundary: 'response',
          canonical: true,
          deltaTokens: 10,
          actor: root,
        }),
        usageEntry('child-response', 20, {
          boundary: 'response',
          canonical: true,
          deltaTokens: 25,
          actor: child,
        }),
      ],
      T0 + 30_000,
    );

    expect(projection.usage).toMatchObject({
      cumulativeTokens: 35,
      burnRatePerMin: 35,
      rootActor: {
        cumulativeTokens: 10,
        burnRatePerMin: 10,
        burnRateBoundary: 'response',
      },
    });
    expect(projection.actorTotals).toEqual(
      new Map([
        ['root', 10],
        ['child', 25],
      ]),
    );
  });

  it('bounds the public sample ring and reports the exact omission', () => {
    const entries = Array.from({ length: 300 }, (_, index) =>
      usageEntry(`sample-${index.toString().padStart(3, '0')}`, index, {
        boundary: 'sample',
        canonical: false,
        cumulativeTokens: index,
      }),
    );
    const projection = projectMonitorUsageLedger(entries, T0 + 300_000);
    expect(projection.usage.samples).toHaveLength(256);
    expect(projection.omittedSamples).toBe(44);
    expect(projection.usage.samples[0]?.cumulativeTokens).toBe(44);
  });
});
