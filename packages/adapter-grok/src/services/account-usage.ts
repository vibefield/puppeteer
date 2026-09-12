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

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
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
import { resolveGrokExecutable } from '../detection.js';
import { GROK_PROFILE_ROOT_VARIABLE } from './profiles.js';

/** ACP wire method. The agent handler matches `x.ai/billing` after stripping `_`. */
export const GROK_BILLING_ACP_METHOD = '_x.ai/billing';
const GROK_CACHED_TOKEN_AUTH = 'cached_token';
const GROK_AGENT_ARGS = ['agent', '--no-leader', 'stdio'] as const;
const CLIENT_INFO = { name: 'puppeteer-account-usage', version: PUPPETEER_VERSION } as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const JSONRPC_METHOD_NOT_FOUND = -32_601;
const AUTH_PATTERN =
  /authentication required|not authenticated|no cached auth|session expired|run [`']?grok login|sign in/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate[- ]?limit/i;
const SOURCE = { kind: 'native-protocol', stability: 'experimental' } as const;

export const GROK_ACCOUNT_USAGE_PROVIDER: AccountUsageProvider = {
  id: 'grok',
  label: 'Grok',
  refresh: { pollIntervalMs: 15 * 60_000 },
};

export interface GrokBillingTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (info: { code: number | null; signal: string | null }) => void): void;
  close(): void | Promise<void>;
}

export interface FetchGrokAccountUsageOptions {
  /** One-shot transport override for tests. Closed after the fetch. */
  transport?: GrokBillingTransport;
  executable?: string;
  requestTimeoutMs?: number;
  now?: () => Date;
  /** Extra process environment; carries the profile binding (`GROK_HOME`). */
  env?: Record<string, string>;
  spawnTransport?: (options: { executable?: string; env?: Record<string, string> }) => GrokBillingTransport;
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

interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

class GrokAcpError extends Error {
  constructor(public readonly body: JsonRpcErrorBody) {
    super(body.message);
    this.name = 'GrokAcpError';
  }
}

class GrokAcpRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`Grok ACP request "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'GrokAcpRequestTimeoutError';
  }
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

class GrokAcpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly transport: GrokBillingTransport,
    requestTimeoutMs: number,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    transport.onMessage((message) => this.handle(message));
    transport.onClose(() => {
      this.closed = true;
      this.rejectAllPending(new Error('Grok ACP transport closed'));
    });
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new GrokAcpRequestTimeoutError(method, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.rejectAllPending(new Error('client closed'));
    try {
      this.closePromise = Promise.resolve(this.transport.close());
    } catch (error) {
      this.closePromise = Promise.reject(error);
    }
    return this.closePromise;
  }

  private rejectAllPending(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  private handle(message: unknown): void {
    if (this.closed) return;
    const body = rec(message);
    if (!body) return;
    const hasId = body.id !== undefined && body.id !== null;
    const method = str(body.method);

    if (hasId && method === undefined) {
      const id = body.id as number;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (body.error !== undefined) entry.reject(new GrokAcpError(body.error as JsonRpcErrorBody));
      else entry.resolve(body.result);
      return;
    }

    if (hasId && method !== undefined) {
      this.transport.send({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'Method not found' },
      });
    }
  }
}

function spawnGrokBillingTransport(opts?: { executable?: string; env?: Record<string, string> }): GrokBillingTransport {
  const child = spawn(resolveGrokExecutable(opts?.executable), [...GROK_AGENT_ARGS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: tmpdir(),
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    windowsHide: true,
  });
  child.stderr?.resume();
  const rl = createInterface({ input: child.stdout });
  let onMsg: ((message: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  let closedInfo: { code: number | null; signal: string | null } | undefined;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  const markClosed = (info: { code: number | null; signal: string | null }): void => {
    if (closedInfo) return;
    closedInfo = info;
    resolveExited();
    onCls?.(info);
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onMsg?.(JSON.parse(trimmed) as unknown);
    } catch {
      // Non-JSON banner lines are ignored.
    }
  });
  child.on('exit', (code, signal) => markClosed({ code, signal }));
  child.on('error', () => markClosed({ code: null, signal: null }));

  const exitedWithin = async (timeoutMs: number): Promise<boolean> => {
    if (closedInfo) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([exited.then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  };

  return {
    send: (message) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (handler) => {
      onMsg = handler;
    },
    onClose: (handler) => {
      onCls = handler;
      if (closedInfo) handler(closedInfo);
    },
    close: async () => {
      if (closedInfo) return;
      try {
        child.kill('SIGTERM');
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) return;
      }
      if (await exitedWithin(2_000)) return;
      try {
        child.kill('SIGKILL');
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) return;
      }
      if (!(await exitedWithin(2_000))) {
        throw new Error(`grok agent process ${child.pid ?? '?'} survived SIGTERM and SIGKILL`);
      }
    },
  };
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
  let transport: GrokBillingTransport | undefined;
  let client: GrokAcpClient | undefined;
  try {
    transport =
      options.transport ??
      (options.spawnTransport ?? spawnGrokBillingTransport)({
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
