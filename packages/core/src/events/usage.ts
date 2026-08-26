import { z } from 'zod';

export const TokenUsageBreakdownSchema = z.strictObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
});
export type TokenUsageBreakdown = z.infer<typeof TokenUsageBreakdownSchema>;

/** Session burn, kept distinct from context-window pressure. */
export const TokensUsedEventSchema = z.strictObject({
  type: z.literal('tokens.used'),
  usageId: z.string(),
  boundary: z.enum(['response', 'sample']),
  canonical: z.boolean(),
  cumulativeTokens: z.number().optional(),
  deltaTokens: z.number().optional(),
  breakdown: TokenUsageBreakdownSchema.optional(),
});
export type TokensUsedEvent = z.infer<typeof TokensUsedEventSchema>;

export type UsageEvent = TokensUsedEvent;
export const UsageEventSchema = TokensUsedEventSchema;
