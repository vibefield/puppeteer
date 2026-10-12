import type {
  MonitorDeviceRef,
  MonitorEndedRow,
  MonitorLivePast,
  MonitorPastSnapshot,
  MonitorPastSpan,
  MonitorPastSpanKind,
} from '@vibefield/puppeteer-view-sdk/model';
import { folderName } from './derive.js';
import type {
  MonitorPastWindow,
  MonitorRecordedActivity,
  MonitorRecordedRun,
  MonitorRecordedSession,
  MonitorRecordedTurn,
  ProjectIdentityStore,
} from './ports.js';

// THE RECORD'S PAST (capability `history`). The record's turns become a lane's
// past here, once, beside the runtime: the join key (provider + native session
// id, AR-D3) is the backend's alone, so no screen re-derives it. Nothing is
// kept: each ask reads the record through the host's port and derives afresh.
//
// ONLY THIS RUNTIME'S RUNS (TIMELINE SHAPES v2, item 7). A session is a lane
// only when it is one of the host's runs: live while the model holds its row,
// ended once it does not. A session the record holds that this runtime never
// ran (an agent started in another terminal app, maybe running right now) is
// no lane at all — drawing it as ended would be a lie.
//
// What the record can say, and what it cannot (TL T1):
//   · inside a turn the agent worked; between turns it was quiet;
//   · a silence inside a turn longer than PAST_SILENCE_MS is NOT worked: a
//     permission wait or a long tool leave no record, so it stays unrecorded;
//   · it never says blocked, and never unseen (a person's glance).
// With only a session's bounds (the floor, TL T5) an ended run is one `bounds`
// band and a live row's past stays unrecorded.

/** A silence inside a turn longer than this is not drawn as work (T1; the History room's own pause). */
export const PAST_SILENCE_MS = 15 * 60_000;

/** The widest window the record is read for: the timeline's day (T2). */
export const PAST_MAX_WINDOW_MS = 24 * 60 * 60_000;

/** The prefix that keeps an ended lane's id apart from every model row's. */
export const ENDED_LANE_PREFIX = 'past:';

/** A live agent row as the join sees it. */
export interface PastLiveRun {
  readonly id: string;
  readonly providerId: string;
  readonly nativeSessionId: string;
  /** The row's current status began here: the runtime speaks from here on. */
  readonly statusSince: number;
}

export interface DerivePastInput {
  readonly window: MonitorPastWindow;
  readonly activity: MonitorRecordedActivity;
  /** The model's agent rows now, each with its join key. */
  readonly live: readonly PastLiveRun[];
  readonly device: MonitorDeviceRef;
  readonly identity: ProjectIdentityStore;
  readonly readAt: number;
}

interface Interval {
  from: number;
  to: number;
}

/** The window an ask names, clamped to a day ending at its `untilMs`; undefined when it names no time at all. */
export function clampPastWindow(window: MonitorPastWindow): MonitorPastWindow | undefined {
  const { sinceMs, untilMs } = window;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) return undefined;
  return { sinceMs: Math.max(sinceMs, untilMs - PAST_MAX_WINDOW_MS), untilMs };
}

/** The join key: a provider's native session id is unique only within its provider. */
export function pastKey(providerId: string, nativeSessionId: string): string {
  return `${providerId}\u0000${nativeSessionId}`;
}

/** Sorted, overlapping or touching intervals merged; empty ones dropped. */
function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((interval) => interval.to > interval.from).sort((a, b) => a.from - b.from);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to);
    else merged.push({ ...interval });
  }
  return merged;
}

/** A turn's worked stretches: the turn less its silences longer than the cut. */
function workedIn(turn: MonitorRecordedTurn, silenceMs: number): Interval[] {
  const silences = union(
    (turn.silences ?? [])
      .filter((silence) => silence.to - silence.from > silenceMs)
      .map((silence) => ({ from: Math.max(silence.from, turn.firstAt), to: Math.min(silence.to, turn.lastAt) })),
  );
  const worked: Interval[] = [];
  let at = turn.firstAt;
  for (const silence of silences) {
    if (silence.from > at) worked.push({ from: at, to: silence.from });
    at = Math.max(at, silence.to);
  }
  if (turn.lastAt > at) worked.push({ from: at, to: turn.lastAt });
  return worked;
}

function inAny(intervals: readonly Interval[], at: number): boolean {
  return intervals.some((interval) => interval.from <= at && at < interval.to);
}

/**
 * A session's spans between `from` and `to` from its turns: worked inside a turn, unrecorded across a silence inside
 * one, quiet between turns. Oldest first, adjacent spans of one kind merged, nothing outside `[from, to]`.
 */
