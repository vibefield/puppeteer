import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AccountUsageAvailable,
  AccountUsageFetchResult,
  AccountUsageMetric,
  AccountUsageMetricGroup,
  AccountUsageProvider,
  AccountUsageService,
  AccountUsageSnapshot,
  AccountUsageSource,
  AgentProfile,
} from '@vibecook/puppeteer-core';

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** Compatibility metadata only; token refresh is owned exclusively by Claude Code. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Compatibility metadata only; the read-only usage observer never calls this endpoint. */
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Keychain service name for one Claude Code config root.
 *
 * Probed 2026-09-06 on Claude Code 2.1.263 (RFC 006 "Resolved questions" §1):
 * the binary uses the bare service name when `CLAUDE_CONFIG_DIR` is unset and
 * `Claude Code-credentials-<sha256(configDir, NFC).hex[0:8]>` when it is set, so
 * a process bound to a profile root reads that profile's item and no other.
 * Pass no root for the native default; pass the managed root otherwise.
 */
export function claudeKeychainService(dataRoot?: string): string {
  const root = dataRoot?.trim();
  if (!root) return KEYCHAIN_SERVICE;
  const digest = createHash('sha256').update(root.normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${digest}`;
}

/** Older Claude Code installs used `unknown`; current installs use the macOS username. */
const KEYCHAIN_ACCOUNT_FALLBACKS = ['unknown'] as const;
/** Refresh slightly before the stored expiry so we never ship a near-dead access token. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const execFileAsync = promisify(execFile);

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const part of path) {
    value = rec(value)?.[part];
  }
  return value;
}

/** Find a Claude Code OAuth access token in known credential layouts. */
export function findClaudeAccessToken(value: unknown): string | undefined {
  const preferred = [
    ['claudeAiOauth', 'accessToken'],
    ['claudeAiOauth', 'access_token'],
    ['oauth', 'accessToken'],
    ['oauth', 'access_token'],
    ['accessToken'],
    ['access_token'],
    ['oauth_access_token'],
  ] as const;
  for (const path of preferred) {
    const token = valueAt(value, path);
    if (typeof token === 'string' && token.trim()) return token.trim();
  }

  const accepted = new Set(['accessToken', 'access_token', 'oauth_access_token']);
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = rec(queue.shift());
    if (!current) continue;
    for (const [key, child] of Object.entries(current)) {
      if (accepted.has(key) && typeof child === 'string' && child.trim()) return child.trim();
      if (rec(child)) queue.push(child);
    }
  }
  return undefined;
}

function findClaudeAccessTokenExpiresAt(value: unknown): number | undefined {
  const preferred = [
    ['claudeAiOauth', 'expiresAt'],
    ['claudeAiOauth', 'expires_at'],
    ['oauth', 'expiresAt'],
    ['oauth', 'expires_at'],
    ['expiresAt'],
    ['expires_at'],
  ] as const;
  for (const path of preferred) {
    const raw = valueAt(value, path);
    const numeric = finite(raw);
    if (numeric !== undefined && numeric >= 0) {
      return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function defaultCredentialsPath(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR?.split(',')
    .map((part) => part.trim())
    .find(Boolean);
  const directory =
    configured === '~' ? homedir() : configured?.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  return join(directory || join(homedir(), '.claude'), '.credentials.json');
}

function resolveCredentialsPath(options: ClaudeCredentialOptions): string {
  const env = options.env ?? process.env;
  const configuredPath =
    options.credentialsPath === '~'
      ? homedir()
      : options.credentialsPath?.startsWith('~/')
        ? join(homedir(), options.credentialsPath.slice(2))
        : options.credentialsPath;
  return configuredPath ?? defaultCredentialsPath(env);
}

function keychainAccountCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const preferred = [env.USER, env.LOGNAME, env.USERNAME]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set([...preferred, ...KEYCHAIN_ACCOUNT_FALLBACKS])];
}

async function readKeychainPayloadForAccount(service: string, account: string): Promise<string> {
  const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * Claude Code may store multiple credential items under the same service name
 * (current installs use the macOS username; older ones used `unknown`). Prefer
 * the freshest document that still contains an access token.
 */
async function defaultKeychainPayload(
  env: NodeJS.ProcessEnv = process.env,
  service: string = KEYCHAIN_SERVICE,
): Promise<string> {
  let best:
    | {
        payload: string;
        expiresAt: number;
        rank: number;
      }
    | undefined;

  const consider = (payload: string, rank: number): void => {
    if (!payload.trim()) return;
    let document: Record<string, unknown> | undefined;
    try {
      document = rec(JSON.parse(payload));
    } catch {
      return;
    }
    if (!document || !findClaudeAccessToken(document)) return;
    const expiresAt = findClaudeAccessTokenExpiresAt(document) ?? Number.NEGATIVE_INFINITY;
    if (!best || expiresAt > best.expiresAt || (expiresAt === best.expiresAt && rank < best.rank)) {
      best = { payload, expiresAt, rank };
    }
  };

  let rank = 0;
  for (const account of keychainAccountCandidates(env)) {
    try {
      consider(await readKeychainPayloadForAccount(service, account), rank++);
    } catch {
      // Try the next account.
    }
  }
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    consider(stdout, rank + 100);
  } catch {
    // No unscoped item.
  }

  if (!best) throw new Error('Claude Code credentials were not found in the Keychain');
  return best.payload;
}

export interface ClaudeCredentialOptions {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  /** Keychain service name; defaults to the native-default item. See {@link claudeKeychainService}. */
  keychainService?: string;
  /** Defaults to true on macOS after file lookup fails. */
  useKeychain?: boolean;
  /** Test seam for a read-only credential lookup. */
  readKeychainPayload?: () => Promise<string | { payload: string }>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function accessTokenIsFresh(expiresAt: number | undefined, nowMs: number): boolean {
  if (expiresAt === undefined) return true;
  return expiresAt > nowMs + TOKEN_EXPIRY_SKEW_MS;
}

async function loadClaudeCredentialDocument(
  options: ClaudeCredentialOptions,
): Promise<Record<string, unknown> | undefined> {
  const env = options.env ?? process.env;
  try {
    const path = resolveCredentialsPath(options);
    const raw = await readFile(path, 'utf8');
    const document = rec(JSON.parse(raw));
    if (document && findClaudeAccessToken(document)) return document;
  } catch {
    // Fall through to Keychain.
  }

  if (!(options.useKeychain ?? process.platform === 'darwin')) return undefined;
  try {
    const read =
      options.readKeychainPayload ??
      ((() =>
        defaultKeychainPayload(
          options.env ?? process.env,
          options.keychainService ?? KEYCHAIN_SERVICE,
        )) as () => Promise<string | { payload: string }>);
    const loaded = await read();
    const payload = typeof loaded === 'string' ? loaded : loaded.payload;
    const document = rec(JSON.parse(payload));
    if (document && findClaudeAccessToken(document)) return document;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Resolve Claude Code's OAuth access token without returning the credential document.
 * Observation is deliberately read-only: Claude Code exclusively owns token
 * refresh and persistence, avoiding refresh-token rotation races with live or
 * concurrently restored Claude processes.
 */
export async function resolveClaudeAccessToken(options: ClaudeCredentialOptions = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_ACCESS_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  const document = await loadClaudeCredentialDocument(options);
  if (!document) return undefined;

  const nowMs = (options.now ?? (() => new Date()))().valueOf();
  const accessToken = findClaudeAccessToken(document);
  const expiresAt = findClaudeAccessTokenExpiresAt(document);
  return accessToken && accessTokenIsFresh(expiresAt, nowMs) ? accessToken : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  let millis: number | undefined;
  const numeric = finite(value);
  if (numeric !== undefined && numeric >= 0) {
    millis = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  } else if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) millis = parsed;
  }
  if (millis === undefined) return undefined;
  const date = new Date(millis);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : undefined;
}

function retryAtFromHeader(value: string | null, now: Date): string | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  const millis = Number.isFinite(seconds) && seconds >= 0 ? now.valueOf() + seconds * 1_000 : Date.parse(header);
  if (!Number.isFinite(millis)) return undefined;
  return new Date(millis).toISOString();
}

function firstFinite(window: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finite(window[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(window: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = window[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstBoolean(window: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = window[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function firstScalar(window: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = window[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstTimestamp(window: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = isoTimestamp(window[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function metricDescription(id: string): string {
  if (id === 'five_hour') return '5-hour';
  if (id === 'seven_day') return '7-day';
  if (id === 'cinder_cove') return 'Claude Code and Cowork credit';
  if (id === 'extra_usage') return 'Usage credits';
  if (id === 'spend_limit') return 'Spend limit';
  if (id === 'overage') return 'Overage';
  if (id.startsWith('seven_day_')) return `7-day ${id.slice('seven_day_'.length).replaceAll('_', ' ')}`;
  return id.replaceAll('_', ' ');
}

function metricLabel(id: string, name?: string): string {
  if (id === 'five_hour') return '5H';
  if (id === 'seven_day') return '7D';
  if (id === 'cinder_cove') return 'CREDIT';
  if (id === 'spend_limit') return 'SPEND';
  if (id === 'extra_usage' || /credit/i.test(`${id} ${name ?? ''}`)) return 'CREDIT';
  if (id === 'overage') return 'OVERAGE';
  if (id.startsWith('seven_day_')) return id.slice('seven_day_'.length).replaceAll('_', ' ').toUpperCase();
  return (name ?? id).replaceAll(/[_-]+/g, ' ').trim().toUpperCase() || 'LIMIT';
}

function metricRank(id: string, kind: AccountUsageMetric['kind']): number {
  if (id === 'five_hour') return 0;
  if (id === 'seven_day') return 20;
  if (id.startsWith('seven_day_')) return 40;
  if (id === 'cinder_cove') return 50;
  return kind === 'window' ? 60 : 70;
}

function windowDurationMinutes(id: string): number | undefined {
  if (id === 'five_hour') return 300;
  if (id === 'seven_day' || id.startsWith('seven_day_')) return 10_080;
  return undefined;
}

interface RankedMetric {
  metric: AccountUsageMetric;
  rank: number;
}

/** A scoped weekly window meters part of the plan: one model, one surface, or both. */
function scopedGroup(key: string, label: string): AccountUsageMetricGroup {
  return { id: `scope:${key}`, label };
}

/** The legacy per-model fields: `seven_day_opus` meters Opus alone, `seven_day_oauth_apps` the OAuth apps. */
function legacyGroup(id: string): AccountUsageMetricGroup | undefined {
  if (!LEGACY_USAGE_WINDOWS.has(id) || !id.startsWith('seven_day_')) return undefined;
  const key = id.slice('seven_day_'.length);
  if (key === 'oauth_apps') return scopedGroup(key, 'OAuth apps');
  const name = key.replaceAll('_', ' ');
  return scopedGroup(key, `${name[0]!.toUpperCase()}${name.slice(1)} only`);
}

function normalizeWindow(id: string, value: unknown, group = 'subscription'): RankedMetric | undefined {
  const window = rec(value);
  if (!window) return undefined;
  const usedPercent = firstFinite(window, [
    'utilization',
    'used_percentage',
    'usage_percentage',
    'percentage',
    'percent',
  ]);
  const resetsAt = firstTimestamp(window, ['resets_at', 'reset_at', 'reset_time', 'expires_at', 'expiry']);
  if (usedPercent === undefined || usedPercent < 0) return undefined;
  const durationMinutes = windowDurationMinutes(id);
  const name = firstString(window, ['display_name', 'label', 'name']);
  const metricId = group === 'subscription' ? `${group}:${id}:window` : `${group}:window`;
  const part = group === 'subscription' ? legacyGroup(id) : undefined;
  return {
    rank: metricRank(id, 'window'),
    metric: {
      id: metricId,
      label: metricLabel(id, name),
      description: name ?? `${metricDescription(id)} usage`,
      kind: 'window',
      usedPercent,
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(part ? { group: part } : {}),
    },
  };
}

function normalizeBudget(id: string, name: string, value: unknown): RankedMetric | undefined {
  const budget = rec(value);
  if (!budget) return undefined;
  const limit = firstScalar(budget, ['monthly_limit', 'limit', 'allowed', 'quota']);
  const used = firstScalar(budget, ['used_credits', 'used', 'usage', 'consumed']);
  const reportedRemainingPercent = firstFinite(budget, ['remaining_percentage', 'remaining_percent']);
  const calculatedUsedPercent = (() => {
    if (reportedRemainingPercent !== undefined && reportedRemainingPercent >= 0) {
      return Math.max(0, 100 - reportedRemainingPercent);
    }
    const numericLimit = Number(limit);
    const numericUsed = Number(used);
    return Number.isFinite(numericLimit) && numericLimit > 0 && Number.isFinite(numericUsed) && numericUsed >= 0
      ? (numericUsed / numericLimit) * 100
      : undefined;
  })();
  const resetsAt = firstTimestamp(budget, [
    'resets_at',
    'reset_at',
    'reset_time',
    'overage_resets_at',
    'expires_at',
    'expiry',
  ]);
  if (calculatedUsedPercent === undefined) return undefined;
  return {
    rank: metricRank(id, 'budget'),
    metric: {
      id: `${id}:budget`,
      label: metricLabel(id, name),
      description: name,
      kind: 'budget',
      usedPercent: calculatedUsedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    },
  };
}

function hasBudgetState(value: unknown): boolean {
  const budget = rec(value);
  if (!budget) return false;
  return (
    firstScalar(budget, ['monthly_limit', 'limit', 'allowed', 'quota', 'used_credits', 'used', 'usage', 'consumed']) !==
      undefined ||
    firstFinite(budget, ['remaining_percentage', 'remaining_percent']) !== undefined ||
    firstBoolean(budget, ['reached', 'is_exhausted', 'out_of_credits', 'limit_reached']) !== undefined
  );
}

function normalizeAuxiliaryMetrics(id: string, value: unknown): RankedMetric[] {
  const limit = rec(value);
  if (!limit || firstBoolean(limit, ['is_enabled', 'enabled']) === false) return [];
  const name = firstString(limit, ['display_name', 'label', 'name']) ?? metricDescription(id);
  const budget = normalizeBudget(id, name, limit);
  if (budget) return [budget];
  const window = normalizeWindow(id, limit, id);
  // Credits can expose a percentage without amounts. They are still one
  // budget, not a second subscription window alongside the amount-based meter.
  return window
    ? [
        {
          rank: metricRank(id, 'budget'),
          metric: { ...window.metric, id: `${id}:budget`, kind: 'budget', description: name },
        },
      ]
    : [];
}

function limitEntryId(value: unknown, fallback: string | undefined): string | undefined {
  const limit = rec(value);
  if (!limit) return fallback;
  return firstString(limit, ['id', 'type', 'rate_limit_type', 'key', 'display_name', 'label', 'name']) ?? fallback;
}

/** Legacy fields whose meanings are known; arbitrary backend counters are not user-facing limits. */
const LEGACY_USAGE_WINDOWS = new Set([
  'five_hour',
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
]);

/** Current OAuth limits[] uses kind and scope, not an id or a display name on the entry itself. */
function normalizeStructuredWindow(value: unknown): RankedMetric | undefined {
  const limit = rec(value);
  if (!limit) return undefined;
  if (limit.kind === 'session') return normalizeWindow('five_hour', limit);
  if (limit.kind === 'weekly_all') return normalizeWindow('seven_day', limit);
  if (limit.kind !== 'weekly_scoped') return undefined;

  const scope = rec(limit.scope);
  const model = firstString(rec(scope?.model) ?? {}, ['display_name']);
  const surface = firstString(rec(scope?.surface) ?? {}, ['display_name']);
  if (!model && !surface) return undefined;
  const scopeKey = (name: string): string => encodeURIComponent(name.toLowerCase());
  const key = `${model ? scopeKey(model) : ''}${surface ? `:surface:${scopeKey(surface)}` : ''}`;
  const normalized = normalizeWindow(`seven_day_${key}`, limit);
  if (!normalized) return undefined;
  const name = [model, surface].filter(Boolean).join(' / ');
  const part = scopedGroup(key, model && surface ? `${model} in ${surface}` : `${model ?? surface} only`);
  return {
    ...normalized,
    metric: {
      ...normalized.metric,
      label: name.toUpperCase(),
      description: `Current week (${name}) usage`,
      group: part,
    },
  };
}

const DEFAULT_OAUTH_SOURCE: AccountUsageSource = { kind: 'oauth-endpoint', stability: 'experimental' };
const STATUSLINE_SOURCE: AccountUsageSource = { kind: 'native-statusline', stability: 'documented' };

export const CLAUDE_ACCOUNT_USAGE_PROVIDER: AccountUsageProvider = {
  id: 'claude',
  label: 'Claude',
  refresh: {
    // The OAuth endpoint is heavily rate limited; status-line pushes are preferred.
    pollIntervalMs: 30 * 60_000,
    pushUpdatePollIntervalMs: 30 * 60_000,
  },
};

/** Normalize named Claude quotas, coalescing legacy and structured representations of the same limit. */
export function normalizeClaudeAccountUsage(
  value: unknown,
  fetchedAt = new Date().toISOString(),
  source: AccountUsageSource = DEFAULT_OAUTH_SOURCE,
): AccountUsageSnapshot {
  const response = rec(value) ?? {};
  const metrics = new Map<string, RankedMetric>();

  const addWindow = (id: string, candidate: unknown): void => {
    const normalized = normalizeWindow(id, candidate);
    if (normalized) metrics.set(normalized.metric.id, normalized);
  };
  const addAuxiliary = (id: string, candidate: unknown): boolean => {
    const normalized = normalizeAuxiliaryMetrics(id, candidate);
    if (normalized.length === 0) return false;
    metrics.delete(`subscription:${id}:window`);
    for (const entry of normalized) metrics.set(entry.metric.id, entry);
    return true;
  };
  const addStructuredEntry = (id: string | undefined, candidate: unknown): void => {
    const record = rec(candidate);
    if (firstBoolean(record ?? {}, ['is_enabled', 'enabled']) === false) return;
    const window = normalizeStructuredWindow(candidate);
    if (window) {
      metrics.set(window.metric.id, window);
      return;
    }
    if (record?.kind === 'session' || record?.kind === 'weekly_all' || record?.kind === 'weekly_scoped') return;
    const normalizedId = limitEntryId(candidate, id);
    if (!normalizedId) return;
    const hasAuxiliaryState =
      hasBudgetState(record) ||
      firstBoolean(record ?? {}, ['is_enabled', 'enabled']) !== undefined ||
      firstString(record ?? {}, ['status', 'state', 'disabled_reason', 'overage_disabled_reason']) !== undefined;
    if (hasAuxiliaryState && addAuxiliary(normalizedId, candidate)) return;
    addWindow(normalizedId, candidate);
  };

  for (const [id, candidate] of Object.entries(response)) {
    if (id === 'extra_usage' || id === 'overage' || id === 'cinder_cove') {
      addAuxiliary(id, candidate);
      continue;
    }
    if (LEGACY_USAGE_WINDOWS.has(id)) addWindow(id, candidate);
  }

  const rateLimits = rec(response.rate_limits);
  if (rateLimits) {
    for (const [id, candidate] of Object.entries(rateLimits)) {
      if (id === 'spend_limit') addAuxiliary(id, candidate);
      else if (LEGACY_USAGE_WINDOWS.has(id)) addWindow(id, candidate);
    }
  }

  const limits = response.limits;
  if (Array.isArray(limits)) {
    limits.forEach((candidate) => addStructuredEntry(undefined, candidate));
  } else {
    const limitMap = rec(limits);
    if (limitMap) {
      const isSingleLimit =
        normalizeWindow('limits', limitMap) !== undefined ||
        normalizeBudget('limits', metricDescription('limits'), limitMap) !== undefined ||
        firstBoolean(limitMap, ['is_enabled', 'enabled']) !== undefined;
      if (isSingleLimit) addStructuredEntry('limits', limitMap);
      else {
        for (const [id, candidate] of Object.entries(limitMap)) addStructuredEntry(id, candidate);
      }
    }
  }

  return {
    provider: 'claude',
    fetchedAt,
    scope: 'subscription',
    source,
    metrics: [...metrics.values()]
      .sort((left, right) => left.rank - right.rank || left.metric.id.localeCompare(right.metric.id))
      .map(({ metric }) => metric),
  };
}

/**
 * Parse Claude Code status-line `rate_limits` into the shared account-usage shape.
 * Official Claude Code stdin fields after the first Pro/Max API response; no network call.
 */
export function claudeAccountUsageFromStatusLine(
  payload: unknown,
  fetchedAt = new Date().toISOString(),
): AccountUsageAvailable | undefined {
  const body = rec(payload);
  const rateLimits = rec(body?.rate_limits);
  if (!rateLimits) return undefined;
  const snapshot = normalizeClaudeAccountUsage({ rate_limits: rateLimits }, fetchedAt, STATUSLINE_SOURCE);
  if (snapshot.metrics.length === 0) return undefined;
  return { status: 'available', snapshot };
}

type ClaudeAccountUsageListener = (result: AccountUsageAvailable) => void;

const statusLineAccountUsageListeners = new Set<ClaudeAccountUsageListener>();
let lastStatusLineAccountUsage: AccountUsageAvailable | undefined;

/** Latest status-line-derived Claude usage, if any process has observed it. */
export function getClaudeStatusLineAccountUsage(): AccountUsageAvailable | undefined {
  return lastStatusLineAccountUsage;
}

/**
 * Subscribe to Claude status-line rate-limit updates. Account-wide (not session-scoped):
 * every live Claude session that emits rate_limits shares this channel.
 */
export function onClaudeAccountUsage(listener: ClaudeAccountUsageListener): () => void {
  statusLineAccountUsageListeners.add(listener);
  return () => {
    statusLineAccountUsageListeners.delete(listener);
  };
}

/**
 * Ingest a Claude status-line payload. When `rate_limits` is present, updates the
 * process-local cache and notifies listeners so hosts can refresh Godview without
 * polling the rate-limited OAuth usage endpoint.
 */
export function observeClaudeStatusLineAccountUsage(
  payload: unknown,
  fetchedAt = new Date().toISOString(),
): AccountUsageAvailable | undefined {
  const next = claudeAccountUsageFromStatusLine(payload, fetchedAt);
  if (!next) return undefined;
  lastStatusLineAccountUsage = next;
  for (const listener of statusLineAccountUsageListeners) {
    try {
      listener(next);
    } catch {
      // Listeners must not break the status-line bridge path.
    }
  }
  return next;
}

/** @internal Test isolation for module-scoped status-line usage state. */
export function resetClaudeAccountUsageObserversForTests(): void {
  lastStatusLineAccountUsage = undefined;
  statusLineAccountUsageListeners.clear();
}

export interface FetchClaudeAccountUsageOptions {
  timeoutMs?: number | undefined;
}

/** @internal Dependency-injection surface for adapter tests; intentionally omitted from the package barrel. */
export interface FetchClaudeAccountUsageDependencies extends FetchClaudeAccountUsageOptions, ClaudeCredentialOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  resolveAccessToken?: () => Promise<string | undefined>;
  now?: () => Date;
}

/** @internal Use `fetchClaudeAccountUsage` outside adapter tests. */
export async function fetchClaudeAccountUsageWithDependencies(
  options: FetchClaudeAccountUsageDependencies = {},
): Promise<AccountUsageFetchResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude account usage timeout must be positive',
      retryable: false,
    };
  }

  let token: string | undefined;
  try {
    token = options.resolveAccessToken ? await options.resolveAccessToken() : await resolveClaudeAccessToken(options);
  } catch {
    return {
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude Code OAuth credentials could not be read',
      retryable: true,
    };
  }
  if (!token) {
    return {
      status: 'unauthenticated',
      provider: 'claude',
      message: 'Claude Code OAuth credentials were not found',
      retryable: false,
    };
  }

  const fetchUsage = async (accessToken: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await (options.fetchImpl ?? fetch)(options.endpoint ?? CLAUDE_USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'anthropic-beta': CLAUDE_OAUTH_BETA,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const response = await fetchUsage(token);
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'unauthenticated',
        provider: 'claude',
        message: 'Claude Code OAuth credentials were rejected',
        retryable: false,
      };
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAt = retryable
        ? retryAtFromHeader(response.headers.get('retry-after'), (options.now ?? (() => new Date()))())
        : undefined;
      return {
        status: 'unavailable',
        provider: 'claude',
        message: `Claude account usage request failed with HTTP ${response.status}`,
        retryable,
        ...(response.status === 429 ? { code: 'rate-limited' as const } : {}),
        ...(retryAt ? { retryAt } : {}),
      };
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        status: 'unavailable',
        provider: 'claude',
        message: 'Claude account usage returned invalid JSON',
        retryable: true,
      };
    }
    const snapshot = normalizeClaudeAccountUsage(body, (options.now ?? (() => new Date()))().toISOString());
    if (snapshot.metrics.length === 0) {
      return {
        status: 'unavailable',
        provider: 'claude',
        message: 'Claude returned no recognized account usage limits',
        retryable: true,
      };
    }
    return { status: 'available', snapshot };
  } catch {
    return {
      status: 'unavailable',
      provider: 'claude',
      message: 'Claude account usage request could not be completed',
      retryable: true,
    };
  }
}

/** Fetch Claude account quota data without exposing credential-bearing dependency seams. */
export async function fetchClaudeAccountUsage(
  options: FetchClaudeAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  return fetchClaudeAccountUsageWithDependencies({
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/**
 * Credential lookup bound to one profile root.
 *
 * A managed profile launches Claude Code with `CLAUDE_CONFIG_DIR`, so its
 * credentials live in that root's file store and under that root's Keychain
 * service name. The ambient token overrides are dropped for managed profiles:
 * they belong to whichever account the shell is logged into and would otherwise
 * report the wrong account's usage under a profile's label.
 */
function credentialOptionsForProfile(profile: AgentProfile | undefined): ClaudeCredentialOptions {
  if (!profile || profile.kind !== 'managed') return {};
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_ACCESS_TOKEN;
  delete env.CLAUDE_CONFIG_DIR;
  return {
    env,
    credentialsPath: join(profile.dataRoot, '.credentials.json'),
    keychainService: claudeKeychainService(profile.dataRoot),
  };
}

/** @internal Use `fetchClaudeAccountUsageForProfile` outside adapter tests. */
export async function fetchClaudeAccountUsageForProfileWithDependencies(
  profile: AgentProfile | undefined,
  options: FetchClaudeAccountUsageDependencies = {},
): Promise<AccountUsageFetchResult> {
  const result = await fetchClaudeAccountUsageWithDependencies({ ...options, ...credentialOptionsForProfile(profile) });
  if (!profile || result.status !== 'available') return result;
  return { ...result, snapshot: { ...result.snapshot, profileId: profile.id } };
}

/** Read Claude account usage for the native default account, or for one profile's root. */
export async function fetchClaudeAccountUsageForProfile(
  profile?: AgentProfile,
  options: FetchClaudeAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  return fetchClaudeAccountUsageForProfileWithDependencies(profile, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** Complete account-usage capability advertised by the Claude adapter. */
export function createClaudeAccountUsageService(): AccountUsageService {
  return {
    provider: CLAUDE_ACCOUNT_USAGE_PROVIDER,
    fetch: (options) => fetchClaudeAccountUsageForProfile(options?.profile),
    subscribe: (listener) => onClaudeAccountUsage(listener),
  };
}
