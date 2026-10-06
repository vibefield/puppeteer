import type { MonitorCost } from '../model.js';

// HOW A VIEW PRINTS A NUMBER: money, lengths of time, counts (MV-D11).
//
// Each one is ported from the view that prints it today, with identical
// output, so a view moved onto the SDK says exactly what it said before:
// money from `monitor/cost-format.ts` and the swarm's bubble, lengths from the
// timeline's words and the swarm's elapsed line, counts from the launcher and
// the swarm. Formatting only: what a number IS (a total, a burn, a share) is
// the backend's, delivered in the row.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const pad2 = (value: number): string => String(value).padStart(2, '0');

// ICU's formatting rules are fixed. Reuse their formatters across rows and animation frames.
const usdTwoPlaces = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdThreePlaces = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** USD, keeping small positive estimates visibly distinct from a known zero: `$7.03`, `$0.004`, `<$0.001`; `—` unknown. */
export function formatUsd(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value > 0 && value < 0.001) return '<$0.001';
  return `$${(value > 0 && value < 0.01 ? usdThreePlaces : usdTwoPlaces).format(value)}`;
}

/**
 * An estimate as a row prints it: `~$7.03`, with `+` while only part of the
 * observed work was priced (`~$7.03+`). `—` when there is no cost, or when the
 * provider has no pricing lane at all: a missing lane is unavailable, never
 * zero dollars (RFC 008).
 */
export function formatEstimate(cost: Pick<MonitorCost, 'usd' | 'coverage'> | undefined): string {
  if (cost === undefined || cost.coverage === 'unavailable') return '—';
  return `~${formatUsd(cost.usd)}${cost.coverage === 'partial' ? '+' : ''}`;
}

/**
 * A burn rate as people price work, by the hour: `$12/hr`, `$1.5/hr`,
 * `$0.45/hr`; `—/hr` unknown. Takes USD an hour (the row's `burnPerHour`); the
 * swarm's own copy took USD a minute and multiplied, so the words are the same.
 */
export function formatRatePerHour(perHour: number | undefined): string {
  if (perHour === undefined) return '—/hr';
  if (perHour >= 10) return `$${Math.round(perHour)}/hr`;
  if (perHour >= 1) return `$${perHour.toFixed(1)}/hr`;
  return `${formatUsd(perHour)}/hr`;
}

/**
 * How long something has been going, to the second: `4:39` under an hour,
 * then `2h 05m`, then `1d 03h` from a day. The swarm's terminal line never
 * printed days (`26h 03m`); it passes `{ days: false }` to keep saying so.
 */
export function formatElapsed(ms: number, options: { readonly days?: boolean } = {}): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (options.days !== false && hours >= 24) return `${Math.floor(hours / 24)}d ${pad2(hours % 24)}h`;
  if (hours > 0) return `${hours}h ${pad2(minutes % 60)}m`;
  return `${minutes}:${pad2(seconds % 60)}`;
}

/** A length, compact: `45s`, `11m`, `2h 14m`, `2h`. */
export function formatShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / SECOND));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (minutes < 1) return `${seconds}s`;
  if (hours < 1) return `${minutes}m`;
  return minutes % 60 ? `${hours}h ${pad2(minutes % 60)}m` : `${hours}h`;
}

/** A length as a screen reader says it: `under a minute`, `1 hour 4 minutes`. */
export function formatWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [
    hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '',
    rest ? `${rest} minute${rest === 1 ? '' : 's'}` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/** The local wall clock: `14:05`, or `14:05:09`. */
export function formatClock(ms: number, withSeconds = false): string {
  const date = new Date(ms);
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad2(date.getSeconds())}` : base;
}

/** A whole count with grouping: `1,204`. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** A token count, compact: `820`, `8.1k`, `24k`, `384k`, `1.2M`, `24M`. */
export function formatTokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** A share of a whole, floored as the list and the swarm print context: `42%`; `missing` when unknown. */
export function formatPercent(value: number | undefined, missing = '—'): string {
  return value === undefined || !Number.isFinite(value) ? missing : `${Math.floor(value)}%`;
}
