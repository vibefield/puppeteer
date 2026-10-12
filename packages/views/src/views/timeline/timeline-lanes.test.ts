import { describe, expect, it } from 'vitest';
import type { AgentView, EndedLaneView, MonitorHistory, MonitorPastSpan } from '@vibefield/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibefield/puppeteer-view-sdk/testing';
import {
  dayStart,
  earliestHead,
  ENDED_ALPHA,
  historyLanes,
  laneContentKey,
  laneAlpha,
  laneFor,
  laneStatus,
  pastBefore,
  QUIET_ALPHA,
  scrolledOutKey,
  stateAt,
  stepLight,
  timelineLanes,
  withoutScrolledOut,
} from './timeline-lanes.js';
import { TIMELINE_HORIZON_MS } from './timeline-scale.js';

const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);
const MIN = 60_000;

/** An agent born `bornAgo` before now, in its current state since `sinceAgo` (its whole life when absent). */
function agentRow(id: string, bornAgo: number, overrides: AgentViewFixturePartial = {}, sinceAgo = bornAgo): AgentView {
  return agentViewFixture({ id, createdAt: NOW - bornAgo, statusSince: NOW - sinceAgo, ...overrides });
}

function terminalRow(id: string, bornAgo: number, overrides: AgentViewFixturePartial = {}): AgentView {
  return agentViewFixture({
    id,
    kind: 'terminal',
    createdAt: NOW - bornAgo,
    statusSince: NOW - bornAgo,
    project: { name: 'notes', seq: undefined },
    ...overrides,
  });
}

describe('timelineLanes', () => {
  it('orders agents by birth, never by status, and puts bare terminals in their own group', () => {
    const set = timelineLanes(
      [agentRow('late', 10 * MIN, { status: 'blocked' }), terminalRow('shell', 90 * MIN), agentRow('early', 50 * MIN)],
      NOW,
    );
    expect(set.agents.map((lane) => lane.id)).toEqual(['early', 'late']);
    expect(set.terminals.map((lane) => lane.id)).toEqual(['shell']);
  });

  it('breaks a tie of births by id', () => {
    const set = timelineLanes([agentRow('b', 10 * MIN), agentRow('a', 10 * MIN)], NOW);
    expect(set.agents.map((lane) => lane.id)).toEqual(['a', 'b']);
  });

  it('draws only what the model holds: a run that left the model has no lane (runtime only)', () => {
    expect(timelineLanes([agentRow('a', 50 * MIN)], NOW).agents.map((lane) => lane.id)).toEqual(['a']);
    expect(timelineLanes([], NOW)).toEqual({ agents: [], terminals: [] });
  });
});

