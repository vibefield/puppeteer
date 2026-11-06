import type {
  ActorRunRef,
  EvidenceCompleteness,
  MonitorUsageAggregate,
  MonitorUsageSample,
  MonitorUsageState,
} from './types.js';
import type { MonitorAccumulatorState, MonitorStoredEntry, MonitorUsageFamilyValue } from './internal-types.js';
import { AGENT_MONITOR_COLLECTION_LIMITS } from './bounds.js';
import { buildUsageCostLedger, projectUsageCost, type UsageCostLedger } from './cost.js';
import { actorOf, selectClaims } from './selection.js';

// The usage ledger's derived index. RFC 008 keeps every live observation for the run, so what the clock does not
// change is computed once per ledger: one claim per usage identity, the ledger order, running totals, the sample
// timeline, actor groups and their totals, the family's evidence. It is memoized on the immutable
// `state.usage.entries`, which only a usage update replaces, and a projection answers the clock-dependent parts
// (burn rates, USD per minute, cost buckets) by binary search. It is never a second ledger: it holds nothing the
// slice does not, and a new slice gets a new index.

export interface MonitorUsageLedgerProjection {
  usage: MonitorUsageState;
  actorTotals: ReadonlyMap<string, number>;
  actorBurnRates: ReadonlyMap<string, number>;
  actorCosts: ReadonlyMap<string, ReturnType<typeof projectUsageCost>>;
  omittedSamples: number;
}

type CanonicalTotals = Pick<
  MonitorUsageAggregate,
  | 'inputTokens'
  | 'freshInputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'reasoningTokens'
  | 'costUsd'
>;

/** A usage observation with its ledger time. */
interface Timed {
  entry: MonitorStoredEntry;
  value: MonitorUsageFamilyValue;
  time: number;
}

interface DatedSample {
  entry: MonitorStoredEntry;
  time: number;
  cumulative: number;
}

/** What a stream's burn rate and cost read by time: its contributions, its dated samples, its cost ledger. */
interface UsageStream {
  contributions: Timed[];
  contributionTimes: number[];
  samples: DatedSample[];
  sampleTimes: number[];
  cost: UsageCostLedger;
}

interface RootActorUsage {
  stream: UsageStream;
  cumulativeTokens: number | undefined;
  totals: CanonicalTotals;
  latest: MonitorStoredEntry | undefined;
}

export interface CompletenessCount {
  count: number;
  complete: number;
  unavailable: number;
}

/** What a family's support and availability read from its selected claims, counted once. */
export interface MonitorFamilyEvidence {
  all: CompletenessCount;
  /** The semantic plane's claims, by producer id. */
  semantic: ReadonlyMap<string, CompletenessCount>;
  /** The runtime and workspace planes' claims. */
  other: CompletenessCount;
  /** The latest valid `observedAt`, the first of equals in claim order. */
  latestObservedAt: string | undefined;
}

