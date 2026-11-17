// @vitest-environment happy-dom
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { MonitorEndedRow, MonitorPastSnapshot, MonitorPastSpan, MonitorPastSpanKind } from '../model.js';
import {
  agentViewFixture,
  agentViewsFixture,
  fixtureHistory,
  fixtureStage,
  fixtureTheme,
} from '../testing/fixtures.js';
import { createFrameDriver } from '../testing/frames.js';
import { createRecordingView } from '../testing/recording-view.js';
import { createFixtureReplica } from '../testing/replica.js';
import type { EndedLaneView, MonitorCapabilities, MonitorHistory, ViewReport } from '../view.js';
import { HISTORY_WINDOW_MS, keepPast, lendHistory, viewWantsHistory } from './history.js';
import { createViewSlot } from './slot.js';

const elements: HTMLElement[] = [];
afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
});

const PAST: MonitorPastSnapshot = {
  sinceMs: 0,
  untilMs: 86_400_000,
  readAt: 86_400_000,
  fidelity: 'turns',
  state: 'complete',
  live: [{ id: 'agent-1', seamAt: 7_200_000, spans: [{ kind: 'worked', from: 3_600_000, to: 7_200_000 }] }],
  ended: [
    {
      id: 'past:claude:a',
      title: 'Split the invoice writer',
      profileSet: 'work',
      project: { name: 'billing-api', seq: 3 },
      device: { id: 'desk', name: 'Desk', self: true },
      startedAt: 0,
      endedAt: 600_000,
      spans: [{ kind: 'bounds', from: 0, to: 600_000 }],
    },
    {
      id: 'past:claude:b',
      project: { name: '' },
      device: { id: 'desk', name: 'Desk', self: true },
      startedAt: 10,
      endedAt: 20,
      spans: [],
    },
  ],
};

const LEND = {
  colourFor: (seq: number | undefined) => (seq === undefined ? 'neutral' : `ink-${seq}`),
  receded: (lane: { profileSet?: string | undefined }) => lane.profileSet !== 'work',
};

// A production read asks the day before it, `[now − 24 h, now]` (T2), and the backend starts a span that began before
// the window at the window's start.
const NOW = Date.UTC(2026, 0, 2, 12);
const HOUR = 3_600_000;
const SINCE = NOW - HISTORY_WINDOW_MS;
/** How much later the next read comes. */
const LATER = 30_000;
const DESK = { id: 'desk', name: 'Desk', self: true };

/** The day read at NOW: a live row and an ended run whose records both began before it, so the window clips both. */
const DAY: MonitorPastSnapshot = {
  sinceMs: SINCE,
  untilMs: NOW,
  readAt: NOW,
  fidelity: 'turns',
  state: 'complete',
  live: [
    {
      id: 'agent-1',
      seamAt: NOW - HOUR,
      spans: [
        { kind: 'quiet', from: SINCE, to: NOW - 2 * HOUR },
        { kind: 'worked', from: NOW - 2 * HOUR, to: NOW - HOUR },
      ],
    },
  ],
  ended: [
    {
      id: 'past:claude:long',
      title: 'Split the invoice writer',
      project: { name: 'billing-api', seq: 3 },
      device: DESK,
      startedAt: SINCE - HOUR,
      endedAt: NOW - 3 * HOUR,
      spans: [
        { kind: 'quiet', from: SINCE, to: NOW - 4 * HOUR },
        { kind: 'worked', from: NOW - 4 * HOUR, to: NOW - 3 * HOUR },
      ],
    },
  ],
};

/** A lane as the read LATER answers it: its first span starts at the moved window's start. */
function clippedLater<Lane extends { readonly spans: readonly MonitorPastSpan[] }>(lane: Lane): Lane {
  const [first, ...rest] = lane.spans;
  return { ...lane, spans: [{ ...first!, from: SINCE + LATER }, ...rest] };
}

