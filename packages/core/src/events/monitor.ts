import { z } from 'zod';
import type { AdapterMonitorObservationBatch } from '../monitor/internal-types.js';

const EvidenceQualitySchema = z.enum(['exact', 'strong', 'derived', 'estimated', 'inferred', 'unknown']);
const EvidenceCompletenessSchema = z.enum(['complete', 'partial', 'unavailable']);
const MonitorMetricFamilySchema = z.enum([
  'status',
  'usage',
  'context',
  'model',
  'effort',
  'mode',
  'planning',
  'delegation',
  'workflow',
  'compaction',
  'environment',
]);

const MonitorFamilyUpdateSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    family: MonitorMetricFamilySchema,
    operation: z.literal('upsert'),
    key: z.string(),
    value: z.unknown(),
  }),
  z.strictObject({
    family: MonitorMetricFamilySchema,
    operation: z.literal('retract'),
    key: z.string(),
  }),
  z.strictObject({
    family: MonitorMetricFamilySchema,
    operation: z.literal('replace'),
    values: z.array(z.strictObject({ key: z.string(), value: z.unknown() })),
    coverage: EvidenceCompletenessSchema,
  }),
]);

const AdapterMonitorObservationBatchShapeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: z.string(),
  producer: z.strictObject({
    id: z.string(),
    epoch: z.string(),
    sequence: z.number().optional(),
    contractVersion: z.string().optional(),
  }),
  phase: z.enum(['bootstrap', 'live', 'correction', 'resync']),
  observedAt: z.string(),
  effectiveAt: z.string().optional(),
  quality: EvidenceQualitySchema,
  completeness: EvidenceCompletenessSchema,
  provisional: z.boolean(),
  readiness: z.enum(['loading', 'ready', 'degraded']).optional(),
  scope: z
    .strictObject({
      nativeSessionId: z.string().optional(),
      actorRunKey: z.string().optional(),
    })
    .optional(),
  updates: z.array(MonitorFamilyUpdateSchema),
  sourceWatermarks: z.array(
    z.strictObject({
      sourceId: z.string(),
      sourceEpoch: z.string(),
      sequence: z.number().optional(),
      cursor: z.string().optional(),
      observedThrough: z.string().optional(),
    }),
  ),
  evidence: z.array(
    z.strictObject({
      namespace: z.string(),
      id: z.string(),
      revisionKey: z.string().optional(),
      sourceInstanceId: z.string().optional(),
      sourceObjectId: z.string().optional(),
      sourceGeneration: z.number().optional(),
      cursorStart: z.number().optional(),
      cursorEnd: z.number().optional(),
    }),
  ),
  capabilities: z
    .array(
      z.strictObject({
        family: MonitorMetricFamilySchema,
        support: z.enum(['supported', 'degraded', 'unsupported']),
        actorScope: z.enum(['root', 'current-actors', 'session']),
        latency: z.enum(['hook', 'sample', 'response', 'file-flush', 'historical']),
        source: z.string(),
        contractVersion: z.string().optional(),
        limitations: z.array(z.string()),
      }),
    )
    .optional(),
  coverage: z
    .array(
      z.strictObject({
        family: MonitorMetricFamilySchema,
        completeness: EvidenceCompletenessSchema,
        asOf: z.string(),
        actor: z
          .strictObject({
            rootSessionKey: z.string(),
            runKey: z.string(),
            role: z.enum(['root', 'child']),
            parentRunKey: z.string().optional(),
            nativeSessionId: z.string().optional(),
            nativeAgentId: z.string().optional(),
            nativeAgentType: z.string().optional(),
          })
          .optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * The monitor category validates the versioned batch shell here. Family value
 * schemas stay owned by the private monitor SPI until that API is modularized.
 */
export const AdapterMonitorObservationBatchSchema = z.custom<AdapterMonitorObservationBatch>(
  (value) => AdapterMonitorObservationBatchShapeSchema.safeParse(value).success,
);

/** Atomic semantic observations share the same adapter event rail as every other normalized fact. */
export const MonitorObservationBatchEventSchema = z.strictObject({
  type: z.literal('monitor.batch'),
  batch: AdapterMonitorObservationBatchSchema,
});
export type MonitorObservationBatchEvent = z.infer<typeof MonitorObservationBatchEventSchema>;

export type MonitorEvent = MonitorObservationBatchEvent;
export const MonitorEventSchema = MonitorObservationBatchEventSchema;
