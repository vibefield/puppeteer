import { z } from 'zod';
import type { AdapterMonitorObservationBatch } from '../monitor/internal-types.js';
import { AgentExecutionModeSchema } from './contract.js';
import { AgentGitStateSchema } from './environment.js';

const NonEmptyStringSchema = z.string().trim().min(1);
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const TimestampSchema = z.iso.datetime({ offset: true });
const EvidenceQualitySchema = z.enum(['exact', 'strong', 'derived', 'estimated', 'inferred', 'unknown']);
const EvidenceCompletenessSchema = z.enum(['complete', 'partial', 'unavailable']);
const MonitorMetricFamilySchema = z.enum([
  'status',
  'usage',
  'context',
  'model',
  'effort',
  'mode',
  'delegation',
  'workflow',
  'compaction',
  'environment',
  'conversation',
]);

const ActorRunRefSchema = z.strictObject({
  rootSessionKey: NonEmptyStringSchema,
  runKey: NonEmptyStringSchema,
  role: z.enum(['root', 'child', 'auxiliary', 'unknown']),
  parentRunKey: NonEmptyStringSchema.optional(),
  nativeSessionId: NonEmptyStringSchema.optional(),
  nativeAgentId: NonEmptyStringSchema.optional(),
  nativeAgentType: NonEmptyStringSchema.optional(),
});

const NativeSessionRefSchema = z.strictObject({
  namespace: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  basis: z.enum(['configured', 'observed', 'inferred']),
  quality: EvidenceQualitySchema,
});

const MonitorRunStatusSchema = z.strictObject({
  kind: z.literal('run'),
  lifecycle: z.enum(['allocated', 'preparing', 'starting', 'running', 'stopping', 'exited', 'failed']),
  alive: z.boolean(),
  nativeSession: NativeSessionRefSchema.optional(),
  failure: z
    .strictObject({ code: z.string().optional(), detail: z.string().optional(), recoverable: z.boolean().optional() })
    .optional(),
});

const MonitorActivitySchema = z.strictObject({
  kind: z.literal('activity'),
  activityKind: z.enum(['starting', 'responding', 'reasoning', 'tool', 'delegating', 'compacting', 'other']),
  active: z.boolean(),
  line: z.string().optional(),
  since: TimestampSchema.optional(),
  actor: ActorRunRefSchema.optional(),
  leaseId: NonEmptyStringSchema.optional(),
});

const MonitorQuestionOptionSchema = z.strictObject({
  label: NonEmptyStringSchema,
  description: z.string().optional(),
});
const MonitorStructuredQuestionSchema = z.strictObject({
  id: NonEmptyStringSchema.optional(),
  header: z.string().optional(),
  prompt: NonEmptyStringSchema,
  options: z.array(MonitorQuestionOptionSchema).optional(),
  allowMultiple: z.boolean().optional(),
  allowFreeForm: z.boolean().optional(),
});
const MonitorInteractionSchema = z.strictObject({
  kind: z.literal('interaction'),
  interactionId: NonEmptyStringSchema,
  interactionKind: z.enum(['permission', 'choice', 'multi-choice', 'free-form', 'mixed']),
  state: z.enum(['pending', 'resolved', 'failed', 'cancelled', 'superseded']),
  actor: ActorRunRefSchema.optional(),
  questions: z.array(MonitorStructuredQuestionSchema).optional(),
  permission: z.strictObject({ requestId: NonEmptyStringSchema, tool: z.string().optional() }).optional(),
  detail: z.string().optional(),
});
const MonitorFailureSchema = z.strictObject({
  kind: z.literal('failure'),
  failureId: NonEmptyStringSchema,
  state: z.enum(['active', 'resolved', 'dismissed']),
  actor: ActorRunRefSchema.optional(),
  detail: z.string().optional(),
  code: z.string().optional(),
  recoverable: z.boolean(),
});
const MonitorStatusValueSchema = z.discriminatedUnion('kind', [
  MonitorRunStatusSchema,
  MonitorActivitySchema,
  MonitorInteractionSchema,
  MonitorFailureSchema,
]);

