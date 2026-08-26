import { z } from 'zod';

export const TurnStartedEventSchema = z.strictObject({
  type: z.literal('turn.started'),
  /** Claude Code `prompt_id`. */
  turnId: z.string().optional(),
  prompt: z.string().optional(),
});
export type TurnStartedEvent = z.infer<typeof TurnStartedEventSchema>;

export const TurnCompletedEventSchema = z.strictObject({
  type: z.literal('turn.completed'),
  turnId: z.string().optional(),
  stopReason: z.string().optional(),
  /** Claude Code `Stop.last_assistant_message`. */
  lastAssistantMessage: z.string().optional(),
});
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>;

export const TurnFailedEventSchema = z.strictObject({
  type: z.literal('turn.failed'),
  turnId: z.string().optional(),
  error: z.string().optional(),
});
export type TurnFailedEvent = z.infer<typeof TurnFailedEventSchema>;

export type TurnStateEvent = TurnStartedEvent | TurnCompletedEvent | TurnFailedEvent;

export const TurnStateEventSchema = z.discriminatedUnion('type', [
  TurnStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
]);
