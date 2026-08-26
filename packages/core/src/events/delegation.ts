import { z } from 'zod';

export const SubagentStartedEventSchema = z.strictObject({
  type: z.literal('delegation:subagent-started'),
  subagentId: z.string().trim().min(1),
  agentType: z.string().trim().min(1).optional(),
});
export type SubagentStartedEvent = z.infer<typeof SubagentStartedEventSchema>;

export const SubagentStoppedEventSchema = z.strictObject({
  type: z.literal('delegation:subagent-stopped'),
  subagentId: z.string().trim().min(1),
});
export type SubagentStoppedEvent = z.infer<typeof SubagentStoppedEventSchema>;

export const TaskCreatedEventSchema = z.strictObject({
  type: z.literal('delegation:task-created'),
  taskId: z.string().trim().min(1),
  description: z.string().optional(),
  teamName: z.string().trim().min(1).optional(),
  teammateName: z.string().trim().min(1).optional(),
});
export type TaskCreatedEvent = z.infer<typeof TaskCreatedEventSchema>;

export const TaskCompletedEventSchema = z.strictObject({
  type: z.literal('delegation:task-completed'),
  taskId: z.string().trim().min(1),
  teamName: z.string().trim().min(1).optional(),
  teammateName: z.string().trim().min(1).optional(),
});
export type TaskCompletedEvent = z.infer<typeof TaskCompletedEventSchema>;

/** A provider task state outside the legacy create/complete pair. */
export const TaskUpdatedEventSchema = z.strictObject({
  type: z.literal('delegation:task-updated'),
  taskId: z.string().trim().min(1),
  description: z.string().optional(),
  status: z.enum(['proposed', 'pending', 'in-progress', 'completed', 'failed', 'cancelled', 'removed', 'unknown']),
  providerStatus: z.string().trim().min(1).optional(),
  teamName: z.string().trim().min(1).optional(),
  teammateName: z.string().trim().min(1).optional(),
  provisional: z.boolean().optional(),
});
export type TaskUpdatedEvent = z.infer<typeof TaskUpdatedEventSchema>;

export const TeammateIdleEventSchema = z.strictObject({
  type: z.literal('delegation:teammate-idle'),
  membershipId: z.string().trim().min(1).optional(),
  teamId: z.string().trim().min(1).optional(),
  teamName: z.string().trim().min(1).optional(),
  teammateName: z.string().trim().min(1),
});
export type TeammateIdleEvent = z.infer<typeof TeammateIdleEventSchema>;

export type DelegationEvent =
  | SubagentStartedEvent
  | SubagentStoppedEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | TaskUpdatedEvent
  | TeammateIdleEvent;
export const DelegationEventSchema = z.discriminatedUnion('type', [
  SubagentStartedEventSchema,
  SubagentStoppedEventSchema,
  TaskCreatedEventSchema,
  TaskCompletedEventSchema,
  TaskUpdatedEventSchema,
  TeammateIdleEventSchema,
]);
