import type { MonitorUsageState } from '@vibecook/puppeteer-core';
import type { UsageHistoryKey, UsageLedgerRecord, UsageRunRecord } from './usage-history.js';

export const USAGE_STEP_MS = 30_000;
export const USAGE_STEP_COUNT = 20;

export interface UsageHistory {
  /** Estimated API-equivalent USD for work observed across these runs. */
  total?: number;
  coverage?: UsageRunRecord['coverage'];
  /** Corrected USD in fixed time buckets, oldest first. */
  steps: readonly number[];
  sides?: { output: readonly number[]; input: readonly number[] };
  stepMs: number;
}

export interface UsageReading {
  id: string;
  runId?: string;
  revision?: number;
  session?: UsageHistoryKey;
  usage?: MonitorUsageState;
}

interface UsageEntry {
  session?: UsageHistoryKey;
  liveRunId?: string;
  runs: ReadonlyMap<string, UsageRunRecord>;
}
export interface UsageLedger {
  readonly entries: ReadonlyMap<string, UsageEntry>;
  readonly histories: ReadonlyMap<string, UsageHistory>;
}
export const EMPTY_USAGE_LEDGER: UsageLedger = { entries: new Map(), histories: new Map() };

function sameSession(left: UsageHistoryKey | undefined, right: UsageHistoryKey | undefined): boolean {
  return left?.providerId === right?.providerId && left?.nativeSessionId === right?.nativeSessionId;
}

function historyOf(entry: UsageEntry, nowMs: number): UsageHistory {
  const steps = new Array<number>(USAGE_STEP_COUNT).fill(0);
  const input = [...steps];
  const output = [...steps];
  const boundary = Math.floor(nowMs / USAGE_STEP_MS);
  let total: number | undefined;
  let partial = false;
  let split = true;
  for (const run of entry.runs.values()) {
    if (run.costUsd !== undefined) total = (total ?? 0) + run.costUsd;
    if (run.coverage !== 'complete') partial = true;
    for (const bucket of run.buckets) {
      const index = USAGE_STEP_COUNT - 1 - (boundary - Math.floor(Date.parse(bucket.at) / USAGE_STEP_MS));
      if (index < 0 || index >= USAGE_STEP_COUNT) continue;
      steps[index]! += bucket.costUsd;
      if (bucket.costUsd > 0 && (bucket.inputUsd === undefined || bucket.outputUsd === undefined)) split = false;
      input[index]! += bucket.inputUsd ?? 0;
      output[index]! += bucket.outputUsd ?? 0;
    }
  }
  return {
    ...(total === undefined ? {} : { total }),
    coverage: total === undefined ? 'unavailable' : partial ? 'partial' : 'complete',
    steps,
    ...(split && steps.some((step) => step > 0) ? { sides: { input, output } } : {}),
    stepMs: USAGE_STEP_MS,
  };
}

/** Core owns the accounting. UI snapshots can neither mint spend nor suppress corrections. */
export function reconcileUsage(previous: UsageLedger, readings: readonly UsageReading[], nowMs: number): UsageLedger {
  const entries = new Map<string, UsageEntry>();
  const histories = new Map<string, UsageHistory>();
  for (const reading of readings) {
    if (!reading.usage) continue;
    const runId = reading.runId ?? reading.id;
    const prior = previous.entries.get(reading.id);
    // A stable bubble can outlive its provider conversation. An initially
    // unknown native id may be filled in only for the same live run.
    const continuesRun = prior?.liveRunId === runId;
    const session = reading.session ?? (continuesRun ? prior?.session : undefined);
    const retainsHistory = (session && sameSession(prior?.session, session)) || (continuesRun && !prior?.session);
    const runs = new Map(retainsHistory ? prior?.runs : undefined);
    const usage = reading.usage;
    runs.set(runId, {
      runId,
      ...(reading.revision === undefined ? {} : { revision: reading.revision }),
      ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      coverage: usage.costCoverage ?? 'unavailable',
      buckets: usage.costHistory ?? [],
    });
    const entry: UsageEntry = { runs, liveRunId: runId, ...(session ? { session } : {}) };
    entries.set(reading.id, entry);
    histories.set(reading.id, historyOf(entry, nowMs));
  }
  return { entries, histories };
}

export interface UsageLedgerKey {
  id: string;
  providerId: string;
  nativeSessionId: string;
}

export function exportUsage(ledger: UsageLedger, keys: readonly UsageLedgerKey[], nowMs: number): UsageLedgerRecord[] {
  return keys.flatMap((key) => {
    const entry = ledger.entries.get(key.id);
    if (!entry || !sameSession(entry.session, key) || !entry.liveRunId) return [];
    const live = entry.runs.get(entry.liveRunId);
    if (!live) return [];
    return [
      {
        currency: 'USD' as const,
        providerId: key.providerId,
        nativeSessionId: key.nativeSessionId,
        savedAt: new Date(nowMs).toISOString(),
        // Cached runs may have been corrected by another renderer. Only this
        // monitor's authoritative snapshot is eligible to overwrite storage.
        runs: [live],
      },
    ];
  });
}

/** Same-run values replace cached values; new runs add only independently observed work. */
export function seedUsage(previous: UsageLedger, id: string, record: UsageLedgerRecord, nowMs: number): UsageLedger {
  if (record.currency !== 'USD') return previous;
  const liveEntry = previous.entries.get(id);
  if (liveEntry?.session && !sameSession(liveEntry.session, record)) return previous;
  const runs = new Map(record.runs.map((run) => [run.runId, run]));
  for (const [runId, live] of liveEntry?.runs ?? []) runs.set(runId, live);
  const entry: UsageEntry = {
    ...liveEntry,
    session: { providerId: record.providerId, nativeSessionId: record.nativeSessionId },
    runs,
  };
  const entries = new Map(previous.entries);
  const histories = new Map(previous.histories);
  entries.set(id, entry);
  histories.set(id, historyOf(entry, nowMs));
  return { entries, histories };
}