const MonitorUsageValueSchema = z
  .strictObject({
    kind: z.literal('usage'),
    usageId: NonEmptyStringSchema,
    actor: ActorRunRefSchema.optional(),
    boundary: z.enum(['response', 'sample']),
    canonical: z.boolean(),
    totalTokens: NonNegativeSafeIntegerSchema.optional(),
    meterTokens: NonNegativeSafeIntegerSchema.optional(),
    cumulativeTokens: NonNegativeSafeIntegerSchema.optional(),
    deltaTokens: NonNegativeSafeIntegerSchema.optional(),
    inputTokens: NonNegativeSafeIntegerSchema.optional(),
    freshInputTokens: NonNegativeSafeIntegerSchema.optional(),
    outputTokens: NonNegativeSafeIntegerSchema.optional(),
    cacheReadTokens: NonNegativeSafeIntegerSchema.optional(),
    cacheCreationTokens: NonNegativeSafeIntegerSchema.optional(),
    reasoningTokens: NonNegativeSafeIntegerSchema.optional(),
    costUsd: NonNegativeNumberSchema.optional(),
  })
  .refine(
    (value) =>
      value.totalTokens !== undefined ||
      value.meterTokens !== undefined ||
      value.cumulativeTokens !== undefined ||
      value.deltaTokens !== undefined ||
      value.inputTokens !== undefined ||
      value.freshInputTokens !== undefined ||
      value.outputTokens !== undefined ||
      value.cacheReadTokens !== undefined ||
      value.cacheCreationTokens !== undefined ||
      value.reasoningTokens !== undefined ||
      value.costUsd !== undefined,
    { message: 'monitor usage observation must contain a token count or cost' },
  );
const MonitorMessageValueSchema = z.strictObject({
  kind: z.literal('message'),
  actor: ActorRunRefSchema.optional(),
  text: z.string().max(4096),
  final: z.boolean(),
  messageId: NonEmptyStringSchema.optional(),
});
const MonitorContextValueSchema = z.strictObject({
  kind: z.literal('context'),
  actor: ActorRunRefSchema.optional(),
  usedTokens: NonNegativeSafeIntegerSchema.optional(),
  capacityTokens: z.number().int().positive().safe().optional(),
  usedPercentage: z.number().finite().min(0).max(100).optional(),
  percentageSource: z.enum(['provider', 'derived', 'unavailable']),
});
const MonitorModelValueSchema = z.strictObject({
  kind: z.literal('model'),
  actor: ActorRunRefSchema.optional(),
  providerModelId: NonEmptyStringSchema,
  displayName: z.string().optional(),
  intent: z.enum(['configured', 'observed']),
});
const MonitorEffortValueSchema = z.strictObject({
  kind: z.literal('effort'),
  actor: ActorRunRefSchema.optional(),
  value: NonEmptyStringSchema,
  intent: z.enum(['configured', 'observed']),
});
const MonitorModeValueSchema = z.strictObject({
  kind: z.literal('mode'),
  actor: ActorRunRefSchema.optional(),
  modeKind: z.enum(['execution', 'provider-session', 'provider-permission']),
  raw: NonEmptyStringSchema,
  normalized: z.string().optional(),
  executionMode: AgentExecutionModeSchema.optional(),
  intent: z.enum(['configured', 'observed']).optional(),
});

