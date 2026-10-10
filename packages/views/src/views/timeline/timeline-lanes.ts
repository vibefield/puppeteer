import type { AgentView, EndedLaneView, MonitorHistory, MonitorPastSpan } from '@vibecook/puppeteer-view-sdk';
import { laneWaitWords, stateTone } from '@vibecook/puppeteer-view-sdk/toolkit';
import { TIMELINE_HORIZON_MS } from './timeline-scale.js';

// The timeline's lanes: the rows it is handed, and the record's past when the
// host lends it, as one ordered list. Agents run in birth order and never move
// (TL-D4); a run that ended keeps its birth slot, drawn faint, until it scrolls
// out of the window (TL-D6); bare terminals sit in a quiet group below (TL-D7).
//
// RUNTIME FIRST (MV-6, MV-D13). A lane is its row: born at the row's birth,
// its current status since `statusSince`, as one open span up to now. The view
// keeps no record of what a row did and never infers it. The record's past is
// READ (`MonitorCapabilities.history`, which the host reads from rosettad),
// never kept here: a row's past before its current status, joined by the row's
// id alone, and the runs this runtime ran that the model no longer holds. Time
// in a lane's life that no recorded span covers is drawn unrecorded (TL-D9), so
// without history a lane is exactly its row, as before.

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

interface LaneCommon {
  readonly id: string;
  readonly kind: TimelineLaneKind;
  readonly bornMs: number;
  /** The host is showing another group (its profile tabs): the lane keeps its slot, drawn quiet. */
  readonly receded: boolean;
  /** The project's colour: the row's, or the ended run's (the host deals both from one theme). */
  readonly colour: string;
  /**
   * What the record says the lane did (`history`), oldest first and never overlapping: before its current state for
   * a row, its whole life for an ended run. Absent without a record: the lane claims nothing there.
   */
  readonly past?: readonly MonitorPastSpan[] | undefined;
}

/** A row's lane. */
export interface LiveLane extends LaneCommon {
  readonly row: AgentView;
  /** When the current status began: before it, back to the birth, the lane has only its record (never before the horizon). */
  readonly sinceMs: number;
  /** The lane's current state, from `sinceMs` to now. */
  readonly current: LaneSpan;
  readonly ended?: undefined;
}

/** A run this runtime ran that the model no longer holds (TL-D6): lit and read, never opened. */
export interface EndedLane extends LaneCommon {
  readonly ended: EndedLaneView;
  readonly row?: undefined;
}

export type TimelineLane = LiveLane | EndedLane;

export interface TimelineLaneSet {
  /** Agent lanes, live and ended, in birth order. */
  readonly agents: readonly TimelineLane[];
  /** Bare terminals, in birth order. */
  readonly terminals: readonly TimelineLane[];
}

/**
 * What a lane was doing at one moment: not born yet, nothing recorded, a stretch of its record (worked, quiet or its
 * bounds alone), past an ended run's last activity, or in its current state.
 */
export type TimelineMoment =
  | { readonly kind: 'unborn' }
  | { readonly kind: 'unrecorded' }
  | { readonly kind: 'past'; readonly span: MonitorPastSpan }
  | { readonly kind: 'ended' }
  | { readonly kind: 'span'; readonly span: LaneSpan };

const byBirth = (a: TimelineLane, b: TimelineLane): number => a.bornMs - b.bornMs || (a.id < b.id ? -1 : 1);

/** The state a row's lane is in: its status, and an agent's unread idle as unseen (the toolkit's tone). */
export function laneStatus(row: Pick<AgentView, 'kind' | 'status' | 'unread'>): LaneStatus {
  const tone = stateTone(row);
  return tone === 'unread' ? 'unseen' : tone;
}

/**
 * The record's spans before `seamMs` (a row's current status, where the runtime takes over): the same array when all
 * of it is, else cut there. Nothing before it: undefined.
 */
