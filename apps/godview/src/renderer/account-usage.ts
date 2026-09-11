import type { AccountUsageMetric } from '@vibecook/puppeteer-core';
import type { AccountUsageBatch, AccountUsageEntry } from '../protocol.js';

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
  /** Stable per row: one provider can hold several accounts. */
  key: string;
  providerId: string;
  label: string;
  /** Named only when the provider holds more than one account. */
  accountLabel?: string;
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

export function accountUsageView(
  entry: AccountUsageEntry,
  nowMs: number,
  options: { showAccount?: boolean } = {},
): AccountUsageView {
  const providerId = entry.provider.id;
  const label = entry.provider.label.toUpperCase();
  const key = entry.profileId ? `${providerId}:${entry.profileId}` : providerId;
  const accountLabel =
    options.showAccount && entry.profileLabel ? { accountLabel: entry.profileLabel.toUpperCase() } : {};
  if (entry.result.status === 'available') {
    const metrics = entry.result.snapshot.metrics.slice(0, 3).map((metric) => metricView(metric, nowMs));
    const failure = entry.refreshFailure;
    const rateLimited = failure?.code === 'rate-limited';
    const retryLabel = formatUsageReset(failure?.retryAt, nowMs);
    return {
      key,
      providerId,
      label,
      ...accountLabel,
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
    key,
    providerId,
    label,
    ...accountLabel,
    state: rateLimited ? 'rate-limited' : entry.result.status,
    metrics: [],
    statusText,
  };
}

/**
 * One row per reading. An account is named only where a provider holds more
 * than one, so the common single-account case stays as quiet as it was.
 */
export function accountUsageViews(batch: AccountUsageBatch | undefined, nowMs: number): AccountUsageView[] {
  const entries = batch?.entries ?? [];
  const perProvider = new Map<string, number>();
  for (const entry of entries) perProvider.set(entry.provider.id, (perProvider.get(entry.provider.id) ?? 0) + 1);
  return entries.map((entry) =>
    accountUsageView(entry, nowMs, { showAccount: (perProvider.get(entry.provider.id) ?? 0) > 1 }),
  );
}

// ── The usage column (record §05) ──────────────────────────────────────────
//
// Each account is its mark inside its rings, one ring per usage window in a
// fixed slot, the tightest figure beneath; the popup lists every window. The
// column consumes the same batch the panel did; nothing here reads a terminal.

/** Inner is the short window, middle the week, outer anything else the provider reports. */
export type UsageRingSlot = 0 | 1 | 2;

export type UsageTileState =
  'available' | 'rate-limited' | 'unauthenticated' | 'unsupported' | 'no-data' | 'unavailable';

export interface UsageWindowView {
  key: string;
  label: string;
  slot: UsageRingSlot;
  /** Clamped to the ring; the figure keeps the true value. */
  usedPercent: number;
  value: string;
  resetLabel?: string;
  hot: boolean;
  title: string;
}

export interface UsageTile {
  key: string;
  providerId: string;
  label: string;
  /** Named only when the provider holds more than one account. */
  accountLabel?: string;
  state: UsageTileState;
  /** Rate limited, or the tightest window at or past the attention line. */
  hot: boolean;
  /** One ring per occupied slot; the outer slot takes the tightest of the extras. */
  rings: readonly UsageWindowView[];
  /** Every window in the adapter's order, for the popup. */
  windows: readonly UsageWindowView[];
  figure: string;
  /** The unmeasured states set their figure small and faint. */
  figureFaint: boolean;
  stateText: string;
  /** One sentence for the unmeasured states, in place of rows. */
  note?: string;
  foot: { lead: string; strong?: string; count?: string };
  aria: string;
}

/** A ring turns orange here, and the figure with it. */
export const USAGE_HOT_PERCENT = 80;

const RING_SLOT_BY_LABEL: Record<string, UsageRingSlot> = { '5H': 0, '7D': 1 };

export function usageRingSlot(label: string): UsageRingSlot {
  return RING_SLOT_BY_LABEL[label.toUpperCase()] ?? 2;
}

export function formatUsageAge(at: string | undefined, nowMs: number): string | undefined {
  if (!at) return undefined;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return undefined;
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds}s AGO`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h AGO`;
  return `${Math.floor(hours / 24)}d AGO`;
}

function windowView(metric: AccountUsageMetric, nowMs: number, rateLimited: boolean): UsageWindowView {
  const base = metricView(metric, nowMs);
  return {
    ...base,
    slot: usageRingSlot(metric.label),
    hot: rateLimited || metric.usedPercent >= USAGE_HOT_PERCENT,
  };
}

const STATE_ORDER: Record<UsageTileState, number> = {
  'rate-limited': 0,
  available: 1,
  unauthenticated: 2,
  unsupported: 3,
  'no-data': 4,
  unavailable: 5,
};

function tightest(windows: readonly UsageWindowView[]): UsageWindowView | undefined {
  return windows.reduce<UsageWindowView | undefined>(
    (best, window) => (!best || window.usedPercent > best.usedPercent ? window : best),
    undefined,
  );
}

function ringsOf(windows: readonly UsageWindowView[]): UsageWindowView[] {
  const bySlot = new Map<UsageRingSlot, UsageWindowView>();
  for (const window of windows) {
    const held = bySlot.get(window.slot);
    if (!held || window.usedPercent > held.usedPercent) bySlot.set(window.slot, window);
  }
  return [...bySlot.values()].sort((left, right) => left.slot - right.slot);
}

