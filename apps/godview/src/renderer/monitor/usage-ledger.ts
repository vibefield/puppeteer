import type { MonitorUsageState } from '@vibecook/puppeteer-core';
import type { UsageLedgerRecord, UsageSeriesRecord } from '../../protocol.js';

/**
 * The UI's own account of each agent's token usage.
 *
 * Core's usage is a corrected estimate: every source that reports moves it, and
 * a resync, a reconciliation between two sources, or a source dropping out can
 * lower it or blank it for a moment. A figure on screen must not follow those
 * excursions, and a chart must not be re-derived from a sliding window of raw
 * samples on every frame. So the views read this ledger instead of Core's
 * usage: one series per agent that holds the last number the source stood
 * behind, snapshotted at every fixed step, from which the bars are the tokens
 * each step burned. The ledger is a fold over successive projections, like
 * `unread.ts`, and the only usage state the UI keeps.
 */

/** The step: the total is snapshotted this often, and one bar is one step. */
export const USAGE_STEP_MS = 30_000;
/** Twenty steps: the ten minutes of history the swarm's bars show. */
export const USAGE_STEP_COUNT = 20;
/** A lower reading is shown once it has stood this long; until then the source is treated as having dropped out. */
export const USAGE_CORRECTION_GRACE_MS = USAGE_STEP_MS;

export interface UsageHistory {
  /** The presented total: the last number the source stood behind. Absent until a source reports one. */
  total?: number;
  /** Tokens burned in each of the last `USAGE_STEP_COUNT` steps, oldest first; zero where nothing is known. */
  steps: readonly number[];
  /** The two sides of the burn when the source splits it: completion (output, reasoning) and prompt (input, cache). */
  sides?: { output: readonly number[]; input: readonly number[] };
  stepMs: number;
}

export interface UsageReading {
  /** The agent's stable monitor identity. */
  id: string;
  /** Core's usage; absent for a terminal no agent has claimed, which keeps no ledger. */
  usage?: MonitorUsageState;
}

interface Series {
  held?: number;
  /** When the source first reported below the held value, epoch ms; cleared when it agrees again. */
  lowerSince?: number;
  /** The held value at each step boundary, oldest first, at most `USAGE_STEP_COUNT + 1`. */
  snapshots: readonly number[];
}

interface UsageEntry {
  /** The last step boundary the series were snapshotted at, in steps since the epoch. */
  boundary: number;
  total: Series;
  output?: Series;
  input?: Series;
}

export interface UsageLedger {
  readonly entries: ReadonlyMap<string, UsageEntry>;
  /** What the views read, one per agent with a ledger. */
  readonly histories: ReadonlyMap<string, UsageHistory>;
}

export const EMPTY_USAGE_LEDGER: UsageLedger = { entries: new Map(), histories: new Map() };

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sum(...values: (number | undefined)[]): number | undefined {
  const known = values.map(finite).filter((value): value is number => value !== undefined);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : undefined;
}

/** The prompt side (input, cache reads, cache creation) and the completion side (output, reasoning) of a reading. */
function sidesOf(usage: MonitorUsageState): { input?: number; output?: number } {
  const last = usage.samples[usage.samples.length - 1];
  const input = sum(usage.inputTokens, usage.cacheReadTokens, usage.cacheCreationTokens) ?? finite(last?.inputTokens);
  const output = sum(usage.outputTokens, usage.reasoningTokens) ?? finite(last?.outputTokens);
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}

/**
 * The hold rule. A reading at or above what is shown is the new number. A
 * source falling to nothing is never followed. A lower positive reading is
 * shown only once the source has stood below the held value for the grace
 * period, so a passing excursion never reaches the screen while a real
 * correction, or a conversation starting over, shows within a step.
 */
function hold(series: Series, incoming: number | undefined, nowMs: number): Series {
  if (incoming === undefined) return series;
  const { held } = series;
  if (held === undefined || incoming >= held) return { held: incoming, snapshots: series.snapshots };
  if (incoming === 0) return { held, snapshots: series.snapshots };
  const lowerSince = series.lowerSince ?? nowMs;
  if (nowMs - lowerSince >= USAGE_CORRECTION_GRACE_MS) return { held: incoming, snapshots: series.snapshots };
  return { held, lowerSince, snapshots: series.snapshots };
}

/**
 * Snapshot the held value. The first known number is a snapshot at once, so
 * an agent's first step is what was seen since first sight. When more than
 * one boundary passed since the last snapshot (a throttled tab), the growth
 * is spread evenly over the missed steps: when it happened is unknown, and
 * one spike beside zeros would be a claim, not a reading.
 */
function snapshot(series: Series, passed: number): Series {
  if (series.held === undefined) return series;
  const last = series.snapshots[series.snapshots.length - 1];
  if (last === undefined) return { ...series, snapshots: [series.held] };
  if (passed <= 0) return series;
  // Only the last window of steps can survive, so a long absence (a
  // conversation resumed hours later) costs a bounded loop, not one per step.
  const next = [...series.snapshots];
  for (let step = Math.max(1, passed - USAGE_STEP_COUNT); step <= passed; step += 1) {
    next.push(last + ((series.held - last) * step) / passed);
  }
  return { ...series, snapshots: next.slice(-(USAGE_STEP_COUNT + 1)) };
}