describe('a lane is its row alone (TL-D9, MV-6)', () => {
  it('is born at the row’s birth, claims nothing until its current status began, then holds that status to now', () => {
    const lane = laneFor(agentRow('a', 50 * MIN, { status: 'working' }, 7 * MIN), NOW);
    expect(lane.bornMs).toBe(NOW - 50 * MIN);
    expect(lane.sinceMs).toBe(NOW - 7 * MIN);
    expect(lane.current).toEqual({ status: 'working', fromMs: NOW - 7 * MIN });
  });

  it('says an agent’s unread idle as unseen, the swarm’s blue (TL-D3); a terminal is never unseen', () => {
    expect(laneFor(agentRow('a', 50 * MIN, { unread: true }, 7 * MIN), NOW).current.status).toBe('unseen');
    expect(laneStatus({ kind: 'terminal', status: 'idle', unread: true })).toBe('idle');
    expect(laneStatus({ kind: 'agent', status: 'working', unread: true })).toBe('working');
    expect(laneStatus({ kind: 'agent', status: 'blocked', unread: true })).toBe('blocked');
  });

  it('carries what a blocked lane waits on in the lane’s own words: detail, then prompt (M14)', () => {
    const asked = laneFor(
      agentRow('a', 50 * MIN, {
        status: 'blocked',
        wait: { kind: 'question', since: NOW - 3 * MIN, header: 'Deploy', question: 'Ship it?' },
      }),
      NOW,
    );
    expect(asked.current.wait).toEqual({ kind: 'question', detail: 'Ship it?' });
    const tool = laneFor(
      agentRow('b', 50 * MIN, { status: 'blocked', wait: { kind: 'permission', since: NOW, tool: 'Bash' } }),
      NOW,
    );
    expect(tool.current.wait).toEqual({ kind: 'permission' });
    // A wait on a row that is not blocked is not the lane's.
    const working = laneFor(
      agentRow('c', 50 * MIN, { status: 'working', wait: { kind: 'permission', since: NOW, detail: 'stale' } }),
      NOW,
    );
    expect(working.current.wait).toBeUndefined();
  });

  it('starts a terminal’s current state where its row says, not where the view first saw it', () => {
    const shell = laneFor(terminalRow('shell', 90 * MIN, { status: 'working', statusSince: NOW - 3 * MIN }), NOW);
    expect(shell.kind).toBe('terminal');
    expect(shell.sinceMs).toBe(NOW - 3 * MIN);
    expect(shell.current.status).toBe('working');
  });

  it('starts every row’s current state where its row says: the rows the old book dated by first sight too (RT5)', () => {
    // A run the runtime has not reported yet, and a peer's run: the legacy rows carried no time for either, so the old
    // book began their lane when the window first saw them. Every row carries its own `statusSince` now.
    const starting = laneFor(agentRow('starting', 20 * MIN, { observed: false }, 20 * MIN), NOW);
    expect(starting.sinceMs).toBe(NOW - 20 * MIN);
    const peer = laneFor(
      agentRow('peer', 40 * MIN, { device: { id: 'd', name: 'studio', self: false }, status: 'idle' }, 7 * MIN),
      NOW,
    );
    expect([peer.sinceMs, peer.current.fromMs, peer.current.status]).toEqual([NOW - 7 * MIN, NOW - 7 * MIN, 'idle']);
  });

  it('clips at the horizon, and never claims a state before its birth or after now', () => {
    const old = laneFor(agentRow('old', TIMELINE_HORIZON_MS + 60 * MIN), NOW);
    expect(old.sinceMs).toBe(NOW - TIMELINE_HORIZON_MS);
    expect(old.bornMs).toBe(NOW - TIMELINE_HORIZON_MS - 60 * MIN);
    const early = laneFor(agentRow('early', 10 * MIN, {}, 30 * MIN), NOW);
    expect(early.sinceMs).toBe(NOW - 10 * MIN);
    const ahead = laneFor(agentViewFixture({ id: 'skew', createdAt: NOW + MIN, statusSince: NOW + MIN }), NOW);
    expect(ahead.sinceMs).toBe(NOW);
    expect(ahead.bornMs).toBe(NOW);
  });

  it('keeps the row itself, and its place: receded', () => {
    const row = agentRow('quiet', 45 * MIN, { receded: true });
    const lane = laneFor(row, NOW);
    expect(lane.row).toBe(row);
    expect(lane.receded).toBe(true);
  });
});

describe('stateAt', () => {
  const lane = laneFor(agentRow('a', 60 * MIN, { status: 'blocked' }, 10 * MIN), NOW);

  it('reads unborn, then unrecorded, then the current state', () => {
    expect(stateAt(lane, NOW - 70 * MIN).kind).toBe('unborn');
    expect(stateAt(lane, NOW - 50 * MIN).kind).toBe('unrecorded');
    expect(stateAt(lane, NOW - 10 * MIN - 1).kind).toBe('unrecorded');
    const blocked = stateAt(lane, NOW - 10 * MIN);
    expect(blocked.kind === 'span' && blocked.span).toBe(lane.current);
    const now = stateAt(lane, NOW);
    expect(now.kind === 'span' && now.span.status).toBe('blocked');
  });
});

