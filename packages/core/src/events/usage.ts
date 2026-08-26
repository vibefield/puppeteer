import { z } from 'zod';

const NonNegativeTokenCountSchema = z.number().int().nonnegative().safe();

export const TokenUsageBreakdownSchema = z
  .strictObject({
    inputTokens: NonNegativeTokenCountSchema.optional(),
    /** Provider-normalized input that was not served from cache. */
    freshInputTokens: NonNegativeTokenCountSchema.optional(),
    outputTokens: NonNegativeTokenCountSchema.optional(),
    cacheReadTokens: NonNegativeTokenCountSchema.optional(),
    cacheCreationTokens: NonNegativeTokenCountSchema.optional(),
    reasoningTokens: NonNegativeTokenCountSchema.optional(),
  })
  .refine((breakdown) => Object.values(breakdown).some((value) => value !== undefined), {
    message: 'token usage breakdown must contain at least one count',
  });
export type TokenUsageBreakdown = z.infer<typeof TokenUsageBreakdownSchema>;

/** Session burn, kept distinct from context-window pressure. */
export const TokensUsedEventSchema = z
  .strictObject({
    type: z.literal('usage:tokens-used'),
    usageId: z.string().trim().min(1),
    boundary: z.enum(['response', 'sample']),
    canonical: z.boolean(),
    /** Provider-normalized total work for this observation. */
    totalTokens: NonNegativeTokenCountSchema.optional(),
    /** Tokens contributing to the short operational meter, normally fresh input + output. */
    meterTokens: NonNegativeTokenCountSchema.optional(),
    cumulativeTokens: NonNegativeTokenCountSchema.optional(),
    deltaTokens: NonNegativeTokenCountSchema.optional(),
    costUsd: z.number().finite().nonnegative().optional(),
    breakdown: TokenUsageBreakdownSchema.optional(),
  })
  .refine(
    (event) =>
      event.totalTokens !== undefined ||
      event.meterTokens !== undefined ||
      event.cumulativeTokens !== undefined ||
      event.deltaTokens !== undefined ||
      event.costUsd !== undefined ||
      event.breakdown !== undefined,
    { message: 'usage observation must contain a token count, cost, or breakdown' },
  );
export type TokensUsedEvent = z.infer<typeof TokensUsedEventSchema>;

export type UsageEvent = TokensUsedEvent;
export const UsageEventSchema = TokensUsedEventSchema;
