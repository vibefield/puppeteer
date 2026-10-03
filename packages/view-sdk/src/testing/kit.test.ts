// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { MonitorAgentRow } from '../model.js';
import { createFixtureClock } from './clock.js';
import {
  agentViewFixture,
  agentViewsFixture,
  FIXTURE_EPOCH,
  fixtureInput,
  fixtureTheme,
  parameterDefaults,
} from './fixtures.js';
import { createFrameDriver } from './frames.js';
import { deepFreeze } from './freeze.js';
import { createFixtureReplica } from './replica.js';

describe('fixtures', () => {
  it('build the same agents on every run, and different costs for a different seed', () => {
    expect(agentViewsFixture(20)).toEqual(agentViewsFixture(20));
    expect(agentViewsFixture(20, { seed: 2 })).not.toEqual(agentViewsFixture(20));
    const crowd = agentViewsFixture(20);
    expect(new Set(crowd.map((agent) => agent.status))).toEqual(new Set(['working', 'blocked', 'idle']));
    expect(crowd.filter((agent) => agent.kind === 'terminal')).toHaveLength(2);
    expect(crowd.every((agent) => agent.createdAt >= FIXTURE_EPOCH)).toBe(true);
  });

  it('keep the theme a host would keep: the same object until something changed', () => {
    expect(fixtureTheme('light')).toBe(fixtureTheme('light'));
    expect(fixtureTheme('light', { animations: false }).tokens).toBe(fixtureTheme('light').tokens);
    expect(fixtureTheme('light').tokens).not.toEqual(fixtureTheme('dark').tokens);
  });

  it('read parameter defaults off a manifest', () => {
    expect(
      parameterDefaults({
        parameters: [
          { title: 'MOTION', controls: [{ key: 'speed', label: 'SPEED', min: 0, max: 2, step: 0.1, defaultValue: 1 }] },
        ],
      }),
    ).toEqual({ speed: 1 });
  });

  it('build a whole input, every agent added', () => {
    const input = fixtureInput({ agents: agentViewsFixture(3) });
    expect(input.changes.added).toEqual(['agent-01', 'agent-02', 'agent-03']);
    expect(input.model.byId.get('agent-02')).toBe(input.model.agents[1]);
  });
});

describe('createFixtureReplica', () => {
  it('keeps an unchanged agent and an unchanged model, and tells nobody about a write that changed nothing', () => {
    const replica = createFixtureReplica(agentViewsFixture(3, { terminals: false }));
    const before = replica.getSnapshot().model;
    const listener = vi.fn();
    replica.subscribe(listener);
    replica.set(before.agents);
    expect(listener).not.toHaveBeenCalled();
    expect(replica.getSnapshot().model).toBe(before);

    const changed = { ...before.agents[1]!, status: 'blocked' as const };
    replica.apply({ upsert: [changed] });
    expect(listener).toHaveBeenCalledOnce();
    const after = replica.getSnapshot();
    expect(after.model.revision).toBe(before.revision + 1);
    expect(after.model.agents[0]).toBe(before.agents[0]);
    expect(after.model.byId.get(changed.id)).toBe(changed);
    expect(after.changes).toEqual({ added: [], updated: [changed.id], removed: [] });
    expect(replica.notifications).toBe(1);
  });

  it("joins a backend snapshot's rows the way a replica does, in the model's order", () => {
    const {
      colour: _colour,
      active: _active,
      receded: _receded,
      ...terminal
    } = agentViewFixture({
      id: 't-1',
      kind: 'terminal',
      createdAt: FIXTURE_EPOCH,
      project: { name: '', seq: undefined },
    });
    const {
      colour: _c,
      active: _a,
      receded: _r,
      ...agent
    } = agentViewFixture({ id: 'a-1', createdAt: FIXTURE_EPOCH + 1 });
    const rows: MonitorAgentRow[] = [terminal, agent];
    const replica = createFixtureReplica({ revision: 7, rows });
    const { model } = replica.getSnapshot();
    expect(model.revision).toBe(7);
    expect(model.agents.map((row) => row.id)).toEqual(['a-1', 't-1']);
    expect(model.agents.every((row) => typeof row.colour === 'string' && row.active === false)).toBe(true);
    // The same row object again keeps its view.
    replica.set(rows);
    expect(replica.getSnapshot().model).toBe(model);
  });

  it('stops telling a subscriber that left', () => {
    const replica = createFixtureReplica();
    const listener = vi.fn();
    const leave = replica.subscribe(listener);
    expect(replica.subscribers).toBe(1);
    leave();
    replica.set(agentViewsFixture(1));
    expect(listener).not.toHaveBeenCalled();
    expect(replica.subscribers).toBe(0);
  });
});

