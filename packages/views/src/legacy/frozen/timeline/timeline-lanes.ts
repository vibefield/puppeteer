// FROZEN (MV-6): the timeline's lanes as it shipped before the timeline moved onto the SDK, runtime only, kept only as
// the "before" that `legacy/timeline-parity.test.tsx` renders beside the ported view over the same model. Only its
// imports changed (it moved folders). Never edit it to match the port; MV-8 deletes it with the shim.

import {
  STATUS_HISTORY_HORIZON_MS,
  type MonitorHistoryBook,
  type MonitorHistorySpan,
  type MonitorHistoryStatus,
  type MonitorLaneHistory,
} from './status-history.js';
import type { MonitorAgent } from '../../../monitor/types.js';

// The timeline's lanes: the rows it is handed, plus the host's book of what
// each did, as one ordered list. Agents run in birth order and never move
// (TL-D4); an ended agent keeps its birth slot, drawn faint, until it scrolls
// out of the window (TL-D6); bare terminals sit in a quiet group below (TL-D7).
//
// Without a book the lanes are built from the rows alone (TL-D9): born at the
// row's birth, unrecorded until its current status began, then that status as
// one open span. A view never infers a past it was not given.

export type TimelineLaneKind = 'agent' | 'terminal';

export interface TimelineLane {
  readonly id: string;
  /** The row: the live one, or the last one the book kept for an ended agent. */
  readonly agent: MonitorAgent;
  readonly kind: TimelineLaneKind;
  readonly bornMs: number;
  /** Before this the lane's past was not recorded (never before `bornMs`, never before the horizon). */
  readonly recordedFromMs: number;
  /** Ordered and contiguous; only the last may be open, and none ends before the horizon. */
  readonly spans: readonly MonitorHistorySpan[];
  readonly endedAtMs?: number | undefined;
  /** The host is showing another group (its profile tabs): the lane keeps its slot, drawn quiet. */
  readonly receded: boolean;
}

export interface TimelineLaneSet {
  /** Agent lanes, live and ended, in birth order. */
  readonly agents: readonly TimelineLane[];
  /** Bare terminals, in birth order. */
  readonly terminals: readonly TimelineLane[];
}

export interface TimelineLaneInput {
  readonly agents: readonly MonitorAgent[];
  readonly history?: MonitorHistoryBook | undefined;
  readonly nowMs: number;
  /** When the view first saw each row: a bare terminal with no book is recorded from then. */
  readonly firstSeen?: ReadonlyMap<string, number> | undefined;
  /** Remembers lanes by their book record across calls (`createLaneCache`). */
  readonly cache?: LaneCache | undefined;
}

/** What a lane was doing at one moment. */
export type TimelineMoment =
  | { readonly kind: 'unborn' }
  | { readonly kind: 'ended' }
  | { readonly kind: 'unrecorded' }
  | { readonly kind: 'span'; readonly span: MonitorHistorySpan };

const byBirth = (a: TimelineLane, b: TimelineLane): number => a.bornMs - b.bornMs || (a.id < b.id ? -1 : 1);

function laneKind(agent: MonitorAgent): TimelineLaneKind {
  return agent.agent ? 'agent' : 'terminal';
}

/** The row's current status as the history speaks it: idle with a reply not yet opened is unseen (TL-D3). */
export function currentHistoryStatus(agent: MonitorAgent): MonitorHistoryStatus {
  if (agent.status === 'idle' && agent.unread === true && agent.agent) return 'unseen';
  return agent.status;
}

function parseIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A lane from the row alone (TL-D9). */
export function laneFromRow(agent: MonitorAgent, nowMs: number, firstSeenMs?: number): TimelineLane {
  const horizon = nowMs - STATUS_HISTORY_HORIZON_MS;
  const bornMs = agent.createdAtMs;
  const monitor = agent.agent?.monitor;
  const since = parseIso(monitor?.statusSince) ?? firstSeenMs ?? nowMs;
  const recordedFromMs = Math.min(nowMs, Math.max(bornMs, since, horizon));
  const status = currentHistoryStatus(agent);
  const blocker = status === 'blocked' ? monitor?.blockers[0] : undefined;
  const did = status === 'working' ? monitor?.activity?.line : undefined;
  const span: MonitorHistorySpan = {
    status,
    fromMs: recordedFromMs,
    ...(blocker ? { blocker: { kind: blocker.kind, ...(blocker.detail ? { detail: blocker.detail } : {}) } } : {}),
    ...(did ? { did } : {}),
  };
  return {
    id: agent.id,
    agent,
    kind: laneKind(agent),
    receded: agent.receded === true,
    bornMs: Math.min(bornMs, recordedFromMs),
    recordedFromMs,
    spans: [span],
  };
}

