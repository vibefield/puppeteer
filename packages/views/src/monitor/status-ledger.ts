import type { AgentVisualStatus } from './agent-status.js';
import {
  STATUS_HISTORY_HORIZON_MS,
  STATUS_HISTORY_MAX_CHANGES,
  STATUS_HISTORY_TEXT_MAX,
  type MonitorHistoryBlocker,
  type MonitorHistoryBook,
  type MonitorHistorySpan,
  type MonitorHistoryStatus,
  type MonitorLaneHistory,
} from './status-history.js';
import type { MonitorAgent } from './types.js';

/**
 * A host's record of what each lane did, built from the rows it already
 * projects and from any durable record it can fetch (VibeField: fieldd's
 * `agent.history`). Pure, like `usage-ledger.ts`: the host keeps the value in a
 * ref, folds every projection into it, and hands `statusHistoryBook` to the
 * views.
 *
 * Observation alone is honest but short: a lane is recorded from the moment
 * Core says its current state began (`statusSince`), so a host with no durable
 * record still draws each agent's current stretch whole. A durable record is
 * merged under the observed one; where both speak for the same moment the
 * observed one wins, because only it knows a reply went unseen.
 */

/** From `atMs` on, the lane was `status`. */
export interface StatusChange {
  readonly status: MonitorHistoryStatus;
  readonly atMs: number;
  readonly blocker?: MonitorHistoryBlocker | undefined;
  readonly did?: string | undefined;
}

interface LaneRecord {
  readonly changes: readonly StatusChange[];
  readonly endedAtMs?: number | undefined;
  /** The last row seen, so an ended lane can still say whose it was. */
  readonly last?: MonitorAgent | undefined;
}

export interface StatusLedger {
  readonly lanes: ReadonlyMap<string, LaneRecord>;
}

export const EMPTY_STATUS_LEDGER: StatusLedger = { lanes: new Map() };

/** A durable record as a host fetched it. Unknown statuses are unrecorded time. */
export interface DurableStatusRecord {
  readonly recordedFromMs: number;
  readonly changes: readonly {
    readonly status: string;
    readonly atMs: number;
    readonly blocker?: MonitorHistoryBlocker | undefined;
    readonly did?: string | undefined;
  }[];
  readonly endedAtMs?: number | undefined;
}

const KNOWN: ReadonlySet<string> = new Set<MonitorHistoryStatus>(['working', 'idle', 'blocked', 'unseen']);

function bounded(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > STATUS_HISTORY_TEXT_MAX ? `${trimmed.slice(0, STATUS_HISTORY_TEXT_MAX - 1)}…` : trimmed;
}

function parseMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The status a row stands in right now, with the swarm's blue for a reply not yet opened. */
export function historyStatusOf(agent: Pick<MonitorAgent, 'status' | 'unread'>): MonitorHistoryStatus {
  const status: AgentVisualStatus = agent.status;
  return status === 'idle' && agent.unread === true ? 'unseen' : status;
}

function blockerOf(agent: MonitorAgent): MonitorHistoryBlocker | undefined {
  const first = agent.agent?.monitor?.blockers?.[0];
  if (!first) return undefined;
  const detail = bounded(first.detail ?? (first.kind === 'question' ? first.questions?.[0]?.prompt : undefined));
  return detail === undefined ? { kind: first.kind } : { kind: first.kind, detail };
}

function didOf(agent: MonitorAgent): string | undefined {
  return agent.status === 'working' ? bounded(agent.agent?.monitor?.activity?.line) : undefined;
}

function changeOf(
  status: MonitorHistoryStatus,
  atMs: number,
  blocker: MonitorHistoryBlocker | undefined,
  did: string | undefined,
): StatusChange {
  return {
    status,
    atMs,
    ...(status === 'blocked' && blocker ? { blocker } : {}),
    ...(status === 'working' && did ? { did } : {}),
  };
}

/** Keep a day, and at most the newest MAX changes. The change straddling the cut stays as it was: the record
 * does know when that stretch began. Returns `changes` itself when nothing goes. */
