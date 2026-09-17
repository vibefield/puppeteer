import type { MonitorUsageFamilyValue, MonitorStoredEntry } from './internal-types.js';
import { AGENT_MONITOR_COLLECTION_LIMITS } from './bounds.js';
import type { MonitorUsageAggregate, MonitorUsageSample, MonitorUsageState } from './types.js';
import { projectUsageCost } from './cost.js';

export const DEFAULT_MONITOR_BURN_RATE_WINDOW_MS = 60_000;

export interface MonitorUsageLedgerProjection {
  usage: MonitorUsageState;
  actorTotals: ReadonlyMap<string, number>;
  actorBurnRates: ReadonlyMap<string, number>;
  actorCosts: ReadonlyMap<string, ReturnType<typeof projectUsageCost>>;
  omittedSamples: number;
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

function canonicalTotals(
  entries: readonly MonitorStoredEntry[],
): Pick<
  MonitorUsageAggregate,
  | 'inputTokens'
  | 'freshInputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'reasoningTokens'
  | 'costUsd'
> {
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
      .map((entry) => finiteNonNegative((entry.value as MonitorUsageFamilyValue)[field]))
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) result[field] = values.reduce((total, value) => total + value, 0);
  }
  return result;
}

function atMs(entry: MonitorStoredEntry): number | undefined {
  const value = Date.parse(entry.rateAt ?? entry.effectiveAt ?? entry.observedAt);
  return Number.isFinite(value) ? value : undefined;
}

function sortUsageEntries(entries: readonly MonitorStoredEntry[]): MonitorStoredEntry[] {
  return [...entries].sort((a, b) => {
    const aTime = atMs(a) ?? Number.NEGATIVE_INFINITY;
    const bTime = atMs(b) ?? Number.NEGATIVE_INFINITY;
    return aTime - bTime || a.key.localeCompare(b.key) || a.storageKey.localeCompare(b.storageKey);
  });
}

function boundedSamples(samples: MonitorUsageSample[]): { samples: MonitorUsageSample[]; omitted: number } {
  const limit = AGENT_MONITOR_COLLECTION_LIMITS.usageSamples;
  const omitted = Math.max(0, samples.length - limit);
  return { samples: omitted > 0 ? samples.slice(-limit) : samples, omitted };
}

