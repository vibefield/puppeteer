// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentViewFixture,
  agentViewsFixture,
  fixtureSpawnMenu,
  fixtureStage,
  fixtureTheme,
} from '../testing/fixtures.js';
import { createFrameDriver, type FrameDriver } from '../testing/frames.js';
import { createRecordingView } from '../testing/recording-view.js';
import { createFixtureReplica, type FixtureReplica } from '../testing/replica.js';
import { defineMonitorView, type MonitorView, type MonitorViewManifest } from '../view.js';
import { createFrameScheduler } from './frame-scheduler.js';
import { createViewSlot, VIEW_ROOT_ATTRIBUTE, VIEW_SLOT_ATTRIBUTES, type ViewSlotOptions } from './slot.js';

const elements: HTMLElement[] = [];
afterEach(() => {
  for (const element of elements.splice(0)) element.remove();
});

interface SetupOptions extends Partial<Omit<ViewSlotOptions, 'replica'>> {
  readonly replica?: FixtureReplica;
  /** Whose frames the slot's scheduler runs on (unless `scheduler` is given too). */
  readonly frames?: FrameDriver;
}

function setup({
  replica = createFixtureReplica(agentViewsFixture(3)),
  frames = createFrameDriver(),
  ...overrides
}: SetupOptions = {}) {
  const element = document.createElement('section');
  document.body.append(element);
  elements.push(element);
  const recording = createRecordingView('first');
  const commands = { select: vi.fn(), create: vi.fn() };
  const onReport = vi.fn();
  const slot = createViewSlot(element, {
    view: recording.view,
    replica,
    input: { stage: fixtureStage('default'), theme: fixtureTheme('dark'), parameters: { speed: 1 } },
    commands,
    onReport,
    scheduler: frames.scheduler,
    ...overrides,
  });
  return { element, frames, replica, recording, commands, onReport, slot };
}

const roots = (element: HTMLElement) => element.querySelectorAll(`[${VIEW_ROOT_ATTRIBUTE}]`);

const hostParts = () => ({ stage: fixtureStage('default'), theme: fixtureTheme('dark'), parameters: { speed: 1 } });

