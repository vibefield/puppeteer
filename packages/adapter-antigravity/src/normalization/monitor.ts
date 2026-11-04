import { randomUUID } from 'node:crypto';
import type { AdapterMonitorObservationBatch, ObservationCoverage } from '@vibefield/puppeteer-core/monitor-spi';
import type { AntigravityJournalShape } from './journal.js';
import { antigravityMonitorContract } from './monitor-capabilities.js';
export function antigravityCapabilitiesBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence = 1,
  shape: AntigravityJournalShape = '1.1.20',
): AdapterMonitorObservationBatch {
  const { contractVersion, capabilities } = antigravityMonitorContract(shape);
  return {
    schemaVersion: 1,
    batchId: `antigravity-capabilities:${randomUUID()}`,
    producer: {
      id: 'antigravity:transcript-monitor',
      epoch: `antigravity:${nativeSessionId}`,
      sequence,
      contractVersion,
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
    evidence: [{ namespace: 'antigravity:surface-contract', id: contractVersion }],
    capabilities: [...capabilities],
  };
}

export function antigravityObservationDegradedBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence: number,
  shape: AntigravityJournalShape = '1.1.20',
): AdapterMonitorObservationBatch {
  const { contractVersion, capabilities: claimed } = antigravityMonitorContract(shape);
  const reason = 'Antigravity durable transcript observation is unavailable or incomplete';
  const capabilities = claimed.map((capability) =>
    capability.support === 'unsupported'
      ? capability
      : {
          ...capability,
          support: 'degraded' as const,
          limitations: [...capability.limitations, `${reason}; native TUI liveness is unchanged.`],
        },
  );
  const coverage: ObservationCoverage[] = claimed
    .filter(({ support }) => support !== 'unsupported')
    .map(({ family }) => ({ family, completeness: 'unavailable', asOf: observedAt, reason }));
  return {
    schemaVersion: 1,
    batchId: `antigravity-observer-degraded:${randomUUID()}`,
    producer: {
      id: 'antigravity:transcript-monitor',
      epoch: `antigravity:${nativeSessionId}`,
      sequence,
      contractVersion,
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
