import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { UsageHistoryKey, UsageLedgerRecord, UsageRunRecord } from '../protocol.js';

/**
 * The UI's usage ledgers, persisted per conversation so a resumed session
 * opens with the total and the burn it had. The renderer owns the numbers
 * (`renderer/monitor/usage-ledger.ts`); main only keeps them.
 *
 * This is cache, not state: it lives in the app's cache folder, every read
 * is tolerant; losing it discards previously observed USD totals and charts,
 * never triggers transcript reconstruction. Records age out and the file is capped, so it
 * never grows with a user's whole past.
 */

export const USAGE_HISTORY_VERSION = 2 as const;

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_ID_LENGTH = 256;
const MAX_SNAPSHOTS = 64;
const TEMP_PREFIX = '.usage-history-';

interface UsageHistoryDocument {
  version: typeof USAGE_HISTORY_VERSION;
  records: UsageLedgerRecord[];
}

/**
 * The platform's per-user cache folder for this app: Library/Caches on macOS,
 * the local app data Cache on Windows, XDG_CACHE_HOME elsewhere. Electron
 * names no cache path of its own, and userData is state, not cache.
 */
export function appCacheDirectory(
  appName: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', appName);
  if (platform === 'win32') return join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), appName, 'Cache');
  return join(environment.XDG_CACHE_HOME ?? join(home, '.cache'), appName);
}

export interface UsageHistoryStore {
  path: string;
  load(key: UsageHistoryKey): UsageLedgerRecord | undefined;
  /** Merge run snapshots, preserve corrections by revision, prune, and write. Junk is dropped. */
  save(records: unknown): void;
  /** Every record kept, newest save first. */
  list(): UsageLedgerRecord[];
}