describe('createViewSlot', () => {
  it("mounts one view in a fresh root inside the host's element, with the replica's model and the host's parts", () => {
    const { element, replica, recording } = setup();
    expect(recording.mounts).toBe(1);
    expect(roots(element)).toHaveLength(1);
    expect(recording.roots[0]!.parentElement).toBe(element);
    const input = recording.lastInput!;
    expect(input.model).toBe(replica.getSnapshot().model);
    expect(input.changes.added).toEqual(replica.getSnapshot().model.agents.map((agent) => agent.id));
    expect(input.stage).toBe(fixtureStage('default'));
    expect(input.theme).toBe(fixtureTheme('dark'));
    expect(input.capabilities).toEqual({});
    expect(element.getAttribute(VIEW_SLOT_ATTRIBUTES.slot)).toBe('');
    expect(element.getAttribute(VIEW_SLOT_ATTRIBUTES.view)).toBe('first');
  });

  it('updates at most once per frame, however many changes arrive in it', () => {
    const { frames, replica, recording, slot } = setup();
    replica.apply({ upsert: [agentViewFixture({ id: 'agent-90', createdAt: 1 })] });
    replica.apply({ upsert: [agentViewFixture({ id: 'agent-91', createdAt: 2 })] });
    slot.setInput({ theme: fixtureTheme('light') });
    slot.setInput({ stage: fixtureStage('wide') });
    expect(recording.updates).toBe(0);
    frames.step();
    expect(recording.updates).toBe(1);
    const input = recording.lastInput!;
    expect(input.model).toBe(replica.getSnapshot().model);
    expect(input.theme).toBe(fixtureTheme('light'));
    expect(input.stage).toBe(fixtureStage('wide'));
    frames.step(3);
    expect(recording.updates).toBe(1);
  });

  it('updates only when a part changed identity, and keeps every unchanged part', () => {
    const { frames, replica, recording, slot } = setup();
    const first = recording.lastInput!;
    // Equal in value: a host re-rendering its literals is no news.
    slot.setInput({ stage: structuredClone(fixtureStage('default')), parameters: { speed: 1 } });
    slot.setInput({ theme: { ...fixtureTheme('dark') } });
    // A write that changes nothing notifies nobody.
    replica.set(replica.getSnapshot().model.agents);
    frames.step(2);
    expect(recording.updates).toBe(0);

    slot.setInput({ parameters: { speed: 2 } });
    frames.step();
    expect(recording.updates).toBe(1);
    const next = recording.lastInput!;
    expect(next.parameters).toEqual({ speed: 2 });
    expect(next.model).toBe(first.model);
    expect(next.stage).toBe(first.stage);
    expect(next.theme).toBe(first.theme);
    expect(next.changes).toEqual({ added: [], updated: [], removed: [] });
  });

  it("names what moved since the view's last update, across notifications it never saw one by one", () => {
    const { frames, replica, recording } = setup();
    const [kept, changed, gone] = replica.getSnapshot().model.agents;
    replica.apply({ upsert: [agentViewFixture({ id: 'agent-new', createdAt: Date.UTC(2027, 0, 1) })] });
    replica.apply({ upsert: [{ ...changed!, status: 'blocked' }] });
    replica.apply({ remove: [gone!.id] });
    frames.step();
    expect(recording.updates).toBe(1);
    expect(recording.lastInput!.changes).toEqual({ added: ['agent-new'], updated: [changed!.id], removed: [gone!.id] });
    expect(recording.lastInput!.model.byId.get(kept!.id)).toBe(kept);
  });

  it('switches by unmounting the old view first, so exactly one view is ever mounted', () => {
    const log: string[] = [];
    const first = createRecordingView('first', { log });
    const second = createRecordingView('second', { log });
    const { element, slot, replica } = setup({ view: first.view });
    slot.switchView(second.view);
    expect(log).toEqual(['first:mount', 'first:unmount', 'second:mount']);
    expect(roots(element)).toHaveLength(1);
    expect(first.roots[0]!.isConnected).toBe(false);
    expect(second.roots[0]!.isConnected).toBe(true);
    expect(second.lastInput!.model).toBe(replica.getSnapshot().model);
    expect(element.getAttribute(VIEW_SLOT_ATTRIBUTES.view)).toBe('second');
    slot.switchView(second.view);
    expect(log).toHaveLength(3);
  });

  it('leaves a view switched away unable to reach the host', () => {
    const second = createRecordingView('second');
    const { recording, commands, onReport, slot } = setup();
    const stale = recording.commands[0]!;
    slot.switchView(second.view);
    onReport.mockClear();
    stale.select('agent-01');
    stale.create({ x: 1, y: 2 });
    stale.report({ renderer: 'webgpu' });
    expect(commands.select).not.toHaveBeenCalled();
    expect(commands.create).not.toHaveBeenCalled();
    expect(onReport).not.toHaveBeenCalled();
    second.commands[0]!.select('agent-01');
    expect(commands.select).toHaveBeenCalledWith('agent-01');
  });

  it("answers the view's create from the host's return (M59): opened on a value or nothing, refused on a rejection or a throw, never rejecting", async () => {
    const { recording, commands, slot } = setup();
    const view = recording.commands[0]!;
    commands.create.mockReturnValueOnce(undefined);
    await expect(view.create({ x: 1, y: 2 })).resolves.toEqual({ opened: true });
    expect(commands.create).toHaveBeenLastCalledWith({ x: 1, y: 2 }, undefined);
    commands.create.mockReturnValueOnce(Promise.resolve('a session'));
    await expect(view.create(undefined, { deviceId: 'peer' })).resolves.toEqual({ opened: true });
    commands.create.mockReturnValueOnce(Promise.reject(new Error('no pane')));
    await expect(view.create()).resolves.toEqual({ opened: false });
    commands.create.mockImplementationOnce(() => {
      throw new Error('thrown');
    });
    await expect(view.create()).resolves.toEqual({ opened: false });
    expect(commands.create).toHaveBeenCalledTimes(4);
    // A view switched away is answered refused, and the host is not asked.
    slot.switchView(createRecordingView('second').view);
    await expect(view.create()).resolves.toEqual({ opened: false });
    expect(commands.create).toHaveBeenCalledTimes(4);
  });

  it('hands report to the host merged, and mirrors it on the slot element, never inside the view', () => {
    const { element, recording, onReport, slot } = setup();
    const commands = recording.commands[0]!;
    commands.report({ renderer: 'webgpu', physics: 'worker' });
    expect(onReport).toHaveBeenLastCalledWith({ renderer: 'webgpu', physics: 'worker' }, recording.view);
    commands.report({ keysHeld: true });
    expect(slot.report).toEqual({ renderer: 'webgpu', physics: 'worker', keysHeld: true });
    expect(element.getAttribute(VIEW_SLOT_ATTRIBUTES.renderer)).toBe('webgpu');
    expect(element.getAttribute(VIEW_SLOT_ATTRIBUTES.physics)).toBe('worker');
    expect(element.getAttribute(VIEW_SLOT_ATTRIBUTES.keysHeld)).toBe('true');
    expect(recording.roots[0]!.getAttributeNames()).toEqual([VIEW_ROOT_ATTRIBUTE, 'style']);

    // A repeated report is no news; a key set to undefined clears it.
    onReport.mockClear();
    commands.report({ keysHeld: true });
    expect(onReport).not.toHaveBeenCalled();
    commands.report({ keysHeld: false, physics: undefined });
    expect(slot.report).toEqual({ renderer: 'webgpu', keysHeld: false });
    expect(element.hasAttribute(VIEW_SLOT_ATTRIBUTES.keysHeld)).toBe(false);
    expect(element.hasAttribute(VIEW_SLOT_ATTRIBUTES.physics)).toBe(false);
  });

  it("clears the old view's report when it switches, and tells the host", () => {
    const second = createRecordingView('second');
    const { element, recording, onReport, slot } = setup();
    recording.commands[0]!.report({ renderer: 'canvas2d', keysHeld: true });
    slot.switchView(second.view);
    expect(onReport).toHaveBeenLastCalledWith({}, second.view);
    expect(element.hasAttribute(VIEW_SLOT_ATTRIBUTES.renderer)).toBe(false);
    expect(element.hasAttribute(VIEW_SLOT_ATTRIBUTES.keysHeld)).toBe(false);
  });

  it('takes a report sent from inside mount', () => {
    const reporting = createRecordingView('reporting', {
      onMount: (_root, _input, commands) => commands.report({ renderer: 'dom' }),
    });
    const { element, onReport } = setup({ view: reporting.view });
    expect(onReport).toHaveBeenCalledWith({ renderer: 'dom' }, reporting.view);
    expect(element.getAttribute(VIEW_SLOT_ATTRIBUTES.renderer)).toBe('dom');
  });

  it('defers a change a view causes from inside its own update to the next frame', () => {
    const { frames, replica, slot } = setup();
    let updates = 0;
    const echoing = createRecordingView('echoing', {
      onUpdate: () => {
        updates += 1;
        if (updates === 1) replica.apply({ upsert: [agentViewFixture({ id: 'agent-echo', createdAt: 5 })] });
      },
    });
    slot.switchView(echoing.view);
    slot.setInput({ theme: fixtureTheme('light') });
    frames.step();
    expect(updates).toBe(1);
    frames.step();
    expect(updates).toBe(2);
    expect(echoing.lastInput!.changes.added).toEqual(['agent-echo']);
  });

  it('disposes: unmounts, removes the root and every attribute, unsubscribes, and drops the pending frame', () => {
    const { element, frames, replica, recording, slot } = setup();
    recording.commands[0]!.report({ renderer: 'webgpu' });
    replica.apply({ remove: ['agent-01'] });
    slot.dispose();
    frames.step();
    expect(recording.unmounts).toBe(1);
    expect(recording.updates).toBe(0);
    expect(roots(element)).toHaveLength(0);
    expect(element.getAttributeNames()).toEqual([]);
    expect(replica.subscribers).toBe(0);
    expect(() => slot.dispose()).not.toThrow();
    slot.setInput({ theme: fixtureTheme('light') });
    expect(frames.pending).toBe(0);
  });

  it('refuses a view built for another contract and keeps the current one standing', () => {
    const { element, recording, slot } = setup();
    const newer = {
      ...createRecordingView('newer').view,
      manifest: { ...createRecordingView('newer').view.manifest, sdk: 2 } as unknown as MonitorViewManifest,
    } as MonitorView;
    expect(() => slot.switchView(newer)).toThrow(RangeError);
    expect(recording.live).toBe(1);
    expect(slot.view).toBe(recording.view);
    expect(roots(element)).toHaveLength(1);
  });

  it('reports a mount that throws, and leaves no root behind', () => {
    const onError = vi.fn();
    const broken = defineMonitorView({
      manifest: { ...createRecordingView('broken').view.manifest },
      mount() {
        throw new Error('no device');
      },
    });
    const { element, slot } = setup({ onError });
    slot.switchView(broken);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no device' }), 'mount', broken);
    expect(roots(element)).toHaveLength(0);
    expect(element.hasAttribute(VIEW_SLOT_ATTRIBUTES.view)).toBe(false);
  });

  it('leaves nothing subscribed when the first mount throws and there is no onError', () => {
    const replica = createFixtureReplica();
    const element = document.createElement('div');
    const broken = defineMonitorView({
      manifest: { ...createRecordingView('broken').view.manifest },
      mount() {
        throw new Error('no device');
      },
    });
    expect(() =>
      createViewSlot(element, {
        view: broken,
        replica,
        input: { stage: fixtureStage(), theme: fixtureTheme(), parameters: {} },
        commands: { select: () => undefined, create: () => undefined },
      }),
    ).toThrow('no device');
    expect(replica.subscribers).toBe(0);
    expect(element.getAttributeNames()).toEqual([]);
  });

  it('reads a new replica at the next frame', () => {
    const { frames, recording, slot, replica } = setup();
    const other = createFixtureReplica(agentViewsFixture(1));
    slot.setReplica(other);
    frames.step();
    expect(recording.lastInput!.model).toBe(other.getSnapshot().model);
    expect(replica.subscribers).toBe(0);
    expect(other.subscribers).toBe(1);
  });

  it('applies pending changes at once on flush', () => {
    const { frames, recording, slot } = setup();
    slot.setInput({ theme: fixtureTheme('light') });
    slot.flush();
    expect(recording.updates).toBe(1);
    frames.step();
    expect(recording.updates).toBe(1);
  });

  it('passes create through with its gesture and target', () => {
    const { recording, commands } = setup();
    recording.commands[0]!.create({ x: 4, y: 5 }, { deviceId: 'peer', profileSet: 'native' });
    expect(commands.create).toHaveBeenCalledWith({ x: 4, y: 5 }, { deviceId: 'peer', profileSet: 'native' });
  });
});

