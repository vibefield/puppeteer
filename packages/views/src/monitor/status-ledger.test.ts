import type { AgentMonitorState } from '@vibecook/puppeteer-core';
import { describe, expect, it } from 'vitest';
import { STATUS_HISTORY_HORIZON_MS, STATUS_HISTORY_MAX_CHANGES, STATUS_HISTORY_TEXT_MAX } from './status-history.js';
import {
  EMPTY_STATUS_LEDGER,
  endStatusLane,
  observeStatuses,
  seedStatusHistory,
  statusHistoryBook,
  type StatusLedger,
} from './status-ledger.js';
import type { MonitorAgent } from './types.js';

const T0 = Date.parse('2026-10-02T14:00:00.000Z');
const at = (seconds: number): number => T0 + seconds * 1000;
const iso = (seconds: number): string => new Date(at(seconds)).toISOString();

interface Spec {
  status: MonitorAgent['status'];
  since?: number;
  unread?: boolean;
  line?: string;
  blocker?: { kind: string; detail?: string; prompt?: string };
}

function row(id: string, spec: Spec): MonitorAgent {
  const monitor = {
    status: spec.status,
    statusSince: iso(spec.since ?? 0),
    blockers: spec.blocker
      ? [
          {
            id: 'b1',
            kind: spec.blocker.kind,
            since: iso(spec.since ?? 0),
            ...(spec.blocker.detail ? { detail: spec.blocker.detail } : {}),
            ...(spec.blocker.prompt ? { questions: [{ prompt: spec.blocker.prompt }] } : {}),
          },
        ]
      : [],
    ...(spec.line ? { activity: { kind: 'tool', line: spec.line, since: iso(spec.since ?? 0) } } : {}),
  } as unknown as AgentMonitorState;
  return {
    id,
    createdAtMs: at(-600),
    status: spec.status,
    project: 'p',
    detail: '',
    color: '#888888',
    active: false,
    ...(spec.unread ? { unread: true } : {}),
    agent: { provider: { id: 'imposter', label: 'Imposter' }, monitor, recency: 'fresh' },
  };
}

function fold(steps: [number, MonitorAgent[]][], from: StatusLedger = EMPTY_STATUS_LEDGER): StatusLedger {
  return steps.reduce((ledger, [seconds, agents]) => observeStatuses(ledger, agents, at(seconds)), from);
}

const spans = (ledger: StatusLedger, id = 'a') =>
  statusHistoryBook(ledger)
    .lanes.get(id)
    ?.spans.map((s) => [s.status, (s.fromMs - T0) / 1000, s.toMs === undefined ? undefined : (s.toMs - T0) / 1000]);

describe('observeStatuses', () => {
  it('records a lane from where Core says its current state began, not from first sight', () => {
    const ledger = fold([[30, [row('a', { status: 'working', since: -120 })]]]);
    expect(spans(ledger)).toEqual([['working', -120, undefined]]);
  });

  it("places a change at Core's moment, so a turn between two projections lands where it happened", () => {
    const ledger = fold([
      [0, [row('a', { status: 'working', since: -10 })]],
      [20, [row('a', { status: 'idle', since: 12 })]],
      [40, [row('a', { status: 'working', since: 41 })]],
    ]);
    expect(spans(ledger)).toEqual([
      ['working', -10, 12],
      ['idle', 12, 40],
      ['working', 40, undefined],
    ]);
  });

  it('keeps a reply unseen from when it landed until the moment it was opened', () => {
    const ledger = fold([
      [0, [row('a', { status: 'working', since: -10 })]],
      [20, [row('a', { status: 'idle', since: 15, unread: true })]],
      [90, [row('a', { status: 'idle', since: 15 })]],
    ]);
    expect(spans(ledger)).toEqual([
      ['working', -10, 15],
      ['unseen', 15, 90],
      ['idle', 90, undefined],
    ]);
  });

  it('turns an idle stretch unseen from its start when the mark comes at the same moment', () => {
    const ledger = fold([
      [0, [row('a', { status: 'working', since: -10 })]],
      [20, [row('a', { status: 'idle', since: 15 })]],
      [21, [row('a', { status: 'idle', since: 15, unread: true })]],
    ]);
    expect(spans(ledger)).toEqual([
      ['working', -10, 15],
      ['unseen', 15, undefined],
    ]);
  });

  it("keeps a working span's latest activity line and a blocker's words, bounded", () => {
    const long = 'x'.repeat(STATUS_HISTORY_TEXT_MAX + 40);
    const ledger = fold([
      [0, [row('a', { status: 'working', since: 0, line: 'Read DESIGN.md' })]],
      [5, [row('a', { status: 'working', since: 0, line: 'Edit tl-view.js' })]],
      [9, [row('a', { status: 'blocked', since: 9, blocker: { kind: 'question', prompt: long } })]],
    ]);
    const lane = statusHistoryBook(ledger).lanes.get('a')!;
    expect(lane.spans[0]!.did).toBe('Edit tl-view.js');
    expect(lane.spans[1]!.blocker?.kind).toBe('question');
    expect(lane.spans[1]!.blocker?.detail).toHaveLength(STATUS_HISTORY_TEXT_MAX);
  });

  it('ends a lane whose row leaves, keeps its last row, and resumes it if the row comes back', () => {
    const first = fold([
      [0, [row('a', { status: 'working', since: 0 })]],
      [30, []],
    ]);
    const book = statusHistoryBook(first);
    expect(book.lanes.get('a')).toMatchObject({ endedAtMs: at(30) });
    expect(book.lanes.get('a')!.spans.at(-1)!.toMs).toBe(at(30));
    expect(book.ended.map((agent) => agent.id)).toEqual(['a']);
    const back = observeStatuses(first, [row('a', { status: 'idle', since: 10 })], at(60));
    const resumed = statusHistoryBook(back);
    expect(resumed.ended).toEqual([]);
    expect(spans(back)).toEqual([
      // Core says idle since 10; the record cannot speak for the time it was gone, so idle starts at the cut
      ['working', 0, 30],
      ['idle', 30, undefined],
    ]);
  });

  it('forgets an ended lane after a day, and keeps at most the newest changes', () => {
    const ended = fold([
      [0, [row('a', { status: 'working', since: 0 })]],
      [10, []],
    ]);
    expect(observeStatuses(ended, [], at(10) + STATUS_HISTORY_HORIZON_MS + 1).lanes.has('a')).toBe(false);
    let ledger = EMPTY_STATUS_LEDGER;
    for (let i = 0; i < STATUS_HISTORY_MAX_CHANGES + 50; i++) {
      ledger = observeStatuses(ledger, [row('a', { status: i % 2 ? 'idle' : 'working', since: i })], at(i));
    }
    expect(statusHistoryBook(ledger).lanes.get('a')!.spans).toHaveLength(STATUS_HISTORY_MAX_CHANGES);
  });

  it('keeps a lane object while nothing in it changed', () => {
    const one = fold([[0, [row('a', { status: 'working', since: 0 })]]]);
    const two = observeStatuses(one, [row('a', { status: 'working', since: 0 })], at(5));
    expect(statusHistoryBook(two).lanes.get('a')).toBe(statusHistoryBook(one).lanes.get('a'));
  });
});

