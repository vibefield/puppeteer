import { z } from 'zod';

export const AssistantMessageEventSchema = z.strictObject({
  type: z.literal('assistant.message'),
  messageId: z.string().optional(),
  turnId: z.string().optional(),
  text: z.string(),
  /** False while deltas are still accumulating (MessageDisplay `final`). */
  final: z.boolean().optional(),
  /** True when sourced from display events rather than the transcript. */
  displayOnly: z.boolean().optional(),
});
export type AssistantMessageEvent = z.infer<typeof AssistantMessageEventSchema>;

export type ConversationEvent = AssistantMessageEvent;
export const ConversationEventSchema = AssistantMessageEventSchema;