export interface UsageHistoryStoreOptions {
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function usageId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageRun(value: unknown): UsageRunRecord | undefined {
  if (
    !isRecord(value) ||
    !usageId(value.runId) ||
    !Array.isArray(value.buckets) ||
    value.buckets.length > MAX_SNAPSHOTS
  )
    return undefined;
  if (value.coverage !== 'complete' && value.coverage !== 'partial' && value.coverage !== 'unavailable')
    return undefined;
  const costUsd = value.costUsd === undefined ? undefined : count(value.costUsd);
  if (value.costUsd !== undefined && costUsd === undefined) return undefined;
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0))
    return undefined;
  const buckets: UsageRunRecord['buckets'] = [];
  const times = new Set<string>();
  for (const bucket of value.buckets) {
    if (
      !isRecord(bucket) ||
      typeof bucket.at !== 'string' ||
      !Number.isFinite(Date.parse(bucket.at)) ||
      times.has(bucket.at)
    )
      return undefined;
    const amount = count(bucket.costUsd);
    const inputUsd = bucket.inputUsd === undefined ? undefined : count(bucket.inputUsd);
    const outputUsd = bucket.outputUsd === undefined ? undefined : count(bucket.outputUsd);
    if (
      amount === undefined ||
      (bucket.inputUsd !== undefined && inputUsd === undefined) ||
      (bucket.outputUsd !== undefined && outputUsd === undefined)
    )
      return undefined;
    times.add(bucket.at);
    buckets.push({
      at: bucket.at,
      costUsd: amount,
      ...(inputUsd === undefined ? {} : { inputUsd }),
      ...(outputUsd === undefined ? {} : { outputUsd }),
    });
  }
  return {
    runId: value.runId as string,
    ...(value.revision === undefined ? {} : { revision: value.revision as number }),
    coverage: value.coverage,
    buckets,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

export function usageHistoryKey(key: UsageHistoryKey): string {
  return `${key.providerId} ${key.nativeSessionId}`;
}

/** USD only: legacy token snapshots must never be interpreted as dollars. */
export function parseUsageLedgerRecord(value: unknown): UsageLedgerRecord | undefined {
  if (!isRecord(value) || value.currency !== 'USD' || !Array.isArray(value.runs) || value.runs.length > MAX_RECORDS)
    return undefined;
  const providerId = usageId(value.providerId);
  const nativeSessionId = usageId(value.nativeSessionId);
  const savedAt =
    typeof value.savedAt === 'string' && !Number.isNaN(Date.parse(value.savedAt)) ? value.savedAt : undefined;
  if (!providerId || !nativeSessionId || !savedAt) return undefined;
  const runs: UsageRunRecord[] = [];
  const ids = new Set<string>();
  for (const candidate of value.runs) {
    const run = usageRun(candidate);
    if (!run || ids.has(run.runId)) return undefined;
    ids.add(run.runId);
    runs.push(run);
  }
  return {
    providerId,
    nativeSessionId,
    savedAt,
    currency: 'USD',
    runs,
  };
}

/** Accepts only well-formed records, one per conversation; everything else is dropped. */
export function parseUsageHistory(value: unknown): UsageLedgerRecord[] {
  const document = isRecord(value) ? value : undefined;
  if (!document || document.version !== USAGE_HISTORY_VERSION || !Array.isArray(document.records)) return [];
  const byKey = new Map<string, UsageLedgerRecord>();
  for (const entry of document.records) {
    if (byKey.size >= MAX_RECORDS) break;
    const record = parseUsageLedgerRecord(entry);
    if (!record || byKey.has(usageHistoryKey(record))) continue;
    byKey.set(usageHistoryKey(record), record);
  }
  return [...byKey.values()];
}

function newestFirst(records: readonly UsageLedgerRecord[]): UsageLedgerRecord[] {
  return [...records].sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
}

/** Bound the actual bytes written, so the next read never rejects our own file. */
export function pruneUsageHistory(records: readonly UsageLedgerRecord[], nowMs: number): UsageLedgerRecord[] {
  const kept: UsageLedgerRecord[] = [];
  let bytes = Buffer.byteLength(serializeUsageHistory([]));
  for (const record of newestFirst(records)) {
    if (nowMs - Date.parse(record.savedAt) > MAX_AGE_MS) continue;
    if (kept.length >= MAX_RECORDS) break;
    const added = Buffer.byteLength(JSON.stringify(record)) + (kept.length > 0 ? 1 : 0);
    if (bytes + added > MAX_FILE_BYTES) continue;
    kept.push(record);
    bytes += added;
  }
  return kept;
}

function mergeRecord(previous: UsageLedgerRecord | undefined, incoming: UsageLedgerRecord): UsageLedgerRecord {
  if (!previous) return incoming;
  const runs = new Map(previous.runs.map((run) => [run.runId, run]));
  const newerSave = Date.parse(incoming.savedAt) >= Date.parse(previous.savedAt);
  for (const run of incoming.runs) {
    const old = runs.get(run.runId);
    const newer =
      old?.revision !== undefined || run.revision !== undefined
        ? (run.revision ?? -1) >= (old?.revision ?? -1)
        : newerSave;
    if (!old || newer) runs.set(run.runId, run);
  }
  return {
    ...incoming,
    savedAt: newerSave ? incoming.savedAt : previous.savedAt,
    runs: [...runs.values()].slice(-MAX_RECORDS),
  };
}

export function serializeUsageHistory(records: readonly UsageLedgerRecord[]): string {
  const document: UsageHistoryDocument = { version: USAGE_HISTORY_VERSION, records: newestFirst(records) };
  return `${JSON.stringify(document)}\n`;
}

function readHistoryFile(path: string): UsageLedgerRecord[] {
  try {
    if (!existsSync(path)) return [];
    if (statSync(path).size > MAX_FILE_BYTES) return [];
    return parseUsageHistory(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    // A corrupt cache costs resumed bubbles their history and nothing else.
    return [];
  }
}

function writeHistoryFile(path: string, records: readonly UsageLedgerRecord[]): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${TEMP_PREFIX}${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, serializeUsageHistory(records), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function createUsageHistoryStore(path: string, options: UsageHistoryStoreOptions = {}): UsageHistoryStore {
  const now = options.now ?? (() => new Date());
  let records: Map<string, UsageLedgerRecord> | undefined;
  const loaded = (): Map<string, UsageLedgerRecord> => {
    records ??= new Map(readHistoryFile(path).map((record) => [usageHistoryKey(record), record] as const));
    return records;
  };
  return {
    path,
    load(key) {
      return loaded().get(usageHistoryKey(key));
    },
    save(incoming) {
      const current = loaded();
      if (!Array.isArray(incoming)) return;
      let changed = false;
      for (const entry of incoming) {
        const record = parseUsageLedgerRecord(entry);
        if (!record) continue;
        current.set(usageHistoryKey(record), mergeRecord(current.get(usageHistoryKey(record)), record));
        changed = true;
      }
      if (!changed) return;
      const kept = pruneUsageHistory([...current.values()], now().getTime());
      records = new Map(kept.map((record) => [usageHistoryKey(record), record] as const));
      try {
        writeHistoryFile(path, kept);
      } catch (error) {
        process.stderr.write(`[main] could not write the usage history cache at ${path}: ${String(error)}\n`);
      }
    },
    list() {
      return newestFirst([...loaded().values()]);
    },
  };
}
