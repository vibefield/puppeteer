import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageLedgerRecord } from '../protocol.js';
import {
  appCacheDirectory,
  createUsageHistoryStore,
  parseUsageHistory,
  USAGE_HISTORY_VERSION,
} from './usage-history-store.js';

const NOW = Date.parse('2026-09-12T00:00:00.000Z');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'usage-history-'));
  roots.push(root);
  return join(root, 'cache', 'usage-history.json');
}

function record(nativeSessionId: string, savedAt = new Date(NOW).toISOString()): UsageLedgerRecord {
  return {
    providerId: 'claude',
    nativeSessionId,
    savedAt,
    boundary: 1_000,
    total: { held: 1_500, snapshots: [1_000, 1_200, 1_500] },
    output: { held: 300, snapshots: [200, 250, 300] },
    input: { held: 1_200, snapshots: [800, 950, 1_200] },
  };
}

describe('appCacheDirectory', () => {
  it('names the platform cache folder for the app', () => {
    expect(appCacheDirectory('Godview', 'darwin', {}, '/Users/j')).toBe('/Users/j/Library/Caches/Godview');
    expect(appCacheDirectory('Godview', 'linux', { XDG_CACHE_HOME: '/tmp/xdg' }, '/home/j')).toBe('/tmp/xdg/Godview');
    expect(appCacheDirectory('Godview', 'linux', {}, '/home/j')).toBe('/home/j/.cache/Godview');
    expect(appCacheDirectory('Godview', 'win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\j')).toBe(
      join('C:\\Local', 'Godview', 'Cache'),
    );
  });
});

describe('usage history store', () => {
  it('saves atomically into a folder it creates and loads by provider and native session', () => {
    const path = storePath();
    const store = createUsageHistoryStore(path, { now: () => new Date(NOW) });
    expect(store.load({ providerId: 'claude', nativeSessionId: 'a' })).toBeUndefined();
    store.save([record('a')]);
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { version: number }).version).toBe(USAGE_HISTORY_VERSION);
    const reopened = createUsageHistoryStore(path, { now: () => new Date(NOW) });
    expect(reopened.load({ providerId: 'claude', nativeSessionId: 'a' })).toEqual(record('a'));
    expect(reopened.load({ providerId: 'codex', nativeSessionId: 'a' })).toBeUndefined();
  });

  it('merges by conversation, the newest save winning, and drops junk without writing', () => {
    const path = storePath();
    const store = createUsageHistoryStore(path, { now: () => new Date(NOW) });
    store.save([record('a'), { providerId: 'claude' }, 'nonsense', null]);
    store.save([{ ...record('a'), total: { held: 2_000, snapshots: [1_500, 2_000] } }, record('b')]);
    expect(
      store
        .list()
        .map((entry) => entry.nativeSessionId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(store.load({ providerId: 'claude', nativeSessionId: 'a' })?.total.held).toBe(2_000);
    const before = readFileSync(path, 'utf8');
    store.save(['still nonsense']);
    store.save('not even a list');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('ages records out after thirty days and keeps the newest thousand', () => {
    const path = storePath();
    const store = createUsageHistoryStore(path, { now: () => new Date(NOW) });
    const stale = record('old', new Date(NOW - 31 * 24 * 60 * 60_000).toISOString());
    store.save([stale, record('fresh')]);
    expect(store.list().map((entry) => entry.nativeSessionId)).toEqual(['fresh']);
    const many = Array.from({ length: 1_005 }, (_, index) =>
      record(`s${index}`, new Date(NOW - index * 1_000).toISOString()),
    );
    store.save(many);
    expect(store.list()).toHaveLength(1_000);
    expect(store.load({ providerId: 'claude', nativeSessionId: 's1004' })).toBeUndefined();
    expect(store.load({ providerId: 'claude', nativeSessionId: 's0' })).toBeDefined();
  });

  it('reads a damaged or foreign file as empty', () => {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"version": 1, "records": [');
    expect(createUsageHistoryStore(path).list()).toEqual([]);
    expect(parseUsageHistory({ version: 99, records: [record('a')] })).toEqual([]);
    expect(parseUsageHistory({ version: USAGE_HISTORY_VERSION, records: [record('a'), record('a')] })).toHaveLength(1);
    expect(
      parseUsageHistory({
        version: USAGE_HISTORY_VERSION,
        records: [
          { ...record('a'), total: { snapshots: ['x'] } },
          { ...record('b'), boundary: -1 },
        ],
      }),
    ).toEqual([]);
  });
});
