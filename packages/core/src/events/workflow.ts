import { z } from 'zod';

export const WorkflowMemberSchema = z.strictObject({
  agentId: z.string().min(1),
  agentType: z.string().min(1).optional(),
  state: z.enum(['active', 'completed']),
});
export type WorkflowMember = z.infer<typeof WorkflowMemberSchema>;

/** Provider workflow snapshot. Repeated ids replace prior membership and activity state. */
export const WorkflowUpdatedEventSchema = z.strictObject({
  type: z.literal('workflow.updated'),
  workflowId: z.string().min(1),
  name: z.string().min(1).optional(),
  active: z.boolean(),
  members: z.array(WorkflowMemberSchema).optional(),
});
export type WorkflowUpdatedEvent = z.infer<typeof WorkflowUpdatedEventSchema>;

export type WorkflowEvent = WorkflowUpdatedEvent;
export const WorkflowEventSchema = WorkflowUpdatedEventSchema;