const MonitorActorValueSchema = z.strictObject({
  kind: z.literal('actor'),
  actor: ActorRunRefSchema,
  state: z.enum(['active', 'idle', 'stopped', 'unknown']),
  activity: z.string().optional(),
});
const MonitorAffiliationValueSchema = z.strictObject({
  kind: z.literal('affiliation'),
  actor: ActorRunRefSchema,
  affiliation: z.strictObject({
    kind: z.enum(['team', 'workflow']),
    id: NonEmptyStringSchema,
    name: z.string().optional(),
  }),
  role: z.string().optional(),
});
const MonitorTeamValueSchema = z.strictObject({
  kind: z.literal('team'),
  teamId: NonEmptyStringSchema,
  nativeTeamId: NonEmptyStringSchema.optional(),
  name: z.string().optional(),
});
const MonitorTeamMemberValueSchema = z.strictObject({
  kind: z.literal('team-member'),
  membershipId: NonEmptyStringSchema,
  teamId: NonEmptyStringSchema,
  nativeTeamId: NonEmptyStringSchema.optional(),
  nativeMemberId: NonEmptyStringSchema.optional(),
  actor: ActorRunRefSchema.optional(),
  runtimeRunId: NonEmptyStringSchema.optional(),
  name: z.string().optional(),
  membershipState: z.enum(['present', 'removed', 'unknown']).optional(),
  state: z.enum(['active', 'idle', 'removed', 'unknown']),
});
const MonitorDelegationValueSchema = z.discriminatedUnion('kind', [
  MonitorActorValueSchema,
  MonitorAffiliationValueSchema,
  MonitorTeamValueSchema,
  MonitorTeamMemberValueSchema,
]);

const ArtifactRefSchema = z.strictObject({
  artifactId: NonEmptyStringSchema,
  family: z.enum(['workflow-definition', 'workflow-journal', 'team-config', 'other']),
  mediaType: z.string().optional(),
  byteLength: NonNegativeSafeIntegerSchema.optional(),
  contentHash: z.string().optional(),
  availability: z.enum(['readable', 'metadata-only', 'unavailable']),
});
const MonitorWorkflowValueSchema = z.strictObject({
  kind: z.literal('workflow'),
  workflowId: NonEmptyStringSchema,
  name: z.string().optional(),
  active: z.boolean(),
  actorRunKeys: z.array(NonEmptyStringSchema),
  artifactRefs: z.array(ArtifactRefSchema),
});
const MonitorCompactionValueSchema = z.strictObject({
  kind: z.literal('compaction'),
  actor: ActorRunRefSchema.optional(),
  active: z.boolean(),
  trigger: z.string().optional(),
  outcome: z.enum(['completed', 'cancelled', 'failed', 'superseded', 'unknown']).optional(),
});
const MonitorEnvironmentValueSchema = z.strictObject({
  kind: z.literal('environment'),
  actor: ActorRunRefSchema.optional(),
  cwd: z.string().nullable().optional(),
  git: AgentGitStateSchema.nullable().optional(),
  worktrees: z.array(z.string()).optional(),
});

const MonitorEvidenceRefSchema = z
  .strictObject({
    namespace: NonEmptyStringSchema,
    id: NonEmptyStringSchema,
    revisionKey: NonEmptyStringSchema.optional(),
    sourceInstanceId: NonEmptyStringSchema.optional(),
    sourceObjectId: NonEmptyStringSchema.optional(),
    sourceGeneration: NonNegativeSafeIntegerSchema.optional(),
    cursorStart: NonNegativeSafeIntegerSchema.optional(),
    cursorEnd: NonNegativeSafeIntegerSchema.optional(),
  })
  .refine(
    ({ cursorStart, cursorEnd }) => cursorStart === undefined || cursorEnd === undefined || cursorEnd >= cursorStart,
    { message: 'cursorEnd must be greater than or equal to cursorStart', path: ['cursorEnd'] },
  );

function familyUpdateSchema<const Family extends z.ZodLiteral<string>, Value extends z.ZodType>(
  family: Family,
  value: Value,
) {
  return z.discriminatedUnion('operation', [
    z.strictObject({ family, operation: z.literal('upsert'), key: NonEmptyStringSchema, value }),
    z.strictObject({ family, operation: z.literal('retract'), key: NonEmptyStringSchema }),
    z.strictObject({
      family,
      operation: z.literal('replace'),
      values: z.array(z.strictObject({ key: NonEmptyStringSchema, value })),
      coverage: EvidenceCompletenessSchema,
    }),
  ]);
}

