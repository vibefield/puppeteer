/**
 * Antigravity account usage.
 *
 * Provider-scoped, independent of any TUI session. The native surface is the
 * documented print-mode slash oracle: `agy -p /usage --output-format json`
 * (alias `/quota`) and `/credits`, which Changelog 1.1.11 says answer without
 * starting a turn, spending quota, or leaving a conversation. That is a
 * one-shot structured command, analogous to Codex's `account/rateLimits/read`,
 * not a shadow of a live TUI process.
 *
 * Do not install a custom status line: that writes `settings.json`. The
 * status-line `quota` map is accepted by the normalizer because official docs
 * publish the same bucket ids, but this service never enables that rail.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { resolveAntigravityExecutable } from '../detection.js';
import { ANTIGRAVITY_PROFILE_ROOT_VARIABLE } from './profiles.js';

const PRINT_USAGE_ARGS = ['-p', '/usage', '--output-format', 'json'] as const;
const PRINT_CREDITS_ARGS = ['-p', '/credits', '--output-format', 'json'] as const;
const DISABLE_AUTO_UPDATE = 'AGY_CLI_DISABLE_AUTO_UPDATE';
const HIDE_ACCOUNT_INFO = 'AGY_CLI_HIDE_ACCOUNT_INFO';
const DEFAULT_TIMEOUT_MS = 15_000;
const PRINT_SOURCE: AccountUsageSource = { kind: 'native-protocol', stability: 'documented' };
const STATUSLINE_SOURCE: AccountUsageSource = { kind: 'native-statusline', stability: 'documented' };
const AUTH_PATTERN = /sign in|not logged in|unauthori[sz]ed|unauthenticated|login required|no active account/i;

export const ANTIGRAVITY_ACCOUNT_USAGE_PROVIDER: AccountUsageProvider = {
  id: 'antigravity',
  label: 'Antigravity',
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

function commandData(value: unknown): Record<string, unknown> | undefined {
  const body = rec(value);
  if (!body) return undefined;
  const command = rec(body.command);
  return rec(command?.data) ?? rec(body.data) ?? body;
}

interface RankedMetric {
  metric: AccountUsageMetric;
  rank: number;
}

function windowSpec(id: string, window: string | undefined): { label: string; durationMinutes: number } | undefined {
  const token = `${window ?? ''} ${id}`.toLowerCase();
  if (/\b5h\b/.test(token) || token.includes('five hour') || token.includes('five-hour')) {
    return { label: '5H', durationMinutes: 300 };
  }
  if (/\bweekly\b/.test(token) || /\b7d\b/.test(token)) {
    return { label: '7D', durationMinutes: 10_080 };
  }
  return undefined;
}

function familyPrefix(id: string, groupName: string | undefined): string | undefined {
  const identity = `${id} ${groupName ?? ''}`.toLowerCase();
  if (id.startsWith('gemini') || /\bgemini\b/.test(identity)) return undefined;
  if (id.startsWith('3p') || /\b3p\b/.test(identity) || /claude|gpt/.test(identity)) return '3P';
  const raw = (groupName ?? id)
    .replace(/-?(weekly|5h)$/i, '')
    .replaceAll(/[_-]+/g, ' ')
    .trim();
  return raw ? raw.toUpperCase() : undefined;
}

function usedPercentFromRemaining(remaining: number): number | undefined {
  if (!Number.isFinite(remaining) || remaining < 0) return undefined;
  const used = remaining <= 1 ? (1 - remaining) * 100 : remaining <= 100 ? 100 - remaining : Number.NaN;
  if (!Number.isFinite(used) || used < 0) return undefined;
  return Math.round(used * 1e6) / 1e6;
}

function bucketEnabled(value: Record<string, unknown>): boolean {
  if (value.enabled === false || value.is_enabled === false) return false;
  const status = str(value.status) ?? str(value.state);
  return !status || status.toLowerCase() !== 'disabled';
}

function resetsAt(bucket: Record<string, unknown>, now: Date): string | undefined {
  const stamped = isoTimestamp(bucket.reset_time) ?? isoTimestamp(bucket.resets_at) ?? isoTimestamp(bucket.resetTime);
  if (stamped) return stamped;
  const seconds = finite(bucket.reset_in_seconds) ?? finite(bucket.resetInSeconds);
  if (seconds === undefined || seconds < 0) return undefined;
  return new Date(now.valueOf() + seconds * 1_000).toISOString();
}

function normalizeBucket(
  bucketValue: unknown,
  fallbackId: string,
  groupName: string | undefined,
  groupDescription: string | undefined,
  now: Date,
): RankedMetric | undefined {
  const bucket = rec(bucketValue);
  if (!bucket || !bucketEnabled(bucket)) return undefined;
  const id = str(bucket.id) ?? fallbackId;
  if (!id) return undefined;
  const remaining = finite(bucket.remaining_fraction) ?? finite(bucket.remainingFraction);
  const usedPercent = usedPercentFromRemaining(remaining ?? Number.NaN);
  if (usedPercent === undefined) return undefined;
  const window = windowSpec(id, str(bucket.window) ?? str(bucket.name));
  if (!window) return undefined;
  const prefix = familyPrefix(id, groupName);
  const label = prefix ? `${prefix} ${window.label}` : window.label;
  const rank = (prefix ? 40 : 0) + (window.durationMinutes === 300 ? 0 : window.durationMinutes === 10_080 ? 20 : 30);
  const description = groupDescription ?? groupName ?? `${id} ${window.label} usage`;
  const reset = resetsAt(bucket, now);
  return {
    rank,
    metric: {
      id: `${id}:window`,
      label,
      description,
      kind: 'window',
      usedPercent,
      durationMinutes: window.durationMinutes,
      ...(reset ? { resetsAt: reset } : {}),
    },
  };
}

function normalizeCredits(value: unknown): AccountUsageCredits | undefined {
  const data = commandData(value) ?? rec(value);
  if (!data) return undefined;
  const remaining =
    finite(data.remaining_credits) ?? finite(data.remainingCredits) ?? finite(rec(data.credits)?.balance);
  if (remaining === undefined || remaining < 0) return undefined;
  return { balance: String(remaining), hasCredits: remaining > 0 };
}

function collectGroupBuckets(value: unknown, now: Date): RankedMetric[] {
  const data = commandData(value) ?? rec(value);
  const groups = data?.groups;
  if (!Array.isArray(groups)) return [];
  const metrics: RankedMetric[] = [];
  for (const groupValue of groups) {
    const group = rec(groupValue);
    if (!group) continue;
    const name = str(group.name);
    const description = str(group.description);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const [index, bucket] of buckets.entries()) {
      const normalized = normalizeBucket(bucket, `${name ?? 'group'}:${index}`, name, description, now);
      if (normalized) metrics.push(normalized);
    }
  }
  return metrics;
}

function looksLikeBucket(value: unknown): boolean {
  const bucket = rec(value);
  return Boolean(bucket && (bucket.remaining_fraction !== undefined || bucket.window !== undefined || bucket.id));
}

function bucketsFromMap(value: Record<string, unknown>, now: Date): RankedMetric[] {
  return Object.entries(value).flatMap(([id, bucket]) => {
    const normalized = normalizeBucket(bucket, id, undefined, undefined, now);
    return normalized ? [normalized] : [];
  });
}

function collectQuotaMap(value: unknown, now: Date): RankedMetric[] {
  const body = rec(value);
  if (!body) return [];
  const nested = rec(body.quota);
  if (nested) return bucketsFromMap(nested, now);
  if (body.groups || body.command || body.conversation_id !== undefined || body.remaining_credits !== undefined) {
    return [];
  }
  if (Object.values(body).some(looksLikeBucket)) return bucketsFromMap(body, now);
  return [];
}

function dedupe(metrics: RankedMetric[]): AccountUsageMetric[] {
  const byId = new Map<string, RankedMetric>();
  for (const entry of metrics) {
    const held = byId.get(entry.metric.id);
    if (!held || entry.rank < held.rank) byId.set(entry.metric.id, entry);
  }
  return [...byId.values()]
    .sort((left, right) => left.rank - right.rank || left.metric.id.localeCompare(right.metric.id))
    .map(({ metric }) => metric);
}

/** Normalize print-mode `/usage` JSON, a status-line `quota` map, or either nested in an envelope. */
export function normalizeAntigravityAccountUsage(
  value: unknown,
  fetchedAt = new Date().toISOString(),
  source: AccountUsageSource = PRINT_SOURCE,
): AccountUsageSnapshot {
  const now = new Date(fetchedAt);
  const clock = Number.isFinite(now.valueOf()) ? now : new Date();
  const credits = normalizeCredits(value);
  return {
    provider: 'antigravity',
    fetchedAt,
    scope: 'subscription',
    source,
    metrics: dedupe([...collectGroupBuckets(value, clock), ...collectQuotaMap(value, clock)]),
    ...(credits ? { credits } : {}),
  };
}

