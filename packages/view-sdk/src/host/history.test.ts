// @vitest-environment happy-dom
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { MonitorPastSnapshot, MonitorPastSpanKind } from '../model.js';
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
