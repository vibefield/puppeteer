import { describe, expect, it } from 'vitest';
import type { MonitorHistoryBook, MonitorLaneHistory } from '../../monitor/status-history.js';
import { STATUS_HISTORY_HORIZON_MS } from '../../monitor/status-history.js';
import type { MonitorAgent } from '../../monitor/types.js';
import {
  ENDED_ALPHA,
  QUIET_ALPHA,
  laneAlpha,
  lanesInView,
  laneFromRow,
  noteFirstSeen,
  stateAt,
  stepLight,
  timelineLanes,
} from './timeline-lanes.js';

const NOW = Date.UTC(2026, 9, 2, 15, 0, 0);
const MIN = 60_000;

function row(overrides: Partial<MonitorAgent>): MonitorAgent {
  return {
    id: 'row',
    createdAtMs: NOW - 60 * MIN,
    status: 'idle',
    project: 'vibe-field',
    detail: '',
    color: '#6366f1',
    active: false,
    ...overrides,
  };
}

function agentRow(id: string, bornAgo: number, overrides: Partial<MonitorAgent> = {}): MonitorAgent {
  return row({
    id,
    createdAtMs: NOW - bornAgo,
    agent: { provider: { id: 'imposter', label: 'Imposter' }, recency: 'fresh' },
    ...overrides,
  });
}

const book = (lanes: Record<string, MonitorLaneHistory>, ended: MonitorAgent[] = []): MonitorHistoryBook => ({
  lanes: new Map(Object.entries(lanes)),
  ended,
});

describe('timelineLanes', () => {
  it('orders agents by birth, never by status, and puts bare terminals in their own group', () => {
    const set = timelineLanes({
      agents: [
        agentRow('late', 10 * MIN, { status: 'blocked' }),
        row({ id: 'shell', createdAtMs: NOW - 90 * MIN }),
        agentRow('early', 50 * MIN),
      ],
      nowMs: NOW,
    });
    expect(set.agents.map((lane) => lane.id)).toEqual(['early', 'late']);
    expect(set.terminals.map((lane) => lane.id)).toEqual(['shell']);
  });

  it('keeps an ended agent in its birth slot among the live ones', () => {
    const endedRow = agentRow('gone', 40 * MIN);
    const set = timelineLanes({
      agents: [agentRow('a', 50 * MIN), agentRow('b', 30 * MIN)],
      history: book(
        {
          gone: {
            recordedFromMs: NOW - 40 * MIN,
            spans: [{ status: 'working', fromMs: NOW - 40 * MIN, toMs: NOW - 20 * MIN }],
            endedAtMs: NOW - 20 * MIN,
          },
        },
        [endedRow],
      ),
      nowMs: NOW,
    });
    expect(set.agents.map((lane) => lane.id)).toEqual(['a', 'gone', 'b']);
    expect(set.agents[1]?.endedAtMs).toBe(NOW - 20 * MIN);
    // It stays until it scrolls out past the window's left edge.
    expect(lanesInView(set, NOW - 30 * MIN).agents.map((lane) => lane.id)).toContain('gone');
    expect(lanesInView(set, NOW - 15 * MIN).agents.map((lane) => lane.id)).not.toContain('gone');
  });

  it('draws a row with no book as unrecorded until its current status began (TL-D9)', () => {
    const since = new Date(NOW - 7 * MIN).toISOString();
    const lane = laneFromRow(
      agentRow('a', 50 * MIN, {
        status: 'idle',
        unread: true,
        agent: {
          provider: { id: 'imposter', label: 'Imposter' },
          recency: 'fresh',
          monitor: { statusSince: since, blockers: [] } as never,
        },
      }),
      NOW,
    );
    expect(lane.bornMs).toBe(NOW - 50 * MIN);
    expect(lane.recordedFromMs).toBe(NOW - 7 * MIN);
    expect(lane.spans).toEqual([{ status: 'unseen', fromMs: NOW - 7 * MIN }]);
  });

  it('records a bare terminal with no book from when the view first saw it', () => {
    const shell = row({ id: 'shell', createdAtMs: NOW - 90 * MIN, status: 'working' });
    const set = timelineLanes({ agents: [shell], nowMs: NOW, firstSeen: new Map([['shell', NOW - 3 * MIN]]) });
    expect(set.terminals[0]?.recordedFromMs).toBe(NOW - 3 * MIN);
    expect(set.terminals[0]?.spans[0]?.status).toBe('working');
  });

  it('falls back to the row when the book has no lane for it, and clips the book to the horizon', () => {
    const horizon = NOW - STATUS_HISTORY_HORIZON_MS;
    const set = timelineLanes({
      agents: [agentRow('old', STATUS_HISTORY_HORIZON_MS + 60 * MIN), agentRow('new', 5 * MIN)],
      history: book({
        old: {
          recordedFromMs: horizon - 60 * MIN,
          spans: [
            { status: 'working', fromMs: horizon - 60 * MIN, toMs: horizon - 30 * MIN },
            { status: 'idle', fromMs: horizon - 30 * MIN, toMs: horizon + 10 * MIN },
            { status: 'working', fromMs: horizon + 10 * MIN },
          ],
        },
      }),
      nowMs: NOW,
    });
    const old = set.agents.find((lane) => lane.id === 'old')!;
    expect(old.recordedFromMs).toBe(horizon);
    expect(old.spans.map((span) => [span.status, span.fromMs])).toEqual([
      ['idle', horizon],
      ['working', horizon + 10 * MIN],
    ]);
    expect(set.agents.find((lane) => lane.id === 'new')?.spans).toHaveLength(1);
  });

  it('never draws a book-ended row that is also live', () => {
    const live = agentRow('a', 20 * MIN);
    const set = timelineLanes({
      agents: [live],
      history: book({ a: { recordedFromMs: NOW - 20 * MIN, spans: [{ status: 'working', fromMs: NOW - 20 * MIN }] } }, [
        live,
      ]),
      nowMs: NOW,
    });
    expect(set.agents).toHaveLength(1);
  });
});