const MonitorFamilyUpdateSchema = z.union([
  familyUpdateSchema(z.literal('status'), MonitorStatusValueSchema),
  familyUpdateSchema(z.literal('usage'), MonitorUsageValueSchema),
  familyUpdateSchema(z.literal('context'), MonitorContextValueSchema),
  familyUpdateSchema(z.literal('model'), MonitorModelValueSchema),
  familyUpdateSchema(z.literal('effort'), MonitorEffortValueSchema),
  familyUpdateSchema(z.literal('mode'), MonitorModeValueSchema),
  familyUpdateSchema(z.literal('delegation'), MonitorDelegationValueSchema),
  familyUpdateSchema(z.literal('workflow'), MonitorWorkflowValueSchema),
  familyUpdateSchema(z.literal('compaction'), MonitorCompactionValueSchema),
  familyUpdateSchema(z.literal('environment'), MonitorEnvironmentValueSchema),
  familyUpdateSchema(z.literal('conversation'), MonitorMessageValueSchema),
]);

export const AdapterMonitorObservationBatchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  batchId: NonEmptyStringSchema,
  producer: z.strictObject({
    id: NonEmptyStringSchema,
    epoch: NonEmptyStringSchema,
    sequence: NonNegativeSafeIntegerSchema.optional(),
    contractVersion: NonEmptyStringSchema.optional(),
  }),
  phase: z.enum(['bootstrap', 'live', 'correction', 'resync']),
  observedAt: TimestampSchema,
  effectiveAt: TimestampSchema.optional(),
  quality: EvidenceQualitySchema,
  completeness: EvidenceCompletenessSchema,
  provisional: z.boolean(),
  readiness: z.enum(['loading', 'ready', 'degraded']).optional(),
  scope: z
    .strictObject({ nativeSessionId: NonEmptyStringSchema.optional(), actorRunKey: NonEmptyStringSchema.optional() })
    .optional(),
  updates: z.array(MonitorFamilyUpdateSchema),
  sourceWatermarks: z.array(
    z.strictObject({
      sourceId: NonEmptyStringSchema,
      sourceEpoch: NonEmptyStringSchema,
      sequence: NonNegativeSafeIntegerSchema.optional(),
      cursor: NonEmptyStringSchema.optional(),
      observedThrough: TimestampSchema.optional(),
    }),
  ),
  evidence: z.array(MonitorEvidenceRefSchema),
  capabilities: z
    .array(
      z.strictObject({
        family: MonitorMetricFamilySchema,
        support: z.enum(['supported', 'degraded', 'unsupported']),
        actorScope: z.enum(['root', 'current-actors', 'session']),
        latency: z.enum(['hook', 'sample', 'response', 'file-flush', 'historical']),
        source: NonEmptyStringSchema,
        contractVersion: NonEmptyStringSchema.optional(),
        limitations: z.array(z.string()),
      }),
    )
    .optional(),
  coverage: z
    .array(
      z.strictObject({
        family: MonitorMetricFamilySchema,
        completeness: EvidenceCompletenessSchema,
        asOf: TimestampSchema,
        actor: ActorRunRefSchema.optional(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
}) satisfies z.ZodType<AdapterMonitorObservationBatch>;

export const MonitorObservationBatchEventSchema = z.strictObject({
  type: z.literal('monitor:batch'),
  batch: AdapterMonitorObservationBatchSchema,
});
export type MonitorObservationBatchEvent = z.infer<typeof MonitorObservationBatchEventSchema>;

export type MonitorEvent = MonitorObservationBatchEvent;
export const MonitorEventSchema = MonitorObservationBatchEventSchema;
