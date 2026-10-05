// @vitest-environment happy-dom
import { act, createElement, useId } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createViewSlot } from '../host/slot.js';
import { duringHostCommit } from '../internal/react-root.js';
import { agentViewsFixture, fixtureInput, fixtureModel, fixtureStage, fixtureTheme } from '../testing/fixtures.js';
import { createFrameDriver } from '../testing/frames.js';
import { createFixtureReplica } from '../testing/replica.js';
import type { MonitorViewCommands, MonitorViewManifest } from '../view.js';
import { reactMonitorView, type ReactMonitorViewProps } from './index.js';

const MANIFEST: MonitorViewManifest = {
  sdk: 1,
  id: 'probe',
  label: 'PROBE',
  mark: { viewBox: '0 0 16 16', paths: ['M0 0h16v16H0z'] },
  parameters: [],
  motion: { loops: false },
};

const COMMANDS: MonitorViewCommands = {
  select: () => undefined,
  create: () => Promise.resolve({ opened: true }),
  report: () => undefined,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const elements: HTMLElement[] = [];
function element(): HTMLElement {
  const created = document.createElement('div');
  document.body.append(created);
  elements.push(created);
  return created;
}
afterEach(() => {
  for (const created of elements.splice(0)) created.remove();
});

describe('reactMonitorView', () => {
  it('renders the component into its own root with the input and the commands', async () => {
    const select = vi.fn();
    function Probe({ input, commands }: ReactMonitorViewProps) {
      return createElement(
        'button',
        { type: 'button', 'data-scheme': input.theme.scheme, onClick: () => commands.select('agent-01') },
        `${input.model.agents.length} agents`,
      );
    }
    const root = element();
    const view = reactMonitorView(MANIFEST, Probe);
    await act(async () => {
      view.mount(root, fixtureInput({ agents: agentViewsFixture(3) }), { ...COMMANDS, select });
    });
    const button = root.querySelector('button')!;
    expect(button.textContent).toBe('3 agents');
    expect(button.dataset['scheme']).toBe('dark');
    await act(async () => button.click());
    expect(select).toHaveBeenCalledWith('agent-01');
    expect(view.Component).toBe(Probe);
  });

  it('renders again only when a part of the input changed identity', async () => {
    let renders = 0;
    function Probe({ input }: ReactMonitorViewProps) {
      renders += 1;
      return createElement('p', null, input.theme.scheme);
    }
    const root = element();
    const input = fixtureInput({ agents: agentViewsFixture(2) });
    const view = reactMonitorView(MANIFEST, Probe);
    let instance!: ReturnType<typeof view.mount>;
    await act(async () => {
      instance = view.mount(root, input, COMMANDS);
    });
    expect(renders).toBe(1);

    // A fresh input object whose parts are all the same objects is no news.
    await act(async () => instance.update({ ...input }));
    expect(renders).toBe(1);

    await act(async () => instance.update({ ...input, theme: fixtureTheme('light') }));
    expect(renders).toBe(2);
    expect(root.textContent).toBe('light');

    const model = fixtureModel(agentViewsFixture(4), 2);
    await act(async () => instance.update({ ...input, theme: fixtureTheme('light'), model }));
    expect(renders).toBe(3);
  });

  it('unmounts its root, and ignores an update that arrives after', async () => {
    const root = element();
    const view = reactMonitorView(MANIFEST, () => createElement('p', null, 'here'));
    const input = fixtureInput();
    let instance!: ReturnType<typeof view.mount>;
    await act(async () => {
      instance = view.mount(root, input, COMMANDS);
    });
    expect(root.textContent).toBe('here');
    await act(async () => instance.unmount());
    expect(root.childNodes).toHaveLength(0);
    expect(() => instance.update({ ...input, theme: fixtureTheme('light') })).not.toThrow();
    expect(() => instance.unmount()).not.toThrow();
  });

  it('gives every mount its own useId space, so two roots never share an id', async () => {
    function Probe() {
      return createElement('span', { id: useId() });
    }
    const view = reactMonitorView(MANIFEST, Probe);
    const first = element();
    const second = element();
    await act(async () => {
      view.mount(first, fixtureInput(), COMMANDS);
      view.mount(second, fixtureInput(), COMMANDS);
    });
    const ids = [first, second].map((root) => root.querySelector('span')!.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(
      ids.every((id) => /probe-\d+-/.test(id)),
      ids.join(' '),
    ).toBe(true);
  });

  it('puts its root class on the element it is given while mounted, and takes it off at unmount (L18)', async () => {
    const root = element();
    root.className = 'host-own';
    const view = reactMonitorView(MANIFEST, () => createElement('p', null, 'styled'), { rootClass: 'mv-probe' });
    let instance!: ReturnType<typeof view.mount>;
    await act(async () => {
      instance = view.mount(root, fixtureInput(), COMMANDS);
    });
    expect(root.className).toBe('host-own mv-probe');
    await act(async () => instance.unmount());
    expect(root.className).toBe('host-own');

    // Without one, the element keeps exactly the classes it came with.
    const bare = element();
    const plain = reactMonitorView(MANIFEST, () => null);
    await act(async () => {
      plain.mount(bare, fixtureInput(), COMMANDS).unmount();
    });
    expect(bare.hasAttribute('class')).toBe(false);
  });

  it('refuses a manifest the contract cannot serve', () => {
    const newer = { ...MANIFEST, sdk: 2 } as unknown as MonitorViewManifest;
    expect(() => reactMonitorView(newer, () => null)).toThrow(RangeError);
    expect(() => reactMonitorView({ ...MANIFEST, id: 'Not A Slug' }, () => null)).toThrow(RangeError);
  });

  it("lets go of its root a microtask late inside a React host's commit, without React's warning", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const root = element();
      const view = reactMonitorView(MANIFEST, () => createElement('p', null, 'here'));
      let instance!: ReturnType<typeof view.mount>;
      await act(async () => {
        instance = view.mount(root, fixtureInput(), COMMANDS);
      });
      await act(async () => {
        duringHostCommit(() => instance.unmount());
        expect(root.textContent).toBe('here');
      });
      expect(root.childNodes).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("commits an update inside the slot's frame that brought it, beside the host's root (M62)", async () => {
    function Probe({ input }: ReactMonitorViewProps) {
      return createElement('p', null, `${input.model.agents.length} agents`);
    }
    const root = element();
    const replica = createFixtureReplica(agentViewsFixture(3));
    const frames = createFrameDriver();
    await act(async () => {
      createViewSlot(root, {
        view: reactMonitorView(MANIFEST, Probe),
        replica,
        input: { stage: fixtureStage(), theme: fixtureTheme(), parameters: {} },
        commands: { select: vi.fn(), create: vi.fn() },
        scheduler: frames.scheduler,
      });
    });
    expect(root.textContent).toBe('3 agents');
    await act(async () => {
      replica.apply({ remove: ['agent-01'] });
      frames.step();
      // act has flushed nothing yet: the view's root committed within the frame callback.
      expect(root.textContent).toBe('2 agents');
    });
  });

  it("keeps an update scheduled inside a React host's commit, without React's warning (M62)", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const root = element();
      const input = fixtureInput();
      const view = reactMonitorView(MANIFEST, ({ input: { theme } }: ReactMonitorViewProps) =>
        createElement('p', null, theme.scheme),
      );
      let instance!: ReturnType<typeof view.mount>;
      await act(async () => {
        instance = view.mount(root, input, COMMANDS);
      });
      await act(async () => {
        duringHostCommit(() => instance.update({ ...input, theme: fixtureTheme('light') }));
        expect(root.textContent).toBe('dark');
      });
      expect(root.textContent).toBe('light');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
