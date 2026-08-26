import { z } from 'zod';

export const SubagentStartedEventSchema = z.strictObject({
  type: z.literal('subagent.started'),
  subagentId: z.string(),
  agentType: z.string().optional(),
});
export type SubagentStartedEvent = z.infer<typeof SubagentStartedEventSchema>;

export const SubagentStoppedEventSchema = z.strictObject({
  type: z.literal('subagent.stopped'),
  subagentId: z.string(),
});
export type SubagentStoppedEvent = z.infer<typeof SubagentStoppedEventSchema>;

export const TaskCreatedEventSchema = z.strictObject({
  type: z.literal('task.created'),
  taskId: z.string(),
  description: z.string().optional(),
  teamName: z.string().optional(),
  teammateName: z.string().optional(),
});
export type TaskCreatedEvent = z.infer<typeof TaskCreatedEventSchema>;

export const TaskCompletedEventSchema = z.strictObject({
  type: z.literal('task.completed'),
  taskId: z.string(),
  teamName: z.string().optional(),
  teammateName: z.string().optional(),
});
export type TaskCompletedEvent = z.infer<typeof TaskCompletedEventSchema>;

/** A provider task state outside the legacy create/complete pair. */
export const TaskUpdatedEventSchema = z.strictObject({
  type: z.literal('task.updated'),
  taskId: z.string(),
  description: z.string().optional(),
  status: z.enum(['proposed', 'pending', 'in-progress', 'completed', 'failed', 'cancelled', 'removed', 'unknown']),
  providerStatus: z.string().optional(),
  teamName: z.string().optional(),
  teammateName: z.string().optional(),
  provisional: z.boolean().optional(),
});
export type TaskUpdatedEvent = z.infer<typeof TaskUpdatedEventSchema>;

export const TeammateIdleEventSchema = z.strictObject({
  type: z.literal('teammate.idle'),
  membershipId: z.string().optional(),
  teamId: z.string().optional(),
  teamName: z.string().optional(),
  teammateName: z.string(),
});
export type TeammateIdleEvent = z.infer<typeof TeammateIdleEventSchema>;

export type DelegationStateEvent =
  | SubagentStartedEvent
  | SubagentStoppedEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | TaskUpdatedEvent
  | TeammateIdleEvent;

export const DelegationStateEventSchema = z.discriminatedUnion('type', [
  SubagentStartedEventSchema,
  SubagentStoppedEventSchema,
  TaskCreatedEventSchema,
  TaskCompletedEventSchema,
  TaskUpdatedEventSchema,
  TeammateIdleEventSchema,
]);
