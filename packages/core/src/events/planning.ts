import { z } from 'zod';

export const PlanStepSchema = z.strictObject({
  text: z.string(),
  status: z.string().trim().min(1),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanUpdatedEventSchema = z.strictObject({
  type: z.literal('planning:updated'),
  planId: z.string().trim().min(1).optional(),
  steps: z.array(PlanStepSchema),
  provisional: z.boolean().optional(),
});
export type PlanUpdatedEvent = z.infer<typeof PlanUpdatedEventSchema>;

export type PlanningEvent = PlanUpdatedEvent;
export const PlanningEventSchema = PlanUpdatedEventSchema;
