/**
 * Kimi Code account usage.
 *
 * Provider-scoped, independent of any TUI session. The native surface is the
 * managed-platform `/usages` HTTP endpoint the official CLI's `/usage` panel
 * already calls (`packages/oauth/src/managed-usage.ts` in kimi-code). Observation
 * is read-only: Kimi Code owns token refresh and persistence, so this adapter
 * never writes `~/.kimi-code/credentials` or rotates a refresh token.
 */

import type {
  AccountUsageCredits,
  AccountUsageFetchResult,
  AccountUsageMetric,
  AccountUsageProvider,
  AccountUsageService,
  AccountUsageSnapshot,
  AccountUsageSource,
  AgentProfile,
} from '@vibecook/puppeteer-core';
import {
  KIMI_CODE_DEFAULT_BASE_URL,
  getKimiCodeDocument,
  kimiCodeCredentialPath,
  readKimiCodeCredential,
  resolveKimiCodeBaseUrl,
} from '../transport/managed-platform.js';
import { kimiCredentialRoot } from './profiles.js';

export const KIMI_USAGE_ENDPOINT = `${KIMI_CODE_DEFAULT_BASE_URL}/usages`;
const DEFAULT_TIMEOUT_MS = 10_000;
const OAUTH_SOURCE: AccountUsageSource = { kind: 'oauth-endpoint', stability: 'documented' };

export const KIMI_ACCOUNT_USAGE_PROVIDER: AccountUsageProvider = {
  id: 'kimi',
  label: 'Kimi',
  refresh: { pollIntervalMs: 5 * 60_000 },
};

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const finite = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function retryAtFromHeader(value: string | undefined, now: Date): string | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  const millis = Number.isFinite(seconds) && seconds >= 0 ? now.valueOf() + seconds * 1_000 : Date.parse(header);
  if (!Number.isFinite(millis)) return undefined;
  return new Date(millis).toISOString();
}

const roundedPercent = (value: number): number => Math.round(value * 1e6) / 1e6;

function usedPercent(used: number, limit: number): number | undefined {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit <= 0) return undefined;
  return roundedPercent((used / limit) * 100);
}

function windowFromNative(raw: unknown): { duration: number; unit: string } | undefined {
  const window = rec(raw);
  if (!window) return undefined;
  const duration = finite(window.duration);
  const unit = str(window.timeUnit) ?? str(window.unit);
  if (duration === undefined || duration <= 0 || !unit) return undefined;
  if (unit === 'TIME_UNIT_MINUTE' || unit === 'minute') {
    if (duration >= 60 && duration % 60 === 0) return { duration: duration / 60, unit: 'hour' };
    return { duration, unit: 'minute' };
  }
  if (unit === 'TIME_UNIT_HOUR' || unit === 'hour') return { duration, unit: 'hour' };
  if (unit === 'TIME_UNIT_DAY' || unit === 'day') return { duration, unit: 'day' };
  if (unit === 'TIME_UNIT_WEEK' || unit === 'week') return { duration, unit: 'week' };
  return undefined;
}

