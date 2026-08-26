import { z } from 'zod';

/** A protocol-authoritative reasoning phase. This carries presence, not hidden thought text. */
export const ReasoningStartedEventSchema = z.strictObject({
  type: z.literal('reasoning.started'),
  reasoningId: z.string().optional(),
});
export type ReasoningStartedEvent = z.infer<typeof ReasoningStartedEventSchema>;

/** A reasoning pulse whose raw provider payload is retained on the envelope. */
export const ReasoningProgressEventSchema = z.strictObject({
  type: z.literal('reasoning.progress'),
  reasoningId: z.string().optional(),
});
export type ReasoningProgressEvent = z.infer<typeof ReasoningProgressEventSchema>;

/** An explicitly user-displayable reasoning summary, accumulated by the adapter. */
export const ReasoningSummaryEventSchema = z.strictObject({
  type: z.literal('reasoning.summary'),
  reasoningId: z.string().optional(),
  text: z.string(),
  final: z.boolean().optional(),
});
export type ReasoningSummaryEvent = z.infer<typeof ReasoningSummaryEventSchema>;

export const ReasoningCompletedEventSchema = z.strictObject({
  type: z.literal('reasoning.completed'),
  reasoningId: z.string().optional(),
});
export type ReasoningCompletedEvent = z.infer<typeof ReasoningCompletedEventSchema>;

export type ReasoningStateEvent =
  ReasoningStartedEvent | ReasoningProgressEvent | ReasoningSummaryEvent | ReasoningCompletedEvent;

export const ReasoningStateEventSchema = z.discriminatedUnion('type', [
  ReasoningStartedEventSchema,
  ReasoningProgressEventSchema,
  ReasoningSummaryEventSchema,
  ReasoningCompletedEventSchema,
]);