function windowCount(count: number): string {
  return `${count} WINDOW${count === 1 ? '' : 'S'}`;
}

export function usageTile(
  entry: AccountUsageEntry,
  nowMs: number,
  batchRefreshedAt: string | undefined,
  options: { showAccount?: boolean } = {},
): UsageTile {
  const providerId = entry.provider.id;
  const label = entry.provider.label.toUpperCase();
  const key = entry.profileId ? `${providerId}:${entry.profileId}` : providerId;
  const accountLabel =
    options.showAccount && entry.profileLabel ? { accountLabel: entry.profileLabel.toUpperCase() } : {};
  const name = accountLabel.accountLabel ? `${label} ${accountLabel.accountLabel}` : label;

  if (entry.result.status === 'available') {
    const rateLimited = entry.refreshFailure?.code === 'rate-limited';
    const windows = entry.result.snapshot.metrics.map((metric) => windowView(metric, nowMs, rateLimited));
    const top = tightest(windows);
    const retryLabel = formatUsageReset(entry.refreshFailure?.retryAt, nowMs);
    const age = formatUsageAge(entry.result.snapshot.fetchedAt, nowMs);
    if (windows.length === 0) {
      return {
        key,
        providerId,
        label,
        ...accountLabel,
        state: 'no-data',
        hot: false,
        rings: [],
        windows: [],
        figure: 'NO DATA',
        figureFaint: true,
        stateText: 'NO LIMIT DATA',
        note: 'Authenticated, but the provider has returned no windows yet.',
        foot: { lead: 'CHECKED', ...(age ? { strong: age } : {}) },
        aria: `${name}, no limit data`,
      };
    }
    const hot = rateLimited || (top?.hot ?? false);
    return {
      key,
      providerId,
      label,
      ...accountLabel,
      state: rateLimited ? 'rate-limited' : 'available',
      hot,
      rings: ringsOf(windows),
      windows,
      figure: rateLimited ? 'RL' : (top?.value ?? '—'),
      figureFaint: false,
      stateText: rateLimited ? 'RATE LIMITED' : 'AVAILABLE',
      foot: rateLimited
        ? {
            lead: 'RETRYING',
            ...(retryLabel ? { strong: `IN ${retryLabel}` } : {}),
            count: windowCount(windows.length),
          }
        : { lead: 'FETCHED', ...(age ? { strong: age } : {}), count: windowCount(windows.length) },
      aria: `${name}, ${windows.map((window) => `${window.label} ${window.value}`).join(', ')}${
        rateLimited ? `, rate limited${retryLabel ? `, retry in ${retryLabel}` : ''}` : ''
      }`,
    };
  }

  const rateLimited = entry.result.code === 'rate-limited';
  const retryLabel = formatUsageReset(entry.result.retryAt, nowMs);
  const age = formatUsageAge(batchRefreshedAt, nowMs);
  const state: UsageTileState = rateLimited ? 'rate-limited' : entry.result.status;
  const stateText =
    state === 'unauthenticated'
      ? 'SIGN IN REQUIRED'
      : state === 'unsupported'
        ? 'NOT EXPOSED'
        : rateLimited
          ? 'RATE LIMITED'
          : 'RETRYING';
  const note =
    state === 'unauthenticated'
      ? 'Sign in from a terminal pane. Usage appears once the agent is authenticated.'
      : state === 'unsupported'
        ? 'This agent does not expose limits. Nothing to show.'
        : rateLimited
          ? 'The provider is rate limiting usage reads. Windows return when it lets the next read through.'
          : 'The last read failed. Windows return with the next successful read.';
  return {
    key,
    providerId,
    label,
    ...accountLabel,
    state,
    hot: rateLimited,
    rings: [],
    windows: [],
    figure: state === 'unauthenticated' ? 'SIGN IN' : state === 'unsupported' ? 'N/A' : rateLimited ? 'RL' : 'RETRY',
    figureFaint: !rateLimited,
    stateText,
    note,
    foot: rateLimited
      ? { lead: 'RETRYING', ...(retryLabel ? { strong: `IN ${retryLabel}` } : {}) }
      : { lead: 'CHECKED', ...(age ? { strong: age } : {}) },
    aria: `${name}, ${stateText.toLowerCase()}${rateLimited && retryLabel ? `, retry in ${retryLabel}` : ''}`,
  };
}

/**
 * The column, by pressure: rate limited first, then the tightest window
 * descending, then the unmeasured states in the order sign in, not exposed,
 * no limit data, retrying. Ties keep the batch's order.
 */
export function usageTiles(batch: AccountUsageBatch | undefined, nowMs: number): UsageTile[] {
  const entries = batch?.entries ?? [];
  const perProvider = new Map<string, number>();
  for (const entry of entries) perProvider.set(entry.provider.id, (perProvider.get(entry.provider.id) ?? 0) + 1);
  const tiles = entries.map((entry, index) => ({
    index,
    tile: usageTile(entry, nowMs, batch?.refreshedAt, { showAccount: (perProvider.get(entry.provider.id) ?? 0) > 1 }),
  }));
  const pressure = (tile: UsageTile): number => tightest(tile.windows)?.usedPercent ?? -1;
  tiles.sort((left, right) => {
    const byState = STATE_ORDER[left.tile.state] - STATE_ORDER[right.tile.state];
    if (byState !== 0) return byState;
    const byPressure = pressure(right.tile) - pressure(left.tile);
    return byPressure !== 0 ? byPressure : left.index - right.index;
  });
  return tiles.map(({ tile }) => tile);
}