describe('receded lanes', () => {
  const lanes = timelineLanes(
    [agentRow('a', 50 * MIN), agentRow('quiet', 45 * MIN, { receded: true }), agentRow('b', 30 * MIN)],
    NOW,
  ).agents;

  it('keep their birth slot', () => {
    expect(lanes.map((lane) => [lane.id, lane.receded])).toEqual([
      ['a', false],
      ['quiet', true],
      ['b', false],
    ]);
  });

  it('are drawn quiet; a lane the pointer lights is whole, and the rest go quiet', () => {
    expect(laneAlpha(lanes[0]!, 0, -1)).toBe(1);
    expect(laneAlpha(lanes[1]!, 1, -1)).toBe(QUIET_ALPHA);
    expect(laneAlpha(lanes[1]!, 1, 1)).toBe(1);
    expect(laneAlpha(lanes[1]!, 1, 0)).toBe(QUIET_ALPHA);
    expect(laneAlpha(lanes[0]!, 0, 2)).toBe(QUIET_ALPHA);
  });

  it('are stepped over by ↑ and ↓', () => {
    expect(stepLight(lanes, -1, 1)).toBe(0);
    expect(stepLight(lanes, 0, 1)).toBe(2);
    expect(stepLight(lanes, 2, 1)).toBe(2);
    expect(stepLight(lanes, 2, -1)).toBe(0);
    expect(stepLight(lanes, -1, -1)).toBe(2);
    // A receded lane the pointer lit is left by the next key, not re-lit.
    expect(stepLight(lanes, 1, 1)).toBe(2);
  });
});

describe('laneContentKey', () => {
  const key = (rows: AgentView[]): string => laneContentKey(timelineLanes(rows, NOW).agents);
  const base = key([agentRow('a', 40 * MIN, { status: 'working' }, 30 * MIN)]);

  it('holds for a fresh row object that draws the same (a new reply, a new line)', () => {
    expect(
      key([agentRow('a', 40 * MIN, { status: 'working', detail: 'something new', reply: { text: 'hi' } }, 30 * MIN)]),
    ).toBe(base);
  });

  it('moves when the current state, its start, the colour or the recede does', () => {
    expect(key([agentRow('a', 40 * MIN, { status: 'blocked' }, 30 * MIN)])).not.toBe(base);
    expect(key([agentRow('a', 40 * MIN, { status: 'working' }, 20 * MIN)])).not.toBe(base);
    expect(key([agentRow('a', 40 * MIN, { status: 'working', colour: '#000' }, 30 * MIN)])).not.toBe(base);
    expect(key([agentRow('a', 40 * MIN, { status: 'working', receded: true }, 30 * MIN)])).not.toBe(base);
  });
});

describe('the day’s start and the head’s limit', () => {
  const set = timelineLanes(
    [agentRow('a', 3 * 60 * MIN), agentRow('b', 30 * MIN), terminalRow('shell', 9 * 60 * MIN)],
    NOW,
  );

  it('starts the map at the first agent’s birth (terminals do not stretch it), never inside the window', () => {
    expect(dayStart(set, 60 * MIN, NOW)).toBe(NOW - 3 * 60 * MIN);
    expect(dayStart(set, 5 * 60 * MIN, NOW)).toBe(NOW - 5 * 60 * MIN);
  });

  it('holds the head a window past it, so the lens never leaves the map', () => {
    for (const span of [15 * MIN, 60 * MIN, 4 * 60 * MIN, 12 * 60 * MIN]) {
      const head = earliestHead(set, span, NOW);
      expect(head - span).toBeGreaterThanOrEqual(dayStart(set, span, NOW));
      expect(head).toBeLessThanOrEqual(NOW);
    }
  });

  it('never reaches past the horizon', () => {
    const old = timelineLanes([agentRow('a', 30 * 60 * MIN)], NOW);
    expect(dayStart(old, 60 * MIN, NOW)).toBe(NOW - TIMELINE_HORIZON_MS);
  });
});

// The record's past, as a host lends it (`history`): plain data, built by hand so each case says what it holds.

/** A recorded stretch from `fromAgo` to `toAgo` before now. */
const span = (kind: MonitorPastSpan['kind'], fromAgo: number, toAgo: number): MonitorPastSpan => ({
  kind,
  from: NOW - fromAgo,
  to: NOW - toAgo,
});

/** A run that ended: its record from `startedAgo` to its last activity `endedAgo` before now, worked throughout. */
function endedRun(
  id: string,
  startedAgo: number,
  endedAgo: number,
  overrides: Partial<EndedLaneView> = {},
): EndedLaneView {
  return {
    id: `past:claude:${id}`,
    provider: { id: 'claude', label: 'Claude Code' },
    project: { name: 'notes', seq: 1 },
    device: { id: 'here', name: 'here', self: true },
    startedAt: NOW - startedAgo,
    endedAt: NOW - endedAgo,
    spans: [span('worked', startedAgo, endedAgo)],
    colour: 'teal',
    receded: false,
    ...overrides,
  };
}