/** Per-step growth, oldest first, right-aligned in the window; a correction downward is a silent step. */
function stepsOf(series: Series | undefined): number[] {
  const steps = new Array<number>(USAGE_STEP_COUNT).fill(0);
  if (!series) return steps;
  const { snapshots } = series;
  for (let index = 1; index < snapshots.length; index += 1) {
    steps[USAGE_STEP_COUNT - (snapshots.length - index)] = Math.max(0, snapshots[index]! - snapshots[index - 1]!);
  }
  return steps;
}

function historyOf(entry: UsageEntry): UsageHistory {
  const split = entry.output !== undefined || entry.input !== undefined;
  return {
    ...(entry.total.held !== undefined ? { total: entry.total.held } : {}),
    steps: stepsOf(entry.total),
    ...(split ? { sides: { output: stepsOf(entry.output), input: stepsOf(entry.input) } } : {}),
    stepMs: USAGE_STEP_MS,
  };
}

export function reconcileUsage(previous: UsageLedger, readings: readonly UsageReading[], nowMs: number): UsageLedger {
  const boundary = Math.floor(nowMs / USAGE_STEP_MS);
  const entries = new Map<string, UsageEntry>();
  const histories = new Map<string, UsageHistory>();
  for (const reading of readings) {
    if (!reading.usage) continue;
    const before = previous.entries.get(reading.id) ?? { boundary, total: { snapshots: [] } };
    const sides = sidesOf(reading.usage);
    const passed = boundary - before.boundary;
    // Read first, then snapshot: a number that arrived during a step belongs
    // to the step it closes. A side exists from the first reading that splits
    // the burn and holds its last value if a later reading does not.
    const total = snapshot(hold(before.total, finite(reading.usage.cumulativeTokens), nowMs), passed);
    const output =
      before.output === undefined && sides.output === undefined
        ? undefined
        : snapshot(hold(before.output ?? { snapshots: [] }, sides.output, nowMs), passed);
    const input =
      before.input === undefined && sides.input === undefined
        ? undefined
        : snapshot(hold(before.input ?? { snapshots: [] }, sides.input, nowMs), passed);
    const entry: UsageEntry = {
      boundary: Math.max(boundary, before.boundary),
      total,
      ...(output ? { output } : {}),
      ...(input ? { input } : {}),
    };
    entries.set(reading.id, entry);
    histories.set(reading.id, historyOf(entry));
  }
  return { entries, histories };
}

export interface UsageLedgerKey {
  /** The agent's stable monitor identity, the ledger's key. */
  id: string;
  providerId: string;
  nativeSessionId: string;
}

function seriesRecord(series: Series): UsageSeriesRecord {
  return { ...(series.held !== undefined ? { held: series.held } : {}), snapshots: [...series.snapshots] };
}

/** The ledgers worth keeping, one record per conversation that has a number to keep. */
export function exportUsage(ledger: UsageLedger, keys: readonly UsageLedgerKey[], nowMs: number): UsageLedgerRecord[] {
  const savedAt = new Date(nowMs).toISOString();
  const records: UsageLedgerRecord[] = [];
  for (const key of keys) {
    const entry = ledger.entries.get(key.id);
    if (!entry || entry.total.held === undefined) continue;
    records.push({
      providerId: key.providerId,
      nativeSessionId: key.nativeSessionId,
      savedAt,
      boundary: entry.boundary,
      total: seriesRecord(entry.total),
      ...(entry.output ? { output: seriesRecord(entry.output) } : {}),
      ...(entry.input ? { input: seriesRecord(entry.input) } : {}),
    });
  }
  return records;
}

/**
 * Give a resumed conversation the ledger it had. The saved series are
 * rebased to now: the steps since the save are silent unless the live
 * number has moved, in which case the growth is spread over them as for any
 * missed boundary, and the live number itself is read through the hold rule
 * so a partial figure from a source still catching up cannot lower what was
 * shown. A ledger that has already recorded a burn of its own is left alone:
 * by then it is the record.
 */
export function seedUsage(previous: UsageLedger, id: string, record: UsageLedgerRecord, nowMs: number): UsageLedger {
  const existing = previous.entries.get(id);
  if (existing && stepsOf(existing.total).some((step) => step > 0)) return previous;
  const boundary = Math.floor(nowMs / USAGE_STEP_MS);
  const passed = Math.max(0, boundary - record.boundary);
  const rebase = (saved: UsageSeriesRecord | undefined, live: Series | undefined): Series | undefined => {
    if (!saved && !live) return undefined;
    const base: Series = {
      ...(saved?.held !== undefined ? { held: saved.held } : {}),
      snapshots: saved?.snapshots ?? [],
    };
    return snapshot(hold(base, live?.held, nowMs), passed);
  };
  const total = rebase(record.total, existing?.total) ?? { snapshots: [] };
  const output = rebase(record.output, existing?.output);
  const input = rebase(record.input, existing?.input);
  const entry: UsageEntry = { boundary, total, ...(output ? { output } : {}), ...(input ? { input } : {}) };
  const entries = new Map(previous.entries);
  const histories = new Map(previous.histories);
  entries.set(id, entry);
  histories.set(id, historyOf(entry));
  return { entries, histories };
}