describe('the history capability (a minor: plain data in place of `never`)', () => {
  it('is the record’s past a view receives; a view asks nothing, and the kinds cannot say blocked or unseen', () => {
    expectTypeOf<NonNullable<MonitorCapabilities['history']>>().toEqualTypeOf<MonitorHistory>();
    expectTypeOf<EndedLaneView['colour']>().toEqualTypeOf<string>();
    expectTypeOf<EndedLaneView['receded']>().toEqualTypeOf<boolean>();
    expectTypeOf<MonitorPastSpanKind>().toEqualTypeOf<'worked' | 'quiet' | 'unrecorded' | 'bounds'>();
    expectTypeOf<MonitorHistory['state']>().toEqualTypeOf<'complete' | 'partial' | 'unavailable'>();
    // the ask is the manifest's: a report carries none
    expectTypeOf<keyof ViewReport>().toEqualTypeOf<'renderer' | 'physics' | 'keysHeld'>();
    expect(HISTORY_WINDOW_MS).toBe(24 * 60 * 60_000);
  });

  it('a host reads only for a view whose manifest declares it', () => {
    const declares = createRecordingView('t', { manifest: { capabilities: { optional: ['history'] } } });
    const spawnOnly = createRecordingView('s', { manifest: { capabilities: { optional: ['spawn'] } } });
    expect(viewWantsHistory(declares.view)).toBe(true);
    expect(viewWantsHistory(spawnOnly.view)).toBe(false);
    expect(viewWantsHistory(createRecordingView('r').view)).toBe(false);
  });

  it('lendHistory colours and recedes each ended lane by the window’s rules and leaves the rest as the backend said', () => {
    const colourFor = vi.fn(LEND.colourFor);
    const lent = lendHistory(PAST, { ...LEND, colourFor });
    expect(lent.ended.map((lane) => [lane.id, lane.colour, lane.receded, lane.title])).toEqual([
      ['past:claude:a', 'ink-3', false, 'Split the invoice writer'],
      ['past:claude:b', 'neutral', true, undefined],
    ]);
    expect(lent.live).toBe(PAST.live);
    expect([lent.sinceMs, lent.untilMs, lent.fidelity, lent.state]).toEqual([0, 86_400_000, 'turns', 'complete']);
    expect(Object.isFrozen(lent)).toBe(true);
    expect(Object.isFrozen(lent.ended[0])).toBe(true);
  });

  it('keepPast keeps the snapshot a re-read did not move — a new readAt alone moves nothing', () => {
    const reread: MonitorPastSnapshot = JSON.parse(JSON.stringify({ ...PAST, readAt: PAST.readAt + 30_000 }));
    expect(keepPast(PAST, reread)).toBe(PAST);
    expect(keepPast(undefined, reread)).toBe(reread);
    const moved: MonitorPastSnapshot = { ...reread, ended: reread.ended.slice(1) };
    expect(keepPast(PAST, moved)).toBe(moved);
    const partial: MonitorPastSnapshot = { ...reread, state: 'partial', detail: 'The agent index is starting' };
    expect(keepPast(PAST, partial)).toBe(partial);
  });

  it('keepPast keeps a re-read whose window moved and whose past did not', () => {
    // half a minute on, a production re-read moves its window, its readAt and every start the window clips, and
    // nothing the day holds
    const reread: MonitorPastSnapshot = JSON.parse(
      JSON.stringify({
        ...DAY,
        sinceMs: SINCE + LATER,
        untilMs: NOW + LATER,
        readAt: NOW + LATER,
        live: DAY.live.map(clippedLater),
        ended: DAY.ended.map(clippedLater),
      }),
    );
    expect(keepPast(DAY, reread)).toBe(DAY);
    // a span new inside the window is news: the row's status moved on, and its past reaches it
    const [lane] = reread.live;
    const lived: MonitorPastSnapshot = {
      ...reread,
      live: [{ ...lane!, seamAt: NOW, spans: [...lane!.spans, { kind: 'quiet', from: NOW - HOUR, to: NOW }] }],
    };
    expect(keepPast(DAY, lived)).toBe(lived);
    // so is a state or a detail
    const partial: MonitorPastSnapshot = { ...reread, state: 'partial', detail: 'The agent index is starting' };
    expect(keepPast(DAY, partial)).toBe(partial);
    // and so is a run the moved window left: kept with no span, its last activity at the window's new start
    const early: MonitorEndedRow = {
      id: 'past:claude:early',
      project: { name: '' },
      device: DESK,
      startedAt: SINCE + 10_000,
      endedAt: SINCE + LATER,
      spans: [{ kind: 'bounds', from: SINCE + 10_000, to: SINCE + LATER }],
    };
    const emptied: MonitorPastSnapshot = { ...reread, ended: [...reread.ended, { ...early, spans: [] }] };
    expect(keepPast({ ...DAY, ended: [...DAY.ended, early] }, emptied)).toBe(emptied);
    // or gone, ended before it
    const gone: MonitorEndedRow = {
      ...early,
      endedAt: SINCE + 20_000,
      spans: [{ kind: 'bounds', from: SINCE + 10_000, to: SINCE + 20_000 }],
    };
    expect(keepPast({ ...DAY, ended: [...DAY.ended, gone] }, reread)).toBe(reread);
  });

  it('reaches a mounted view’s input as the same object until the host lends another', () => {
    const element = document.createElement('section');
    document.body.append(element);
    elements.push(element);
    const frames = createFrameDriver();
    const agents = agentViewsFixture(2);
    const history = fixtureHistory({
      live: [agentViewFixture({ id: agents[0]!.id, statusSince: Date.UTC(2026, 0, 1, 20) })],
    });
    const recording = createRecordingView('timeline', { manifest: { capabilities: { optional: ['history'] } } });
    const slot = createViewSlot(element, {
      view: recording.view,
      replica: createFixtureReplica(agents),
      input: { stage: fixtureStage('default'), theme: fixtureTheme('dark'), parameters: {}, capabilities: {} },
      commands: { select: vi.fn(), create: vi.fn() },
      scheduler: frames.scheduler,
    });
    // absent until the first answer: the view draws today's floor
    expect(recording.lastInput!.capabilities.history).toBeUndefined();
    const capabilities = { history };
    slot.setInput({ capabilities });
    frames.step();
    expect(recording.lastInput!.capabilities.history).toBe(history);
    expect(recording.lastInput!.capabilities.history!.live[0]!.id).toBe(agents[0]!.id);
    expect(recording.lastInput!.capabilities.history!.ended.map((lane) => [lane.project.name, lane.title])).toEqual([
      ['billing-api', 'Split the invoice writer'],
      ['rosetta', undefined],
    ]);
    // the same capabilities again is no update: a view's caches keyed on the object hold
    const updates = recording.updates;
    slot.setInput({ capabilities });
    frames.step();
    expect(recording.updates).toBe(updates);
  });

  it('the fixture’s floor is one bounds span per ended run and no live past', () => {
    const floor = fixtureHistory({ fidelity: 'bounds', live: [agentViewFixture()] });
    expect(floor.live).toEqual([]);
    expect(floor.ended.map((lane) => lane.spans.map((span) => span.kind))).toEqual([['bounds'], ['bounds']]);
    expect(floor.ended.every((lane) => lane.receded === false)).toBe(true);
  });
});
