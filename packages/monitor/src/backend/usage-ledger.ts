import type { MonitorCostBucket, MonitorUsageState } from '@vibecook/puppeteer-core';
import type { CostCoverage } from '@vibecook/puppeteer-view-sdk/model';
import { deepEqual } from './equal.js';

// The usage ledger, ported from the window's former `views/monitor/usage-ledger.ts`
// (`reconcileUsage` + `historyOf`; deleted at MV-8b, so this is the one ledger, L11)
// as a per-run incremental table. Core owns the accounting: a
// reading can neither mint spend nor suppress a correction; the ledger only
// holds each run's corrected total and lays its 30 s buckets on a fixed grid.
// Persistence (`seedUsage` / `exportUsage`) is not ported: the series lives in
// the backend's memory for the daemon's lifetime, refilled from core's own
// `costHistory` buckets (L11).

export const USAGE_STEP_MS = 30_000;
export const USAGE_STEP_COUNT = 20;

export interface UsageSessionKey {
  readonly providerId: string;
  readonly nativeSessionId: string;
}

export interface UsageHistory {
  /** Estimated API-equivalent USD for work observed across these runs. */
  readonly total?: number | undefined;
  readonly coverage: CostCoverage;
  /** Corrected USD in fixed time buckets, oldest first; the last is the current bucket. */
  readonly steps: readonly number[];
  readonly stepMs: number;
  /** When the current bucket began. */
  readonly lastStepAt: number;
}

export interface UsageReading {
  /** The row the history belongs to. */
  readonly id: string;
  /** The run observed; defaults to the id. A new epoch is a new run. */
  readonly runId?: string | undefined;
  readonly revision?: number | undefined;
  /** The conversation the run continues; a different one resets the history. */
  readonly session?: UsageSessionKey | undefined;
  readonly usage?: MonitorUsageState | undefined;
}

interface UsageRun {
  readonly runId: string;
  readonly revision?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly coverage: CostCoverage;
  readonly buckets: readonly MonitorCostBucket[];
}

interface UsageEntry {
  readonly session?: UsageSessionKey | undefined;
  readonly liveRunId: string;
  readonly runs: ReadonlyMap<string, UsageRun>;
}

function sameSession(left: UsageSessionKey | undefined, right: UsageSessionKey | undefined): boolean {
  return left?.providerId === right?.providerId && left?.nativeSessionId === right?.nativeSessionId;
}

function historyOf(entry: UsageEntry, nowMs: number): UsageHistory {
  const steps = new Array<number>(USAGE_STEP_COUNT).fill(0);
  const boundary = Math.floor(nowMs / USAGE_STEP_MS);
  let total: number | undefined;
  let partial = false;
  for (const run of entry.runs.values()) {
    if (run.costUsd !== undefined) total = (total ?? 0) + run.costUsd;
    if (run.coverage !== 'complete') partial = true;
    for (const bucket of run.buckets) {
      const index = USAGE_STEP_COUNT - 1 - (boundary - Math.floor(Date.parse(bucket.at) / USAGE_STEP_MS));
      if (index < 0 || index >= USAGE_STEP_COUNT) continue;
      steps[index]! += bucket.costUsd;
    }
  }
  return {
    ...(total === undefined ? {} : { total }),
    coverage: total === undefined ? 'unavailable' : partial ? 'partial' : 'complete',
    steps,
    stepMs: USAGE_STEP_MS,
    lastStepAt: boundary * USAGE_STEP_MS,
  };
}

/**
 * One entry per row id; a history object is replaced only when its content
 * changes, so a caller can compare histories by identity.
 */
export class UsageLedger {
  private readonly entries = new Map<string, UsageEntry>();
  private readonly histories = new Map<string, UsageHistory>();

  history(id: string): UsageHistory | undefined {
    return this.histories.get(id);
  }

  /** Takes one reading; returns whether the row's history changed. A reading with no usage forgets the row. */
  observe(reading: UsageReading, nowMs: number): boolean {
    if (!reading.usage) return this.forget(reading.id);
    const runId = reading.runId ?? reading.id;
    const prior = this.entries.get(reading.id);
    // A stable row can outlive its provider conversation. An initially unknown
    // native id may be filled in only for the same live run.
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
    this.entries.set(reading.id, entry);
    return this.settle(reading.id, historyOf(entry, nowMs));
  }

  forget(id: string): boolean {
    this.entries.delete(id);
    return this.histories.delete(id);
  }

  /** The step clock: every history is laid on the new boundary; returns the ids whose history changed. */
  step(nowMs: number): string[] {
    const changed: string[] = [];
    for (const [id, entry] of this.entries) {
      if (this.settle(id, historyOf(entry, nowMs))) changed.push(id);
    }
    return changed;
  }

  private settle(id: string, history: UsageHistory): boolean {
    const previous = this.histories.get(id);
    if (previous && deepEqual(previous, history)) return false;
    this.histories.set(id, Object.freeze({ ...history, steps: Object.freeze(history.steps) }));
    return true;
  }
}