export interface MonitorUsageIndex {
  cumulativeTokens: number | undefined;
  totals: CanonicalTotals;
  run: UsageStream;
  /** Only child sample streams: the run has no sample rate of its own. */
  actorOnlySamples: boolean;
  /** No canonical contribution and no root sample: the run's total and rate are its actors' sums. */
  actorAggregate: boolean;
  /** Every attributed stream, by actor run key, in the order the ledger first names it. */
  actors: ReadonlyMap<string, UsageStream>;
  actorTotals: ReadonlyMap<string, number>;
  rootActor: RootActorUsage | undefined;
  samples: MonitorUsageSample[];
  omittedSamples: number;
  latest: MonitorStoredEntry | undefined;
  /** The proven children the claims name, each by its first claim in claim order: the subagents usage adds. */
  childActors: ReadonlyMap<string, ActorRunRef>;
  /** The usage family's evidence, for its freshness. */
  evidence: MonitorFamilyEvidence;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function totalContribution(value: MonitorUsageFamilyValue): number | undefined {
  const total = finiteNonNegative(value.totalTokens);
  if (total !== undefined) return total;
  const delta = finiteNonNegative(value.deltaTokens);
  if (delta !== undefined) return delta;

  const buckets = [
    finiteNonNegative(value.inputTokens),
    finiteNonNegative(value.outputTokens),
    finiteNonNegative(value.cacheReadTokens),
    finiteNonNegative(value.cacheCreationTokens),
    finiteNonNegative(value.reasoningTokens),
  ];
  const known = buckets.filter((bucket): bucket is number => bucket !== undefined);
  return known.length > 0 ? known.reduce((total, bucket) => total + bucket, 0) : undefined;
}

function meterContribution(value: MonitorUsageFamilyValue): number | undefined {
  return finiteNonNegative(value.meterTokens) ?? totalContribution(value);
}

/** The prompt side of a contribution: input, cache reads, and cache creation. */
function inputSide(value: MonitorUsageFamilyValue): number | undefined {
  const buckets = [
    finiteNonNegative(value.inputTokens),
    finiteNonNegative(value.cacheReadTokens),
    finiteNonNegative(value.cacheCreationTokens),
  ].filter((bucket): bucket is number => bucket !== undefined);
  return buckets.length > 0 ? buckets.reduce((total, bucket) => total + bucket, 0) : undefined;
}

/** The completion side of a contribution: output and reasoning. */
function outputSide(value: MonitorUsageFamilyValue): number | undefined {
  const buckets = [finiteNonNegative(value.outputTokens), finiteNonNegative(value.reasoningTokens)].filter(
    (bucket): bucket is number => bucket !== undefined,
  );
  return buckets.length > 0 ? buckets.reduce((total, bucket) => total + bucket, 0) : undefined;
}

function canonicalTotals(entries: readonly Timed[]): CanonicalTotals {
  const fields = [
    'inputTokens',
    'freshInputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'reasoningTokens',
    'costUsd',
  ] as const;
  const result: Partial<Record<(typeof fields)[number], number>> = {};
  for (const field of fields) {
    const values = entries
      .map(({ value }) => finiteNonNegative(value[field]))
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) result[field] = values.reduce((total, value) => total + value, 0);
  }
  return result;
}