describe('openEnded, the optional fourth command (TV-8)', () => {
  it('hands a view none when the host has none: absent, never a no-op in its place', () => {
    const { recording } = setup();
    expect(Object.keys(recording.commands[0]!).sort()).toEqual(['create', 'report', 'select']);
    expect(recording.commands[0]!.openEnded).toBeUndefined();
    // A host that says `undefined` says the same.
    const explicit = setup({ commands: { select: vi.fn(), create: vi.fn(), openEnded: undefined } });
    expect('openEnded' in explicit.recording.commands[0]!).toBe(false);
  });

  it("lends it when the host has one: the id reaches the host's own, and no other command", () => {
    const commands = { select: vi.fn(), create: vi.fn(), openEnded: vi.fn() };
    const { recording, slot } = setup({ commands });
    const view = recording.commands[0]!;
    expect(Object.isFrozen(view)).toBe(true);
    view.openEnded!('past:claude:native-gone');
    expect(commands.openEnded.mock.calls).toEqual([['past:claude:native-gone']]);
    expect(commands.select).not.toHaveBeenCalled();
    expect(commands.create).not.toHaveBeenCalled();
    // Once the view is gone it reaches nothing, as the three do.
    slot.switchView(createRecordingView('second').view);
    view.openEnded!('past:claude:native-gone');
    expect(commands.openEnded).toHaveBeenCalledTimes(1);
  });

  it('reads whether the host has one as each view mounts, and calls the one it has then', () => {
    const commands: { select(): void; create(): void; openEnded?: (id: string) => void } = {
      select: vi.fn(),
      create: vi.fn(),
    };
    const second = createRecordingView('second');
    const third = createRecordingView('third');
    const { recording, slot } = setup({ commands });
    const first = vi.fn();
    commands.openEnded = first;
    // The view already mounted keeps what it was given: nothing.
    expect(recording.commands[0]!.openEnded).toBeUndefined();
    slot.switchView(second.view);
    const later = vi.fn();
    commands.openEnded = later;
    second.commands[0]!.openEnded!('past:claude:x');
    expect([first.mock.calls, later.mock.calls]).toEqual([[], [['past:claude:x']]]);
    // A host that lost it: the mounted view's call reaches nothing, and the next view is lent none.
    delete commands.openEnded;
    expect(() => second.commands[0]!.openEnded!('past:claude:x')).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    slot.switchView(third.view);
    expect('openEnded' in third.commands[0]!).toBe(false);
  });
});

