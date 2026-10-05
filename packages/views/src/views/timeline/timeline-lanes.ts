import type { AgentView } from '@vibecook/puppeteer-view-sdk';
import { laneWaitWords, stateTone } from '@vibecook/puppeteer-view-sdk/toolkit';
import { TIMELINE_HORIZON_MS } from './timeline-scale.js';

// The timeline's lanes: the rows it is handed, as one ordered list. Agents run
// in birth order and never move (TL-D4); bare terminals sit in a quiet group
// below (TL-D7).
//
// RUNTIME ONLY (MV-6, MV-D13). A lane is its row and nothing else: born at the
// row's birth, claiming no state until its current status began
// (`statusSince`), then that status as one open span, up to now. The view keeps
// no record of what a row did and never infers it, so the time between a birth
// and the current status is drawn as unrecorded (TL-D9). A run that leaves the
// model leaves the timeline with it. History, when it comes, is read from
// rosettad (`MonitorCapabilities.history`), never kept here.

export type TimelineLaneKind = 'agent' | 'terminal';

/** A lane's state: the row's status, with idle under a reply nobody has opened as unseen (TL-D3, the swarm's blue). */
export type LaneStatus = 'working' | 'idle' | 'blocked' | 'unseen';

/** What a blocked span waits on: the runtime's own kind, and the lane's words for it (`laneWaitWords`). */
export interface LaneWait {
  readonly kind: string;
  readonly detail?: string | undefined;
}

/** A lane's current state: since `fromMs` and still going. */
export interface LaneSpan {
  readonly status: LaneStatus;
  readonly fromMs: number;
  readonly wait?: LaneWait | undefined;
}

export interface TimelineLane {
  readonly id: string;
  readonly row: AgentView;
  readonly kind: TimelineLaneKind;
  readonly bornMs: number;
  /** When the current status began: before it, back to the birth, the lane claims nothing (never before the horizon). */
  readonly sinceMs: number;
  /** The one span a lane has: its current state, from `sinceMs` to now. */
  readonly current: LaneSpan;
  /** The host is showing another group (its profile tabs): the lane keeps its slot, drawn quiet. */
  readonly receded: boolean;
}

export interface TimelineLaneSet {
  /** Agent lanes, in birth order. */
  readonly agents: readonly TimelineLane[];
  /** Bare terminals, in birth order. */
  readonly terminals: readonly TimelineLane[];
}

/** What a lane was doing at one moment: not born yet, born but claiming nothing, or in its current state. */
export type TimelineMoment =
  { readonly kind: 'unborn' } | { readonly kind: 'unrecorded' } | { readonly kind: 'span'; readonly span: LaneSpan };

const byBirth = (a: TimelineLane, b: TimelineLane): number => a.bornMs - b.bornMs || (a.id < b.id ? -1 : 1);

/** The state a row's lane is in: its status, and an agent's unread idle as unseen (the toolkit's tone). */
export function laneStatus(row: Pick<AgentView, 'kind' | 'status' | 'unread'>): LaneStatus {
  const tone = stateTone(row);
  return tone === 'unread' ? 'unseen' : tone;
}

/** A lane from its row alone (TL-D9): born at its birth, its current status since `statusSince`. */
export function laneFor(row: AgentView, nowMs: number): TimelineLane {
  const sinceMs = Math.min(nowMs, Math.max(row.createdAt, row.statusSince, nowMs - TIMELINE_HORIZON_MS));
  const status = laneStatus(row);
  const words = status === 'blocked' ? laneWaitWords(row.wait) : undefined;
  const wait: LaneWait | undefined =
    status === 'blocked' && row.wait
      ? { kind: row.wait.kind, ...(words === undefined ? {} : { detail: words }) }
      : undefined;
  return {
    id: row.id,
    row,
    kind: row.kind,
    receded: row.receded,
    bornMs: Math.min(row.createdAt, sinceMs),
    sinceMs,
    current: { status, fromMs: sinceMs, ...(wait ? { wait } : {}) },
  };
}

/** Every lane the view draws: the agents in birth order, then the bare terminals in theirs. */
export function timelineLanes(rows: readonly AgentView[], nowMs: number): TimelineLaneSet {
  const agents: TimelineLane[] = [];
  const terminals: TimelineLane[] = [];
  for (const row of rows) (row.kind === 'agent' ? agents : terminals).push(laneFor(row, nowMs));
  return { agents: agents.sort(byBirth), terminals: terminals.sort(byBirth) };
}

/** What the lane was doing at `t`: not yet born, before its current state (unrecorded), or in it. */
export function stateAt(lane: TimelineLane, t: number): TimelineMoment {
  if (t < lane.bornMs) return { kind: 'unborn' };
  if (t < lane.sinceMs) return { kind: 'unrecorded' };
  return { kind: 'span', span: lane.current };
}

/** The quiet a lane takes when another is lit, or when the host shows another group (DESIGN §8: 30%). */
export const QUIET_ALPHA = 0.3;

/**
 * How strongly a lane is drawn. With a lane lit, the lit one is whole and the
 * rest quiet; with none, a receded lane is quiet.
 */
export function laneAlpha(lane: TimelineLane, index: number, lit: number): number {
  if (lit >= 0) return lit === index ? 1 : QUIET_ALPHA;
  return lane.receded ? QUIET_ALPHA : 1;
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
 * What the canvases draw of the lanes, as one string: a new model that changed
 * nothing they draw (a fresh row object, a new reply) keeps the key, so neither
 * canvas repaints for it.
 */
export function laneContentKey(lanes: readonly TimelineLane[]): string {
  return lanes
    .map((lane) =>
      [
        lane.id,
        lane.kind,
        lane.receded ? 1 : 0,
        lane.row.colour,
        lane.bornMs,
        lane.sinceMs,
        `${lane.current.status}:${lane.current.fromMs}:${lane.current.wait?.kind ?? ''}`,
      ].join(','),
    )
    .join('|');
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
  return Math.max(nowMs - TIMELINE_HORIZON_MS, start);
}

export function earliestHead(set: TimelineLaneSet, spanMs: number, nowMs: number): number {
  return Math.min(nowMs, dayStart(set, spanMs, nowMs) + spanMs);
}
