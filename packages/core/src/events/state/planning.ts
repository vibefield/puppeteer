import { z } from 'zod';

export const PlanStepSchema = z.strictObject({
  text: z.string(),
  status: z.string(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanUpdatedEventSchema = z.strictObject({
  type: z.literal('plan.updated'),
  planId: z.string().optional(),
  steps: z.array(PlanStepSchema),
  provisional: z.boolean().optional(),
});
export type PlanUpdatedEvent = z.infer<typeof PlanUpdatedEventSchema>;

export const CompactionStartedEventSchema = z.strictObject({
  type: z.literal('compaction.started'),
  compactionId: z.string().optional(),
  trigger: z.string().optional(),
});
export type CompactionStartedEvent = z.infer<typeof CompactionStartedEventSchema>;

export const CompactionCompletedEventSchema = z.strictObject({
  type: z.literal('compaction.completed'),
  compactionId: z.string().optional(),
  trigger: z.string().optional(),
  /** Omitted legacy events mean a successful completion. */
  outcome: z.enum(['completed', 'cancelled', 'failed', 'superseded', 'unknown']).optional(),
});
export type CompactionCompletedEvent = z.infer<typeof CompactionCompletedEventSchema>;

export type PlanningStateEvent = PlanUpdatedEvent | CompactionStartedEvent | CompactionCompletedEvent;

export const PlanningStateEventSchema = z.discriminatedUnion('type', [
  PlanUpdatedEventSchema,
  CompactionStartedEventSchema,
  CompactionCompletedEventSchema,
]);
