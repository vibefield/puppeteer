import { z } from 'zod';

export const TurnStartedEventSchema = z.strictObject({
  type: z.literal('turn:started'),
  /** Provider-native turn or prompt id. */
  turnId: z.string().trim().min(1).optional(),
  prompt: z.string().optional(),
});
export type TurnStartedEvent = z.infer<typeof TurnStartedEventSchema>;

export const TurnCompletedEventSchema = z.strictObject({
  type: z.literal('turn:completed'),
  turnId: z.string().trim().min(1).optional(),
  stopReason: z.string().trim().min(1).optional(),
  /** Provider-authoritative final assistant text when supplied at the boundary. */
  lastAssistantMessage: z.string().optional(),
});
export type TurnCompletedEvent = z.infer<typeof TurnCompletedEventSchema>;

export const TurnFailedEventSchema = z.strictObject({
  type: z.literal('turn:failed'),
  turnId: z.string().trim().min(1).optional(),
  error: z.string().optional(),
});
export type TurnFailedEvent = z.infer<typeof TurnFailedEventSchema>;

export type TurnEvent = TurnStartedEvent | TurnCompletedEvent | TurnFailedEvent;
export const TurnEventSchema = z.discriminatedUnion('type', [
  TurnStartedEventSchema,
  TurnCompletedEventSchema,
  TurnFailedEventSchema,
]);