/** The last span that has begun by `t` (spans are ordered and contiguous), or -1 before the first. */
export function spanIndexAt(spans: readonly MonitorHistorySpan[], t: number): number {
  let low = 0;
  let high = spans.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.fromMs <= t) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/**
 * A book's spans clipped to the horizon. When nothing reaches back past it the
 * book's own array is returned, uncopied: a host keeps up to 2000 spans a lane.
 */
export function clipToHorizon(spans: readonly MonitorHistorySpan[], horizon: number): readonly MonitorHistorySpan[] {
  const first = spans[0];
  if (!first || first.fromMs >= horizon) return spans;
  let index = Math.max(0, spanIndexAt(spans, horizon));
  const at = spans[index]!;
  if (at.toMs !== undefined && at.toMs <= horizon) index += 1;
  const rest = spans.slice(index);
  const head = rest[0];
  if (head && head.fromMs < horizon) rest[0] = { ...head, fromMs: horizon };
  return rest;
}

/** A lane from the book, clipped to the horizon. */
export function laneFromHistory(agent: MonitorAgent, history: MonitorLaneHistory, nowMs: number): TimelineLane {
  const horizon = nowMs - STATUS_HISTORY_HORIZON_MS;
  const recordedFromMs = Math.max(history.recordedFromMs, horizon);
  return {
    id: agent.id,
    agent,
    kind: laneKind(agent),
    receded: agent.receded === true,
    bornMs: Math.min(agent.createdAtMs, recordedFromMs),
    recordedFromMs,
    spans: clipToHorizon(history.spans, horizon),
    ...(history.endedAtMs === undefined ? {} : { endedAtMs: history.endedAtMs }),
  };
}

const MINUTE = 60_000;

/**
 * Lanes built from the book, remembered by the book's own lane record: a host
 * projects its rows several times a second, and a lane whose record did not
 * change keeps its object (and its spans) rather than being rebuilt. The
 * horizon clip is refreshed once a minute, which is finer than a 24 h edge
 * can be seen.
 */
export interface LaneCache {
  lane(agent: MonitorAgent, history: MonitorLaneHistory, nowMs: number): TimelineLane;
}

export function createLaneCache(): LaneCache {
  const entries = new WeakMap<MonitorLaneHistory, { agent: MonitorAgent; minute: number; lane: TimelineLane }>();
  return {
    lane(agent, history, nowMs) {
      const minute = Math.floor(nowMs / MINUTE);
      const entry = entries.get(history);
      if (entry && entry.minute === minute) {
        if (entry.agent === agent) return entry.lane;
        // The same record under a new row object: the row's own facts, the record's spans.
        const lane: TimelineLane = {
          ...entry.lane,
          agent,
          kind: laneKind(agent),
          receded: agent.receded === true,
          bornMs: Math.min(agent.createdAtMs, entry.lane.recordedFromMs),
        };
        entries.set(history, { agent, minute, lane });
        return lane;
      }
      const lane = laneFromHistory(agent, history, minute * MINUTE);
      entries.set(history, { agent, minute, lane });
      return lane;
    },
  };
}

/** Every lane the view could draw: the rows, then the book's ended agents still inside the horizon. */
export function timelineLanes(input: TimelineLaneInput): TimelineLaneSet {
  const { agents, history, nowMs, firstSeen, cache } = input;
  const fromBook = (agent: MonitorAgent, record: MonitorLaneHistory): TimelineLane =>
    cache ? cache.lane(agent, record, nowMs) : laneFromHistory(agent, record, nowMs);
  const horizon = nowMs - STATUS_HISTORY_HORIZON_MS;
  const lanes: TimelineLane[] = [];
  const live = new Set<string>();
  for (const agent of agents) {
    live.add(agent.id);
    const record = history?.lanes.get(agent.id);
    lanes.push(
      record && record.spans.length > 0 ? fromBook(agent, record) : laneFromRow(agent, nowMs, firstSeen?.get(agent.id)),
    );
  }
  for (const agent of history?.ended ?? []) {
    if (live.has(agent.id)) continue;
    const record = history?.lanes.get(agent.id);
    if (!record || record.spans.length === 0) continue;
    const ended = record.endedAtMs ?? record.spans[record.spans.length - 1]?.toMs;
    if (ended === undefined || ended <= horizon) continue;
    const lane = fromBook(agent, record);
    lanes.push(lane.endedAtMs === undefined ? { ...lane, endedAtMs: ended } : lane);
  }
  return {
    agents: lanes.filter((lane) => lane.kind === 'agent').sort(byBirth),
    terminals: lanes.filter((lane) => lane.kind === 'terminal').sort(byBirth),
  };
}

/** The lanes in the window: an ended one stays until it has scrolled out past the left edge (TL-D6). */
export function lanesInView(set: TimelineLaneSet, viewStartMs: number): TimelineLaneSet {
  const keep = (lane: TimelineLane): boolean => lane.endedAtMs === undefined || lane.endedAtMs > viewStartMs;
  return { agents: set.agents.filter(keep), terminals: set.terminals.filter(keep) };
}