/** The reducer's `timeMs`, or the same rule for an entry built elsewhere. */
function timeOf(entry: MonitorStoredEntry): number {
  if (entry.timeMs !== undefined) return entry.timeMs;
  const value = Date.parse(entry.rateAt ?? entry.effectiveAt ?? entry.observedAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Ascending time; an untimed observation first; ties by key, then storage key (`localeCompare`, as ever). */
function ledgerOrder(entries: readonly MonitorStoredEntry[]): Timed[] {
  return entries
    .map((entry) => ({ entry, value: entry.value as MonitorUsageFamilyValue, time: timeOf(entry) }))
    .sort(
      (a, b) =>
        a.time - b.time ||
        a.entry.key.localeCompare(b.entry.key) ||
        a.entry.storageKey.localeCompare(b.entry.storageKey),
    );
}

function boundedSamples(samples: MonitorUsageSample[]): { samples: MonitorUsageSample[]; omitted: number } {
  const limit = AGENT_MONITOR_COLLECTION_LIMITS.usageSamples;
  const omitted = Math.max(0, samples.length - limit);
  return { samples: omitted > 0 ? samples.slice(-limit) : samples, omitted };
}

function aggregateActorSampleTimeline(entries: readonly Timed[]): MonitorUsageSample[] {
  const latestByActor = new Map<string, number>();
  const timeline: MonitorUsageSample[] = [];
  for (const { entry, value } of entries) {
    const actorRunKey = value.actor?.runKey;
    const cumulative = finiteNonNegative(value.cumulativeTokens);
    if (!actorRunKey || cumulative === undefined) continue;
    latestByActor.set(actorRunKey, cumulative);
    timeline.push({
      at: entry.effectiveAt ?? entry.observedAt,
      cumulativeTokens: [...latestByActor.values()].reduce((total, current) => total + current, 0),
    });
  }
  return timeline;
}

/** `contributions` feed the response rate, `sampled` the sample rate (once dated), `costed` the cost. */
function stream(contributions: Timed[], sampled: readonly Timed[], costed: readonly Timed[]): UsageStream {
  const samples: DatedSample[] = [];
  for (const { entry, value, time } of sampled) {
    const cumulative = finiteNonNegative(value.cumulativeTokens);
    if (Number.isFinite(time) && cumulative !== undefined) samples.push({ entry, time, cumulative });
  }
  return {
    contributions,
    contributionTimes: contributions.map(({ time }) => time),
    samples,
    sampleTimes: samples.map(({ time }) => time),
    cost: buildUsageCostLedger(costed),
  };
}

function rootActorUsage(rootEntries: readonly Timed[]): RootActorUsage {
  const contributions = rootEntries.filter(({ value }) => value.canonical && totalContribution(value) !== undefined);
  const cumulativeEntry = rootEntries
    .filter(({ value }) => finiteNonNegative(value.cumulativeTokens) !== undefined)
    .at(-1);
  return {
    stream: stream(contributions, rootEntries.filter(({ value }) => !value.canonical), rootEntries),
    cumulativeTokens:
      contributions.length > 0
        ? contributions.reduce((total, { value }) => total + (totalContribution(value) ?? 0), 0)
        : cumulativeEntry
          ? finiteNonNegative(cumulativeEntry.value.cumulativeTokens)
          : undefined,
    totals: canonicalTotals(contributions),
    latest: rootEntries.at(-1)?.entry,
  };
}

function counted(): CompletenessCount {
  return { count: 0, complete: 0, unavailable: 0 };
}

function tally(count: CompletenessCount, completeness: EvidenceCompleteness): void {
  count.count += 1;
  if (completeness === 'complete') count.complete += 1;
  else if (completeness === 'unavailable') count.unavailable += 1;
}

/** How many completeness values there are, how many say complete, and how many say unavailable. */
export function countCompleteness(values: Iterable<EvidenceCompleteness>): CompletenessCount {
  const count = counted();
  for (const value of values) tally(count, value);
  return count;
}

/** The counts of every value several counts saw. */
export function sumCompleteness(counts: Iterable<CompletenessCount>): CompletenessCount {
  const sum = counted();
  for (const count of counts) {
    sum.count += count.count;
    sum.complete += count.complete;
    sum.unavailable += count.unavailable;
  }
  return sum;
}

/** Counts one family's selected claims for its support and availability: the usage index's, and every other's. */
export function summarizeFamilyEvidence(entries: readonly MonitorStoredEntry[]): MonitorFamilyEvidence {
  const all = counted();
  const other = counted();
  const semantic = new Map<string, CompletenessCount>();
  let latestObservedAt: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    tally(all, entry.completeness);
    if (entry.plane === 'semantic') {
      let owner = semantic.get(entry.ownerId);
      if (!owner) {
        owner = counted();
        semantic.set(entry.ownerId, owner);
      }
      tally(owner, entry.completeness);
    } else {
      tally(other, entry.completeness);
    }
    const observedMs = Date.parse(entry.observedAt);
    if (Number.isFinite(observedMs) && (latestObservedAt === undefined || observedMs > latestMs)) {
      latestObservedAt = entry.observedAt;
      latestMs = observedMs;
    }
  }
  return { all, semantic, other, latestObservedAt };
}

/** The proven children the claims name, as the projection's own child rule reads them. */
function childActorsOf(entries: readonly MonitorStoredEntry[]): Map<string, ActorRunRef> {
  const actors = new Map<string, ActorRunRef>();
  for (const entry of entries) {
    const actor = actorOf(entry.value);
    // Attribution groups and unjoined status tasks are not proven child identities.
    if (!actor || actor.role !== 'child' || !actor.nativeAgentId || actors.has(actor.runKey)) continue;
    actors.set(actor.runKey, actor);
  }
  return actors;
}

/**
 * Indexes corrected usage entries without adding low-latency cumulative samples to canonical response
 * contributions. `entries` are taken as given, as `projectMonitorUsageLedger` always took them; a state's index
 * selects one claim per usage identity first (`usageIndexOf`).
 */
export function buildUsageIndex(entries: readonly MonitorStoredEntry[]): MonitorUsageIndex {
  const usageEntries = ledgerOrder(entries.filter((entry) => entry.value.kind === 'usage'));
  const canonicalContributions = usageEntries.filter(
    ({ value }) => value.canonical && totalContribution(value) !== undefined,
  );
  const canonicalCumulative = usageEntries.filter(
    ({ value }) => value.canonical && finiteNonNegative(value.cumulativeTokens) !== undefined,
  );
  const allSamples = usageEntries.filter(
    ({ value }) => !value.canonical && finiteNonNegative(value.cumulativeTokens) !== undefined,
  );
  // A provider may expose a root aggregate sample alongside per-child
  // samples. In that shape the actorless stream is already the run total;
  // mixing child samples into its timeline would make the public cumulative
  // value jump between unrelated counters. Actor projections below still use
  // every child's own stream.
  const rootSamples = allSamples.filter(({ value }) => !value.actor);
  const samples = rootSamples.length > 0 ? rootSamples : allSamples;
  const actorOnlySamples = rootSamples.length === 0 && allSamples.length > 0;

  const actorTotals = new Map<string, number>();
  let cumulativeTokens: number | undefined;
  let projectedSamples: MonitorUsageSample[] = [];

  if (canonicalContributions.length > 0) {
    let running = 0;
    // The sides run alongside the total once a contribution splits them, so a
    // consumer can chart prompt and completion rates separately.
    let runningInput: number | undefined;
    let runningOutput: number | undefined;
    projectedSamples = canonicalContributions.map(({ entry, value }) => {
      const amount = totalContribution(value) ?? 0;
      running += amount;
      const input = inputSide(value);
      const output = outputSide(value);
      if (input !== undefined) runningInput = (runningInput ?? 0) + input;
      if (output !== undefined) runningOutput = (runningOutput ?? 0) + output;
      if (value.actor) actorTotals.set(value.actor.runKey, (actorTotals.get(value.actor.runKey) ?? 0) + amount);
      return {
        at: entry.effectiveAt ?? entry.observedAt,
        cumulativeTokens: running,
        ...(runningInput !== undefined ? { inputTokens: runningInput } : {}),
        ...(runningOutput !== undefined ? { outputTokens: runningOutput } : {}),
      };
    });
    cumulativeTokens = running;
  } else if (canonicalCumulative.length > 0) {
    const rootCumulative = canonicalCumulative.filter(({ value }) => !value.actor);
    projectedSamples =
      rootCumulative.length > 0
        ? rootCumulative.map(({ entry, value }) => ({
            at: entry.effectiveAt ?? entry.observedAt,
            cumulativeTokens: finiteNonNegative(value.cumulativeTokens) ?? 0,
          }))
        : aggregateActorSampleTimeline(canonicalCumulative);
    cumulativeTokens = projectedSamples.at(-1)?.cumulativeTokens;
  } else if (samples.length > 0) {
    projectedSamples = actorOnlySamples
      ? aggregateActorSampleTimeline(samples)
      : samples.map(({ entry, value }) => ({
          at: entry.effectiveAt ?? entry.observedAt,
          cumulativeTokens: finiteNonNegative(value.cumulativeTokens) ?? 0,
        }));
    cumulativeTokens = projectedSamples.at(-1)?.cumulativeTokens;
  }

  const byActor = new Map<string, Timed[]>();
  for (const timed of usageEntries) {
    if (!timed.value.actor) continue;
    const group = byActor.get(timed.value.actor.runKey);
    if (group) group.push(timed);
    else byActor.set(timed.value.actor.runKey, [timed]);
  }
  const actors = new Map<string, UsageStream>();
  for (const [actorRunKey, actorEntries] of byActor) {
    const contributions = actorEntries.filter(({ value }) => value.canonical && totalContribution(value) !== undefined);
    if (contributions.length > 0) {
      actorTotals.set(
        actorRunKey,
        contributions.reduce((total, { value }) => total + (totalContribution(value) ?? 0), 0),
      );
    } else {
      const cumulative = actorEntries
        .filter(({ value }) => finiteNonNegative(value.cumulativeTokens) !== undefined)
        .at(-1);
      const total = cumulative ? finiteNonNegative(cumulative.value.cumulativeTokens) : undefined;
      if (total !== undefined) actorTotals.set(actorRunKey, total);
    }
    actors.set(actorRunKey, stream(contributions, actorEntries.filter(({ value }) => !value.canonical), actorEntries));
  }

  const actorAggregate = canonicalContributions.length === 0 && rootSamples.length === 0 && byActor.size > 0;
  if (actorAggregate) cumulativeTokens = [...actorTotals.values()].reduce((total, value) => total + value, 0);

  const bounded = boundedSamples(projectedSamples);
  const rootEntries = usageEntries.filter(({ value }) => value.actor?.role === 'root');
  return {
    cumulativeTokens,
    totals: canonicalTotals(canonicalContributions),
    run: stream(canonicalContributions, samples, usageEntries),
    actorOnlySamples,
    actorAggregate,
    actors,
    actorTotals,
    rootActor: rootEntries.length > 0 ? rootActorUsage(rootEntries) : undefined,
    samples: bounded.samples,
    omittedSamples: bounded.omitted,
    latest: usageEntries.at(-1)?.entry,
    childActors: childActorsOf(entries),
    evidence: summarizeFamilyEvidence(entries.filter((entry) => entry.family === 'usage')),
  };
}

/** The first index whose time is above `bound`, in ascending times. */
function firstAbove(times: readonly number[], bound: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! > bound) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The meter tokens of the rate-eligible contributions inside the window; undefined when there are none. */
function responseRate(usage: UsageStream, windowStart: number, asOfMs: number, windowMs: number): number | undefined {
  let live = 0;
  let windowTokens = 0;
  const end = firstAbove(usage.contributionTimes, asOfMs);
  for (let index = firstAbove(usage.contributionTimes, windowStart); index < end; index++) {
    const { entry, value } = usage.contributions[index]!;
    if (!entry.rateEligible) continue;
    live += 1;
    windowTokens += meterContribution(value) ?? 0;
  }
  return live > 0 ? Math.max(0, windowTokens * (60_000 / windowMs)) : undefined;
}

/** The positive counter movement across the window, from the last sample before it, per minute of samples. */
function sampleRate(usage: UsageStream, windowStart: number, asOfMs: number, windowMs: number): number | undefined {
  const start = firstAbove(usage.sampleTimes, windowStart);
  const predecessor = start > 0 ? usage.samples[start - 1] : undefined;
  const inWindow = usage.samples.slice(start, firstAbove(usage.sampleTimes, asOfMs));
  const rateSamples = predecessor ? [predecessor, ...inWindow] : inWindow;
  if (rateSamples.length < 2 || !rateSamples.slice(1).some((sample) => sample.entry.rateEligible)) return undefined;

  let positiveDelta = 0;
  for (let index = 1; index < rateSamples.length; index += 1) {
    const previous = rateSamples[index - 1];
    const current = rateSamples[index];
    if (!previous || !current || !current.entry.rateEligible) continue;
    positiveDelta += Math.max(0, current.cumulative - previous.cumulative);
  }
  const elapsedMs = Math.min(windowMs, Math.max(1, rateSamples.at(-1)!.time - rateSamples[0]!.time));
  return Math.max(0, positiveDelta * (60_000 / elapsedMs));
}

function projectRootActor(
  root: RootActorUsage,
  windowStart: number,
  asOfMs: number,
  windowMs: number,
): MonitorUsageAggregate {
  let burnRatePerMin = responseRate(root.stream, windowStart, asOfMs, windowMs);
  let burnRateBoundary: MonitorUsageAggregate['burnRateBoundary'];
  if (burnRatePerMin !== undefined) {
    burnRateBoundary = 'response';
  } else {
    burnRatePerMin = sampleRate(root.stream, windowStart, asOfMs, windowMs);
    if (burnRatePerMin !== undefined) burnRateBoundary = 'sample';
  }
  const { costHistory: _history, ...cost } = projectUsageCost(root.stream.cost, asOfMs, windowMs);
  return {
    ...(root.cumulativeTokens !== undefined ? { cumulativeTokens: root.cumulativeTokens } : {}),
    ...root.totals,
    ...cost,
    ...(burnRatePerMin !== undefined ? { burnRatePerMin, burnRateWindowMs: windowMs, burnRateBoundary } : {}),
    ...(root.latest ? { asOf: root.latest.observedAt } : {}),
  };
}

/** The clock-dependent part of the ledger at `asOfMs`. This helper never reads the wall clock. */
export function queryUsageIndex(
  index: MonitorUsageIndex,
  asOfMs: number,
  windowMs: number,
): MonitorUsageLedgerProjection {
  if (!Number.isFinite(asOfMs)) throw new RangeError('monitor usage asOfMs must be finite');
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('monitor burn-rate windowMs must be a positive finite number');
  }

  const windowStart = asOfMs - windowMs;
  let burnRatePerMin = responseRate(index.run, windowStart, asOfMs, windowMs);
  let burnRateBoundary: MonitorUsageState['burnRateBoundary'];
  if (burnRatePerMin !== undefined) {
    burnRateBoundary = 'response';
  } else {
    burnRatePerMin = index.actorOnlySamples ? undefined : sampleRate(index.run, windowStart, asOfMs, windowMs);
    if (burnRatePerMin !== undefined) burnRateBoundary = 'sample';
  }

  const actorBurnRates = new Map<string, number>();
  const actorCosts = new Map<string, ReturnType<typeof projectUsageCost>>();
  for (const [actorRunKey, actor] of index.actors) {
    actorCosts.set(actorRunKey, projectUsageCost(actor.cost, asOfMs, windowMs));
    const rate = responseRate(actor, windowStart, asOfMs, windowMs) ?? sampleRate(actor, windowStart, asOfMs, windowMs);
    if (rate !== undefined) actorBurnRates.set(actorRunKey, rate);
  }

  if (index.actorAggregate && actorBurnRates.size > 0) {
    burnRatePerMin = [...actorBurnRates.values()].reduce((total, value) => total + value, 0);
    burnRateBoundary = 'sample';
  }

  const rootActor = index.rootActor ? projectRootActor(index.rootActor, windowStart, asOfMs, windowMs) : undefined;
  return {
    usage: {
      ...(index.cumulativeTokens !== undefined ? { cumulativeTokens: index.cumulativeTokens } : {}),
      ...index.totals,
      ...projectUsageCost(index.run.cost, asOfMs, windowMs),
      ...(burnRatePerMin !== undefined ? { burnRatePerMin, burnRateWindowMs: windowMs, burnRateBoundary } : {}),
      ...(rootActor ? { rootActor } : {}),
      samples: [...index.samples],
      ...(index.latest ? { asOf: index.latest.observedAt } : {}),
    },
    actorTotals: index.actorTotals,
    actorBurnRates,
    actorCosts,
    omittedSamples: index.omittedSamples,
  };
}

