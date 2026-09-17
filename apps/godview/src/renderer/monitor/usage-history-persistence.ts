import {
  exportUsage,
  type UsageHistoryStore,
  type UsageLedger,
  type UsageLedgerKey,
  type UsageLedgerRecord,
} from '@vibecook/puppeteer-views';

interface Options {
  store: UsageHistoryStore;
  read(): UsageLedger;
  seed(id: string, record: UsageLedgerRecord): void;
  now(): number;
}

/** Loads belong to a conversation binding, not an individual React effect run. */
export function createUsageHistoryPersistence({ store, read, seed, now }: Options) {
  const bindings = new Map<string, { key: UsageLedgerKey; ready: boolean }>();
  const identity = (key: UsageLedgerKey) => JSON.stringify([key.id, key.providerId, key.nativeSessionId]);
  return {
    sync(keys: readonly UsageLedgerKey[]): void {
      const current = new Set(keys.map(identity));
      for (const id of bindings.keys()) if (!current.has(id)) bindings.delete(id);
      for (const key of keys) {
        const id = identity(key);
        if (bindings.has(id)) continue;
        const binding = { key, ready: false };
        bindings.set(id, binding);
        void store.load(key).then(
          (record) => {
            if (bindings.get(id) !== binding) return;
            if (record) seed(key.id, record);
            binding.ready = true;
          },
          () => {
            // A later update can retry; a failed load must not overwrite cache.
            if (bindings.get(id) === binding) bindings.delete(id);
          },
        );
      }
    },
    save(): void {
      const keys = [...bindings.values()].filter((binding) => binding.ready).map((binding) => binding.key);
      const records = exportUsage(read(), keys, now());
      if (records.length > 0) void store.save(records).catch(() => undefined);
    },
    disconnect(): void {
      bindings.clear();
    },
  };
}
