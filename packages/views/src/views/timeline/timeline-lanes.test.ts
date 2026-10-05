import { describe, expect, it } from 'vitest';
import type { AgentView } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import {
  dayStart,
  earliestHead,
  laneContentKey,
  laneAlpha,
  laneFor,
  laneStatus,
  QUIET_ALPHA,
  stateAt,
  stepLight,
  timelineLanes,
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
