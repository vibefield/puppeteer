import { z } from 'zod';

export const CompactionStartedEventSchema = z.strictObject({
  type: z.literal('compaction:started'),
  compactionId: z.string().trim().min(1).optional(),
  trigger: z.string().trim().min(1).optional(),
});
export type CompactionStartedEvent = z.infer<typeof CompactionStartedEventSchema>;

export const CompactionCompletedEventSchema = z.strictObject({
  type: z.literal('compaction:completed'),
  compactionId: z.string().trim().min(1).optional(),
  trigger: z.string().trim().min(1).optional(),
  /** Omitted legacy events mean a successful completion. */
  outcome: z.enum(['completed', 'cancelled', 'failed', 'superseded', 'unknown']).optional(),
});
export type CompactionCompletedEvent = z.infer<typeof CompactionCompletedEventSchema>;

export type CompactionEvent = CompactionStartedEvent | CompactionCompletedEvent;
export const CompactionEventSchema = z.discriminatedUnion('type', [
  CompactionStartedEventSchema,
  CompactionCompletedEventSchema,
]);