describe('stateAt', () => {
  const lane = timelineLanes({
    agents: [agentRow('a', 60 * MIN)],
    history: book({
      a: {
        recordedFromMs: NOW - 40 * MIN,
        spans: [
          { status: 'working', fromMs: NOW - 40 * MIN, toMs: NOW - 10 * MIN },
          { status: 'blocked', fromMs: NOW - 10 * MIN, blocker: { kind: 'permission' } },
        ],
      },
    }),
    nowMs: NOW,
  }).agents[0]!;

  it('reads unborn, unrecorded and each span', () => {
    expect(stateAt(lane, NOW - 70 * MIN).kind).toBe('unborn');
    expect(stateAt(lane, NOW - 50 * MIN).kind).toBe('unrecorded');
    const working = stateAt(lane, NOW - 20 * MIN);
    expect(working.kind === 'span' && working.span.status).toBe('working');
    const blocked = stateAt(lane, NOW - MIN);
    expect(blocked.kind === 'span' && blocked.span.status).toBe('blocked');
  });

  it('reads ended from the end on', () => {
    expect(stateAt({ ...lane, endedAtMs: NOW - 5 * MIN }, NOW - MIN).kind).toBe('ended');
  });
});

describe('noteFirstSeen', () => {
  it('keeps first sightings, forgets rows that left, and returns the same map when nothing moved', () => {
    const first = noteFirstSeen(new Map(), [row({ id: 'a' }), row({ id: 'b' })], 100);
    expect([...first]).toEqual([
      ['a', 100],
      ['b', 100],
    ]);
    expect(noteFirstSeen(first, [row({ id: 'a' }), row({ id: 'b' })], 200)).toBe(first);
    expect([...noteFirstSeen(first, [row({ id: 'b' })], 300)]).toEqual([['b', 100]]);
  });
});

describe('receded lanes', () => {
  const gone = agentRow('gone', 40 * MIN, { receded: true });
  const set = timelineLanes({
    agents: [agentRow('a', 50 * MIN), agentRow('quiet', 45 * MIN, { receded: true }), agentRow('b', 30 * MIN)],
    history: book(
      {
        gone: {
          recordedFromMs: NOW - 40 * MIN,
          spans: [{ status: 'working', fromMs: NOW - 40 * MIN, toMs: NOW - 20 * MIN }],
          endedAtMs: NOW - 20 * MIN,
        },
      },
      [gone],
    ),
    nowMs: NOW,
  });
  const lanes = set.agents;

  it('keep their birth slot, live or ended', () => {
    expect(lanes.map((lane) => [lane.id, lane.receded])).toEqual([
      ['a', false],
      ['quiet', true],
      ['gone', true],
      ['b', false],
    ]);
  });

  it('are drawn quiet, and fainter again when ended; a lane the pointer lights is whole', () => {
    expect(laneAlpha(lanes[0]!, 0, -1)).toBe(1);
    expect(laneAlpha(lanes[1]!, 1, -1)).toBe(QUIET_ALPHA);
    expect(laneAlpha(lanes[2]!, 2, -1)).toBeCloseTo(QUIET_ALPHA * ENDED_ALPHA);
    expect(laneAlpha(lanes[1]!, 1, 1)).toBe(1);
    expect(laneAlpha(lanes[1]!, 1, 0)).toBe(QUIET_ALPHA);
    expect(laneAlpha(lanes[0]!, 0, 3)).toBe(QUIET_ALPHA);
  });

  it('are stepped over by ↑ and ↓', () => {
    expect(stepLight(lanes, -1, 1)).toBe(0);
    expect(stepLight(lanes, 0, 1)).toBe(3);
    expect(stepLight(lanes, 3, 1)).toBe(3);
    expect(stepLight(lanes, 3, -1)).toBe(0);
    expect(stepLight(lanes, -1, -1)).toBe(3);
    // A receded lane the pointer lit is left by the next key, not re-lit.
    expect(stepLight(lanes, 1, 1)).toBe(3);
  });
});
