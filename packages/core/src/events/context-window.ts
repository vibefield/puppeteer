import { z } from 'zod';

/** Current provider-reported context pressure, normalized to ACP's used/size model. */
export const ContextWindowUpdatedEventSchema = z.strictObject({
  type: z.literal('context-window.updated'),
  usedTokens: z.number(),
  capacityTokens: z.number(),
  /** Provider-calculated percentage when the native surface supplies one. */
  usedPercentage: z.number().optional(),
  /** Distinguishes a preserved provider value from a locally derived ratio. */
  percentageSource: z.enum(['provider', 'derived']).optional(),
  modelId: z.string().optional(),
});
export type ContextWindowUpdatedEvent = z.infer<typeof ContextWindowUpdatedEventSchema>;

/** The previous measurement is no longer trustworthy; this never means 0% used. */
export const ContextWindowInvalidatedEventSchema = z.strictObject({
  type: z.literal('context-window.invalidated'),
  reason: z.enum(['compacted', 'history-changed', 'model-changed', 'provider-reset']),
});
export type ContextWindowInvalidatedEvent = z.infer<typeof ContextWindowInvalidatedEventSchema>;

export type ContextWindowEvent = ContextWindowUpdatedEvent | ContextWindowInvalidatedEvent;
export const ContextWindowEventSchema = z.discriminatedUnion('type', [
  ContextWindowUpdatedEventSchema,
  ContextWindowInvalidatedEventSchema,
]);
