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

export const TeammateIdleEventSchema = z.strictObject({
  type: z.literal('delegation:teammate-idle'),
  membershipId: z.string().trim().min(1).optional(),
  teamId: z.string().trim().min(1).optional(),
  teamName: z.string().trim().min(1).optional(),
  teammateName: z.string().trim().min(1),
});
export type TeammateIdleEvent = z.infer<typeof TeammateIdleEventSchema>;

export type DelegationEvent = SubagentStartedEvent | SubagentStoppedEvent | TeammateIdleEvent;
export const DelegationEventSchema = z.discriminatedUnion('type', [
  SubagentStartedEventSchema,
  SubagentStoppedEventSchema,
  TeammateIdleEventSchema,
]);
