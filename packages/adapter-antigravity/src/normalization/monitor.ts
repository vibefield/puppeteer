import { randomUUID } from 'node:crypto';
import type { AdapterMonitorObservationBatch, ObservationCoverage } from '@vibefield/puppeteer-core/monitor-spi';
import { ANTIGRAVITY_CONTRACT, ANTIGRAVITY_MONITOR_CAPABILITIES } from './monitor-capabilities.js';
export function antigravityCapabilitiesBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence = 1,
): AdapterMonitorObservationBatch {
  return {
    schemaVersion: 1,
    batchId: `antigravity-capabilities:${randomUUID()}`,
    producer: {
      id: 'antigravity:transcript-monitor',
      epoch: `antigravity:${nativeSessionId}`,
      sequence,
      contractVersion: ANTIGRAVITY_CONTRACT,
    },
    phase: 'bootstrap',
    observedAt,
    quality: 'inferred',
    completeness: 'complete',
    provisional: false,
    readiness: 'ready',
    scope: { nativeSessionId },
    updates: [],
    sourceWatermarks: [],
    evidence: [{ namespace: 'antigravity:surface-contract', id: ANTIGRAVITY_CONTRACT }],
    capabilities: [...ANTIGRAVITY_MONITOR_CAPABILITIES],
  };
}

export function antigravityObservationDegradedBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence: number,
): AdapterMonitorObservationBatch {
  const reason = 'Antigravity durable transcript observation is unavailable or incomplete';
  const capabilities = ANTIGRAVITY_MONITOR_CAPABILITIES.map((capability) =>
    capability.support === 'unsupported'
      ? capability
      : {
          ...capability,
          support: 'degraded' as const,
          limitations: [...capability.limitations, `${reason}; native TUI liveness is unchanged.`],
        },
  );
  const coverage: ObservationCoverage[] = ANTIGRAVITY_MONITOR_CAPABILITIES.filter(
    ({ support }) => support !== 'unsupported',
  ).map(({ family }) => ({ family, completeness: 'unavailable', asOf: observedAt, reason }));
  return {
    schemaVersion: 1,
    batchId: `antigravity-observer-degraded:${randomUUID()}`,
    producer: {
      id: 'antigravity:transcript-monitor',
      epoch: `antigravity:${nativeSessionId}`,
      sequence,
      contractVersion: ANTIGRAVITY_CONTRACT,
    },
    phase: 'live',
    observedAt,
    quality: 'unknown',
    completeness: 'unavailable',
    provisional: false,
    readiness: 'degraded',
    scope: { nativeSessionId },
    updates: [],
    sourceWatermarks: [],
    evidence: [{ namespace: 'antigravity:transcript-observer', id: `degraded:${sequence}` }],
    capabilities,
    coverage,
  };
}
