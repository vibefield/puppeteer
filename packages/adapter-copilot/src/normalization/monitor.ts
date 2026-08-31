import { randomUUID } from 'node:crypto';
import type { AdapterMonitorObservationBatch, ObservationCoverage } from '@vibecook/puppeteer-core/monitor-spi';
import { COPILOT_CONTRACT, COPILOT_MONITOR_CAPABILITIES } from './monitor-capabilities.js';
export function copilotCapabilitiesBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence = 1,
): AdapterMonitorObservationBatch {
  return {
    schemaVersion: 1,
    batchId: `copilot-capabilities:${randomUUID()}`,
    producer: {
      id: 'copilot:session-monitor',
      epoch: `copilot:${nativeSessionId}`,
      sequence,
      contractVersion: COPILOT_CONTRACT,
    },
    phase: 'bootstrap',
    observedAt,
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    readiness: 'ready',
    scope: { nativeSessionId },
    updates: [],
    sourceWatermarks: [],
    evidence: [{ namespace: 'copilot:surface-contract', id: COPILOT_CONTRACT }],
    capabilities: [...COPILOT_MONITOR_CAPABILITIES],
  };
}

export function copilotObservationDegradedBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence: number,
): AdapterMonitorObservationBatch {
  const reason = 'Copilot durable session-event observation is unavailable or incomplete';
  const capabilities = COPILOT_MONITOR_CAPABILITIES.map((capability) =>
    capability.support === 'unsupported'
      ? capability
      : {
          ...capability,
          support: 'degraded' as const,
          limitations: [...capability.limitations, `${reason}; native TUI liveness is unchanged.`],
        },
  );
  const coverage: ObservationCoverage[] = COPILOT_MONITOR_CAPABILITIES.filter(
    ({ support }) => support !== 'unsupported',
  ).map(({ family }) => ({ family, completeness: 'unavailable', asOf: observedAt, reason }));
  return {
    schemaVersion: 1,
    batchId: `copilot-observer-degraded:${randomUUID()}`,
    producer: {
      id: 'copilot:session-monitor',
      epoch: `copilot:${nativeSessionId}`,
      sequence,
      contractVersion: COPILOT_CONTRACT,
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
    evidence: [{ namespace: 'copilot:session-observer', id: `degraded:${sequence}` }],
    capabilities,
    coverage,
  };
}
