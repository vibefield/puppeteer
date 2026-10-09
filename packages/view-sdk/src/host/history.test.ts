// @vitest-environment happy-dom
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { MonitorPastSnapshot } from '../model.js';
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
import type { MonitorCapabilities, MonitorHistory, MonitorHistoryAsk, ViewReport } from '../view.js';
import { lendHistory } from './history.js';
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
      project: { name: 'billing-api', seq: 3 },
      device: { id: 'desk', name: 'Desk', self: true },
      startedAt: 0,
      endedAt: 600_000,
      spans: [{ kind: 'active', from: 0, to: 600_000 }],
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

describe('the history capability (a minor: plain data in place of `never`)', () => {
  it('is the record’s past a view receives, and an ask a view reports', () => {
    expectTypeOf<NonNullable<MonitorCapabilities['history']>>().toEqualTypeOf<MonitorHistory>();
    expectTypeOf<NonNullable<ViewReport['history']>>().toEqualTypeOf<MonitorHistoryAsk>();
    expectTypeOf<MonitorHistory['ended'][number]['colour']>().toEqualTypeOf<string>();
  });

  it('lendHistory colours each ended lane with the theme function and leaves the rest as the backend said', () => {
    const colourFor = vi.fn((seq: number | undefined) => (seq === undefined ? 'neutral' : `ink-${seq}`));
    const lent = lendHistory(PAST, colourFor);
    expect(lent.ended.map((lane) => [lane.id, lane.colour])).toEqual([
      ['past:claude:a', 'ink-3'],
      ['past:claude:b', 'neutral'],
    ]);
    expect(lent.live).toBe(PAST.live);
    expect([lent.sinceMs, lent.untilMs, lent.fidelity, lent.state]).toEqual([0, 86_400_000, 'turns', 'complete']);
    expect(Object.isFrozen(lent)).toBe(true);
    expect(Object.isFrozen(lent.ended[0])).toBe(true);
  });

  it('reaches a mounted view’s input, and the view’s ask reaches the host until the view goes', () => {
    const element = document.createElement('section');
    document.body.append(element);
    elements.push(element);
    const frames = createFrameDriver();
    const agents = agentViewsFixture(2);
    const history = fixtureHistory({
      live: [agentViewFixture({ id: agents[0]!.id, statusSince: Date.UTC(2026, 0, 1, 20) })],
    });
    const recording = createRecordingView('timeline', { manifest: { capabilities: { optional: ['history'] } } });
    const onReport = vi.fn();
    const slot = createViewSlot(element, {
      view: recording.view,
      replica: createFixtureReplica(agents),
      input: { stage: fixtureStage('default'), theme: fixtureTheme('dark'), parameters: {}, capabilities: {} },
      commands: { select: vi.fn(), create: vi.fn() },
      onReport,
      scheduler: frames.scheduler,
    });
    expect(recording.lastInput!.capabilities.history).toBeUndefined();

    const ask: MonitorHistoryAsk = { sinceMs: history.sinceMs };
    recording.commands[0]!.report({ history: ask });
    expect(onReport).toHaveBeenLastCalledWith({ history: ask }, recording.view);

    slot.setInput({ capabilities: { history } });
    frames.step();
    expect(recording.lastInput!.capabilities.history).toBe(history);
    expect(recording.lastInput!.capabilities.history!.live[0]!.id).toBe(agents[0]!.id);
    expect(recording.lastInput!.capabilities.history!.ended.map((lane) => lane.project.name)).toEqual([
      'billing-api',
      'rosetta',
    ]);

    // a scrub back past what it holds: the same window, asked again
    recording.commands[0]!.report({ history: { sinceMs: history.sinceMs, seq: 1 } });
    expect(onReport).toHaveBeenLastCalledWith({ history: { sinceMs: history.sinceMs, seq: 1 } }, recording.view);

    // the view goes: its ask goes with it, so a host asks nothing more (PF6)
    const next = createRecordingView('swarm');
    slot.switchView(next.view);
    expect(onReport).toHaveBeenLastCalledWith({}, next.view);
  });

  it('the fixture’s floor is one active band per ended run and no live past', () => {
    const floor = fixtureHistory({ fidelity: 'bounds', live: [agentViewFixture()] });
    expect(floor.live).toEqual([]);
    expect(floor.ended.map((lane) => lane.spans.map((span) => span.kind))).toEqual([['active'], ['active']]);
  });
});
