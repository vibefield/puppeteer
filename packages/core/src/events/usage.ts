import { z } from 'zod';

const NonNegativeTokenCountSchema = z.number().nonnegative();

export const TokenUsageBreakdownSchema = z.strictObject({
  inputTokens: NonNegativeTokenCountSchema.optional(),
  /** Provider-normalized input that was not served from cache. */
  freshInputTokens: NonNegativeTokenCountSchema.optional(),
  outputTokens: NonNegativeTokenCountSchema.optional(),
  cacheReadTokens: NonNegativeTokenCountSchema.optional(),
  cacheCreationTokens: NonNegativeTokenCountSchema.optional(),
  reasoningTokens: NonNegativeTokenCountSchema.optional(),
});
export type TokenUsageBreakdown = z.infer<typeof TokenUsageBreakdownSchema>;

/** Session burn, kept distinct from context-window pressure. */
export const TokensUsedEventSchema = z.strictObject({
  type: z.literal('tokens.used'),
  usageId: z.string().min(1),
  boundary: z.enum(['response', 'sample']),
  canonical: z.boolean(),
  /** Provider-normalized total work for this observation. */
  totalTokens: NonNegativeTokenCountSchema.optional(),
  /** Tokens contributing to the short operational meter, normally fresh input + output. */
  meterTokens: NonNegativeTokenCountSchema.optional(),
  cumulativeTokens: NonNegativeTokenCountSchema.optional(),
  deltaTokens: NonNegativeTokenCountSchema.optional(),
  costUsd: z.number().nonnegative().optional(),
  breakdown: TokenUsageBreakdownSchema.optional(),
});
export type TokensUsedEvent = z.infer<typeof TokensUsedEventSchema>;

export type UsageEvent = TokensUsedEvent;
export const UsageEventSchema = TokensUsedEventSchema;