describe("the replica's spawn menu (M2)", () => {
  it('fills capabilities.spawn when the host has no menu of its own, as one object for as long as nothing moves', () => {
    const menu = fixtureSpawnMenu();
    const replica = createFixtureReplica({ revision: 1, rows: agentViewsFixture(2), spawn: menu });
    const { frames, recording, slot } = setup({ replica, input: { ...hostParts(), capabilities: {} } });
    const first = recording.lastInput!;
    expect(first.capabilities.spawn).toBe(menu);

    slot.setInput({ theme: fixtureTheme('light') });
    frames.step();
    expect(recording.lastInput!.capabilities).toBe(first.capabilities);

    const next = { devices: menu.devices.slice(1) };
    replica.setSpawn(next);
    frames.step();
    expect(recording.updates).toBe(2);
    expect(recording.lastInput!.capabilities.spawn).toBe(next);
    expect(recording.lastInput!.model).toBe(first.model);
    expect(recording.lastInput!.changes).toEqual({ added: [], updated: [], removed: [] });
  });

  it("keeps the host's own menu over the replica's", () => {
    const own = { devices: [] };
    const replica = createFixtureReplica({ revision: 1, rows: agentViewsFixture(2), spawn: fixtureSpawnMenu() });
    const { frames, recording } = setup({ replica, input: { ...hostParts(), capabilities: { spawn: own } } });
    expect(recording.lastInput!.capabilities.spawn).toBe(own);
    replica.setSpawn({ devices: fixtureSpawnMenu().devices.slice(2) });
    frames.step();
    expect(recording.updates).toBe(0);
  });

  it("hands the host's capabilities through as they are while the replica has no menu", () => {
    const capabilities = {};
    const { recording } = setup({ input: { ...hostParts(), capabilities } });
    expect(recording.lastInput!.capabilities).toBe(capabilities);
  });
});

