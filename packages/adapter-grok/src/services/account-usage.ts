/**
 * Grok account usage.
 *
 * Provider-scoped, independent of any TUI session. Grok Build's pager reads the
 * weekly SuperGrok pool through ACP `ext_method` `x.ai/billing`. On the wire
 * that is `_x.ai/billing` (ACP custom methods require the `_` prefix); sending
 * `x.ai/billing` returns -32601. The agent already holds the grok.com login
 * token, so this service never reads `~/.grok/auth.json` and never scrapes the
 * terminal. A managed profile binds `GROK_HOME` the same way launch does.
 */

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
  GROK_BILLING_ACP_METHOD,
  GrokAcpClient,
  GrokAcpError,
  JSONRPC_METHOD_NOT_FOUND,
  spawnGrokAgentTransport,
  type GrokAgentTransport,
  type JsonRpcErrorBody,
} from '../transport/agent-client.js';
import { GROK_PROFILE_ROOT_VARIABLE } from './profiles.js';

const GROK_CACHED_TOKEN_AUTH = 'cached_token';
const CLIENT_INFO = { name: 'puppeteer-account-usage', version: PUPPETEER_VERSION } as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const AUTH_PATTERN =
  /authentication required|not authenticated|no cached auth|session expired|run [`']?grok login|sign in/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate[- ]?limit/i;
const SOURCE = { kind: 'native-protocol', stability: 'experimental' } as const;

export const GROK_ACCOUNT_USAGE_PROVIDER: AccountUsageProvider = {
  id: 'grok',
  label: 'Grok',
  refresh: { pollIntervalMs: 15 * 60_000 },
};

export interface FetchGrokAccountUsageOptions {
  /** One-shot transport override for tests. Closed after the fetch. */
  transport?: GrokAgentTransport | undefined;
  executable?: string | undefined;
  requestTimeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
  /** Extra process environment; carries the profile binding (`GROK_HOME`). */
  env?: Record<string, string> | undefined;
  spawnTransport?: ((options: { executable?: string; env?: Record<string, string> }) => GrokAgentTransport) | undefined;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function isoTimestamp(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

/** Proto3 JSON omits zero Cents as `{}`. */
function cents(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric = finite(value);
  if (numeric !== undefined) return numeric;
  const wrapped = rec(value);
  if (!wrapped) return undefined;
  if (wrapped.val === undefined) return 0;
  return finite(wrapped.val);
}

function dollarsFromCents(value: number): string {
  return (value / 100).toFixed(2);
}

function periodMinutes(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return undefined;
  const minutes = Math.round((endMs - startMs) / 60_000);
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : undefined;
}

function includedWindow(
  periodType: string | undefined,
  start: string | undefined,
  end: string | undefined,
): { label: string; durationMinutes: number } | undefined {
  const token = (periodType ?? '').toUpperCase();
  if (token.includes('WEEKLY')) return { label: '7D', durationMinutes: 10_080 };
  if (token.includes('MONTHLY')) return { label: '30D', durationMinutes: periodMinutes(start, end) ?? 43_200 };
  const duration = periodMinutes(start, end);
  if (duration === undefined) return undefined;
  if (duration >= 4 * 1_440 && duration <= 12 * 1_440) return { label: '7D', durationMinutes: 10_080 };
  if (duration >= 20 * 1_440 && duration <= 45 * 1_440) return { label: '30D', durationMinutes: duration };
  return undefined;
}

function firstDefined<T>(...values: readonly T[]): T | undefined {
  return values.find((value) => value !== undefined);
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

/** The default transport: `env` carries only the binding, merged over this process's environment. */
function spawnBillingTransport(options: { executable?: string; env?: Record<string, string> }): GrokAgentTransport {
  return spawnGrokAgentTransport({
    ...(options.executable !== undefined ? { executable: options.executable } : {}),
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

function authMethodIds(value: unknown): string[] {
  const methods = rec(value)?.authMethods;
  if (!Array.isArray(methods)) return [];
  return methods.map((method) => str(rec(method)?.id)).filter((id): id is string => id !== undefined);
}

function errorBody(error: unknown): JsonRpcErrorBody | undefined {
  if (error instanceof GrokAcpError) return error.body;
  return undefined;
}

function isMethodNotFound(error: unknown): boolean {
  const body = errorBody(error);
  if (body?.code === JSONRPC_METHOD_NOT_FOUND) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /method not found/i.test(message);
}

function isUnauthenticated(error: unknown): boolean {
  const body = errorBody(error);
  const message = `${body?.message ?? ''} ${error instanceof Error ? error.message : String(error)}`;
  return AUTH_PATTERN.test(message);
}

function isRateLimited(error: unknown): boolean {
  const body = errorBody(error);
  const message = `${body?.message ?? ''} ${error instanceof Error ? error.message : String(error)}`;
  return body?.code === 429 || RATE_LIMIT_PATTERN.test(message);
}

function grokFailure(error: unknown): AccountUsageFetchResult {
  if (error instanceof RangeError && /must be positive/i.test(error.message)) {
    return {
      status: 'unavailable',
      provider: 'grok',
      message: 'Grok account usage timeout must be positive',
      retryable: false,
    };
  }
  if (isMethodNotFound(error)) {
    return {
      status: 'unsupported',
      provider: 'grok',
      message: 'Grok account usage is not exposed through its ACP protocol',
      retryable: false,
    };
  }
  if (isUnauthenticated(error)) {
    return {
      status: 'unauthenticated',
      provider: 'grok',
      message: 'Grok is not authenticated with a grok.com account',
      retryable: false,
    };
  }
  const rateLimited = isRateLimited(error);
  return {
    status: 'unavailable',
    provider: 'grok',
    message: 'Grok account usage is unavailable',
    retryable: true,
    ...(rateLimited ? { code: 'rate-limited' as const } : {}),
  };
}

function includedUsedPercent(config: Record<string, unknown>): number | undefined {
  const reported = finite(config.creditUsagePercent) ?? finite(config.credit_usage_percent);
  if (reported !== undefined && reported >= 0) return reported;
  const limit = cents(config.monthlyLimit ?? config.monthly_limit);
  const used = cents(firstDefined(config.used, config.includedUsed, config.included_used));
  if (limit === undefined || limit <= 0 || used === undefined || used < 0) return undefined;
  return (used / limit) * 100;
}

function normalizeCredits(config: Record<string, unknown>): AccountUsageCredits | undefined {
  const prepaid = cents(config.prepaidBalance ?? config.prepaid_balance);
  if (prepaid === undefined) return undefined;
  return { balance: dollarsFromCents(prepaid), hasCredits: prepaid > 0 };
}

function onDemandMetric(config: Record<string, unknown>, resetsAt: string | undefined): AccountUsageMetric | undefined {
  const cap = cents(config.onDemandCap ?? config.on_demand_cap);
  const used = cents(config.onDemandUsed ?? config.on_demand_used) ?? 0;
  if (cap === undefined || cap <= 0 || used < 0) return undefined;
  return {
    id: 'grok:on-demand:budget',
    label: 'ON-DEMAND',
    description: 'Grok on-demand credit usage',
    kind: 'budget',
    usedPercent: (used / cap) * 100,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** Normalize the ACP `_x.ai/billing` / `GetGrokCreditsConfig` payload. */
export function normalizeGrokAccountUsage(value: unknown, fetchedAt = new Date().toISOString()): AccountUsageSnapshot {
  const response = rec(value) ?? {};
  const config = rec(response.config) ?? response;
  const period = rec(config.currentPeriod) ?? rec(config.current_period) ?? {};
  const startsAt = isoTimestamp(firstDefined(period.start, config.billingPeriodStart, config.billing_period_start));
  const resetsAt = isoTimestamp(firstDefined(period.end, config.billingPeriodEnd, config.billing_period_end));
  const window = includedWindow(
    str(period.type) ?? str(period.periodType) ?? str(period.period_type),
    startsAt,
    resetsAt,
  );
  const usedPercent = includedUsedPercent(config);
  const metrics: AccountUsageMetric[] = [];
  if (usedPercent !== undefined && usedPercent >= 0 && window) {
    metrics.push({
      id: 'grok:included:window',
      label: window.label,
      description: window.label === '7D' ? 'Grok weekly included usage' : 'Grok included usage',
      kind: 'window',
      usedPercent,
      durationMinutes: window.durationMinutes,
      ...(startsAt ? { startsAt } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const onDemand = onDemandMetric(config, resetsAt);
  if (onDemand) metrics.push(onDemand);
  const credits = normalizeCredits(config);
  return {
    provider: 'grok',
    fetchedAt,
    scope: 'subscription',
    source: SOURCE,
    metrics,
    ...(credits ? { credits } : {}),
  };
}

/** Fetch account-wide Grok quota data through ACP `_x.ai/billing`. */
export async function fetchGrokAccountUsage(
  options: FetchGrokAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  if (options.requestTimeoutMs !== undefined) {
    try {
      positiveTimeout(options.requestTimeoutMs, 'Grok account usage timeout');
    } catch (error) {
      await options.transport?.close();
      return grokFailure(error);
    }
  }

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let transport: GrokAgentTransport | undefined;
  let client: GrokAcpClient | undefined;
  try {
    transport =
      options.transport ??
      // The transport factory's parameter stays narrow: test doubles annotate it
      // explicitly, and widening it would reject those implementations.
      (options.spawnTransport ?? spawnBillingTransport)({
        ...(options.executable !== undefined ? { executable: options.executable } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
    client = new GrokAcpClient(transport, timeoutMs);
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientInfo: CLIENT_INFO,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    if (authMethodIds(initialized).includes(GROK_CACHED_TOKEN_AUTH)) {
      try {
        await client.request('authenticate', {
          methodId: GROK_CACHED_TOKEN_AUTH,
          _meta: { headless: true },
        });
      } catch (error) {
        // initialize already reloaded disk auth. Billing is the authority.
        if (!isUnauthenticated(error) && !isMethodNotFound(error)) throw error;
      }
    }
    const response = await client.request(GROK_BILLING_ACP_METHOD, {});
    const snapshot = normalizeGrokAccountUsage(response, (options.now ?? (() => new Date()))().toISOString());
    if (snapshot.metrics.length === 0 && !snapshot.credits) {
      return {
        status: 'unavailable',
        provider: 'grok',
        message: 'Grok returned no recognized account usage limits',
        retryable: true,
      };
    }
    return { status: 'available', snapshot };
  } catch (error) {
    return grokFailure(error);
  } finally {
    if (client) await client.close();
    else await transport?.close();
  }
}

/**
 * Read Grok account usage for the native default account, or for one profile's
 * root. A managed profile binds the agent to its own `GROK_HOME`.
 */
export async function fetchGrokAccountUsageForProfile(
  profile?: AgentProfile,
  options: Omit<FetchGrokAccountUsageOptions, 'transport'> = {},
): Promise<AccountUsageFetchResult> {
  const binding = profile?.kind === 'managed' ? { [GROK_PROFILE_ROOT_VARIABLE]: profile.dataRoot } : undefined;
  const result = await fetchGrokAccountUsage({
    ...options,
    ...(binding ? { env: { ...options.env, ...binding } } : {}),
  });
  if (!profile || result.status !== 'available') return result;
  return { ...result, snapshot: { ...result.snapshot, profileId: profile.id } };
}

/** Complete account-usage capability advertised by the Grok adapter. */
export function createGrokAccountUsageService(
  options: Omit<FetchGrokAccountUsageOptions, 'transport'> = {},
): AccountUsageService {
  return {
    provider: GROK_ACCOUNT_USAGE_PROVIDER,
    fetch: (fetchOptions) => fetchGrokAccountUsageForProfile(fetchOptions?.profile, options),
  };
}
