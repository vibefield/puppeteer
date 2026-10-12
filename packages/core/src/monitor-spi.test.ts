import { describe, expect, it } from 'vitest';
import type {
  AdapterMonitorObservationBatch,
  RuntimeMonitorObservationBatch,
} from '@vibefield/puppeteer-core/monitor-spi';
// @ts-expect-error version-locked SPI types must not leak from the application package root
import type { AdapterMonitorObservationBatch as LeakedPublicBatch } from '@vibefield/puppeteer-core';
// @ts-expect-error accumulator implementation must remain on the version-locked SPI subpath
type LeakedPublicReducer = (typeof import('@vibefield/puppeteer-core'))['reduceMonitorAccumulator'];

void (undefined as unknown as LeakedPublicBatch);
void (undefined as unknown as LeakedPublicReducer);

describe('monitor SPI package subpath', () => {
  it('carries typed atomic updates without provider-native records', () => {
    const batch: AdapterMonitorObservationBatch = {
      schemaVersion: 1,
      batchId: 'batch-1',
      producer: { id: 'claude:transcript', epoch: 'generation-4', contractVersion: 'claude-transcript-v1' },
      phase: 'correction',
      observedAt: '2026-08-16T12:00:00.000Z',
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      scope: { nativeSessionId: 'native-1' },
      updates: [
        {
          family: 'usage',
          operation: 'upsert',
          key: 'response-1',
          value: {
            kind: 'usage',
            usageId: 'response-1',
            boundary: 'response',
            canonical: true,
            inputTokens: 100,
            outputTokens: 20,
          },
        },
        {
          family: 'compaction',
          operation: 'replace',
          coverage: 'complete',
          values: [
            {
              key: 'compaction-1',
              value: {
                kind: 'compaction',
                active: true,
              },
            },
          ],
        },
      ],
      sourceWatermarks: [{ sourceId: 'transcript-1', sourceEpoch: 'generation-2', cursor: '4096' }],
      evidence: [{ namespace: 'provider-semantic', id: 'event-1', revisionKey: 'response-1:2' }],
    };
    expect(structuredClone(batch)).toEqual(batch);

    const wrapped: RuntimeMonitorObservationBatch = {
      ...batch,
      kind: 'semantic',
      runtimeRunId: 'run-1',
      runtimeEpoch: 3,
    };
    expect(wrapped.runtimeRunId).toBe('run-1');
  });
});