export function pastBefore(spans: readonly MonitorPastSpan[], seamMs: number): readonly MonitorPastSpan[] | undefined {
  const count = spans.length;
  if (count === 0) return undefined;
  if (spans[count - 1]!.to <= seamMs) return spans;
  const kept: MonitorPastSpan[] = [];
  for (const span of spans) {
    if (span.from >= seamMs) break;
    kept.push(span.to <= seamMs ? span : { ...span, to: seamMs });
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * A lane from its row (TL-D9): born at its birth, its current status since `statusSince`. With the row's recorded
 * past it holds that past too, cut at the CURRENT `statusSince`, and is born at the earlier of the row's birth and
 * the record's first span (a resumed session's record starts before its run).
 */
export function laneFor(row: AgentView, nowMs: number, recorded?: readonly MonitorPastSpan[]): LiveLane {
  const sinceMs = Math.min(nowMs, Math.max(row.createdAt, row.statusSince, nowMs - TIMELINE_HORIZON_MS));
  const status = laneStatus(row);
  const words = status === 'blocked' ? laneWaitWords(row.wait) : undefined;
  const wait: LaneWait | undefined =
    status === 'blocked' && row.wait
      ? { kind: row.wait.kind, ...(words === undefined ? {} : { detail: words }) }
      : undefined;
  const past = recorded === undefined ? undefined : pastBefore(recorded, sinceMs);
  return {
    id: row.id,
    row,
    kind: row.kind,
    receded: row.receded,
    colour: row.colour,
    bornMs: past === undefined ? Math.min(row.createdAt, sinceMs) : Math.min(row.createdAt, sinceMs, past[0]!.from),
    sinceMs,
    current: { status, fromMs: sinceMs, ...(wait ? { wait } : {}) },
    ...(past === undefined ? {} : { past }),
  };
}

/** An ended run's lane: born when its record began, its record its whole life, up to its last activity. */
function endedLane(run: EndedLaneView): EndedLane {
  const first = run.spans[0];
  return {
    id: run.id,
    kind: 'agent',
    bornMs: Math.min(run.startedAt, run.endedAt, first?.from ?? run.startedAt),
    receded: run.receded,
    colour: run.colour,
    ended: run,
    ...(first === undefined ? {} : { past: run.spans }),
  };
}

/** The record's part of the lanes: built once per history object, since rows change every frame and the past does not. */
export interface HistoryLanes {
  /** Each row's recorded past, by the row's id (`MonitorLivePast.id`, the model row's own). */
  readonly live: ReadonlyMap<string, readonly MonitorPastSpan[]>;
  /** The runs the model no longer holds, as lanes, in birth order. */
  readonly ended: readonly EndedLane[];
}

const HISTORY_LANES = new WeakMap<MonitorHistory, HistoryLanes>();

/** The history's lanes, memoized on the history object's identity (the host keeps it while nothing moved). */
export function historyLanes(history: MonitorHistory): HistoryLanes {
  let lanes = HISTORY_LANES.get(history);
  if (lanes === undefined) {
    lanes = {
      live: new Map(history.live.map((past) => [past.id, past.spans] as const)),
      ended: history.ended.map(endedLane).sort(byBirth),
    };
    HISTORY_LANES.set(history, lanes);
  }
  return lanes;
}

/** Two lists in birth order as one. */
function mergeByBirth(a: readonly TimelineLane[], b: readonly TimelineLane[]): TimelineLane[] {
  const out: TimelineLane[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(byBirth(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/**
 * Every lane the view draws: the agents in birth order, the ended runs among them by their births, then the bare
 * terminals in theirs. Each row is joined to its recorded past by its id on every call; the ended runs come built.
 */
export function timelineLanes(rows: readonly AgentView[], nowMs: number, history?: MonitorHistory): TimelineLaneSet {
  const recorded = history === undefined ? undefined : historyLanes(history);
  const agents: TimelineLane[] = [];
  const terminals: TimelineLane[] = [];
  for (const row of rows) {
    (row.kind === 'agent' ? agents : terminals).push(laneFor(row, nowMs, recorded?.live.get(row.id)));
  }
  agents.sort(byBirth);
  return {
    agents: recorded === undefined || recorded.ended.length === 0 ? agents : mergeByBirth(agents, recorded.ended),
    terminals: terminals.sort(byBirth),
  };
}

/** The ended runs that have scrolled out past `viewStartMs` (TL-D6), as one key in birth order: empty while none has. */
export function scrolledOutKey(set: TimelineLaneSet, viewStartMs: number): string {
  let key = '';
  for (const lane of set.agents) {
    if (lane.ended !== undefined && lane.ended.endedAt <= viewStartMs) key = key ? `${key}\n${lane.id}` : lane.id;
  }
  return key;
}

/** The lanes still in the window: an ended run stays until it has scrolled out past the left edge (TL-D6). */
export function withoutScrolledOut(set: TimelineLaneSet, key: string): TimelineLaneSet {
  if (!key) return set;
  const out = new Set(key.split('\n'));
  return { agents: set.agents.filter((lane) => !out.has(lane.id)), terminals: set.terminals };
}

/** The last span that has begun by `t` (oldest first, never overlapping), or -1 before the first. */
export function spanIndexAt(spans: readonly MonitorPastSpan[], t: number): number {
  let low = 0;
  let high = spans.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.from <= t) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** What the record says at `t`: a worked, quiet or bounds stretch; an unrecorded one, or none, is not recorded. */
function recordedAt(past: readonly MonitorPastSpan[] | undefined, t: number): TimelineMoment {
  const span = past === undefined ? undefined : past[spanIndexAt(past, t)];
  return span !== undefined && t < span.to && span.kind !== 'unrecorded'
    ? { kind: 'past', span }
    : { kind: 'unrecorded' };
}

/** What the lane was doing at `t`: not yet born, its record (or nothing recorded), past its end, or its current state. */
export function stateAt(lane: TimelineLane, t: number): TimelineMoment {
  if (t < lane.bornMs) return { kind: 'unborn' };
  if (lane.ended !== undefined) return t >= lane.ended.endedAt ? { kind: 'ended' } : recordedAt(lane.past, t);
  if (t < lane.sinceMs) return lane.past === undefined ? { kind: 'unrecorded' } : recordedAt(lane.past, t);
  return { kind: 'span', span: lane.current };
}

/** The quiet a lane takes when another is lit, or when the host shows another group (DESIGN §8: 30%). */
export const QUIET_ALPHA = 0.3;
/** An ended run, until it scrolls out (TL-D6). */
export const ENDED_ALPHA = 0.45;

/**
 * How strongly a lane is drawn. With a lane lit, the lit one is whole and the
 * rest quiet; with none, a receded lane is quiet. An ended run is fainter again
 * either way.
 */
export function laneAlpha(lane: TimelineLane, index: number, lit: number): number {
  const ended = lane.ended === undefined ? 1 : ENDED_ALPHA;
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

/** A lane's record as a key: its length and its two ends. */
const pastKey = (past: readonly MonitorPastSpan[]): string =>
  `${past.length}:${past[0]!.from}:${past[past.length - 1]!.to}`;

/**
 * What the canvases draw of the lanes, as one string: a new model that changed
 * nothing they draw (a fresh row object, a new reply) keeps the key, so neither
 * canvas repaints for it. A new history repaints them on its own (the view keys
 * on its identity).
 */
export function laneContentKey(lanes: readonly TimelineLane[]): string {
  return lanes
    .map((lane) => {
      if (lane.ended !== undefined) {
        return [
          lane.id,
          'ended',
          lane.receded ? 1 : 0,
          lane.colour,
          lane.bornMs,
          lane.ended.endedAt,
          lane.past === undefined ? '' : pastKey(lane.past),
        ].join(',');
      }
      const key = [
        lane.id,
        lane.kind,
        lane.receded ? 1 : 0,
        lane.row.colour,
        lane.bornMs,
        lane.sinceMs,
        `${lane.current.status}:${lane.current.fromMs}:${lane.current.wait?.kind ?? ''}`,
      ];
      if (lane.past !== undefined) key.push(pastKey(lane.past));
      return key.join(',');
    })
    .join('|');
}

/**
 * The map of the day's left end: the first agent's birth (an ended run's too),
 * at most a horizon back, and never inside the window. It is also the head's
 * limit: the head stands no earlier than `dayStart + span` (`earliestHead`), so
 * the window in view, and the map's lens on it, never leave the map — and the
 * arrows, a drag and Home all stop at the same place.
 */
export function dayStart(set: TimelineLaneSet, spanMs: number, nowMs: number): number {
  let start = nowMs - spanMs;
  for (const lane of set.agents) start = Math.min(start, lane.bornMs);
  return Math.max(nowMs - TIMELINE_HORIZON_MS, start);
}

export function earliestHead(set: TimelineLaneSet, spanMs: number, nowMs: number): number {
  return Math.min(nowMs, dayStart(set, spanMs, nowMs) + spanMs);
}