/** What the lane was doing at `t`: a span, or not yet born, ended, or before its record. */
export function stateAt(lane: TimelineLane, t: number): TimelineMoment {
  if (t < lane.bornMs) return { kind: 'unborn' };
  if (lane.endedAtMs !== undefined && t >= lane.endedAtMs) return { kind: 'ended' };
  if (t < lane.recordedFromMs) return { kind: 'unrecorded' };
  const span = lane.spans[spanIndexAt(lane.spans, t)];
  return span ? { kind: 'span', span } : { kind: 'unrecorded' };
}

/** Remember when each row was first seen, and forget the ones that left. Returns the same map when nothing changed. */
export function noteFirstSeen(
  previous: ReadonlyMap<string, number>,
  agents: readonly MonitorAgent[],
  nowMs: number,
): ReadonlyMap<string, number> {
  let changed = previous.size !== agents.length;
  const next = new Map<string, number>();
  for (const agent of agents) {
    const seen = previous.get(agent.id);
    if (seen === undefined) changed = true;
    next.set(agent.id, seen ?? nowMs);
  }
  return changed ? next : previous;
}

/** The quiet a lane takes when another is lit, or when the host shows another group (DESIGN §8: 30%). */
export const QUIET_ALPHA = 0.3;
/** An ended lane, until it scrolls out (TL-D6). */
export const ENDED_ALPHA = 0.45;

/**
 * How strongly a lane is drawn. With a lane lit, the lit one is whole and the
 * rest quiet; with none, a receded lane is quiet. An ended lane is fainter
 * again either way.
 */
export function laneAlpha(lane: TimelineLane, index: number, lit: number): number {
  const ended = lane.endedAtMs === undefined ? 1 : ENDED_ALPHA;
  if (lit >= 0) return (lit === index ? 1 : QUIET_ALPHA) * ended;
  return (lane.receded ? QUIET_ALPHA : 1) * ended;
}

/**
 * The lane ↑ or ↓ moves the light to: the next one in `direction` that is not
 * receded (the host is showing another group; only the pointer lights those).
 * From -1 it enters at the first (↓) or the last (↑). Stays put at either end.
 */
export function stepLight(lanes: readonly TimelineLane[], from: number, direction: 1 | -1): number {
  let index = from < 0 ? (direction > 0 ? -1 : lanes.length) : from;
  for (;;) {
    index += direction;
    if (index < 0 || index >= lanes.length) return from;
    if (!lanes[index]!.receded) return index;
  }
}

/**
 * What the canvases draw of the lanes, as one string: a projection that
 * changed nothing they draw (a fresh row object, a new detail line) keeps the
 * key, so neither canvas repaints for it.
 */
export function laneContentKey(lanes: readonly TimelineLane[]): string {
  return lanes
    .map((lane) => {
      const first = lane.spans[0];
      const last = lane.spans[lane.spans.length - 1];
      return [
        lane.id,
        lane.kind,
        lane.receded ? 1 : 0,
        lane.agent.color,
        lane.bornMs,
        lane.recordedFromMs,
        lane.endedAtMs ?? '',
        lane.spans.length,
        first?.fromMs ?? '',
        last ? `${last.status}:${last.fromMs}:${last.toMs ?? ''}:${last.blocker?.kind ?? ''}` : '',
      ].join(',');
    })
    .join('|');
}

/** The ended lanes that have scrolled out past `viewStartMs`, as a sorted id list. */
export function scrolledOutIds(set: TimelineLaneSet, viewStartMs: number): string {
  const out: string[] = [];
  for (const lane of set.agents) if (lane.endedAtMs !== undefined && lane.endedAtMs <= viewStartMs) out.push(lane.id);
  for (const lane of set.terminals)
    if (lane.endedAtMs !== undefined && lane.endedAtMs <= viewStartMs) out.push(lane.id);
  return out.sort().join('\n');
}

/**
 * The map of the day's left end: the first agent's birth, at most a horizon
 * back, and never inside the window. It is also the head's limit: the head
 * stands no earlier than `dayStart + span` (`earliestHead`), so the window in
 * view, and the map's lens on it, never leave the map — and the arrows, a drag
 * and Home all stop at the same place.
 */
export function dayStart(set: TimelineLaneSet, spanMs: number, nowMs: number): number {
  let start = nowMs - spanMs;
  for (const lane of set.agents) start = Math.min(start, lane.bornMs);
  return Math.max(nowMs - STATUS_HISTORY_HORIZON_MS, start);
}

export function earliestHead(set: TimelineLaneSet, spanMs: number, nowMs: number): number {
  return Math.min(nowMs, dayStart(set, spanMs, nowMs) + spanMs);
}
