import { describe, expect, it, vi } from 'vitest';
import { EMPTY_USAGE_LEDGER, reconcileUsage, seedUsage, type UsageLedgerRecord } from '@vibecook/puppeteer-views';
import { createUsageHistoryPersistence } from './usage-history-persistence.js';

const now = Date.parse('2026-09-17T12:00:00Z');
const key = { id: 'bubble', providerId: 'claude', nativeSessionId: 'session' };
const cached: UsageLedgerRecord = {
  ...key,
  currency: 'USD',
  savedAt: new Date(now).toISOString(),
  runs: [{ runId: 'old-run', costUsd: 2, coverage: 'complete', buckets: [] }],
};

function fixture() {
  let resolve!: (value: UsageLedgerRecord | null) => void;
  let reject!: (reason: Error) => void;
  const pending = new Promise<UsageLedgerRecord | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let ledger = reconcileUsage(
    EMPTY_USAGE_LEDGER,
    [
      {
        id: key.id,
        runId: 'live-run',
        session: key,
        usage: { samples: [], costUsd: 0.5, costCoverage: 'complete' },
      },
    ],
    now,
  );
  const load = vi.fn(() => pending);
  const save = vi.fn(async () => undefined);
  const seed = vi.fn((id: string, record: UsageLedgerRecord) => {
    ledger = seedUsage(ledger, id, record, now);
  });
  const persistence = createUsageHistoryPersistence({
    store: { load, save },
    read: () => ledger,
    seed,
    now: () => now,
  });
  return { persistence, load, save, seed, resolve, reject, read: () => ledger };
}

describe('usage history persistence lifecycle', () => {
  it('keeps an in-flight load through live renders and waits before saving', async () => {
    const f = fixture();
    f.persistence.sync([key]);
    f.persistence.sync([{ ...key }]);
    f.persistence.save();
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    f.resolve(cached);
    await Promise.resolve();
    expect(f.read().histories.get(key.id)?.total).toBe(2.5);
    f.persistence.save();
    expect(f.save).toHaveBeenCalledWith([
      expect.objectContaining({
        runs: [expect.objectContaining({ runId: 'live-run', costUsd: 0.5 })],
      }),
    ]);
  });

  it('ignores a late load after a conversation leaves and reloads when it returns', async () => {
    const f = fixture();
    f.persistence.sync([key]);
    f.persistence.sync([]);
    f.resolve(cached);
    await Promise.resolve();
    expect(f.seed).not.toHaveBeenCalled();
    f.persistence.sync([key]);
    await Promise.resolve();
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.seed).toHaveBeenCalledTimes(1);
  });

  it('retries failures and invalidates pending callbacks when disconnected', async () => {
    const f = fixture();
    f.persistence.sync([key]);
    f.reject(new Error('IPC failed'));
    await Promise.resolve();
    f.persistence.sync([key]);
    expect(f.load).toHaveBeenCalledTimes(2);
    f.persistence.disconnect();
    await Promise.resolve();
    f.persistence.save();
    expect(f.save).not.toHaveBeenCalled();
  });
});
