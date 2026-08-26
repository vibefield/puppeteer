import { z } from 'zod';

export const PermissionRequestedEventSchema = z.strictObject({
  type: z.literal('permission.requested'),
  requestId: z.string(),
  toolCallId: z.string().optional(),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  presentation: z.enum(['native-tui', 'host-ui']),
});
export type PermissionRequestedEvent = z.infer<typeof PermissionRequestedEventSchema>;

export const PermissionResolvedEventSchema = z.strictObject({
  type: z.literal('permission.resolved'),
  requestId: z.string(),
  outcome: z.enum(['allowed', 'denied', 'dismissed', 'unknown']),
});
export type PermissionResolvedEvent = z.infer<typeof PermissionResolvedEventSchema>;

export const AgentQuestionOptionSchema = z.strictObject({
  label: z.string(),
  description: z.string().optional(),
});
export type AgentQuestionOption = z.infer<typeof AgentQuestionOptionSchema>;

export const AgentStructuredQuestionSchema = z.strictObject({
  id: z.string().optional(),
  /** Short provider-native label shown above the question, when supplied. */
  header: z.string().optional(),
  prompt: z.string(),
  options: z.array(AgentQuestionOptionSchema).optional(),
  allowMultiple: z.boolean().optional(),
  allowFreeForm: z.boolean().optional(),
});
export type AgentStructuredQuestion = z.infer<typeof AgentStructuredQuestionSchema>;

export const QuestionRequestedEventSchema = z.strictObject({
  type: z.literal('question.requested'),
  requestId: z.string(),
  questions: z.array(AgentStructuredQuestionSchema),
});
export type QuestionRequestedEvent = z.infer<typeof QuestionRequestedEventSchema>;

export const QuestionResolvedEventSchema = z.strictObject({
  type: z.literal('question.resolved'),
  requestId: z.string(),
  outcome: z.enum(['answered', 'failed', 'cancelled', 'superseded']),
});
export type QuestionResolvedEvent = z.infer<typeof QuestionResolvedEventSchema>;

export type InteractionStateEvent =
  PermissionRequestedEvent | PermissionResolvedEvent | QuestionRequestedEvent | QuestionResolvedEvent;

export const InteractionStateEventSchema = z.discriminatedUnion('type', [
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
]);
