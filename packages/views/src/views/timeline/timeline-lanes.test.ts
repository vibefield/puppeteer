import { describe, expect, it } from 'vitest';
import type { MonitorHistoryBook, MonitorLaneHistory } from '../../monitor/status-history.js';
import { STATUS_HISTORY_HORIZON_MS } from '../../monitor/status-history.js';
import type { MonitorAgent } from '../../monitor/types.js';
import {
  clipToHorizon,
  createLaneCache,
  laneContentKey,
  scrolledOutIds,
  spanIndexAt,
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

describe('the span window search', () => {
  const spans = Array.from({ length: 2000 }, (_, index) => ({
    status: (index % 2 ? 'idle' : 'working') as 'idle' | 'working',
    fromMs: index * MIN,
    toMs: (index + 1) * MIN,
  }));

  it('finds the span that has begun by t, -1 before the first', () => {
    expect(spanIndexAt(spans, -1)).toBe(-1);
    expect(spanIndexAt(spans, 0)).toBe(0);
    expect(spanIndexAt(spans, 1234 * MIN + 5)).toBe(1234);
    expect(spanIndexAt(spans, 1e12)).toBe(1999);
    expect(spanIndexAt([], 5)).toBe(-1);
  });

  it('clips to the horizon without copying a record that does not reach it', () => {
    expect(clipToHorizon(spans, -5)).toBe(spans);
    const clipped = clipToHorizon(spans, 1500.5 * MIN);
    expect(clipped).toHaveLength(500);
    expect(clipped[0]).toMatchObject({ fromMs: 1500.5 * MIN, toMs: 1501 * MIN });
    // A span that ends exactly at the horizon is dropped.
    expect(clipToHorizon(spans, 1500 * MIN)[0]?.fromMs).toBe(1500 * MIN);
  });
});

describe('the lane cache', () => {
  const record: MonitorLaneHistory = {
    recordedFromMs: NOW - 30 * MIN,
    spans: [
      { status: 'working', fromMs: NOW - 30 * MIN, toMs: NOW - 10 * MIN },
      { status: 'idle', fromMs: NOW - 10 * MIN },
    ],
  };

  it('keeps a lane’s object while its record and row are the same, and its spans while only the row is new', () => {
    const cache = createLaneCache();
    const agent = agentRow('a', 40 * MIN);
    const first = cache.lane(agent, record, NOW);
    expect(cache.lane(agent, record, NOW + 1000)).toBe(first);
    expect(first.spans).toBe(record.spans);
    const again = cache.lane({ ...agent, receded: true }, record, NOW + 2000);
    expect(again).not.toBe(first);
    expect(again.spans).toBe(first.spans);
    expect(again.receded).toBe(true);
    // A new record is a new lane.
    expect(cache.lane(agent, { ...record }, NOW).spans).toBe(record.spans);
  });

  it('is what timelineLanes uses when handed one', () => {
    const cache = createLaneCache();
    const agents = [agentRow('a', 40 * MIN)];
    const history = book({ a: record });
    const one = timelineLanes({ agents, history, nowMs: NOW, cache });
    const two = timelineLanes({ agents, history, nowMs: NOW + 500, cache });
    expect(two.agents[0]).toBe(one.agents[0]);
  });
});

describe('laneContentKey', () => {
  it('holds for a fresh row object that draws the same, and moves when a span does', () => {
    const history = book({
      a: { recordedFromMs: NOW - 30 * MIN, spans: [{ status: 'working', fromMs: NOW - 30 * MIN }] },
    });
    const key = (agents: MonitorAgent[], h = history): string =>
      laneContentKey(timelineLanes({ agents, history: h, nowMs: NOW }).agents);
    const base = key([agentRow('a', 40 * MIN)]);
    expect(key([agentRow('a', 40 * MIN, { detail: 'something new' })])).toBe(base);
    const moved = book({
      a: {
        recordedFromMs: NOW - 30 * MIN,
        spans: [
          { status: 'working', fromMs: NOW - 30 * MIN, toMs: NOW - MIN },
          { status: 'blocked', fromMs: NOW - MIN },
        ],
      },
    });
    expect(key([agentRow('a', 40 * MIN)], moved)).not.toBe(base);
    expect(key([agentRow('a', 40 * MIN, { receded: true })])).not.toBe(base);
  });
});

describe('scrolledOutIds', () => {
  it('names the ended lanes past the window’s left edge', () => {
    const set = {
      agents: [
        { ...laneFromRow(agentRow('a', 40 * MIN), NOW), endedAtMs: NOW - 20 * MIN },
        { ...laneFromRow(agentRow('b', 40 * MIN), NOW), endedAtMs: NOW - 5 * MIN },
        laneFromRow(agentRow('c', 40 * MIN), NOW),
      ],
      terminals: [],
    };
    expect(scrolledOutIds(set, NOW - 10 * MIN)).toBe('a');
    expect(scrolledOutIds(set, NOW)).toBe('a\nb');
  });
});