function trim(changes: readonly StatusChange[], nowMs: number): readonly StatusChange[] {
  const cut = nowMs - STATUS_HISTORY_HORIZON_MS;
  let first = 0;
  while (first + 1 < changes.length && changes[first + 1]!.atMs <= cut) first++;
  first = Math.max(first, changes.length - STATUS_HISTORY_MAX_CHANGES);
  return first === 0 ? changes : changes.slice(first);
}

/** Same status twice in a row is one stretch: keep the earlier moment, the later words. */
function collapse(changes: readonly StatusChange[]): StatusChange[] {
  const out: StatusChange[] = [];
  for (const change of changes) {
    const prev = out[out.length - 1];
    if (prev && prev.status === change.status) {
      out[out.length - 1] = changeOf(prev.status, prev.atMs, prev.blocker ?? change.blocker, change.did ?? prev.did);
      continue;
    }
    out.push(change);
  }
  return out;
}

/**
 * Fold one projection into the ledger. A row's lane begins where Core says its
 * current state began; a change is placed at Core's `statusSince` when that is
 * not older than the last change (a turn that began and ended between two
 * projections still lands where it happened), at `nowMs` otherwise — and
 * opening a reply is always `nowMs`, because that moment is the person's, not
 * Core's. A row that leaves the projection ends its lane there; one that comes
 * back resumes it. A lane's `changes` keep their identity while nothing in
 * them changed, which is what lets `statusHistoryBook` reuse its spans.
 */
export function observeStatuses(previous: StatusLedger, agents: readonly MonitorAgent[], nowMs: number): StatusLedger {
  const lanes = new Map(previous.lanes);
  const seen = new Set<string>();
  for (const agent of agents) {
    seen.add(agent.id);
    const status = historyStatusOf(agent);
    const sinceMs = parseMs(agent.agent?.monitor?.statusSince);
    const blocker = status === 'blocked' ? blockerOf(agent) : undefined;
    const did = didOf(agent);
    const record = lanes.get(agent.id);
    const tail = record?.changes[record.changes.length - 1];
    if (!record || !tail) {
      const from = Math.min(nowMs, Math.max(sinceMs ?? nowMs, agent.createdAtMs));
      lanes.set(agent.id, { changes: [changeOf(status, from, blocker, did)], last: agent });
      continue;
    }
    let next = record.changes;
    if (tail.status !== status) {
      const opened = tail.status === 'unseen' && status === 'idle';
      let at = !opened && sinceMs !== undefined && sinceMs >= tail.atMs ? Math.min(sinceMs, nowMs) : nowMs;
      if (record.endedAtMs !== undefined) at = Math.max(at, record.endedAtMs);
      next =
        at <= tail.atMs
          ? // the same moment: the stretch was this status from its start
            collapse([...next.slice(0, -1), changeOf(status, tail.atMs, blocker, did)])
          : [...next, changeOf(status, at, blocker, did)];
    } else if ((did !== undefined && did !== tail.did) || (blocker !== undefined && tail.blocker === undefined)) {
      next = [...next.slice(0, -1), changeOf(status, tail.atMs, tail.blocker ?? blocker, did ?? tail.did)];
    }
    lanes.set(agent.id, { changes: trim(next, nowMs), last: agent });
  }
  for (const [id, record] of previous.lanes) {
    if (seen.has(id)) continue;
    const endedAtMs = record.endedAtMs ?? (record.last ? nowMs : undefined);
    if (endedAtMs === undefined) continue;
    if (endedAtMs < nowMs - STATUS_HISTORY_HORIZON_MS) lanes.delete(id);
    else if (record.endedAtMs === undefined) lanes.set(id, { ...record, endedAtMs });
  }
  return { lanes };
}

/**
 * Merge a durable record under what was observed. Every change of both, by
 * time; at the same moment the observed change wins; a run of the same status
 * is one stretch. A durable `unknown` (or any status this ledger does not know)
 * is unrecorded: leading ones move the record's start up, later ones leave the
 * stretch before them running, never a guessed state.
 */
