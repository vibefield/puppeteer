import type { MonitorFamilyAvailability, MonitorFamilyFreshness, MonitorFamilySupport } from './types.js';

export type MonitorRecency = 'fresh' | 'stale' | 'unknown';

export interface MonitorFreshnessPolicy {
  staleAfterMs: number;
}

/** Initial shared app policy; callers pass an explicit clock to classification. */
export const DEFAULT_MONITOR_FRESHNESS_POLICY: Readonly<MonitorFreshnessPolicy> = Object.freeze({
  staleAfterMs: 30_000,
});

export interface MonitorRecencyResult {
  recency: MonitorRecency;
  ageMs?: number;
}

export interface MonitorFamilyFreshnessResult extends MonitorRecencyResult {
  support: MonitorFamilySupport | 'unknown';
  availability: MonitorFamilyAvailability | 'unknown';
  reason?: string;
}

function validatePolicy(policy: MonitorFreshnessPolicy): void {
  if (!Number.isFinite(policy.staleAfterMs) || policy.staleAfterMs < 0) {
    throw new RangeError('monitor freshness staleAfterMs must be a non-negative finite number');
  }
}

/** Pure recency classification; renderer wall-clock reads stay outside core. */
export function classifyMonitorRecency(
  asOf: string | undefined,
  nowMs: number,
  policy: MonitorFreshnessPolicy = DEFAULT_MONITOR_FRESHNESS_POLICY,
): MonitorRecencyResult {
  validatePolicy(policy);
  if (!Number.isFinite(nowMs) || asOf === undefined) return { recency: 'unknown' };
  const observedMs = Date.parse(asOf);
  if (!Number.isFinite(observedMs)) return { recency: 'unknown' };
  const ageMs = Math.max(0, nowMs - observedMs);
  return { recency: ageMs > policy.staleAfterMs ? 'stale' : 'fresh', ageMs };
}

/** Keeps support and recency orthogonal instead of manufacturing a fourth agent status. */
export function classifyMonitorFamilyFreshness(
  family: MonitorFamilyFreshness | undefined,
  nowMs: number,
  policy: MonitorFreshnessPolicy = DEFAULT_MONITOR_FRESHNESS_POLICY,
): MonitorFamilyFreshnessResult {
  validatePolicy(policy);
  if (family === undefined) return { support: 'unknown', availability: 'unknown', recency: 'unknown' };
  const availability =
    family.availability ??
    (family.support === 'unsupported' ? 'unavailable' : family.asOf === undefined ? 'unavailable' : 'available');
  if (family.support === 'unsupported') {
    return {
      support: 'unsupported',
      availability,
      recency: 'unknown',
      ...(family.reason ? { reason: family.reason } : {}),
    };
  }
  return {
    support: family.support,
    availability,
    ...classifyMonitorRecency(family.asOf, nowMs, policy),
    ...(family.reason ? { reason: family.reason } : {}),
  };
}