export function spansFromTurns(
  turns: readonly MonitorRecordedTurn[],
  from: number,
  to: number,
  silenceMs: number = PAST_SILENCE_MS,
): MonitorPastSpan[] {
  if (to <= from) return [];
  const worked = union(turns.flatMap((turn) => workedIn(turn, silenceMs)));
  const covered = union(turns.map((turn) => ({ from: turn.firstAt, to: turn.lastAt })));
  const edges = new Set<number>([from, to]);
  for (const interval of [...worked, ...covered]) {
    if (interval.from > from && interval.from < to) edges.add(interval.from);
    if (interval.to > from && interval.to < to) edges.add(interval.to);
  }
  const points = [...edges].sort((a, b) => a - b);
  const spans: { kind: MonitorPastSpanKind; from: number; to: number }[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const kind: MonitorPastSpanKind = inAny(worked, start) ? 'worked' : inAny(covered, start) ? 'unrecorded' : 'quiet';
    const last = spans[spans.length - 1];
    if (last && last.kind === kind && last.to === start) last.to = end;
    else spans.push({ kind, from: start, to: end });
  }
  return spans;
}

/** Where a session's past starts inside the window: its first recorded activity, or the window's start. */
function pastStart(session: MonitorRecordedSession, window: MonitorPastWindow): number {
  return Math.max(window.sinceMs, session.firstAt);
}

function touches(session: MonitorRecordedSession, window: MonitorPastWindow): boolean {
  return session.lastAt >= window.sinceMs && session.firstAt <= window.untilMs;
}

function endedRow(
  input: DerivePastInput,
  session: MonitorRecordedSession,
  run: MonitorRecordedRun,
  fine: boolean,
): MonitorEndedRow {
  const { window, identity, device } = input;
  const from = pastStart(session, window);
  const to = Math.min(window.untilMs, session.lastAt);
  // a session whose turns were not read is one flat `bounds` span, even in a turns snapshot
  const spans: MonitorPastSpan[] =
    fine && session.turns !== undefined
      ? spansFromTurns(session.turns, from, to)
      : to > from
        ? [{ kind: 'bounds', from, to }]
        : [];
  // the run's own key first: the one its colour was dealt by while it was live
  const key = run.projectKey || session.projectKey || undefined;
  // read, never dealt: every ended lane is a run this runtime ran, so its project was dealt while it was live, and a
  // past that is only read writes no identity (an unknown key wears the neutral ramp)
  const seq = key === undefined ? undefined : identity.seq(key);
  const title = run.title || session.title || undefined;
  const label = run.provider.label || session.provider.label;
  return {
    id: `${ENDED_LANE_PREFIX}${session.provider.id}:${session.nativeSessionId}`,
    provider: { id: session.provider.id, label },
    ...(title === undefined ? {} : { title }),
    ...(run.profileSet === undefined ? {} : { profileSet: run.profileSet }),
    project: {
      name: session.projectName ?? folderName(key, label),
      ...(seq === undefined ? {} : { seq }),
    },
    device,
    startedAt: Math.min(
      run.createdAt ?? Number.POSITIVE_INFINITY,
      session.startedAt ?? session.firstAt,
      session.firstAt,
    ),
    endedAt: session.lastAt,
    spans,
  };
}

/**
 * The past of a window: the record's sessions joined by provider and native session id (AR-D3) with the model's rows
 * — each row's past before its current status — and with the host's runs the model no longer holds, as ended lanes in
 * birth order. A session that is neither is left out.
 */
export function derivePast(input: DerivePastInput): MonitorPastSnapshot {
  const { window, activity, readAt } = input;
  const fine = activity.fidelity === 'turns';
  const liveByKey = new Map<string, PastLiveRun>();
  for (const run of input.live) liveByKey.set(pastKey(run.providerId, run.nativeSessionId), run);
  const ranHere = new Map<string, MonitorRecordedRun>();
  for (const run of activity.runs) ranHere.set(pastKey(run.provider.id, run.nativeSessionId), run);

  const live: MonitorLivePast[] = [];
  const ended: MonitorEndedRow[] = [];
  const seen = new Set<string>();
  for (const session of activity.sessions) {
    const key = pastKey(session.provider.id, session.nativeSessionId);
    if (seen.has(key) || !touches(session, window)) continue;
    seen.add(key);
    const run = liveByKey.get(key);
    if (run === undefined) {
      // ended only if this runtime ran it; a stranger's session is no lane
      const recorded = ranHere.get(key);
      if (recorded !== undefined) ended.push(endedRow(input, session, recorded, fine));
      continue;
    }
    // the floor keeps a live row's past unrecorded (T5): bounds cannot say where its current turn began
    if (!fine || session.turns === undefined) continue;
    const seamAt = Math.min(run.statusSince, window.untilMs);
    const spans = spansFromTurns(session.turns, pastStart(session, window), seamAt);
    if (spans.length > 0) live.push({ id: run.id, seamAt, spans });
  }
  ended.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    readAt,
    fidelity: activity.fidelity,
    state: activity.partial ? 'partial' : 'complete',
    ...(activity.detail === undefined ? {} : { detail: activity.detail }),
    live,
    ended,
  };
}

/** The past when the record cannot be read: nothing, honestly said. */
export function unavailablePast(window: MonitorPastWindow, readAt: number, detail: string): MonitorPastSnapshot {
  // `bounds`: nothing finer was read
  return {
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    readAt,
    fidelity: 'bounds',
    state: 'unavailable',
    detail,
    live: [],
    ended: [],
  };
}
