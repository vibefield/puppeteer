import { z } from 'zod';

export const PermissionRequestedEventSchema = z.strictObject({
  type: z.literal('interaction:permission-requested'),
  requestId: z.string().trim().min(1),
  toolCallId: z.string().trim().min(1).optional(),
  tool: z.string().trim().min(1).optional(),
  input: z.unknown().optional(),
  presentation: z.enum(['native-tui', 'host-ui']),
});
export type PermissionRequestedEvent = z.infer<typeof PermissionRequestedEventSchema>;

export const PermissionResolvedEventSchema = z.strictObject({
  type: z.literal('interaction:permission-resolved'),
  requestId: z.string().trim().min(1),
  outcome: z.enum(['allowed', 'denied', 'dismissed', 'unknown']),
});
export type PermissionResolvedEvent = z.infer<typeof PermissionResolvedEventSchema>;

export const AgentQuestionOptionSchema = z.strictObject({
  label: z.string().trim().min(1),
  description: z.string().optional(),
});
export type AgentQuestionOption = z.infer<typeof AgentQuestionOptionSchema>;

export const AgentStructuredQuestionSchema = z.strictObject({
  id: z.string().trim().min(1).optional(),
  /** Short provider-native label shown above the question, when supplied. */
  header: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1),
  options: z.array(AgentQuestionOptionSchema).optional(),
  allowMultiple: z.boolean().optional(),
  allowFreeForm: z.boolean().optional(),
});
export type AgentStructuredQuestion = z.infer<typeof AgentStructuredQuestionSchema>;

export const QuestionRequestedEventSchema = z.strictObject({
  type: z.literal('interaction:question-requested'),
  requestId: z.string().trim().min(1),
  questions: z.array(AgentStructuredQuestionSchema).min(1),
});
export type QuestionRequestedEvent = z.infer<typeof QuestionRequestedEventSchema>;

export const QuestionResolvedEventSchema = z.strictObject({
  type: z.literal('interaction:question-resolved'),
  requestId: z.string().trim().min(1),
  outcome: z.enum(['answered', 'failed', 'cancelled', 'superseded']),
});
export type QuestionResolvedEvent = z.infer<typeof QuestionResolvedEventSchema>;

export type InteractionEvent =
  PermissionRequestedEvent | PermissionResolvedEvent | QuestionRequestedEvent | QuestionResolvedEvent;
export const InteractionEventSchema = z.discriminatedUnion('type', [
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
]);