describe('one scheduler for the replica and the slot (M7)', () => {
  it('brings a change to the view in the frame it arrived in', () => {
    const frames = createFrameDriver();
    // The host's wiring: ONE instance, handed to the replica and to the slot.
    const scheduler = frames.scheduler;
    const replica = createFixtureReplica(agentViewsFixture(2), { scheduler });
    const { recording } = setup({ replica, scheduler });
    replica.apply({ upsert: [agentViewFixture({ id: 'agent-new', createdAt: Date.UTC(2027, 0, 1) })] });
    expect(recording.updates).toBe(0);
    // One platform frame: the replica's notify and the slot's update both drain in it.
    expect(frames.step()).toBe(1);
    expect(recording.updates).toBe(1);
    expect(recording.lastInput!.changes.added).toEqual(['agent-new']);
    expect(recording.lastInput!.model).toBe(replica.getSnapshot().model);
    expect(frames.pending).toBe(0);
  });

  it('lands a frame late when the replica batches on a scheduler of its own (the control)', () => {
    const frames = createFrameDriver();
    const own = createFrameScheduler((run) => {
      frames.requestAnimationFrame(() => run());
    });
    const replica = createFixtureReplica(agentViewsFixture(2), { scheduler: own });
    const { recording } = setup({ replica, scheduler: frames.scheduler });
    replica.apply({ upsert: [agentViewFixture({ id: 'agent-new', createdAt: Date.UTC(2027, 0, 1) })] });
    frames.step();
    expect(recording.updates).toBe(0);
    frames.step();
    expect(recording.updates).toBe(1);
  });
});
