/**
 * The record's past as a host lends it to a view (capability `history`).
 *
 * - `viewWantsHistory`: the ask is the manifest's, never the view's report: a
 *   host reads only while a mounted view declares `capabilities.optional:
 *   ['history']`, over the fixed window `[now − 24 h, now]` (T2).
 * - `keepPast`: a re-read that brings nothing new keeps the snapshot it had,
 *   so everything keyed on it stays put; a moved window or `readAt` alone is
 *   nothing new.
 * - `lendHistory`: the snapshot as the view sees it, built ONCE per snapshot
 *   (and per theme or filter), never per publish: each ended lane coloured with
 *   the replica's theme function (L7), so an ended lane and a live one in the
 *   same project wear the same ink, and receded by the window's own rule.
 */

import type { MonitorEndedRow, MonitorPastSnapshot, MonitorPastSpan } from '../model.js';
import type { EndedLaneView, MonitorHistory, MonitorView } from '../view.js';

/** The day a view's past covers (T2). */
export const HISTORY_WINDOW_MS = 24 * 60 * 60_000;

/** Whether the view declares the capability: the host's one reason to read the record. */
export function viewWantsHistory(view: Pick<MonitorView, 'manifest'>): boolean {
  return view.manifest.capabilities?.optional?.includes('history') === true;
}

/** Plain data compared by value; a key holding undefined counts as absent. */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false;
  return keys.every((key) => sameData(left[key], right[key]));
}

/**
 * What a snapshot holds from `since` on: its window and `readAt` left out, and every span's start clamped to `since`.
 * Nothing is removed, so a span or a run that ended before `since` stays, clamped to nothing.
 */
function heldFrom(past: MonitorPastSnapshot, since: number): object {
  const { sinceMs: _sinceMs, untilMs: _untilMs, readAt: _readAt, live, ended, ...rest } = past;
  const clamp = (spans: readonly MonitorPastSpan[]): MonitorPastSpan[] =>
    spans.map((span) => ({ ...span, from: Math.max(span.from, since) }));
  return {
    ...rest,
    live: live.map((lane) => ({ ...lane, spans: clamp(lane.spans) })),
    ended: ended.map((lane) => ({ ...lane, spans: clamp(lane.spans) })),
  };
}

/**
 * `previous` when `next` holds nothing new, else `next`. Every read asks the day before it, so a re-read moves its
 * window, its `readAt` and each span start the window clipped; what is compared is what both hold from `next`'s start
 * on. A span or a run that only aged out of the window is still news, so the snapshot kept never holds what `next`
 * let go.
 */
export function keepPast<T extends MonitorPastSnapshot>(previous: T | undefined, next: T): T {
  if (previous === undefined || previous === next) return next;
  return sameData(heldFrom(previous, next.sinceMs), heldFrom(next, next.sinceMs)) ? previous : next;
}

export interface LendHistoryOptions {
  /** The replica's theme function: a project's sequence, or the neutral ramp. */
  readonly colourFor: (seq: number | undefined) => string;
  /** The window's own rule for a lane drawn faint (`AgentView.receded`'s, over its device and profile filters). */
  readonly receded: (lane: MonitorEndedRow) => boolean;
}

/** `past` as a view sees it. Call it once per snapshot (and per theme or filter), never per publish. */
export function lendHistory(past: MonitorPastSnapshot, options: LendHistoryOptions): MonitorHistory {
  const ended: EndedLaneView[] = past.ended.map((lane) =>
    Object.freeze({ ...lane, colour: options.colourFor(lane.project.seq), receded: options.receded(lane) }),
  );
  return Object.freeze({ ...past, ended: Object.freeze(ended) });
}