function windowLabel(minutes: number | undefined, native?: { duration: number; unit: string }): string {
  if (minutes === 300 || (native?.unit === 'hour' && native.duration === 5)) return '5H';
  if (minutes === 10_080 || native?.unit === 'week') return '7D';
  if (native?.unit === 'hour') return `${native.duration}H`;
  if (native?.unit === 'day') return `${native.duration}D`;
  if (native?.unit === 'minute') return `${native.duration}M`;
  if (minutes !== undefined && minutes > 0) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}D`;
    if (minutes % 60 === 0) return `${minutes / 60}H`;
    return `${minutes}M`;
  }
  return 'LIMIT';
}

function windowRank(minutes: number | undefined, label: string): number {
  if (label === '5H' || minutes === 300) return 0;
  if (label === '7D' || minutes === 10_080) return 20;
  return 40;
}

interface RankedMetric {
  metric: AccountUsageMetric;
  rank: number;
}

function metricFromRow(
  id: string,
  usedRaw: unknown,
  limitRaw: unknown,
  resetRaw: unknown,
  nativeWindow: unknown,
  description: string | undefined,
): RankedMetric | undefined {
  const used = finite(usedRaw);
  const limit = finite(limitRaw);
  if (used === undefined || limit === undefined) return undefined;
  const percent = usedPercent(used, limit);
  if (percent === undefined) return undefined;
  const native = windowFromNative(nativeWindow);
  const minutes = native
    ? native.unit === 'hour'
      ? native.duration * 60
      : native.unit === 'day'
        ? native.duration * 1_440
        : native.unit === 'week'
          ? native.duration * 10_080
          : native.duration
    : undefined;
  const label = windowLabel(minutes, native);
  const reset = isoTimestamp(resetRaw);
  return {
    rank: windowRank(minutes, label),
    metric: {
      id,
      label,
      description: description ?? `${label} usage`,
      kind: 'window',
      usedPercent: percent,
      ...(minutes !== undefined && minutes > 0 ? { durationMinutes: minutes } : {}),
      ...(reset ? { resetsAt: reset } : {}),
    },
  };
}

/** The older document: a weekly `usage` summary and `limits[]` rows that carry their native window. */
function legacyMetrics(body: Record<string, unknown>): RankedMetric[] {
  const metrics: RankedMetric[] = [];
  const summaryWindow = rec(body.usage) ? { duration: 1, timeUnit: 'TIME_UNIT_WEEK' } : undefined;
  const summary = metricFromRow(
    'subscription:weekly:window',
    rec(body.usage)?.used,
    rec(body.usage)?.limit,
    rec(body.usage)?.resetTime,
    summaryWindow,
    'Weekly plan limit',
  );
  if (summary) metrics.push(summary);

  const limits = Array.isArray(body.limits) ? body.limits : [];
  for (const [index, item] of limits.entries()) {
    const row = rec(item);
    if (!row) continue;
    const detail = rec(row.detail) ?? row;
    const name = str(row.name) ?? str(detail.name);
    const nativeWindow = row.window ?? detail.window;
    const id = `subscription:${name ?? `limit-${index}`}:window`;
    const metric = metricFromRow(id, detail.used, detail.limit, detail.resetTime, nativeWindow, name ?? 'Plan window');
    if (metric) metrics.push(metric);
  }
  return metrics;
}

/**
 * The current document's `usages` entries, in the order the CLI lists them
 * (`quotaUsageRows` in kimi-code). Each is `used_ratio` (0–1) and `reset_time`.
 * `limit_month_code` is not a limit of its own: the CLI draws it as Kimi Code's
 * part of the monthly bar, so it is kept as that share, ranked just after it.
 * The month has no stated length; thirty days is the window a meter paces by.
 */
const QUOTA_WINDOWS = [
  { key: 'limit_5h', id: 'subscription:5h:window', label: '5H', description: '5-hour limit', minutes: 300, rank: 0 },
  {
    key: 'limit_7d',
    id: 'subscription:weekly:window',
    label: '7D',
    description: 'Weekly limit',
    minutes: 10_080,
    rank: 20,
  },
  {
    key: 'limit_month_total',
    id: 'subscription:monthly:window',
    label: '30D',
    description: 'Monthly limit',
    minutes: 43_200,
    rank: 30,
  },
  {
    key: 'limit_month_code',
    id: 'subscription:monthly-code:window',
    label: 'CODE',
    description: "Kimi Code's share of the monthly limit",
    minutes: 43_200,
    rank: 31,
  },
] as const;

function quotaMetrics(value: unknown): RankedMetric[] {
  const usages = rec(value);
  if (!usages) return [];
  return QUOTA_WINDOWS.flatMap((window): RankedMetric[] => {
    const entry = rec(usages[window.key]);
    const ratio = finite(entry?.used_ratio);
    if (ratio === undefined || ratio < 0) return [];
    const reset = isoTimestamp(entry?.reset_time);
    return [
      {
        rank: window.rank,
        metric: {
          id: window.id,
          label: window.label,
          description: window.description,
          kind: 'window',
          usedPercent: roundedPercent(ratio * 100),
          durationMinutes: window.minutes,
          ...(reset ? { resetsAt: reset } : {}),
        },
      },
    ];
  });
}

function fixedPointToCents(value: number): number {
  const cents = value / 1_000_000;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

/**
 * The pay-as-you-go booster wallet, read as the CLI reads it: `amount` and
 * `amountLeft` are fixed-point (a million per cent), the monthly charge limit
 * and this month's spend are plain cents, and a wallet never funded (no
 * positive `amount`) is no wallet. The limit becomes a budget meter only while
 * it is switched on.
 */
function parseBoosterWallet(value: unknown): { credits: AccountUsageCredits; budget?: RankedMetric } | undefined {
  const wallet = rec(value);
  const balance = rec(wallet?.balance);
  if (!wallet || !balance || str(balance.type) !== 'BOOSTER') return undefined;
  const amount = finite(balance.amount);
  if (amount === undefined || amount <= 0) return undefined;
  const amountLeft = finite(balance.amountLeft);
  const cents = amountLeft === undefined ? 0 : fixedPointToCents(amountLeft);
  const chargeLimit = rec(wallet.monthlyChargeLimit);
  const monthlyUsed = rec(wallet.monthlyUsed);
  const currency = str(chargeLimit?.currency) ?? str(monthlyUsed?.currency) ?? str(wallet.currency) ?? 'USD';
  const credits = { balance: `${(cents / 100).toFixed(2)} ${currency}`, hasCredits: cents > 0 };

  const limitCents = finite(chargeLimit?.priceInCents);
  const spent = usedPercent(finite(monthlyUsed?.priceInCents) ?? 0, limitCents ?? 0);
  if (wallet.monthlyChargeLimitEnabled !== true || spent === undefined) return { credits };
  return {
    credits,
    budget: {
      rank: 70,
      metric: {
        id: 'booster:monthly:budget',
        label: 'SPEND',
        description: 'Booster spend against the monthly charge limit',
        kind: 'budget',
        usedPercent: spent,
      },
    },
  };
}

/**
 * Normalize the managed `/usages` payload into ordered metrics. The current
 * document (`usages.limit_*`) wins; the older one (`usage` and `limits[]`) is
 * read only when it yields nothing, so a document carrying both never shows one
 * window twice.
 */
export function normalizeKimiAccountUsage(
  value: unknown,
  fetchedAt = new Date().toISOString(),
  source: AccountUsageSource = OAUTH_SOURCE,
): AccountUsageSnapshot {
  const body = rec(value) ?? {};
  const current = quotaMetrics(body.usages);
  const metrics = current.length > 0 ? current : legacyMetrics(body);
  const wallet = parseBoosterWallet(body.boosterWallet);
  if (wallet?.budget) metrics.push(wallet.budget);

  const byId = new Map<string, RankedMetric>();
  for (const entry of metrics) {
    const held = byId.get(entry.metric.id);
    if (!held || entry.rank < held.rank) byId.set(entry.metric.id, entry);
  }

  return {
    provider: 'kimi',
    fetchedAt,
    scope: 'subscription',
    source,
    metrics: [...byId.values()]
      .sort((left, right) => left.rank - right.rank || left.metric.id.localeCompare(right.metric.id))
      .map(({ metric }) => metric),
    ...(wallet ? { credits: wallet.credits } : {}),
  };
}

export interface FetchKimiAccountUsageOptions {
  timeoutMs?: number | undefined;
  /** Ambient environment: `KIMI_CODE_HOME` when no root is named, and `KIMI_CODE_BASE_URL`. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * The Kimi Code root to read: its credential, and the platform its config and
   * region marker name. Absent, the root Kimi Code itself resolves.
   */
  root?: string | undefined;
  endpoint?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  resolveAccessToken?: (() => Promise<string | undefined>) | undefined;
  now?: (() => Date) | undefined;
}

function failure(
  status: 'unauthenticated' | 'unavailable',
  message: string,
  retryable: boolean,
): AccountUsageFetchResult {
  return { status, provider: 'kimi', message, retryable };
}

const notFound = (): AccountUsageFetchResult =>
  failure('unauthenticated', 'Kimi Code OAuth credentials were not found', false);
const unreadable = (): AccountUsageFetchResult =>
  failure('unavailable', 'Kimi Code OAuth credentials could not be read', true);

export async function fetchKimiAccountUsage(
  options: FetchKimiAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure('unavailable', 'Kimi account usage timeout must be positive', false);
  }

  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const root = options.root ?? kimiCredentialRoot(undefined, env);
  let token: string;
  if (options.resolveAccessToken) {
    let resolved: string | undefined;
    try {
      resolved = await options.resolveAccessToken();
    } catch {
      return unreadable();
    }
    if (!resolved) return notFound();
    token = resolved;
  } else {
    const credential = await readKimiCodeCredential(kimiCodeCredentialPath(root), now().valueOf());
    if (credential.state === 'signed-out') return notFound();
    // A signed-in root whose fifteen-minute token lapsed while Kimi Code was
    // closed is not a root that needs a sign-in.
    if (credential.state === 'expired') {
      return failure('unavailable', "Kimi Code's access token has expired; Kimi Code renews it while it runs", true);
    }
    if (credential.state === 'unreadable') return unreadable();
    token = credential.accessToken;
  }

  const url = options.endpoint ?? `${await resolveKimiCodeBaseUrl(root, env)}/usages`;
  const response = await getKimiCodeDocument(url, token, { timeoutMs, fetchImpl: options.fetchImpl });
  if (response.status === 'failed') {
    return failure('unavailable', 'Kimi account usage request could not be completed', true);
  }
  if (response.status === 'invalid-json') {
    return failure('unavailable', 'Kimi account usage returned invalid JSON', true);
  }
  if (response.status === 'http-error') {
    if (response.httpStatus === 401 || response.httpStatus === 403) {
      return failure('unauthenticated', 'Kimi Code OAuth credentials were rejected', false);
    }
    const retryable = response.httpStatus === 429 || response.httpStatus >= 500;
    const retryAt = retryable ? retryAtFromHeader(response.retryAfter, now()) : undefined;
    return {
      status: 'unavailable',
      provider: 'kimi',
      message: `Kimi account usage request failed with HTTP ${response.httpStatus}`,
      retryable,
      ...(response.httpStatus === 429 ? { code: 'rate-limited' as const } : {}),
      ...(retryAt ? { retryAt } : {}),
    };
  }
  const snapshot = normalizeKimiAccountUsage(response.body, now().toISOString());
  if (snapshot.metrics.length === 0 && !snapshot.credits) {
    return failure('unavailable', 'Kimi returned no account usage limits', true);
  }
  return { status: 'available', snapshot };
}

export async function fetchKimiAccountUsageForProfile(
  profile?: AgentProfile,
  options: FetchKimiAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  // A managed profile reads its own root whatever the options name; the native
  // default reads the root Kimi Code resolves, as `kimiCredentialRoot` says.
  const result = await fetchKimiAccountUsage({
    ...options,
    ...(profile?.kind === 'managed' ? { root: profile.dataRoot } : {}),
  });
  if (!profile || result.status !== 'available') return result;
  return { ...result, snapshot: { ...result.snapshot, profileId: profile.id } };
}

export function createKimiAccountUsageService(options: FetchKimiAccountUsageOptions = {}): AccountUsageService {
  return {
    provider: KIMI_ACCOUNT_USAGE_PROVIDER,
    fetch: (fetchOptions) => fetchKimiAccountUsageForProfile(fetchOptions?.profile, options),
  };
}