function sampleBurnRate(
  entries: readonly MonitorStoredEntry[],
  windowStart: number,
  asOfMs: number,
  windowMs: number,
): number | undefined {
  const datedSamples = entries
    .map((entry) => ({
      entry,
      time: atMs(entry),
      cumulative: finiteNonNegative((entry.value as MonitorUsageFamilyValue).cumulativeTokens),
    }))
    .filter(
      (sample): sample is { entry: MonitorStoredEntry; time: number; cumulative: number } =>
        sample.time !== undefined && sample.cumulative !== undefined && sample.time <= asOfMs,
    );
  const predecessor = [...datedSamples].reverse().find((sample) => sample.time <= windowStart);
  const inWindow = datedSamples.filter((sample) => sample.time > windowStart);
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

function aggregateActorSampleTimeline(entries: readonly MonitorStoredEntry[]): MonitorUsageSample[] {
  const latestByActor = new Map<string, number>();
  const timeline: MonitorUsageSample[] = [];
  for (const entry of entries) {
    const value = entry.value as MonitorUsageFamilyValue;
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

function projectExplicitRootActorUsage(
  entries: readonly MonitorStoredEntry[],
  windowStart: number,
  asOfMs: number,
  windowMs: number,
): MonitorUsageAggregate | undefined {
  const rootEntries = entries.filter((entry) => (entry.value as MonitorUsageFamilyValue).actor?.role === 'root');
  if (rootEntries.length === 0) return undefined;

  const contributions = rootEntries.filter((entry) => {
    const value = entry.value as MonitorUsageFamilyValue;
    return value.canonical && totalContribution(value) !== undefined;
  });
  const cumulativeEntry = rootEntries
    .filter((entry) => finiteNonNegative((entry.value as MonitorUsageFamilyValue).cumulativeTokens) !== undefined)
    .at(-1);
  const cumulativeTokens =
    contributions.length > 0
      ? contributions.reduce(
          (total, entry) => total + (totalContribution(entry.value as MonitorUsageFamilyValue) ?? 0),
          0,
        )
      : cumulativeEntry
        ? finiteNonNegative((cumulativeEntry.value as MonitorUsageFamilyValue).cumulativeTokens)
        : undefined;

  const live = contributions.filter((entry) => {
    const entryTime = atMs(entry);
    return entry.rateEligible && entryTime !== undefined && entryTime > windowStart && entryTime <= asOfMs;
  });
  let burnRatePerMin: number | undefined;
  let burnRateBoundary: MonitorUsageAggregate['burnRateBoundary'];
  if (live.length > 0) {
    burnRatePerMin = Math.max(
      0,
      live.reduce((total, entry) => total + (meterContribution(entry.value as MonitorUsageFamilyValue) ?? 0), 0) *
        (60_000 / windowMs),
    );
    burnRateBoundary = 'response';
  } else {
    const samples = rootEntries.filter((entry) => !(entry.value as MonitorUsageFamilyValue).canonical);
    burnRatePerMin = sampleBurnRate(samples, windowStart, asOfMs, windowMs);
    if (burnRatePerMin !== undefined) burnRateBoundary = 'sample';
  }

  const latest = rootEntries.at(-1);
  const { costHistory: _history, ...cost } = projectUsageCost(rootEntries, asOfMs, windowMs);
  return {
    ...(cumulativeTokens !== undefined ? { cumulativeTokens } : {}),
    ...canonicalTotals(contributions),
    ...cost,
    ...(burnRatePerMin !== undefined ? { burnRatePerMin, burnRateWindowMs: windowMs, burnRateBoundary } : {}),
    ...(latest ? { asOf: latest.observedAt } : {}),
  };
}

/**
 * Projects corrected usage entries without adding low-latency cumulative
 * samples to canonical response contributions. `asOfMs` is injected by the
 * caller; this helper never reads the wall clock.
 */
export function projectMonitorUsageLedger(
  entries: readonly MonitorStoredEntry[],
  asOfMs: number,
  windowMs = DEFAULT_MONITOR_BURN_RATE_WINDOW_MS,
): MonitorUsageLedgerProjection {
  if (!Number.isFinite(asOfMs)) throw new RangeError('monitor usage asOfMs must be finite');
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('monitor burn-rate windowMs must be a positive finite number');
  }

  const usageEntries = sortUsageEntries(entries.filter((entry) => entry.value.kind === 'usage'));
  const canonicalContributions = usageEntries.filter((entry) => {
    const value = entry.value as MonitorUsageFamilyValue;
    return value.canonical && totalContribution(value) !== undefined;
  });
  const canonicalCumulative = usageEntries.filter((entry) => {
    const value = entry.value as MonitorUsageFamilyValue;
    return value.canonical && finiteNonNegative(value.cumulativeTokens) !== undefined;
  });
  const allSamples = usageEntries.filter((entry) => {
    const value = entry.value as MonitorUsageFamilyValue;
    return !value.canonical && finiteNonNegative(value.cumulativeTokens) !== undefined;
  });
  // A provider may expose a root aggregate sample alongside per-child
  // samples. In that shape the actorless stream is already the run total;
  // mixing child samples into its timeline would make the public cumulative
  // value jump between unrelated counters. Actor projections below still use
  // every child's own stream.
  const rootSamples = allSamples.filter((entry) => !(entry.value as MonitorUsageFamilyValue).actor);
  const samples = rootSamples.length > 0 ? rootSamples : allSamples;
  const actorOnlySamples = rootSamples.length === 0 && allSamples.length > 0;

  const actorTotals = new Map<string, number>();
  const actorBurnRates = new Map<string, number>();
  const actorCosts = new Map<string, ReturnType<typeof projectUsageCost>>();
  let cumulativeTokens: number | undefined;
  let projectedSamples: MonitorUsageSample[] = [];

  if (canonicalContributions.length > 0) {
    let running = 0;
    // The sides run alongside the total once a contribution splits them, so a
    // consumer can chart prompt and completion rates separately.
    let runningInput: number | undefined;
    let runningOutput: number | undefined;
    projectedSamples = canonicalContributions.map((entry) => {
      const value = entry.value as MonitorUsageFamilyValue;
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
    const rootCumulative = canonicalCumulative.filter((entry) => !(entry.value as MonitorUsageFamilyValue).actor);
    projectedSamples =
      rootCumulative.length > 0
        ? rootCumulative.map((entry) => ({
            at: entry.effectiveAt ?? entry.observedAt,
            cumulativeTokens: finiteNonNegative((entry.value as MonitorUsageFamilyValue).cumulativeTokens) ?? 0,
          }))
        : aggregateActorSampleTimeline(canonicalCumulative);
    cumulativeTokens = projectedSamples.at(-1)?.cumulativeTokens;
  } else if (samples.length > 0) {
    projectedSamples = actorOnlySamples
      ? aggregateActorSampleTimeline(samples)
      : samples.map((entry) => ({
          at: entry.effectiveAt ?? entry.observedAt,
          cumulativeTokens: finiteNonNegative((entry.value as MonitorUsageFamilyValue).cumulativeTokens) ?? 0,
        }));
    cumulativeTokens = projectedSamples.at(-1)?.cumulativeTokens;
  }

  const windowStart = asOfMs - windowMs;
  let burnRatePerMin: number | undefined;
  let burnRateBoundary: MonitorUsageState['burnRateBoundary'];

  const liveCanonical = canonicalContributions.filter((entry) => {
    const time = atMs(entry);
    return entry.rateEligible && time !== undefined && time > windowStart && time <= asOfMs;
  });
  if (liveCanonical.length > 0) {
    const windowTokens = liveCanonical.reduce(
      (total, entry) => total + (meterContribution(entry.value as MonitorUsageFamilyValue) ?? 0),
      0,
    );
    burnRatePerMin = Math.max(0, windowTokens * (60_000 / windowMs));
    burnRateBoundary = 'response';
  } else {
    burnRatePerMin = actorOnlySamples ? undefined : sampleBurnRate(samples, windowStart, asOfMs, windowMs);
    if (burnRatePerMin !== undefined) {
      burnRateBoundary = 'sample';
    }
  }

  const byActor = new Map<string, MonitorStoredEntry[]>();
  for (const entry of usageEntries) {
    const value = entry.value as MonitorUsageFamilyValue;
    if (!value.actor) continue;
    const group = byActor.get(value.actor.runKey);
    if (group) group.push(entry);
    else byActor.set(value.actor.runKey, [entry]);
  }
  for (const [actorRunKey, actorEntries] of byActor) {
    actorCosts.set(actorRunKey, projectUsageCost(actorEntries, asOfMs, windowMs));
    const contributions = actorEntries.filter((entry) => {
      const value = entry.value as MonitorUsageFamilyValue;
      return value.canonical && totalContribution(value) !== undefined;
    });
    if (contributions.length > 0) {
      actorTotals.set(
        actorRunKey,
        contributions.reduce(
          (total, entry) => total + (totalContribution(entry.value as MonitorUsageFamilyValue) ?? 0),
          0,
        ),
      );
    } else {
      const cumulative = actorEntries
        .filter((entry) => finiteNonNegative((entry.value as MonitorUsageFamilyValue).cumulativeTokens) !== undefined)
        .at(-1);
      const total = cumulative
        ? finiteNonNegative((cumulative.value as MonitorUsageFamilyValue).cumulativeTokens)
        : undefined;
      if (total !== undefined) actorTotals.set(actorRunKey, total);
    }

    const live = contributions.filter((entry) => {
      const entryTime = atMs(entry);
      return entry.rateEligible && entryTime !== undefined && entryTime > windowStart && entryTime <= asOfMs;
    });
    if (live.length > 0) {
      actorBurnRates.set(
        actorRunKey,
        Math.max(
          0,
          live.reduce((total, entry) => total + (meterContribution(entry.value as MonitorUsageFamilyValue) ?? 0), 0) *
            (60_000 / windowMs),
        ),
      );
    } else {
      const actorSamples = actorEntries.filter((entry) => !(entry.value as MonitorUsageFamilyValue).canonical);
      const rate = sampleBurnRate(actorSamples, windowStart, asOfMs, windowMs);
      if (rate !== undefined) actorBurnRates.set(actorRunKey, rate);
    }
  }

  if (canonicalContributions.length === 0 && rootSamples.length === 0 && byActor.size > 0) {
    cumulativeTokens = [...actorTotals.values()].reduce((total, value) => total + value, 0);
    if (actorBurnRates.size > 0) {
      burnRatePerMin = [...actorBurnRates.values()].reduce((total, value) => total + value, 0);
      burnRateBoundary = 'sample';
    }
  }

  const bounded = boundedSamples(projectedSamples);
  const latestEntry = usageEntries.at(-1);
  const rootActor = projectExplicitRootActorUsage(usageEntries, windowStart, asOfMs, windowMs);
  return {
    usage: {
      ...(cumulativeTokens !== undefined ? { cumulativeTokens } : {}),
      ...canonicalTotals(canonicalContributions),
      ...projectUsageCost(usageEntries, asOfMs, windowMs),
      ...(burnRatePerMin !== undefined ? { burnRatePerMin, burnRateWindowMs: windowMs, burnRateBoundary } : {}),
      ...(rootActor ? { rootActor } : {}),
      samples: bounded.samples,
      ...(latestEntry ? { asOf: latestEntry.observedAt } : {}),
    },
    actorTotals,
    actorBurnRates,
    actorCosts,
    omittedSamples: bounded.omitted,
  };
}
