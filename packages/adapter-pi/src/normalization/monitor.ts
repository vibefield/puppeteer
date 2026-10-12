import { randomUUID } from 'node:crypto';
import type { AdapterMonitorObservationBatch, ObservationCoverage } from '@vibefield/puppeteer-core/monitor-spi';
import { PI_CONTRACT, PI_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

export function piCapabilitiesBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence = 1,
): AdapterMonitorObservationBatch {
  return {
    schemaVersion: 1,
    batchId: `pi-capabilities:${randomUUID()}`,
    producer: { id: 'pi:session-monitor', epoch: `pi:${nativeSessionId}`, sequence, contractVersion: PI_CONTRACT },
    phase: 'bootstrap',
    observedAt,
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    readiness: 'ready',
    scope: { nativeSessionId },
    updates: [],
    sourceWatermarks: [],
    evidence: [{ namespace: 'pi:surface-contract', id: PI_CONTRACT }],
    capabilities: [...PI_MONITOR_CAPABILITIES],
  };
}

export function piObservationDegradedBatch(
  nativeSessionId: string,
  observedAt: string,
  sequence: number,
): AdapterMonitorObservationBatch {
  const reason = 'Pi durable session observation is unavailable or incomplete';
  const capabilities = PI_MONITOR_CAPABILITIES.map((capability) =>
    capability.support === 'unsupported'
      ? capability
      : {
          ...capability,
          support: 'degraded' as const,
          limitations: [...capability.limitations, `${reason}; native TUI liveness is unchanged.`],
        },
  );
  const coverage: ObservationCoverage[] = PI_MONITOR_CAPABILITIES.filter(
    ({ support }) => support !== 'unsupported',
  ).map(({ family }) => ({ family, completeness: 'unavailable', asOf: observedAt, reason }));
  return {
    schemaVersion: 1,
    batchId: `pi-observer-degraded:${randomUUID()}`,
    producer: {
      id: 'pi:session-monitor',
      epoch: `pi:${nativeSessionId}`,
      sequence,
      contractVersion: PI_CONTRACT,
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
    evidence: [{ namespace: 'pi:session-observer', id: `degraded:${sequence}` }],
    capabilities,
    coverage,
  };
}