function history(partial: Partial<MonitorHistory> = {}): MonitorHistory {
  return {
    sinceMs: NOW - 24 * 60 * MIN,
    untilMs: NOW,
    readAt: NOW,
    fidelity: 'turns',
    state: 'complete',
    live: [],
    ended: [],
    ...partial,
  };
}

describe('a row with its recorded past (T1, T3)', () => {
  const recorded = [
    span('worked', 70 * MIN, 40 * MIN),
    span('quiet', 40 * MIN, 20 * MIN),
    span('worked', 20 * MIN, 10 * MIN),
  ];
  const lent = history({ live: [{ id: 'a', seamAt: NOW - 10 * MIN, spans: recorded }] });

  it('joins its past by its own id, and is born at the earlier of its birth and the record (a resumed session)', () => {
    const [lane] = timelineLanes([agentRow('a', 50 * MIN, { status: 'working' }, 10 * MIN)], NOW, lent).agents;
    expect(lane!.past).toBe(recorded);
    expect(lane!.bornMs).toBe(NOW - 70 * MIN);
    expect(lane!.ended === undefined && lane!.sinceMs).toBe(NOW - 10 * MIN);
    // A row the record does not hold has none, and is the row alone, exactly as without history.
    const [other] = timelineLanes([agentRow('b', 50 * MIN, {}, 10 * MIN)], NOW, lent).agents;
    expect(other).toEqual(laneFor(agentRow('b', 50 * MIN, {}, 10 * MIN), NOW));
  });

  it('cuts its past at the CURRENT statusSince, and keeps it whole when the status has moved on since the read', () => {
    const back = laneFor(agentRow('a', 50 * MIN, {}, 15 * MIN), NOW, recorded);
    expect(back.past).toEqual([
      span('worked', 70 * MIN, 40 * MIN),
      span('quiet', 40 * MIN, 20 * MIN),
      span('worked', 20 * MIN, 15 * MIN),
    ]);
    const on = laneFor(agentRow('a', 50 * MIN, {}, 5 * MIN), NOW, recorded);
    expect(on.past).toBe(recorded);
    // Between the read's seam and the newer status the record says nothing: not recorded, until the host reads again.
    expect(stateAt(on, NOW - 7 * MIN).kind).toBe('unrecorded');
    expect(pastBefore(recorded, NOW - 80 * MIN)).toBeUndefined();
    expect(pastBefore([], NOW)).toBeUndefined();
  });

  it('reads a moment from its record: worked, quiet and bounds are recorded; a silence or uncovered time is not', () => {
    const lane = laneFor(agentRow('a', 90 * MIN, { status: 'blocked' }, 10 * MIN), NOW, [
      span('worked', 80 * MIN, 60 * MIN),
      span('unrecorded', 60 * MIN, 40 * MIN),
      span('quiet', 40 * MIN, 30 * MIN),
      span('bounds', 25 * MIN, 10 * MIN),
    ]);
    const at = (ago: number) => stateAt(lane, NOW - ago);
    expect(at(85 * MIN).kind).toBe('unrecorded');
    expect(at(70 * MIN)).toEqual({ kind: 'past', span: span('worked', 80 * MIN, 60 * MIN) });
    expect(at(50 * MIN).kind).toBe('unrecorded');
    expect(at(35 * MIN)).toEqual({ kind: 'past', span: span('quiet', 40 * MIN, 30 * MIN) });
    expect(at(27 * MIN).kind).toBe('unrecorded');
    expect(at(20 * MIN)).toEqual({ kind: 'past', span: span('bounds', 25 * MIN, 10 * MIN) });
    expect(at(5 * MIN)).toEqual({ kind: 'span', span: lane.current });
    expect(at(95 * MIN).kind).toBe('unborn');
  });

  it('keys its record into what the canvases draw', () => {
    const row = agentRow('a', 50 * MIN, {}, 10 * MIN);
    const bare = laneContentKey([laneFor(row, NOW)]);
    const kept = laneContentKey([laneFor(row, NOW, recorded)]);
    expect(kept).not.toBe(bare);
    expect(laneContentKey([laneFor(row, NOW, recorded.slice(1))])).not.toBe(kept);
  });
});