const indexes = new WeakMap<ReadonlyMap<string, MonitorStoredEntry>, MonitorUsageIndex>();

/** The ledger in plane order (runtime, semantic, workspace), so each identity's claims rank as the planes list them. */
function inPlaneOrder(ledger: ReadonlyMap<string, MonitorStoredEntry>): MonitorStoredEntry[] {
  const runtime: MonitorStoredEntry[] = [];
  const semantic: MonitorStoredEntry[] = [];
  const workspace: MonitorStoredEntry[] = [];
  for (const entry of ledger.values()) {
    if (entry.plane === 'runtime') runtime.push(entry);
    else if (entry.plane === 'semantic') semantic.push(entry);
    else workspace.push(entry);
  }
  return [...runtime, ...semantic, ...workspace];
}

/** The state's usage index, built once per ledger: a non-usage input keeps the ledger, and with it the index. */
export function usageIndexOf(state: MonitorAccumulatorState): MonitorUsageIndex {
  let index = indexes.get(state.usage.entries);
  if (!index) {
    index = buildUsageIndex(selectClaims(inPlaneOrder(state.usage.entries)));
    indexes.set(state.usage.entries, index);
  }
  return index;
}

const rateTimes = new WeakMap<ReadonlyMap<string, MonitorStoredEntry>, number[]>();

/**
 * When the burn rate next moves without new evidence: the first stored rate-eligible claim whose window still ends
 * after `nowMs`, at its time plus the window and one millisecond; undefined when none is left. Every stored claim
 * counts, selected or not, as the runtime's scan counted them; their times are sorted once per ledger.
 */
export function nextUsageRateBoundaryMs(
  state: MonitorAccumulatorState,
  nowMs: number,
  windowMs: number,
): number | undefined {
  let times = rateTimes.get(state.usage.entries);
  if (!times) {
    times = [...state.usage.entries.values()]
      .filter((entry) => entry.rateEligible)
      .map(timeOf)
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b);
    rateTimes.set(state.usage.entries, times);
  }
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (times[middle]! + windowMs + 1 > nowMs) high = middle;
    else low = middle + 1;
  }
  return low < times.length ? times[low]! + windowMs + 1 : undefined;
}