describe('seedStatusHistory', () => {
  it('lays a durable record under the observed one, the observed winning at the same moment', () => {
    const observed = fold([
      [100, [row('a', { status: 'working', since: 10 })]],
      [130, [row('a', { status: 'idle', since: 120, unread: true })]],
    ]);
    const seeded = seedStatusHistory(
      observed,
      'a',
      {
        recordedFromMs: at(-300),
        changes: [
          { status: 'unknown', atMs: at(-300) },
          { status: 'working', atMs: at(-200), did: 'Run pnpm verify' },
          { status: 'blocked', atMs: at(-100), blocker: { kind: 'permission' } },
          { status: 'working', atMs: at(10) },
          { status: 'idle', atMs: at(120) },
        ],
      },
      at(130),
    );
    expect(spans(seeded)).toEqual([
      ['working', -200, -100],
      ['blocked', -100, 10],
      ['working', 10, 120],
      ['unseen', 120, undefined],
    ]);
    expect(statusHistoryBook(seeded).lanes.get('a')!.spans[0]!.did).toBe('Run pnpm verify');
  });

  it('leaves the stretch before a later unknown running, never a guessed state', () => {
    const seeded = seedStatusHistory(
      EMPTY_STATUS_LEDGER,
      'a',
      {
        recordedFromMs: at(0),
        changes: [
          { status: 'working', atMs: at(0) },
          { status: 'unknown', atMs: at(30) },
          { status: 'idle', atMs: at(60) },
        ],
        endedAtMs: at(90),
      },
      at(100),
    );
    expect(spans(seeded)).toEqual([
      ['working', 0, 60],
      ['idle', 60, 90],
    ]);
  });

  it('is idempotent when the same record is seeded twice', () => {
    const record = {
      recordedFromMs: at(0),
      changes: [
        { status: 'working', atMs: at(0) },
        { status: 'idle', atMs: at(9) },
      ],
    };
    const once = seedStatusHistory(EMPTY_STATUS_LEDGER, 'a', record, at(10));
    expect(spans(seedStatusHistory(once, 'a', record, at(10)))).toEqual(spans(once));
  });
});

describe('endStatusLane', () => {
  it('names an ended run the host learned about while nobody watched', () => {
    const seeded = seedStatusHistory(
      EMPTY_STATUS_LEDGER,
      'gone',
      { recordedFromMs: at(0), changes: [{ status: 'working', atMs: at(0) }], endedAtMs: at(40) },
      at(50),
    );
    const named = endStatusLane(seeded, row('gone', { status: 'idle' }), at(40));
    const book = statusHistoryBook(named);
    expect(book.ended.map((agent) => agent.id)).toEqual(['gone']);
    expect(spans(named, 'gone')).toEqual([['working', 0, 40]]);
  });
});