/** Parse a status-line stdin payload's `quota` map into the shared account-usage shape. */
export function antigravityAccountUsageFromStatusLine(
  payload: unknown,
  fetchedAt = new Date().toISOString(),
): AccountUsageSnapshot | undefined {
  const snapshot = normalizeAntigravityAccountUsage(payload, fetchedAt, STATUSLINE_SOURCE);
  if (snapshot.metrics.length === 0 && !snapshot.credits) return undefined;
  return snapshot;
}

export type AntigravityAccountUsageExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface FetchAntigravityAccountUsageOptions {
  executable?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  exec?: AntigravityAccountUsageExec;
  cwd?: string;
}

function defaultExec(
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(error);
          return;
        }
        if (error?.killed || error?.code === 'ETIMEDOUT') {
          reject(
            Object.assign(new Error('Antigravity account usage timed out'), { code: 'ETIMEDOUT', stdout, stderr }),
          );
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    child.stdin?.end();
  });
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function isUnauthenticated(stdout: string, stderr: string): boolean {
  return AUTH_PATTERN.test(`${stderr}\n${stdout}`);
}

function printTimeoutFlag(timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  return `${seconds}s`;
}

function usageEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, [DISABLE_AUTO_UPDATE]: '1', NO_COLOR: '1' };
  delete env[HIDE_ACCOUNT_INFO];
  delete env.FORCE_COLOR;
  return env;
}