describe('deepFreeze', () => {
  it('freezes objects and arrays all the way down, and stops a Map and a Set from changing', () => {
    const value = deepFreeze({ list: [{ deep: 1 }], index: new Map([['a', { deep: 2 }]]), tags: new Set(['x']) });
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.index.get('a'))).toBe(true);
    expect(() => value.index.set('b', { deep: 3 })).toThrow(/frozen map/);
    expect(() => value.index.delete('a')).toThrow(/frozen map/);
    expect(() => value.tags.add('y')).toThrow(/frozen set/);
    expect(() => {
      (value.list as { deep: number }[]).push({ deep: 4 });
    }).toThrow(TypeError);
    expect(value.index.get('a')).toEqual({ deep: 2 });
    expect(deepFreeze(value)).toBe(value);
  });
});

describe('createFixtureClock', () => {
  it('moves only when told, and owns Date.now and performance.now while installed', () => {
    const clock = createFixtureClock();
    const dateNow = Date.now;
    const performanceNow = performance.now;
    const restore = clock.install();
    try {
      expect(Date.now()).toBe(FIXTURE_EPOCH);
      expect(performance.now()).toBe(0);
      clock.advance(1_500);
      expect(Date.now()).toBe(FIXTURE_EPOCH + 1_500);
      expect(performance.now()).toBe(1_500);
      expect(() => clock.advance(-1)).toThrow(RangeError);
    } finally {
      restore();
    }
    expect(Date.now).toBe(dateNow);
    expect(performance.now).toBe(performanceNow);
  });
});

describe('createFrameDriver', () => {
  it('runs frames only when stepped, counts them, and holds a callback requested during a frame for the next', () => {
    const frames = createFrameDriver();
    const seen: number[] = [];
    const tick = (time: number): void => {
      seen.push(time);
      if (seen.length < 3) frames.requestAnimationFrame(tick);
    };
    frames.requestAnimationFrame(tick);
    expect(frames.pending).toBe(1);
    expect(frames.step()).toBe(1);
    expect(frames.step(5)).toBe(2);
    expect(seen).toHaveLength(3);
    expect(seen[1]! - seen[0]!).toBeCloseTo(1000 / 60);
    expect([frames.requested, frames.ran, frames.frames, frames.pending]).toEqual([3, 3, 6, 0]);
  });

  it('becomes the page animation frame while installed, and gives it back', () => {
    const frames = createFrameDriver();
    const original = window.requestAnimationFrame;
    const restore = frames.install();
    try {
      const callback = vi.fn();
      const handle = requestAnimationFrame(callback);
      expect(frames.pending).toBe(1);
      cancelAnimationFrame(handle);
      expect(frames.pending).toBe(0);
    } finally {
      restore();
    }
    expect(window.requestAnimationFrame).toBe(original);
  });

  it('steps a fixture clock with its frames, for goldens', () => {
    const clock = createFixtureClock();
    const frames = createFrameDriver({ clock, frameMs: 20 });
    const times: number[] = [];
    frames.requestAnimationFrame((time) => times.push(time));
    frames.step();
    expect(times).toEqual([20]);
    expect(clock.now()).toBe(FIXTURE_EPOCH + 20);
  });

  it('finishes a frame whose callback threw, and reports the error', () => {
    const errors: unknown[] = [];
    const frames = createFrameDriver({ onError: (error) => errors.push(error) });
    const after = vi.fn();
    frames.requestAnimationFrame(() => {
      throw new Error('paint failed');
    });
    frames.requestAnimationFrame(after);
    frames.step();
    expect(after).toHaveBeenCalledOnce();
    expect(errors).toEqual([new Error('paint failed')]);

    const strict = createFrameDriver();
    strict.requestAnimationFrame(() => {
      throw new Error('paint failed');
    });
    expect(() => strict.step()).toThrow('paint failed');
  });

  it('drives a slot scheduler on its frames', () => {
    const frames = createFrameDriver();
    const work = vi.fn();
    frames.scheduler.request(work);
    expect(work).not.toHaveBeenCalled();
    frames.step();
    expect(work).toHaveBeenCalledOnce();
    frames.scheduler.request(work);
    frames.clear();
    frames.step();
    expect(work).toHaveBeenCalledOnce();
  });
});
