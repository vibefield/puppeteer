import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AccountUsageAvailable,
  AccountUsageBudget,
  AccountUsageFetchResult,
  AccountUsageLimit,
  AccountUsageSnapshot,
  AccountUsageSource,
  AccountUsageWindow,
} from '@vibecook/puppeteer-core';

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** Compatibility metadata only; token refresh is owned exclusively by Claude Code. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Compatibility metadata only; the read-only usage observer never calls this endpoint. */
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
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

async function readKeychainPayloadForAccount(account: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    { timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  return stdout;
}

/**
 * Claude Code may store multiple credential items under the same service name
 * (current installs use the macOS username; older ones used `unknown`). Prefer
 * the freshest document that still contains an access token.
 */
async function defaultKeychainPayload(env: NodeJS.ProcessEnv = process.env): Promise<string> {
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
      consider(await readKeychainPayloadForAccount(account), rank++);
    } catch {
      // Try the next account.
    }
  }
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
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
      ((() => defaultKeychainPayload(options.env ?? process.env)) as () => Promise<string | { payload: string }>);
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

function windowLabel(id: string): string {
  if (id === 'five_hour') return '5-hour';
  if (id === 'seven_day') return '7-day';
  if (id === 'cinder_cove') return 'Fable 5';
  if (id === 'extra_usage') return 'Usage credits';
  if (id === 'overage') return 'Overage';
  if (id.startsWith('seven_day_')) return `7-day ${id.slice('seven_day_'.length).replaceAll('_', ' ')}`;
  return id.replaceAll('_', ' ');
}

function windowDurationMinutes(id: string): number | undefined {
  if (id === 'five_hour') return 300;
  if (id === 'seven_day' || id.startsWith('seven_day_')) return 10_080;
  return undefined;
}