function profileBinding(profile: AgentProfile | undefined): NodeJS.ProcessEnv {
  if (!profile || profile.kind !== 'managed') return {};
  return { HOME: profile.dataRoot, [ANTIGRAVITY_PROFILE_ROOT_VARIABLE]: profile.dataRoot };
}

function failure(
  status: 'unauthenticated' | 'unavailable',
  message: string,
  retryable: boolean,
): AccountUsageFetchResult {
  return { status, provider: 'antigravity', message, retryable };
}

async function runPrintCommand(
  args: readonly string[],
  options: {
    executable: string;
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
    exec: AntigravityAccountUsageExec;
  },
): Promise<{ body: unknown; stdout: string; stderr: string }> {
  const argv = [...args, '--print-timeout', printTimeoutFlag(options.timeoutMs)];
  const { stdout, stderr } = await options.exec(options.executable, argv, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  return { body: parseJson(stdout), stdout, stderr };
}

/** Fetch Antigravity quota through documented print-mode JSON. */
export async function fetchAntigravityAccountUsage(
  options: FetchAntigravityAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure('unavailable', 'Antigravity account usage timeout must be positive', false);
  }

  const executable = resolveAntigravityExecutable(options.executable, options.env ?? process.env);
  const env = usageEnv(options.env ?? process.env);
  const exec = options.exec ?? defaultExec;
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const ownedCwd = options.cwd ? undefined : await mkdtemp(join(tmpdir(), 'puppeteer-agy-usage-'));
  const cwd = options.cwd ?? ownedCwd!;

  try {
    const [usage, credits] = await Promise.all([
      runPrintCommand(PRINT_USAGE_ARGS, { executable, env, cwd, timeoutMs, exec }),
      runPrintCommand(PRINT_CREDITS_ARGS, { executable, env, cwd, timeoutMs, exec }),
    ]);

    if (isUnauthenticated(usage.stdout, usage.stderr) || isUnauthenticated(credits.stdout, credits.stderr)) {
      const snapshot = normalizeAntigravityAccountUsage(usage.body, fetchedAt);
      const creditState = normalizeCredits(credits.body);
      if (snapshot.metrics.length > 0) {
        return { status: 'available', snapshot: { ...snapshot, ...(creditState ? { credits: creditState } : {}) } };
      }
      return failure('unauthenticated', 'Antigravity is not authenticated with a supported account', false);
    }

    const snapshot = normalizeAntigravityAccountUsage(usage.body, fetchedAt);
    const creditState = normalizeCredits(credits.body);
    const merged = creditState ? { ...snapshot, credits: creditState } : snapshot;
    if (merged.metrics.length === 0 && !merged.credits) {
      return failure('unavailable', 'Antigravity returned no account usage limits', true);
    }
    return { status: 'available', snapshot: merged };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return failure('unavailable', 'Antigravity executable was not found', true);
    }
    if (code === 'ETIMEDOUT') {
      return failure('unavailable', 'Antigravity account usage timed out', true);
    }
    const output = `${(error as { stdout?: string }).stdout ?? ''}\n${(error as { stderr?: string }).stderr ?? ''}`;
    if (isUnauthenticated(output, error instanceof Error ? error.message : String(error))) {
      return failure('unauthenticated', 'Antigravity is not authenticated with a supported account', false);
    }
    return failure('unavailable', 'Antigravity account usage is unavailable', true);
  } finally {
    if (ownedCwd) await rm(ownedCwd, { recursive: true, force: true });
  }
}

/** Read usage for the native default account, or for one profile's redirected HOME. */
export async function fetchAntigravityAccountUsageForProfile(
  profile?: AgentProfile,
  options: FetchAntigravityAccountUsageOptions = {},
): Promise<AccountUsageFetchResult> {
  const binding = profileBinding(profile);
  const result = await fetchAntigravityAccountUsage({
    ...options,
    env: { ...(options.env ?? process.env), ...binding },
  });
  if (!profile || result.status !== 'available') return result;
  return { ...result, snapshot: { ...result.snapshot, profileId: profile.id } };
}

/** Complete account-usage capability advertised by the Antigravity adapter. */
export function createAntigravityAccountUsageService(
  options: FetchAntigravityAccountUsageOptions = {},
): AccountUsageService {
  return {
    provider: ANTIGRAVITY_ACCOUNT_USAGE_PROVIDER,
    fetch: (fetchOptions) => fetchAntigravityAccountUsageForProfile(fetchOptions?.profile, options),
  };
}
