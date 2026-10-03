// @vitest-environment happy-dom
import { act, createElement, useEffect, useLayoutEffect } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { reactMonitorView, type ReactMonitorViewProps } from '../react/index.js';
import type { MonitorViewManifest } from '../view.js';
import { countCommits, countingCommands, countReactEffects, type EffectCounter } from './counters.js';
import { agentViewsFixture, fixtureInput, fixtureModel, fixtureTheme } from './fixtures.js';

const MANIFEST: MonitorViewManifest = {
  sdk: 1,
  id: 'counted',
  label: 'COUNTED',
  mark: { viewBox: '0 0 16 16', paths: [] },
  parameters: [],
  motion: { loops: false },
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const roots: HTMLElement[] = [];
function root(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  roots.push(element);
  return element;
}
let counter: EffectCounter | undefined;
afterEach(() => {
  counter?.restore();
  counter = undefined;
  for (const element of roots.splice(0)) element.remove();
});

/** One effect keyed on the theme, one layout effect at mount only. */
function Themed({ input }: ReactMonitorViewProps) {
  useEffect(() => () => undefined, [input.theme]);
  useLayoutEffect(() => () => undefined, []);
  return createElement('p', null, input.model.agents.length);
}

describe('countingCommands', () => {
  it('remembers every call of the three', () => {
    const counting = countingCommands();
    counting.commands.select('agent-01');
    counting.commands.create({ x: 1, y: 2 }, { deviceId: 'peer' });
    counting.commands.create();
    counting.commands.report({ renderer: 'dom' });
    expect(counting.selects).toEqual(['agent-01']);
    expect(counting.creates).toEqual([{ at: { x: 1, y: 2 }, target: { deviceId: 'peer' } }, {}]);
    expect(counting.reports).toEqual([{ renderer: 'dom' }]);
    expect(counting.calls).toBe(4);
    counting.reset();
    expect(counting.calls).toBe(0);
  });
});

describe('countCommits', () => {
  it("counts the view's React commits, its mount's included", async () => {
    const counted = countCommits(reactMonitorView(MANIFEST, Themed));
    const input = fixtureInput({ agents: agentViewsFixture(2) });
    let instance!: ReturnType<typeof counted.view.mount>;
    await act(async () => {
      instance = counted.view.mount(root(), input, countingCommands().commands);
    });
    expect(counted.commits).toBe(1);
    await act(async () => instance.update({ ...input }));
    expect(counted.commits).toBe(1);
    await act(async () => instance.update({ ...input, theme: fixtureTheme('light') }));
    expect(counted.commits).toBe(2);
    counted.reset();
    expect(counted.commits).toBe(0);
    await act(async () => instance.unmount());
  });
});

describe('countReactEffects', () => {
  it('counts effect runs and cleanups as React calls them, without touching the view', async () => {
    counter = countReactEffects();
    const view = reactMonitorView(MANIFEST, Themed);
    const input = fixtureInput({ agents: agentViewsFixture(2) });
    let instance!: ReturnType<typeof view.mount>;
    await act(async () => {
      instance = view.mount(root(), input, countingCommands().commands);
    });
    expect([counter.runs, counter.cleanups]).toEqual([2, 0]);

    // A new model alone moves no effect keyed on the theme.
    await act(async () => instance.update({ ...input, model: fixtureModel(agentViewsFixture(3), 2) }));
    expect([counter.runs, counter.cleanups]).toEqual([2, 0]);

    await act(async () => instance.update({ ...input, theme: fixtureTheme('light') }));
    expect([counter.runs, counter.cleanups]).toEqual([3, 1]);

    await act(async () => instance.unmount());
    expect([counter.runs, counter.cleanups]).toEqual([3, 3]);
  });

  it('stops counting on restore, and refuses a second counter while one holds the dispatcher', async () => {
    counter = countReactEffects();
    expect(() => countReactEffects()).toThrow(/React 19/);
    counter.restore();
    const after = countReactEffects();
    try {
      const view = reactMonitorView(MANIFEST, Themed);
      counter.reset();
      let instance!: ReturnType<typeof view.mount>;
      await act(async () => {
        instance = view.mount(root(), fixtureInput(), countingCommands().commands);
      });
      await act(async () => instance.unmount());
      expect(counter.runs).toBe(0);
      expect([after.runs, after.cleanups]).toEqual([2, 2]);
    } finally {
      after.restore();
    }
  });
});
