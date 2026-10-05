// @vitest-environment happy-dom
import { act, createContext, createElement, useContext } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { reactMonitorView } from '../react/index.js';
import { agentViewsFixture, fixtureStage, fixtureTheme } from '../testing/fixtures.js';
import { createFrameDriver } from '../testing/frames.js';
import { createFixtureReplica } from '../testing/replica.js';
import type { MonitorViewCommands, MonitorViewInput } from '../view.js';
import { isLegacyMonitorView, legacyView } from './legacy.js';
import { createViewSlot } from './slot.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const elements: HTMLElement[] = [];
afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
});

/** An old-style view: its own props, a provider it reads, an action that takes the whole row. */
interface OldAgent {
  readonly id: string;
  readonly label: string;
}
interface OldProps {
  readonly agents: readonly OldAgent[];
  readonly actions: { select(agent: OldAgent): void };
  readonly history: string;
}
const PhysicsContext = createContext('inline');
let renders = 0;
function OldSwarm({ agents, actions, history }: OldProps) {
  renders += 1;
  const physics = useContext(PhysicsContext);
  return createElement(
    'section',
    { 'data-physics': physics, 'data-history': history },
    agents.map((agent) =>
      createElement('button', { key: agent.id, type: 'button', onClick: () => actions.select(agent) }, agent.label),
    ),
  );
}

const SWARM_REGISTRY_ENTRY = {
  id: 'swarm',
  label: 'SWARM',
  parameterGroups: [
    { title: 'MOTION', controls: [{ key: 'speed', label: 'SPEED', min: 0, max: 2, step: 0.1, defaultValue: 1 }] },
  ],
  parametersRevision: 'motion-2',
  Component: OldSwarm,
};

function bridged(history: { current: string }) {
  return legacyView(
    SWARM_REGISTRY_ENTRY,
    SWARM_REGISTRY_ENTRY.Component,
    (input: MonitorViewInput, commands: MonitorViewCommands): OldProps => ({
      agents: input.model.agents.map((agent) => ({ id: agent.id, label: agent.project.name || agent.id })),
      actions: { select: (agent) => commands.select(agent.id) },
      history: history.current,
    }),
    (view) => createElement(PhysicsContext.Provider, { value: 'worker' }, view),
  );
}

function mountInSlot(history = { current: 'h1' }) {
  const element = document.createElement('section');
  document.body.append(element);
  elements.push(element);
  const frames = createFrameDriver();
  const replica = createFixtureReplica(agentViewsFixture(3, { terminals: false }));
  const commands = { select: vi.fn(), create: vi.fn() };
  const view = bridged(history);
  return {
    element,
    frames,
    replica,
    commands,
    view,
    history,
    start: () => {
      return createViewSlot(element, {
        view,
        replica,
        input: { stage: fixtureStage(), theme: fixtureTheme(), parameters: {} },
        commands,
        scheduler: frames.scheduler,
      });
    },
  };
}

describe('legacyView', () => {
  it('reads a legacy registry entry as a manifest, with safe defaults for what it lacks', () => {
    const view = bridged({ current: 'h1' });
    expect(view.manifest).toEqual({
      sdk: 1,
      id: 'swarm',
      label: 'SWARM',
      mark: { viewBox: '0 0 16 16', paths: [] },
      parameters: SWARM_REGISTRY_ENTRY.parameterGroups,
      parametersRevision: 'motion-2',
      motion: { loops: true },
    });
    expect(isLegacyMonitorView(view)).toBe(true);
    expect(isLegacyMonitorView(reactMonitorView(view.manifest, () => null))).toBe(false);
  });

  it('mounts the old component through a slot, with props from toProps and the providers wrap keeps', async () => {
    const { element, commands, start } = mountInSlot();
    await act(async () => {
      start();
    });
    const section = element.querySelector('section')!;
    expect(section.dataset['physics']).toBe('worker');
    expect([...section.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'billing-api',
      'vibe-field',
      'rosetta',
    ]);
    await act(async () => section.querySelector('button')!.click());
    expect(commands.select).toHaveBeenCalledWith('agent-01');
  });

  it('renders again when the input changes, and on refresh for host state beside the input', async () => {
    const { element, frames, replica, view, history, start } = mountInSlot();
    await act(async () => {
      start();
    });
    const before = renders;
    await act(async () => {
      replica.apply({ remove: ['agent-01'] });
      frames.step();
    });
    expect(renders).toBe(before + 1);
    expect(element.querySelectorAll('button')).toHaveLength(2);

    history.current = 'h2';
    await act(async () => view.refresh());
    expect(renders).toBe(before + 2);
    expect(element.querySelector('section')!.dataset['history']).toBe('h2');
  });

  it('commits an update inside the frame that brought it, not a task later (M62)', async () => {
    const { element, frames, replica, start } = mountInSlot();
    await act(async () => {
      start();
    });
    await act(async () => {
      replica.apply({ remove: ['agent-01'] });
      frames.step();
      // act has flushed nothing yet: the root committed within the frame callback, beside the host's.
      expect(element.querySelectorAll('button')).toHaveLength(2);
    });
  });

  it('lets go of its root on unmount, after which refresh draws nothing', async () => {
    const { element, view, start } = mountInSlot();
    let slot!: ReturnType<typeof start>;
    await act(async () => {
      slot = start();
    });
    await act(async () => slot.dispose());
    expect(element.childNodes).toHaveLength(0);
    const before = renders;
    await act(async () => view.refresh());
    expect(renders).toBe(before);
  });
});
