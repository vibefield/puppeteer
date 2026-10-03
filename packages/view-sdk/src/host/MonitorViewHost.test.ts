// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reactMonitorView } from '../react/index.js';
import {
  agentViewFixture,
  agentViewsFixture,
  fixtureSpawnMenu,
  fixtureStage,
  fixtureTheme,
} from '../testing/fixtures.js';
import { createFrameDriver } from '../testing/frames.js';
import { createRecordingView } from '../testing/recording-view.js';
import { createFixtureReplica } from '../testing/replica.js';
import { MonitorViewHost, type MonitorViewHostProps } from './MonitorViewHost.js';
import { VIEW_ROOT_ATTRIBUTE, VIEW_SLOT_ATTRIBUTES } from './slot.js';

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function host(act = true) {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = act;
  const container = document.createElement('main');
  document.body.append(container);
  const root: Root = createRoot(container);
  cleanups.push(() => {
    container.remove();
  });
  const frames = createFrameDriver();
  const replica = createFixtureReplica(agentViewsFixture(2));
  const props = (overrides: Partial<MonitorViewHostProps> = {}): MonitorViewHostProps => ({
    replica,
    view: createRecordingView().view,
    stage: fixtureStage('default'),
    theme: fixtureTheme('dark'),
    parameters: { speed: 1 },
    commands: { select: () => undefined, create: () => undefined },
    scheduler: frames.scheduler,
    className: 'stage-slot',
    ...overrides,
  });
  const element = (overrides?: Partial<MonitorViewHostProps>): ReactElement =>
    createElement(MonitorViewHost, props(overrides));
  return { container, root, frames, replica, element };
}

const viewRoots = (container: HTMLElement) => container.querySelectorAll(`[${VIEW_ROOT_ATTRIBUTE}]`);

describe('MonitorViewHost', () => {
  it('renders the slot element and mounts the view inside it', async () => {
    const { container, root, element } = host();
    const recording = createRecordingView('list');
    await act(async () => root.render(element({ view: recording.view })));
    const slot = container.querySelector('.stage-slot')!;
    expect(slot.hasAttribute(VIEW_SLOT_ATTRIBUTES.slot)).toBe(true);
    expect(slot.getAttribute(VIEW_SLOT_ATTRIBUTES.view)).toBe('list');
    expect(viewRoots(container)).toHaveLength(1);
    expect(recording.mounts).toBe(1);
    await act(async () => root.unmount());
  });

  it('turns prop changes into one update at the next frame, and ignores props equal in value', async () => {
    const { root, frames, element } = host();
    const recording = createRecordingView('list');
    await act(async () => root.render(element({ view: recording.view })));
    await act(async () => root.render(element({ view: recording.view, theme: fixtureTheme('light') })));
    expect(recording.updates).toBe(0);
    await act(async () => frames.step());
    expect(recording.updates).toBe(1);

    const sameStage = structuredClone(fixtureStage('default'));
    await act(async () =>
      root.render(
        element({ view: recording.view, theme: fixtureTheme('light'), stage: sameStage, parameters: { speed: 1 } }),
      ),
    );
    await act(async () => frames.step(2));
    expect(recording.updates).toBe(1);
    await act(async () => root.unmount());
  });

  it('switches views inside the host commit, so no frame is left without a view', () => {
    const { container, root, element } = host(false);
    const swarm = createRecordingView('swarm');
    const list = reactMonitorView({ ...createRecordingView('list').view.manifest }, ({ input }) =>
      createElement('ol', null, `${input.model.agents.length} rows`),
    );
    flushSync(() => root.render(element({ view: swarm.view })));
    expect(container.textContent).toBe('swarm');

    flushSync(() => root.render(element({ view: list })));
    // Synchronously after the commit, before the browser could paint: the old view is gone, the new one drawn.
    expect(swarm.unmounts).toBe(1);
    expect(viewRoots(container)).toHaveLength(1);
    expect(container.textContent).toBe('2 rows');
    flushSync(() => root.unmount());
  });

  it("disposes the slot when it unmounts, React views included, without React's warning", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { container, root, replica, element } = host();
      const list = reactMonitorView({ ...createRecordingView('list').view.manifest }, () =>
        createElement('ol', null, 'rows'),
      );
      await act(async () => root.render(element({ view: list })));
      expect(container.textContent).toBe('rows');
      await act(async () => root.unmount());
      expect(container.childNodes).toHaveLength(0);
      expect(replica.subscribers).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('sends commands and reports to the latest props without remounting the view', async () => {
    const { root, element } = host();
    const recording = createRecordingView('list');
    const first = { select: vi.fn(), create: vi.fn() };
    const second = { select: vi.fn(), create: vi.fn() };
    const onReport = vi.fn();
    await act(async () => root.render(element({ view: recording.view, commands: first })));
    await act(async () => root.render(element({ view: recording.view, commands: second, onReport })));
    recording.commands[0]!.select('agent-02');
    recording.commands[0]!.report({ renderer: 'dom' });
    expect(first.select).not.toHaveBeenCalled();
    expect(second.select).toHaveBeenCalledWith('agent-02');
    expect(onReport).toHaveBeenCalledWith({ renderer: 'dom' }, recording.view);
    expect(recording.mounts).toBe(1);
    await act(async () => root.unmount());
  });

  it('takes capabilities that go away as none, not as the last ones', async () => {
    const { root, frames, element } = host();
    const recording = createRecordingView('list');
    const spawn = { devices: [{ id: 'desk', label: 'Desk', self: true, state: 'ready' as const }] };
    await act(async () => root.render(element({ view: recording.view, capabilities: { spawn } })));
    expect(recording.lastInput!.capabilities).toEqual({ spawn });
    await act(async () => root.render(element({ view: recording.view })));
    await act(async () => frames.step());
    expect(recording.lastInput!.capabilities).toEqual({});
    await act(async () => root.unmount());
  });

  it('wires one scheduler into the replica and the slot, so a change lands in the frame it arrived in (M7)', async () => {
    const { root, frames, element } = host();
    const replica = createFixtureReplica(agentViewsFixture(2), { scheduler: frames.scheduler });
    const recording = createRecordingView('list');
    await act(async () => root.render(element({ view: recording.view, replica, scheduler: frames.scheduler })));
    replica.apply({ upsert: [agentViewFixture({ id: 'agent-new', createdAt: Date.UTC(2027, 0, 1) })] });
    await act(async () => frames.step());
    expect(recording.updates).toBe(1);
    expect(recording.lastInput!.changes.added).toEqual(['agent-new']);
    await act(async () => root.unmount());
  });

  it("fills the view's spawn from the replica when the host passes none (M2)", async () => {
    const { root, element } = host();
    const menu = fixtureSpawnMenu();
    const replica = createFixtureReplica({ revision: 1, rows: agentViewsFixture(2), spawn: menu });
    const recording = createRecordingView('list');
    await act(async () => root.render(element({ view: recording.view, replica })));
    expect(recording.lastInput!.capabilities.spawn).toBe(menu);
    await act(async () => root.unmount());
  });

  it('leaves exactly one view mounted under StrictMode', async () => {
    const { container, root, element } = host();
    const recording = createRecordingView('list');
    await act(async () => root.render(createElement(StrictMode, null, element({ view: recording.view }))));
    expect(recording.live).toBe(1);
    expect(viewRoots(container)).toHaveLength(1);
    await act(async () => root.unmount());
    expect(recording.live).toBe(0);
  });
});
