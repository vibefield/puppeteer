import type { AccountUsageMetric } from '@vibecook/puppeteer-core';
import type { AccountUsageEntry } from '../protocol.js';

export type AccountUsageViewState = 'available' | 'rate-limited' | 'unauthenticated' | 'unsupported' | 'unavailable';

export interface AccountUsageMetricView {
  key: string;
  label: string;
  usedPercent: number;
  value: string;
  resetLabel?: string;
  title: string;
}

export interface AccountUsageView {
  providerId: string;
  label: string;
  state: AccountUsageViewState;
  metrics: readonly AccountUsageMetricView[];
  statusText?: string;
  badgeText?: string;
  badgeTitle?: string;
}

function progressPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function formatUsageReset(resetsAt: string | undefined, nowMs: number): string | undefined {
  if (!resetsAt) return undefined;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return undefined;
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return 'NOW';
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  if (hours < 24) return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  if (days < 7) return hourRemainder ? `${days}d ${hourRemainder}h` : `${days}d`;
  return new Date(resetMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
}

function metricView(metric: AccountUsageMetric, nowMs: number): AccountUsageMetricView {
  const resetLabel = formatUsageReset(metric.resetsAt, nowMs);
  const used = metric.usedPercent;
  return {
    key: metric.id,
    label: metric.label,
    usedPercent: progressPercent(used),
    value: `${Math.round(used)}%`,
    ...(resetLabel ? { resetLabel } : {}),
    title: `${metric.description ?? metric.label}: ${used.toFixed(1)}% used${resetLabel ? `, resets in ${resetLabel}` : ''}`,
  };
}

export function accountUsageView(entry: AccountUsageEntry, nowMs: number): AccountUsageView {
  const providerId = entry.provider.id;
  const label = entry.provider.label.toUpperCase();
  if (entry.result.status === 'available') {
    const metrics = entry.result.snapshot.metrics.slice(0, 3).map((metric) => metricView(metric, nowMs));
    const failure = entry.refreshFailure;
    const rateLimited = failure?.code === 'rate-limited';
    const retryLabel = formatUsageReset(failure?.retryAt, nowMs);
    return {
      providerId,
      label,
      state: rateLimited ? 'rate-limited' : 'available',
      metrics,
      ...(rateLimited
        ? {
            badgeText: 'RATE LIMITED',
            badgeTitle: retryLabel ? `Retrying in ${retryLabel}` : 'Waiting to retry',
          }
        : {}),
      ...(metrics.length === 0 ? { statusText: 'NO LIMIT DATA' } : {}),
    };
  }

  const rateLimited = entry.result.code === 'rate-limited';
  const retryLabel = formatUsageReset(entry.result.retryAt, nowMs);
  const statusText =
    entry.result.status === 'unauthenticated'
      ? 'SIGN IN REQUIRED'
      : entry.result.status === 'unsupported'
        ? 'NOT EXPOSED'
        : rateLimited
          ? `RATE LIMITED${retryLabel ? ` · ${retryLabel}` : ''}`
          : 'RETRYING';
  return {
    providerId,
    label,
    state: rateLimited ? 'rate-limited' : entry.result.status,
    metrics: [],
    statusText,
  };
}
