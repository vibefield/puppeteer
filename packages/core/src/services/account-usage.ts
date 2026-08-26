import { z } from 'zod';

/**
 * Provider-neutral account usage and quota contracts.
 *
 * Account limits are deliberately separate from Agent: subscription quotas
 * are normally shared by every process and conversation authenticated as the
 * same provider account. Native bucket semantics stop at the adapter boundary;
 * consumers receive opaque canonical ids plus ordered semantic metrics.
 */

const NonEmptyStringSchema = z.string().trim().min(1);
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const TimestampSchema = z.iso.datetime({ offset: true });

export const AccountUsageScopeSchema = z.enum(['subscription', 'api', 'workspace', 'unknown']);
export type AccountUsageScope = z.infer<typeof AccountUsageScopeSchema>;

export const AccountUsageSourceSchema = z.strictObject({
  /** How the adapter obtained the snapshot without exposing credentials. */
  kind: z.enum(['native-protocol', 'native-statusline', 'oauth-endpoint']),
  /** Whether the provider publicly documents this integration surface. */
  stability: z.enum(['documented', 'experimental']),
});
export type AccountUsageSource = z.infer<typeof AccountUsageSourceSchema>;

export const AccountUsageMetricKindSchema = z.enum(['window', 'budget']);
export type AccountUsageMetricKind = z.infer<typeof AccountUsageMetricKindSchema>;

/**
 * One adapter-normalized meter, already named and ordered for a generic
 * consumer. The id is opaque outside the adapter; consumers render `label`
 * and preserve array order.
 */
export const AccountUsageMetricSchema = z.strictObject({
  id: NonEmptyStringSchema,
  /** Compact semantic label such as `5H`, `7D`, `OPUS`, or `BUDGET`. */
  label: NonEmptyStringSchema,
  /** Optional longer provider-neutral explanation for tooltips/accessibility. */
  description: NonEmptyStringSchema.optional(),
  kind: AccountUsageMetricKindSchema,
  /** Percentage consumed. Values above 100 are valid for exceeded budgets. */
  usedPercent: NonNegativeNumberSchema,
  /** Rolling/fixed window length when known. */
  durationMinutes: PositiveSafeIntegerSchema.optional(),
  startsAt: TimestampSchema.optional(),
  resetsAt: TimestampSchema.optional(),
});
export type AccountUsageMetric = z.infer<typeof AccountUsageMetricSchema>;

export const AccountUsageCreditsSchema = z
  .strictObject({
    /** Provider-formatted balance. A string preserves units and decimal precision. */
    balance: NonEmptyStringSchema.optional(),
    hasCredits: z.boolean().optional(),
    unlimited: z.boolean().optional(),
    /** Available provider-issued rate-limit reset credits, when supported. */
    resetCreditsAvailable: z.number().int().nonnegative().safe().optional(),
  })
  .refine((credits) => Object.values(credits).some((value) => value !== undefined), {
    message: 'account usage credits must contain at least one value',
  });
export type AccountUsageCredits = z.infer<typeof AccountUsageCreditsSchema>;

export const AccountUsageSnapshotSchema = z
  .strictObject({
    provider: NonEmptyStringSchema,
    fetchedAt: TimestampSchema,
    scope: AccountUsageScopeSchema,
    source: AccountUsageSourceSchema,
    /** Adapter-ranked metrics. Generic consumers preserve this order. */
    metrics: z.array(AccountUsageMetricSchema),
    /** Account-wide credits that are not represented by a percentage meter. */
    credits: AccountUsageCreditsSchema.optional(),
  })
  .superRefine((snapshot, context) => {
    const ids = new Set<string>();
    snapshot.metrics.forEach((metric, index) => {
      if (ids.has(metric.id)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate account usage metric id: ${metric.id}`,
          path: ['metrics', index, 'id'],
        });
      }
      ids.add(metric.id);
    });
  });
export type AccountUsageSnapshot = z.infer<typeof AccountUsageSnapshotSchema>;

export const AccountUsageAvailableSchema = z.strictObject({
  status: z.literal('available'),
  snapshot: AccountUsageSnapshotSchema,
});
export type AccountUsageAvailable = z.infer<typeof AccountUsageAvailableSchema>;

export const AccountUsageFailureSchema = z.strictObject({
  status: z.enum(['unsupported', 'unauthenticated', 'unavailable']),
  provider: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
  code: z.literal('rate-limited').optional(),
  /** Earliest provider-authorized retry time, normalized from Retry-After when available. */
  retryAt: TimestampSchema.optional(),
});
export type AccountUsageFailure = z.infer<typeof AccountUsageFailureSchema>;

export const AccountUsageFetchResultSchema = z.union([AccountUsageAvailableSchema, AccountUsageFailureSchema]);
export type AccountUsageFetchResult = z.infer<typeof AccountUsageFetchResultSchema>;

/** Adapter-owned identity and recommended observation cadence. */
export const AccountUsageProviderSchema = z.strictObject({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  refresh: z.strictObject({
    pollIntervalMs: PositiveSafeIntegerSchema,
    /** Poll delay after a push update; defaults to `pollIntervalMs`. */
    pushUpdatePollIntervalMs: PositiveSafeIntegerSchema.optional(),
  }),
});
export type AccountUsageProvider = z.infer<typeof AccountUsageProviderSchema>;

/** One adapter-owned account-usage service, independent of live sessions. */
export interface AccountUsageService {
  readonly provider: AccountUsageProvider;
  fetch(): Promise<AccountUsageFetchResult>;
  subscribe?(listener: (result: AccountUsageFetchResult) => void): () => void;
}
