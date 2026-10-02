import {
  STATUS_HISTORY_HORIZON_MS,
  type MonitorHistoryBook,
  type MonitorHistorySpan,
  type MonitorHistoryStatus,
  type MonitorLaneHistory,
} from '../../monitor/status-history.js';
import type { MonitorAgent } from '../../monitor/types.js';

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
    bornMs: Math.min(bornMs, recordedFromMs),
    recordedFromMs,
    spans: [span],
  };
}

/** A lane from the book, clipped to the horizon. */
export function laneFromHistory(agent: MonitorAgent, history: MonitorLaneHistory, nowMs: number): TimelineLane {
  const horizon = nowMs - STATUS_HISTORY_HORIZON_MS;
  const recordedFromMs = Math.max(history.recordedFromMs, horizon);
  const spans: MonitorHistorySpan[] = [];
  for (const span of history.spans) {
    if (span.toMs !== undefined && span.toMs <= horizon) continue;
    spans.push(span.fromMs < horizon ? { ...span, fromMs: horizon } : span);
  }
  return {
    id: agent.id,
    agent,
    kind: laneKind(agent),
    bornMs: Math.min(agent.createdAtMs, recordedFromMs),
    recordedFromMs,
    spans,
    ...(history.endedAtMs === undefined ? {} : { endedAtMs: history.endedAtMs }),
  };
}

/** Every lane the view could draw: the rows, then the book's ended agents still inside the horizon. */
export function timelineLanes(input: TimelineLaneInput): TimelineLaneSet {
  const { agents, history, nowMs, firstSeen } = input;
  const horizon = nowMs - STATUS_HISTORY_HORIZON_MS;
  const lanes: TimelineLane[] = [];
  const live = new Set<string>();
  for (const agent of agents) {
    live.add(agent.id);
    const record = history?.lanes.get(agent.id);
    lanes.push(
      record && record.spans.length > 0
        ? laneFromHistory(agent, record, nowMs)
        : laneFromRow(agent, nowMs, firstSeen?.get(agent.id)),
    );
  }
  for (const agent of history?.ended ?? []) {
    if (live.has(agent.id)) continue;
    const record = history?.lanes.get(agent.id);
    if (!record || record.spans.length === 0) continue;
    const ended = record.endedAtMs ?? record.spans[record.spans.length - 1]?.toMs;
    if (ended === undefined || ended <= horizon) continue;
    const lane = laneFromHistory(agent, record, nowMs);
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
  for (let index = lane.spans.length - 1; index >= 0; index -= 1) {
    const span = lane.spans[index]!;
    if (t >= span.fromMs) return { kind: 'span', span };
  }
  return { kind: 'unrecorded' };
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
