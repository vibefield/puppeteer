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
    currency: 'USD',
    runs: [{ runId: 'run-1', costUsd: 1.5, coverage: 'complete', buckets: [{ at: savedAt, costUsd: 0.3 }] }],
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
    store.save([
      { ...record('a'), runs: [{ runId: 'run-1', costUsd: 2, coverage: 'complete', buckets: [] }] },
      record('b'),
    ]);
    expect(
      store
        .list()
        .map((entry) => entry.nativeSessionId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(store.load({ providerId: 'claude', nativeSessionId: 'a' })?.runs[0]?.costUsd).toBe(2);
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

  it('merges independent runs and prevents late snapshots from undoing a correction', () => {
    const path = storePath();
    const store = createUsageHistoryStore(path, { now: () => new Date(NOW) });
    store.save([record('a')]);
    const second = {
      ...record('a'),
      runs: [{ runId: 'run-2', revision: 4, costUsd: 0.5, coverage: 'complete', buckets: [] }],
    };
    store.save([second]);
    store.save([{ ...second, runs: [{ ...second.runs[0], revision: 3, costUsd: 9 }] }]);
    expect(createUsageHistoryStore(path).load(record('a'))?.runs).toMatchObject([
      { runId: 'run-1', costUsd: 1.5 },
      { runId: 'run-2', costUsd: 0.5 },
    ]);
  });

  it('caps the written file so a large cache remains readable on restart', () => {
    const path = storePath();
    const store = createUsageHistoryStore(path, { now: () => new Date(NOW) });
    const many = Array.from({ length: 1_000 }, (_, index) => ({
      ...record(`large-${index}`),
      runs: [0, 1].map((runId) => ({
        runId: String(runId),
        costUsd: 64,
        coverage: 'complete',
        buckets: Array.from({ length: 64 }, (_, bucket) => ({
          at: new Date(NOW - bucket * 30_000).toISOString(),
          costUsd: 1,
          inputUsd: 0.5,
          outputUsd: 0.5,
        })),
      })),
    }));
    store.save(many);
    expect(Buffer.byteLength(readFileSync(path))).toBeLessThanOrEqual(4 * 1024 * 1024);
    const reopened = createUsageHistoryStore(path).list();
    expect(reopened.length).toBeGreaterThan(0);
    expect(reopened).toEqual(store.list());
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
          { ...record('a'), runs: [{ runId: 'x', coverage: 'complete', costUsd: -1, buckets: [] }] },
          { ...record('b'), currency: 'tokens' },
        ],
      }),
    ).toEqual([]);
    expect(
      parseUsageHistory({
        version: 1,
        records: [{ providerId: 'claude', nativeSessionId: 'legacy', total: { held: 5000, snapshots: [] } }],
      }),
    ).toEqual([]);
  });
});
