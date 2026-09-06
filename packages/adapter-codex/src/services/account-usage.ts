import type {
  AccountUsageCredits,
  AccountUsageFetchResult,
  AccountUsageMetric,
  AccountUsageProvider,
  AccountUsageService,
  AccountUsageSnapshot,
  AgentProfile,
} from '@vibecook/puppeteer-core';
import { PUPPETEER_VERSION } from '@vibecook/puppeteer-core';
import {
  AppServerClient,
  AppServerError,
  spawnAppServerTransport,
  type Transport,
} from '../transport/app-server-client.js';

const CLIENT_INFO = { name: 'puppeteer-account-usage', version: PUPPETEER_VERSION } as const;

export const CODEX_ACCOUNT_USAGE_PROVIDER: AccountUsageProvider = {
  id: 'codex',
  label: 'Codex',
  refresh: { pollIntervalMs: 60_000 },
};

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function unixSecondsIso(value: unknown): string | undefined {
  const seconds = finite(value);
  if (seconds === undefined || seconds < 0) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

interface RankedMetric {
  metric: AccountUsageMetric;
  rank: number;
}

interface NormalizedLimit {
  metrics: RankedMetric[];
  credits?: AccountUsageCredits;
  workspace: boolean;
}

function compactLabel(value: string): string {
  return value
    .replace(/^codex[\s_-]*/i, '')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .toUpperCase();
}

function specializedLimitLabel(id: string, name: string | undefined): string | undefined {
  const identity = `${id} ${name ?? ''}`;
  if (/\bspark\b/i.test(identity)) return 'SPARK';
  if (/\bmini\b/i.test(identity)) return 'MINI';
  return undefined;
}

function normalizeWindow(
  limitId: string,
  limitName: string | undefined,
  id: 'primary' | 'secondary',
  value: unknown,
  providerOrder: number,
): RankedMetric | undefined {
  const window = rec(value);
  if (!window) return undefined;
  const usedPercent = finite(window.usedPercent);
  if (usedPercent === undefined || usedPercent < 0) return undefined;

  const duration = finite(window.windowDurationMins);
  const resetsAt = unixSecondsIso(window.resetsAt);
  const specialized = specializedLimitLabel(limitId, limitName);
  const label = duration === 300 ? '5H' : duration === 10_080 ? (specialized ?? '7D') : compactLabel(id) || 'LIMIT';
  const rank =
    duration === 300
      ? (specialized ? 5 : 0) + providerOrder / 100
      : duration === 10_080
        ? 20 + (specialized ? 5 : 0) + providerOrder / 100
        : 60 + providerOrder / 100;
  return {
    rank,
    metric: {
      id: `${limitId}:${id}:window`,
      label,
      description: `${limitName ?? limitId} ${label} usage`,
      kind: 'window',
      usedPercent,
      ...(duration !== undefined && duration > 0 ? { durationMinutes: duration } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    },
  };
}

function normalizeCredits(value: unknown): AccountUsageCredits | undefined {
  const credits = rec(value);
  if (!credits) return undefined;
  const balance = str(credits.balance);
  const hasCredits = typeof credits.hasCredits === 'boolean' ? credits.hasCredits : undefined;
  const unlimited = typeof credits.unlimited === 'boolean' ? credits.unlimited : undefined;
  if (balance === undefined && hasCredits === undefined && unlimited === undefined) return undefined;
  return {
    ...(balance !== undefined ? { balance } : {}),
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
  };
}

function normalizeBudget(id: string, name: string | undefined, value: unknown): RankedMetric | undefined {
  const budget = rec(value);
  const limit = str(budget?.limit);
  const used = str(budget?.used);
  const reportedRemainingPercent = finite(budget?.remainingPercent);
  const usedPercent = (() => {
    if (reportedRemainingPercent !== undefined && reportedRemainingPercent >= 0) {
      return Math.max(0, 100 - reportedRemainingPercent);
    }
    const numericLimit = Number(limit);
    const numericUsed = Number(used);
    return Number.isFinite(numericLimit) && numericLimit > 0 && Number.isFinite(numericUsed) && numericUsed >= 0
      ? (numericUsed / numericLimit) * 100
      : undefined;
  })();
  const resetsAt = unixSecondsIso(budget?.resetsAt);
  if (usedPercent === undefined) return undefined;
  const description = name ?? id;
  return {
    rank: 70,
    metric: {
      id: `${id}:budget`,
      label: /credit/i.test(`${id} ${description}`) ? 'CREDIT' : 'BUDGET',
      description,
      kind: 'budget',
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    },
  };
}

function normalizeLimit(fallbackId: string, value: unknown, providerOrder: number): NormalizedLimit | undefined {
  const limit = rec(value);
  if (!limit) return undefined;
  const id = str(limit.limitId) ?? fallbackId;
  const name = str(limit.limitName);
  const metrics = [
    normalizeWindow(id, name, 'primary', limit.primary, providerOrder),
    normalizeWindow(id, name, 'secondary', limit.secondary, providerOrder),
    normalizeBudget(id, name, limit.individualLimit),
  ].filter((metric): metric is RankedMetric => metric !== undefined);
  const credits = normalizeCredits(limit.credits);
  const reached = str(limit.rateLimitReachedType);
  const workspace = rec(limit.individualLimit) !== undefined || reached?.startsWith('workspace_') === true;
  if (metrics.length === 0 && !credits && !reached) return undefined;
  return {
    metrics,
    ...(credits ? { credits } : {}),
    workspace,
  };
}

/** Normalize the documented `account/rateLimits/read` response. */
export function normalizeCodexAccountUsage(value: unknown, fetchedAt = new Date().toISOString()): AccountUsageSnapshot {
  const response = rec(value) ?? {};
  const byId = rec(response.rateLimitsByLimitId);
  const candidates =
    byId && Object.keys(byId).length > 0 ? Object.entries(byId) : [['codex', response.rateLimits] as const];
  const limits = candidates
    .map(([id, limit], index) => normalizeLimit(id, limit, index))
    .filter((limit): limit is NormalizedLimit => limit !== undefined);

  const resetCredits = rec(response.rateLimitResetCredits);
  const resetCreditsAvailable = finite(resetCredits?.availableCount);
  const limitCredits = limits.find((limit) => limit.credits)?.credits;
  const credits =
    resetCreditsAvailable !== undefined && resetCreditsAvailable >= 0
      ? { ...limitCredits, resetCreditsAvailable }
      : limitCredits;

  return {
    provider: 'codex',
    fetchedAt,
    scope: limits.some((limit) => limit.workspace) ? 'workspace' : 'subscription',
    source: { kind: 'native-protocol', stability: 'documented' },
    metrics: limits
      .flatMap((limit) => limit.metrics)
      .sort((left, right) => left.rank - right.rank || left.metric.id.localeCompare(right.metric.id))
      .map(({ metric }) => metric),
    ...(credits ? { credits } : {}),
  };
}

export interface FetchCodexAccountUsageOptions {
  /** One-shot transport override for tests or embedded app-server routing. It is closed after the fetch. */
  transport?: Transport;
  executable?: string;
  requestTimeoutMs?: number;
  now?: () => Date;
  /** Extra app-server environment, merged over this process's own. Carries the profile binding. */
  env?: Record<string, string>;
  /** Injected transport factory; the default spawns `codex app-server` over stdio. */
  spawnTransport?: (options: { executable?: string; env?: Record<string, string> }) => Transport;
}

function codexFailure(error: unknown): AccountUsageFetchResult {
  if (error instanceof RangeError && /timeout/i.test(error.message)) {
    return {
      status: 'unavailable',
      provider: 'codex',
      message: 'Codex account usage timeout must be positive',
      retryable: false,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const unauthenticated =
    (error instanceof AppServerError || error instanceof Error) &&
    /(auth|unauthori[sz]ed|not logged in|login required|credential)/i.test(message);
  return {
    status: unauthenticated ? 'unauthenticated' : 'unavailable',
    provider: 'codex',
    message: unauthenticated
      ? 'Codex is not authenticated with a supported account'
      : 'Codex account usage is unavailable',
    retryable: !unauthenticated,
  };
}

/** Fetch account-wide Codex quota data through the documented app-server API. */
export async function fetchCodexAccountUsage(
  options: FetchCodexAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
  ) {
    await options.transport?.close();
    return codexFailure(new RangeError('app-server request timeout must be positive'));
  }

  let transport: Transport | undefined;
  let client: AppServerClient | undefined;
  try {
    transport =
      options.transport ??
      (options.spawnTransport ?? spawnAppServerTransport)({
        ...(options.executable !== undefined ? { executable: options.executable } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
    client = new AppServerClient(transport, { requestTimeoutMs: options.requestTimeoutMs });
    await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: {} });
    client.notify('initialized');
    const response = await client.request('account/rateLimits/read');
    const snapshot = normalizeCodexAccountUsage(response, (options.now ?? (() => new Date()))().toISOString());
    if (snapshot.metrics.length === 0 && !snapshot.credits) {
      return {
        status: 'unavailable',
        provider: 'codex',
        message: 'Codex returned no account rate-limit buckets',
        retryable: true,
      };
    }
    return { status: 'available', snapshot };
  } catch (error) {
    return codexFailure(error);
  } finally {
    if (client) await client.close();
    else await transport?.close();
  }
}

/**
 * Read Codex account usage for the native default account, or for one profile's
 * root. A managed profile binds the app-server to its own `CODEX_HOME`, so the
 * quotas come back for the account that root is logged into.
 */
export async function fetchCodexAccountUsageForProfile(
  profile?: AgentProfile,
  options: Omit<FetchCodexAccountUsageOptions, 'transport'> = {},
): Promise<AccountUsageFetchResult> {
  const binding = profile?.kind === 'managed' ? { CODEX_HOME: profile.dataRoot } : undefined;
  const result = await fetchCodexAccountUsage({
    ...options,
    ...(binding ? { env: { ...options.env, ...binding } } : {}),
  });
  if (!profile || result.status !== 'available') return result;
  return { ...result, snapshot: { ...result.snapshot, profileId: profile.id } };
}

/** Complete account-usage capability advertised by the Codex adapter. */
export function createCodexAccountUsageService(
  options: Omit<FetchCodexAccountUsageOptions, 'transport'> = {},
): AccountUsageService {
  return {
    provider: CODEX_ACCOUNT_USAGE_PROVIDER,
    fetch: (fetchOptions) => fetchCodexAccountUsageForProfile(fetchOptions?.profile, options),
  };
}
