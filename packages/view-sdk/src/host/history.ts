/**
 * The record's past as a host lends it to a view (capability `history`).
 *
 * - `viewWantsHistory`: the ask is the manifest's, never the view's report: a
 *   host reads only while a mounted view declares `capabilities.optional:
 *   ['history']`, over the fixed window `[now − 24 h, now]` (T2).
 * - `keepPast`: a re-read that brings nothing new keeps the snapshot it had,
 *   so everything keyed on it stays put; a changed `readAt` alone is nothing new.
 * - `lendHistory`: the snapshot as the view sees it, built ONCE per snapshot
 *   (and per theme or filter), never per publish: each ended lane coloured with
 *   the replica's theme function (L7), so an ended lane and a live one in the
 *   same project wear the same ink, and receded by the window's own rule.
 */

import type { MonitorEndedRow, MonitorPastSnapshot } from '../model.js';
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

/** `previous` when `next` says nothing new (its `readAt` aside), else `next`. */
export function keepPast<T extends MonitorPastSnapshot>(previous: T | undefined, next: T): T {
  if (previous === undefined || previous === next) return next;
  const { readAt: _previousReadAt, ...before } = previous;
  const { readAt: _nextReadAt, ...after } = next;
  return sameData(before, after) ? previous : next;
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