function normalizeWindow(id: string, value: unknown): AccountUsageWindow | undefined {
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
  if ((usedPercent === undefined || usedPercent < 0) && resetsAt === undefined) return undefined;
  const durationMinutes = windowDurationMinutes(id);
  return {
    id,
    label: windowLabel(id),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    ...(usedPercent !== undefined && usedPercent >= 0 ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function normalizeBudget(value: unknown): AccountUsageBudget | undefined {
  const budget = rec(value);
  if (!budget) return undefined;
  const limit = firstScalar(budget, ['monthly_limit', 'limit', 'allowed', 'quota']);
  const used = firstScalar(budget, ['used_credits', 'used', 'usage', 'consumed']);
  const reportedRemainingPercent = firstFinite(budget, ['remaining_percentage', 'remaining_percent']);
  const remainingPercent =
    reportedRemainingPercent !== undefined && reportedRemainingPercent >= 0 ? reportedRemainingPercent : undefined;
  const resetsAt = firstTimestamp(budget, [
    'resets_at',
    'reset_at',
    'reset_time',
    'overage_resets_at',
    'expires_at',
    'expiry',
  ]);
  const reached = firstBoolean(budget, ['reached', 'is_exhausted', 'out_of_credits', 'limit_reached']);
  if (
    limit === undefined &&
    used === undefined &&
    remainingPercent === undefined &&
    resetsAt === undefined &&
    reached === undefined
  ) {
    return undefined;
  }
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(reached !== undefined ? { reached } : {}),
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

function normalizeAuxiliaryLimit(id: string, value: unknown): AccountUsageLimit | undefined {
  const limit = rec(value);
  if (!limit) return undefined;
  const window = normalizeWindow(id, limit);
  const budget = normalizeBudget(limit);
  const enabled = firstBoolean(limit, ['is_enabled', 'enabled']);
  const status = firstString(limit, ['status', 'state', 'disabled_reason', 'overage_disabled_reason']);
  if (!window && !budget && enabled === undefined && status === undefined) return undefined;
  const name = firstString(limit, ['display_name', 'label', 'name']) ?? windowLabel(id);
  return {
    id,
    name,
    windows: window?.usedPercent !== undefined ? [window] : [],
    ...(enabled !== undefined ? { enabled } : {}),
    ...(status ? { status } : {}),
    ...(budget ? { budget } : {}),
  };
}

function limitEntryId(value: unknown, fallback: string): string {
  const limit = rec(value);
  if (!limit) return fallback;
  return firstString(limit, ['id', 'type', 'rate_limit_type', 'key']) ?? fallback;
}

const DEFAULT_OAUTH_SOURCE: AccountUsageSource = { kind: 'oauth-endpoint', stability: 'experimental' };
const STATUSLINE_SOURCE: AccountUsageSource = { kind: 'native-statusline', stability: 'documented' };

/** Normalize Claude's experimental OAuth usage response, including optional and future quota families. */
export function normalizeClaudeAccountUsage(
  value: unknown,
  fetchedAt = new Date().toISOString(),
  source: AccountUsageSource = DEFAULT_OAUTH_SOURCE,
): AccountUsageSnapshot {
  const response = rec(value) ?? {};
  const windows = new Map<string, AccountUsageWindow>();
  const auxiliaryLimits = new Map<string, AccountUsageLimit>();

  const addWindow = (id: string, candidate: unknown): void => {
    const window = normalizeWindow(id, candidate);
    if (window && !auxiliaryLimits.has(id)) windows.set(id, window);
  };
  const addAuxiliary = (id: string, candidate: unknown): boolean => {
    const limit = normalizeAuxiliaryLimit(id, candidate);
    if (!limit) return false;
    windows.delete(id);
    auxiliaryLimits.set(id, limit);
    return true;
  };
  const addStructuredEntry = (id: string, candidate: unknown): void => {
    const normalizedId = limitEntryId(candidate, id);
    const record = rec(candidate);
    const hasAuxiliaryState =
      hasBudgetState(record) ||
      firstBoolean(record ?? {}, ['is_enabled', 'enabled']) !== undefined ||
      firstString(record ?? {}, ['status', 'state', 'disabled_reason', 'overage_disabled_reason']) !== undefined;
    if (hasAuxiliaryState && addAuxiliary(normalizedId, candidate)) return;
    addWindow(normalizedId, candidate);
  };

  for (const [id, candidate] of Object.entries(response)) {
    if (id === 'extra_usage' || id === 'overage') {
      addAuxiliary(id, candidate);
      continue;
    }
    if (id !== 'rate_limits' && id !== 'limits') addWindow(id, candidate);
  }

  const rateLimits = rec(response.rate_limits);
  if (rateLimits) {
    for (const [id, candidate] of Object.entries(rateLimits)) addWindow(id, candidate);
  }

  const limits = response.limits;
  if (Array.isArray(limits)) {
    limits.forEach((candidate, index) => addStructuredEntry(`limit_${index + 1}`, candidate));
  } else {
    const limitMap = rec(limits);
    if (limitMap) {
      const isSingleLimit =
        normalizeWindow('limits', limitMap) !== undefined ||
        normalizeBudget(limitMap) !== undefined ||
        firstBoolean(limitMap, ['is_enabled', 'enabled']) !== undefined;
      if (isSingleLimit) addStructuredEntry('limits', limitMap);
      else {
        for (const [id, candidate] of Object.entries(limitMap)) addStructuredEntry(id, candidate);
      }
    }
  }

  const normalizedLimits: AccountUsageLimit[] = [];
  if (windows.size > 0) {
    normalizedLimits.push({
      id: 'claude-subscription',
      windows: [...windows.values()],
    });
  }
  normalizedLimits.push(...auxiliaryLimits.values());

  return {
    provider: 'claude',
    fetchedAt,
    scope: 'subscription',
    source,
    limits: normalizedLimits,
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
  if (snapshot.limits.length === 0) return undefined;
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
  timeoutMs?: number;
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
    if (snapshot.limits.length === 0) {
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