describe('the runs that ended (TL-D6)', () => {
  const rows = [agentRow('early', 50 * MIN), agentRow('late', 10 * MIN), terminalRow('shell', 90 * MIN)];
  const lent = history({ ended: [endedRun('mid', 30 * MIN, 15 * MIN), endedRun('first', 80 * MIN, 60 * MIN)] });

  it('take their birth slots among the agents, the terminals still below', () => {
    const set = timelineLanes(rows, NOW, lent);
    expect(set.agents.map((lane) => lane.id)).toEqual(['past:claude:first', 'early', 'past:claude:mid', 'late']);
    expect(set.terminals.map((lane) => lane.id)).toEqual(['shell']);
    const ended = set.agents[0]!;
    expect(ended.ended?.id).toBe('past:claude:first');
    expect([ended.kind, ended.bornMs, ended.colour]).toEqual(['agent', NOW - 80 * MIN, 'teal']);
  });

  it('are built once per history object; the rows join them on every call', () => {
    const one = timelineLanes(rows, NOW, lent);
    const two = timelineLanes([...rows], NOW, lent);
    expect(two.agents[0]).toBe(one.agents[0]);
    expect(historyLanes(lent)).toBe(historyLanes(lent));
    expect(historyLanes({ ...lent }).ended[0]).not.toBe(historyLanes(lent).ended[0]);
  });

  it('are drawn faint, fainter again when receded or another lane is lit', () => {
    const [ended] = historyLanes(history({ ended: [endedRun('x', 30 * MIN, 15 * MIN)] })).ended;
    const [quiet] = historyLanes(history({ ended: [endedRun('y', 30 * MIN, 15 * MIN, { receded: true })] })).ended;
    expect(laneAlpha(ended!, 0, -1)).toBe(ENDED_ALPHA);
    expect(laneAlpha(quiet!, 0, -1)).toBe(QUIET_ALPHA * ENDED_ALPHA);
    expect(laneAlpha(ended!, 0, 0)).toBe(ENDED_ALPHA);
    expect(laneAlpha(ended!, 0, 1)).toBe(QUIET_ALPHA * ENDED_ALPHA);
  });

  it('say they ended past their last activity, and read their record before it', () => {
    const [ended] = historyLanes(lent).ended;
    expect(stateAt(ended!, NOW - 70 * MIN)).toEqual({ kind: 'past', span: span('worked', 80 * MIN, 60 * MIN) });
    expect(stateAt(ended!, NOW - 60 * MIN)).toEqual({ kind: 'ended' });
    expect(stateAt(ended!, NOW - 85 * MIN).kind).toBe('unborn');
  });

  it('stay until they have scrolled out past the left edge', () => {
    const set = timelineLanes(rows, NOW, lent);
    expect(scrolledOutKey(set, NOW - 90 * MIN)).toBe('');
    expect(scrolledOutKey(set, NOW - 30 * MIN)).toBe('past:claude:first');
    expect(scrolledOutKey(set, NOW - 15 * MIN)).toBe('past:claude:first\npast:claude:mid');
    expect(withoutScrolledOut(set, '')).toBe(set);
    const left = withoutScrolledOut(set, scrolledOutKey(set, NOW - 30 * MIN));
    expect(left.agents.map((lane) => lane.id)).toEqual(['early', 'past:claude:mid', 'late']);
    expect(left.terminals).toBe(set.terminals);
  });

  it('start the day at their births too, never past the horizon', () => {
    expect(dayStart(timelineLanes(rows, NOW, lent), 60 * MIN, NOW)).toBe(NOW - 80 * MIN);
    const old = history({ ended: [endedRun('old', 30 * 60 * MIN, 20 * 60 * MIN)] });
    expect(dayStart(timelineLanes(rows, NOW, old), 60 * MIN, NOW)).toBe(NOW - TIMELINE_HORIZON_MS);
  });

  it('key their record into what the canvases draw', () => {
    const key = laneContentKey(timelineLanes(rows, NOW, lent).agents);
    expect(key).toContain('past:claude:mid,ended');
    const moved = history({ ended: [endedRun('mid', 30 * MIN, 12 * MIN), endedRun('first', 80 * MIN, 60 * MIN)] });
    expect(laneContentKey(timelineLanes(rows, NOW, moved).agents)).not.toBe(key);
  });
});
