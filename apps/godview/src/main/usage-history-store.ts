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
import type { UsageHistoryKey, UsageLedgerRecord, UsageSeriesRecord } from '../protocol.js';

/**
 * The UI's usage ledgers, persisted per conversation so a resumed session
 * opens with the total and the burn it had. The renderer owns the numbers
 * (`renderer/monitor/usage-ledger.ts`); main only keeps them.
 *
 * This is cache, not state: it lives in the app's cache folder, every read
 * is tolerant, and losing it costs a resumed bubble nothing but its first
 * ten minutes of history. Records age out and the file is capped, so it
 * never grows with a user's whole past.
 */

export const USAGE_HISTORY_VERSION = 1 as const;

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
  /** Merge the given records in (the newest save of a conversation wins), prune, and write. Junk is dropped. */
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

function series(value: unknown): UsageSeriesRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.snapshots) || value.snapshots.length > MAX_SNAPSHOTS) return undefined;
  const snapshots: number[] = [];
  for (const snapshot of value.snapshots) {
    const number = count(snapshot);
    if (number === undefined) return undefined;
    snapshots.push(number);
  }
  const held = value.held === undefined ? undefined : count(value.held);
  if (value.held !== undefined && held === undefined) return undefined;
  return { ...(held !== undefined ? { held } : {}), snapshots };
}

export function usageHistoryKey(key: UsageHistoryKey): string {
  return `${key.providerId} ${key.nativeSessionId}`;
}

/** One well-formed record, or nothing: ids present, a real save time, a whole boundary, readable series. */
export function parseUsageLedgerRecord(value: unknown): UsageLedgerRecord | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = usageId(value.providerId);
  const nativeSessionId = usageId(value.nativeSessionId);
  const savedAt =
    typeof value.savedAt === 'string' && !Number.isNaN(Date.parse(value.savedAt)) ? value.savedAt : undefined;
  const boundary =
    typeof value.boundary === 'number' && Number.isSafeInteger(value.boundary) && value.boundary >= 0
      ? value.boundary
      : undefined;
  const total = series(value.total);
  if (!providerId || !nativeSessionId || !savedAt || boundary === undefined || !total) return undefined;
  const output = value.output === undefined ? undefined : series(value.output);
  const input = value.input === undefined ? undefined : series(value.input);
  if ((value.output !== undefined && !output) || (value.input !== undefined && !input)) return undefined;
  return {
    providerId,
    nativeSessionId,
    savedAt,
    boundary,
    total,
    ...(output ? { output } : {}),
    ...(input ? { input } : {}),
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

/** Drop what has aged out, then keep the newest saves up to the cap. */
export function pruneUsageHistory(records: readonly UsageLedgerRecord[], nowMs: number): UsageLedgerRecord[] {
  return newestFirst(records.filter((record) => nowMs - Date.parse(record.savedAt) <= MAX_AGE_MS)).slice(
    0,
    MAX_RECORDS,
  );
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
        current.set(usageHistoryKey(record), record);
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
