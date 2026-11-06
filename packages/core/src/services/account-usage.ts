import { z } from 'zod';
import { AgentProviderDescriptorSchema, AgentProviderIdSchema } from './provider.js';
import { AgentProfileIdSchema, type AgentProfile } from './profiles.js';

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
 * The part of a plan a meter measures when it is not the whole plan: a model
 * family ("Claude and GPT models") or an allowance of its own ("Luna Reserve"),
 * named as the provider names it. Meters that share a group id are one family;
 * a consumer may head them with `label` and name each by its window alone.
 */
export const AccountUsageMetricGroupSchema = z.strictObject({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  /**
   * An allowance the provider draws on only after the plan's own limits run
   * out. Untouched, it says nothing about the plan, so a consumer may keep it
   * out of sight until it is used or those limits are spent
   * (`accountUsageMetricInPlay`).
   */
  standby: z.literal(true).optional(),
});
export type AccountUsageMetricGroup = z.infer<typeof AccountUsageMetricGroupSchema>;

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
  /** Absent for the plan's own meters; `label` stays unique across groups. */
  group: AccountUsageMetricGroupSchema.optional(),
  /**
   * When this meter was read, present only when earlier than its snapshot's `fetchedAt`: a meter a later, partial
   * reading (a push) did not carry, kept from the reading that did.
   */
  fetchedAt: TimestampSchema.optional(),
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
    provider: AgentProviderIdSchema,
    fetchedAt: TimestampSchema,
    scope: AccountUsageScopeSchema,
    source: AccountUsageSourceSchema,
    /** Adapter-ranked metrics. Generic consumers preserve this order. */
    metrics: z.array(AccountUsageMetricSchema),
    /**
     * Account-wide credits that are not represented by a percentage meter. A push that does not carry them keeps the
     * last reading's, which have no age of their own.
     */
    credits: AccountUsageCreditsSchema.optional(),
    /** Present when the snapshot was read for one registered profile rather than the native default. */
    profileId: AgentProfileIdSchema.optional(),
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

/** The fields the in-play rule reads, so a host's own copy of the metric contract fits as well as this one. */
type InPlayMetric = {
  kind: string;
  usedPercent: number;
  group?: { id: string; standby?: boolean | undefined } | undefined;
};

/**
 * Whether a meter belongs in sight, by the rule `standby` states: a standby allowance is in play once any meter of
 * its group is used, or once one of the plan's own windows (no group) is spent; every other meter always is. The one
 * place that rule is written, so every consumer of a reading keeps the same meters out of sight.
 */
export function accountUsageMetricInPlay(metric: InPlayMetric, metrics: readonly InPlayMetric[]): boolean {
  const group = metric.group;
  if (group?.standby !== true) return true;
  if (metrics.some((other) => other.group?.id === group.id && other.usedPercent > 0)) return true;
  return metrics.some((other) => other.group === undefined && other.kind === 'window' && other.usedPercent >= 100);
}

export const AccountUsageAvailableSchema = z.strictObject({
  status: z.literal('available'),
  snapshot: AccountUsageSnapshotSchema,
});
export type AccountUsageAvailable = z.infer<typeof AccountUsageAvailableSchema>;

export const AccountUsageFailureSchema = z.strictObject({
  status: z.enum(['unsupported', 'unauthenticated', 'unavailable']),
  provider: AgentProviderIdSchema,
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
  code: z.literal('rate-limited').optional(),
  /** Earliest provider-authorized retry time, normalized from Retry-After when available. */
  retryAt: TimestampSchema.optional(),
});
export type AccountUsageFailure = z.infer<typeof AccountUsageFailureSchema>;

/** The fields the passing rule reads, so a host's own copy of the failure contract fits as well as this one. */
type PassingFailure = { status: string; code?: string | undefined };

/**
 * Whether a failed refresh is passing: a read that failed or was rate limited says nothing of the account, so the
 * last reading still describes it and stands beside the failure. A failure that names the account (a refused sign-in,
 * limits it does not expose) says it cannot be read: that failure, not a kept reading, is the row. The one place that
 * rule is written, so every consumer of a retained reading tells the two apart alike.
 */
export function accountUsageFailurePasses(failure: PassingFailure): boolean {
  return failure.status === 'unavailable' || failure.code === 'rate-limited';
}

export const AccountUsageFetchResultSchema = z.union([AccountUsageAvailableSchema, AccountUsageFailureSchema]);
export type AccountUsageFetchResult = z.infer<typeof AccountUsageFetchResultSchema>;

/** Adapter-owned identity and recommended observation cadence. */
export const AccountUsageProviderSchema = z.strictObject({
  ...AgentProviderDescriptorSchema.shape,
  refresh: z.strictObject({
    pollIntervalMs: PositiveSafeIntegerSchema,
    /**
     * The delay before the next poll after a push that carries every meter the last poll did, or less when the
     * reading names a reset sooner; defaults to `pollIntervalMs`. A push never brings a poll forward.
     */
    pushUpdatePollIntervalMs: PositiveSafeIntegerSchema.optional(),
  }),
});
export type AccountUsageProvider = z.infer<typeof AccountUsageProviderSchema>;

/**
 * One account's reading as a monitor publishes it: the provider, the result,
 * and which registered account it belongs to. The last good snapshot is kept
 * (`stale`) when a later refresh fails, with that failure beside it. The
 * shape every host's usage column reads (`@vibefield/puppeteer-views`), and
 * what the runtime's monitor (`createAccountUsageMonitor`) produces.
 */
export const AccountUsageEntrySchema = z.strictObject({
  provider: AccountUsageProviderSchema,
  result: AccountUsageFetchResultSchema,
  /** The account this reading belongs to; absent while no registry answer exists. */
  profileId: AgentProfileIdSchema.optional(),
  /** Registry label for that account, so a row can name it without a second lookup. */
  profileLabel: NonEmptyStringSchema.optional(),
  /** The last good snapshot is retained when a later refresh fails. */
  stale: z.boolean().optional(),
  /** That failure. Whether the kept reading still stands for the account is `accountUsageFailurePasses`. */
  refreshFailure: AccountUsageFailureSchema.optional(),
});
export type AccountUsageEntry = z.infer<typeof AccountUsageEntrySchema>;

export const AccountUsageBatchSchema = z.strictObject({
  refreshedAt: TimestampSchema,
  entries: z.array(AccountUsageEntrySchema),
});
export type AccountUsageBatch = z.infer<typeof AccountUsageBatchSchema>;

/** One adapter-owned account-usage service, independent of live sessions. */
export interface AccountUsageService {
  readonly provider: AccountUsageProvider;
  /** Read usage for the native default account, or for one profile's root when given. */
  fetch(options?: { profile?: AgentProfile }): Promise<AccountUsageFetchResult>;
  subscribe?(listener: (result: AccountUsageFetchResult) => void): () => void;
}