export function seedStatusHistory(
  previous: StatusLedger,
  id: string,
  durable: DurableStatusRecord,
  nowMs: number,
): StatusLedger {
  const record = previous.lanes.get(id);
  const known: StatusChange[] = [];
  for (const change of durable.changes) {
    if (!KNOWN.has(change.status) || !Number.isFinite(change.atMs)) continue;
    const atMs = Math.max(change.atMs, durable.recordedFromMs);
    if (known.length && atMs < known[known.length - 1]!.atMs) continue;
    known.push(
      changeOf(
        change.status as MonitorHistoryStatus,
        atMs,
        change.blocker && { ...change.blocker, detail: bounded(change.blocker.detail) },
        bounded(change.did),
      ),
    );
  }
  const observed = record?.changes ?? [];
  const merged: StatusChange[] = [];
  let i = 0;
  let j = 0;
  while (i < known.length || j < observed.length) {
    const d = known[i];
    const o = observed[j];
    if (o && (!d || o.atMs <= d.atMs)) {
      if (d && d.atMs === o.atMs) {
        // the same moment: the observed status, and the record's words where the window had none
        i++;
        merged.push(d.status === o.status ? changeOf(o.status, o.atMs, o.blocker ?? d.blocker, o.did ?? d.did) : o);
      } else {
        merged.push(o);
      }
      j++;
    } else if (d) {
      merged.push(d);
      i++;
    }
  }
  const changes = trim(collapse(merged), nowMs);
  const endedAtMs = durable.endedAtMs ?? record?.endedAtMs;
  const lanes = new Map(previous.lanes);
  lanes.set(id, {
    changes,
    ...(endedAtMs !== undefined ? { endedAtMs } : {}),
    ...(record?.last ? { last: record.last } : {}),
  });
  return { lanes };
}

/** A host that knows a row ended while nobody watched (a fold's exited run) gives its last row here. */
export function endStatusLane(previous: StatusLedger, row: MonitorAgent, endedAtMs: number): StatusLedger {
  const record = previous.lanes.get(row.id);
  if (record?.last === row && record.endedAtMs === endedAtMs) return previous;
  const lanes = new Map(previous.lanes);
  lanes.set(row.id, { changes: record?.changes ?? [], endedAtMs, last: row });
  return { lanes };
}

const laneCache = new WeakMap<readonly StatusChange[], { endMs: number | undefined; lane: MonitorLaneHistory }>();

function laneOf(changes: readonly StatusChange[], endMs: number | undefined): MonitorLaneHistory | undefined {
  const hit = laneCache.get(changes);
  if (hit && hit.endMs === endMs) return hit.lane;
  const spans: MonitorHistorySpan[] = [];
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    if (endMs !== undefined && change.atMs >= endMs) break;
    const next = changes[index + 1]?.atMs;
    const toMs = endMs === undefined ? next : Math.min(next ?? endMs, endMs);
    spans.push({
      status: change.status,
      fromMs: change.atMs,
      ...(toMs !== undefined ? { toMs } : {}),
      ...(change.blocker ? { blocker: change.blocker } : {}),
      ...(change.did ? { did: change.did } : {}),
    });
  }
  if (spans.length === 0) return undefined;
  const lane: MonitorLaneHistory = {
    recordedFromMs: spans[0]!.fromMs,
    spans,
    ...(endMs !== undefined ? { endedAtMs: endMs } : {}),
  };
  laneCache.set(changes, { endMs, lane });
  return lane;
}

/**
 * The book the views read. A lane keeps its object while its changes did not
 * change, so a view can compare lanes by identity. An ended lane closes at its
 * end and its last row joins `ended`; a lane with no recorded change is left out.
 */
export function statusHistoryBook(ledger: StatusLedger): MonitorHistoryBook {
  const lanes = new Map<string, MonitorLaneHistory>();
  const ended: MonitorAgent[] = [];
  for (const [id, record] of ledger.lanes) {
    const lane = laneOf(record.changes, record.endedAtMs);
    if (lane) lanes.set(id, lane);
    if (record.endedAtMs !== undefined && record.last) ended.push(record.last);
  }
  ended.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return { lanes, ended };
}
