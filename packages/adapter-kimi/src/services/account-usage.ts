/**
 * Kimi Code account usage.
 *
 * Provider-scoped, independent of any TUI session. The native surface is the
 * managed-platform `/usages` HTTP endpoint the official CLI's `/usage` panel
 * already calls (`packages/oauth/src/managed-usage.ts` in kimi-code). Observation
 * is read-only: Kimi Code owns token refresh and persistence, so this adapter
 * never writes `~/.kimi-code/credentials` or rotates a refresh token.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import { KIMI_PROFILE_ROOT_VARIABLE } from './profiles.js';

export const KIMI_USAGE_ENDPOINT = 'https://api.kimi.com/coding/v1/usages';
export const KIMI_CODE_BASE_URL_VARIABLE = 'KIMI_CODE_BASE_URL';
const CREDENTIALS_FILE = 'kimi-code.json';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
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

function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[KIMI_PROFILE_ROOT_VARIABLE]?.trim();
  if (configured)
    return configured === '~'
      ? homedir()
      : configured.startsWith('~/')
        ? join(homedir(), configured.slice(2))
        : configured;
  return join(homedir(), '.kimi-code');
}

export function kimiCredentialsPath(env: NodeJS.ProcessEnv = process.env, credentialsPath?: string): string {
  if (credentialsPath) {
    return credentialsPath === '~'
      ? homedir()
      : credentialsPath.startsWith('~/')
        ? join(homedir(), credentialsPath.slice(2))
        : credentialsPath;
  }
  return join(kimiHome(env), 'credentials', CREDENTIALS_FILE);
}

export function kimiUsageUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env[KIMI_CODE_BASE_URL_VARIABLE]?.trim().replace(/\/+$/, '');
  return base ? `${base}/usages` : KIMI_USAGE_ENDPOINT;
}

export interface KimiCredentialOptions {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  now?: () => Date;
}

function expiresAtMs(value: unknown): number | undefined {
  const numeric = finite(value);
  if (numeric === undefined || numeric < 0) return undefined;
  return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
}

export function findKimiAccessToken(value: unknown, nowMs = Date.now()): string | undefined {
  const document = rec(value);
  if (!document) return undefined;
  const token = str(document.access_token) ?? str(document.accessToken);
  if (!token) return undefined;
  const expiresAt = expiresAtMs(document.expires_at ?? document.expiresAt);
  if (expiresAt !== undefined && expiresAt <= nowMs + TOKEN_EXPIRY_SKEW_MS) return undefined;
  return token;
}

export async function resolveKimiAccessToken(options: KimiCredentialOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const path = kimiCredentialsPath(env, options.credentialsPath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  return findKimiAccessToken(document, (options.now ?? (() => new Date()))().valueOf());
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function retryAtFromHeader(value: string | null, now: Date): string | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  const millis = Number.isFinite(seconds) && seconds >= 0 ? now.valueOf() + seconds * 1_000 : Date.parse(header);
  if (!Number.isFinite(millis)) return undefined;
  return new Date(millis).toISOString();
}

function usedPercent(used: number, limit: number): number | undefined {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit <= 0) return undefined;
  return Math.round((used / limit) * 100 * 1e6) / 1e6;
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

function fixedPointToCents(value: number): number {
  const cents = value / 1_000_000;
  if (cents > 0 && cents < 1) return 1;
  return Math.round(cents);
}

function parseBoosterCredits(value: unknown): AccountUsageCredits | undefined {
  const wallet = rec(value);
  if (!wallet) return undefined;
  const balance = rec(wallet.balance);
  if (!balance || str(balance.type) !== 'BOOSTER') return undefined;
  const amountLeft = finite(balance.amountLeft);
  if (amountLeft === undefined || amountLeft < 0) return undefined;
  const cents = fixedPointToCents(amountLeft);
  const currency = str(rec(wallet.monthlyChargeLimit)?.currency) ?? str(wallet.currency) ?? 'USD';
  return { balance: `${(cents / 100).toFixed(2)} ${currency}`, hasCredits: cents > 0 };
}

/** Normalize the documented managed `/usages` payload into ordered metrics. */
export function normalizeKimiAccountUsage(
  value: unknown,
  fetchedAt = new Date().toISOString(),
  source: AccountUsageSource = OAUTH_SOURCE,
): AccountUsageSnapshot {
  const body = rec(value) ?? {};
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

  const byId = new Map<string, RankedMetric>();
  for (const entry of metrics) {
    const held = byId.get(entry.metric.id);
    if (!held || entry.rank < held.rank) byId.set(entry.metric.id, entry);
  }

  const credits = parseBoosterCredits(body.boosterWallet);
  return {
    provider: 'kimi',
    fetchedAt,
    scope: 'subscription',
    source,
    metrics: [...byId.values()]
      .sort((left, right) => left.rank - right.rank || left.metric.id.localeCompare(right.metric.id))
      .map(({ metric }) => metric),
    ...(credits ? { credits } : {}),
  };
}

export interface FetchKimiAccountUsageOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  resolveAccessToken?: () => Promise<string | undefined>;
  now?: () => Date;
}

function failure(
  status: 'unauthenticated' | 'unavailable',
  message: string,
  retryable: boolean,
): AccountUsageFetchResult {
  return { status, provider: 'kimi', message, retryable };
}

export async function fetchKimiAccountUsage(
  options: FetchKimiAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure('unavailable', 'Kimi account usage timeout must be positive', false);
  }

  const env = options.env ?? process.env;
  let token: string | undefined;
  try {
    token = options.resolveAccessToken
      ? await options.resolveAccessToken()
      : await resolveKimiAccessToken({
          env,
          ...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}),
          now: options.now,
        });
  } catch {
    return failure('unavailable', 'Kimi Code OAuth credentials could not be read', true);
  }
  if (!token) {
    return failure('unauthenticated', 'Kimi Code OAuth credentials were not found', false);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? kimiUsageUrl(env), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return failure('unauthenticated', 'Kimi Code OAuth credentials were rejected', false);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAt = retryable
        ? retryAtFromHeader(response.headers.get('retry-after'), (options.now ?? (() => new Date()))())
        : undefined;
      return {
        status: 'unavailable',
        provider: 'kimi',
        message: `Kimi account usage request failed with HTTP ${response.status}`,
        retryable,
        ...(response.status === 429 ? { code: 'rate-limited' as const } : {}),
        ...(retryAt ? { retryAt } : {}),
      };
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return failure('unavailable', 'Kimi account usage returned invalid JSON', true);
    }
    const snapshot = normalizeKimiAccountUsage(body, (options.now ?? (() => new Date()))().toISOString());
    if (snapshot.metrics.length === 0 && !snapshot.credits) {
      return failure('unavailable', 'Kimi returned no account usage limits', true);
    }
    return { status: 'available', snapshot };
  } catch {
    return failure('unavailable', 'Kimi account usage request could not be completed', true);
  } finally {
    clearTimeout(timer);
  }
}

function credentialOptionsForProfile(profile: AgentProfile | undefined): KimiCredentialOptions {
  if (!profile || profile.kind !== 'managed') return {};
  const env = { ...process.env };
  delete env[KIMI_PROFILE_ROOT_VARIABLE];
  return {
    env,
    credentialsPath: join(profile.dataRoot, 'credentials', CREDENTIALS_FILE),
  };
}

export async function fetchKimiAccountUsageForProfile(
  profile?: AgentProfile,
  options: FetchKimiAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  const bound = credentialOptionsForProfile(profile);
  const result = await fetchKimiAccountUsage({
    ...options,
    ...(bound.credentialsPath ? { credentialsPath: bound.credentialsPath, env: bound.env } : {}),
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
