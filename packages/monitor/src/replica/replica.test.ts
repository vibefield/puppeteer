import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareMonitorRows,
  type FrameScheduler,
  type MonitorAgentRow,
  type MonitorModelChange,
  type MonitorModelSnapshot,
  type MonitorSpawnMenu,
} from '@vibecook/puppeteer-view-sdk/model';
import {
  createMonitorReplica,
  NO_THEME_COLOUR,
  type MonitorReplicaAttachment,
  type MonitorReplicaLocal,
} from './index.js';

function row(id: string, overrides: Partial<MonitorAgentRow> = {}): MonitorAgentRow {
  return {
    id,
    kind: 'agent',
    createdAt: 1_000,
    status: 'idle',
    statusSince: 1_000,
    stale: false,
    alive: true,
    observed: true,
    detail: 'idle',
    project: { name: 'alpha', seq: 0 },
    unread: false,
    device: { id: 'desk-1', name: 'Studio', os: 'mac', self: true },
    attachable: true,
    ...overrides,
  };
}

function snapshot(revision: number, rows: readonly MonitorAgentRow[], spawn?: MonitorSpawnMenu): MonitorModelSnapshot {
  return { revision, rows, ...(spawn ? { spawn } : {}) };
}

function change(
  since: number,
  revision: number,
  parts: { upserts?: MonitorAgentRow[]; removed?: string[]; spawn?: MonitorSpawnMenu } = {},
): MonitorModelChange {
  return {
    since,
    revision,
    upserts: parts.upserts ?? [],
    removed: parts.removed ?? [],
    ...(parts.spawn ? { spawn: parts.spawn } : {}),
  };
}

function local(parts: Partial<MonitorReplicaLocal> = {}): MonitorReplicaLocal {
  return { attachments: new Map(), activeIds: new Set(), spawnHints: new Map(), ...parts };
}

/** What a transport delivers: equal content, never the same objects. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Frames stepped by hand, under the contract's rule (M7): work requested while
 * a frame drains joins that frame, unless that task already ran in it.
 */
function manualFrames() {
  let waiting: (() => void)[] = [];
  let draining: { readonly ran: Set<() => void>; readonly queue: (() => void)[] } | undefined;
  let count = 0;
  const scheduler: FrameScheduler = {
    request(work) {
      const queue = draining && !draining.ran.has(work) ? draining.queue : waiting;
      queue.push(work);
      return () => {
        const index = queue.indexOf(work);
        if (index >= 0) queue.splice(index, 1);
      };
    },
  };
  return {
    scheduler,
    /** Work waiting for the next frame. */
    pending: () => waiting.length,
    /** The frame running now, or the last one run. */
    current: () => count,
    frame: () => {
      count += 1;
      const frame = { ran: new Set<() => void>(), queue: waiting };
      waiting = [];
      draining = frame;
      for (let index = 0; index < frame.queue.length; index += 1) {
        const work = frame.queue[index]!;
        frame.ran.add(work);
        work();
      }
      draining = undefined;
    },
  };
}

function setup() {
  const frames = manualFrames();
  const replica = createMonitorReplica({ scheduler: frames.scheduler });
  const listener = vi.fn();
  replica.subscribe(listener);
  return { frames, replica, listener };
}

const spawnMenu: MonitorSpawnMenu = {
  devices: [
    { id: 'desk-1', label: 'Studio', self: true, state: 'ready', profiles: [{ id: 'native', label: 'Native' }] },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createMonitorReplica', () => {
  it('publishes a snapshot in the model order: agents by birth, then terminals, ties by id', () => {
    const { frames, replica, listener } = setup();
    const rows = [
      row('t1', { kind: 'terminal', createdAt: 0, project: { name: '' } }),
      row('b', { createdAt: 2_000 }),
      row('c', { createdAt: 1_000 }),
      row('a', { createdAt: 1_000 }),
    ];
    expect(replica.apply(snapshot(7, rows))).toBe(true);
    expect(replica.getSnapshot().model.agents).toEqual([]);
    expect(listener).not.toHaveBeenCalled();

    frames.frame();
    const { model, changes } = replica.getSnapshot();
    expect(model.agents.map((view) => view.id)).toEqual(['a', 'c', 'b', 't1']);
    expect(model.agents.map((view) => view.id)).toEqual([...rows].sort(compareMonitorRows).map((entry) => entry.id));
    expect(model.revision).toBe(7);
    expect([...model.byId.keys()].sort()).toEqual(['a', 'b', 'c', 't1']);
    expect(model.byId.get('b')).toBe(model.agents[2]);
    expect(changes).toEqual({ added: ['a', 'c', 'b', 't1'], updated: [], removed: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps an unchanged AgentView, and the model itself, across applies (MV-D21)', () => {
    const { frames, replica, listener } = setup();
    const a = row('a');
    const b = row('b', { createdAt: 2_000 });
    replica.apply(snapshot(1, [a, b]));
    frames.frame();
    const first = replica.getSnapshot();

    // An equal row off the wire is no change: nothing is scheduled, nothing is heard.
    expect(replica.apply(change(1, 2, { upserts: [wire(a)] }))).toBe(true);
    expect(frames.pending()).toBe(0);
    expect(replica.getSnapshot()).toBe(first);

    replica.apply(change(2, 3, { upserts: [{ ...wire(b), status: 'working', statusSince: 3_000 }] }));
    frames.frame();
    const second = replica.getSnapshot();
    expect(second.model).not.toBe(first.model);
    expect(second.model.revision).toBe(3);
    expect(second.model.agents[0]).toBe(first.model.agents[0]);
    expect(second.model.byId.get('a')).toBe(first.model.byId.get('a'));
    expect(second.model.byId.get('b')).not.toBe(first.model.byId.get('b'));
    expect(second.model.byId.get('b')?.status).toBe('working');
    expect(second.changes).toEqual({ added: [], updated: ['b'], removed: [] });

    // A re-snapshot of the same content (the host healing a gap) keeps every object.
    replica.apply(wire(snapshot(3, [a, { ...b, status: 'working', statusSince: 3_000 }])));
    frames.frame();
    expect(replica.getSnapshot()).toBe(second);
    expect(listener).toHaveBeenCalledTimes(2);
    // getSnapshot is stable between publications.
    expect(replica.getSnapshot()).toBe(replica.getSnapshot());
  });

  it('keeps identity through a flip inside one frame, and through a removal undone before the frame', () => {
    const { frames, replica, listener } = setup();
    const a = row('a');
    const b = row('b', { createdAt: 2_000 });
    replica.apply(snapshot(1, [a, b]));
    frames.frame();
    const first = replica.getSnapshot();

    replica.apply(change(1, 2, { upserts: [{ ...a, status: 'working' }] }));
    replica.apply(change(2, 3, { upserts: [wire(a)] }));
    replica.apply(change(3, 4, { removed: ['b'] }));
    replica.apply(change(4, 5, { upserts: [wire(b)] }));
    frames.frame();
    expect(replica.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('removes rows, and re-sorts a row whose birth moved', () => {
    const { frames, replica } = setup();
    replica.apply(
      snapshot(1, [row('a', { createdAt: 1_000 }), row('b', { createdAt: 2_000 }), row('c', { createdAt: 3_000 })]),
    );
    frames.frame();

    replica.apply(change(1, 2, { removed: ['b'], upserts: [row('c', { createdAt: 500 })] }));
    frames.frame();
    const { model, changes } = replica.getSnapshot();
    expect(model.agents.map((view) => view.id)).toEqual(['c', 'a']);
    expect(model.byId.has('b')).toBe(false);
    expect(changes).toEqual({ added: [], updated: ['c'], removed: ['b'] });

    // A removal and a re-add with another birth, inside one frame, still lands in order.
    replica.apply(change(2, 3, { removed: ['a'] }));
    replica.apply(change(3, 4, { upserts: [row('a', { createdAt: 100 })] }));
    frames.frame();
    expect(replica.getSnapshot().model.agents.map((view) => view.id)).toEqual(['a', 'c']);
    expect(replica.getSnapshot().changes).toEqual({ added: [], updated: ['a'], removed: [] });
  });

  it('treats a change off the held revision as a gap: not applied, heard once, healed by a snapshot', () => {
    const { frames, replica } = setup();
    const gap = vi.fn();
    replica.onGap(gap);

    // Nothing held yet: a change has nothing to apply on.
    expect(replica.apply(change(0, 1, { upserts: [row('early')] }))).toBe(false);
    expect(gap).toHaveBeenCalledTimes(1);

    replica.apply(snapshot(4, [row('a')]));
    frames.frame();
    const held = replica.getSnapshot();

    expect(replica.apply(change(5, 6, { upserts: [row('b')] }))).toBe(false);
    expect(gap).toHaveBeenCalledTimes(2);
    // Gapped: even a link that would chain is refused until the snapshot, and the gap is heard once.
    expect(replica.apply(change(4, 5, { upserts: [row('c')] }))).toBe(false);
    expect(replica.apply(change(9, 10))).toBe(false);
    expect(gap).toHaveBeenCalledTimes(2);
    expect(frames.pending()).toBe(0);
    expect(replica.getSnapshot()).toBe(held);

    expect(replica.apply(snapshot(10, [row('a'), row('b', { createdAt: 2_000 })]))).toBe(true);
    frames.frame();
    expect(replica.getSnapshot().model.agents.map((view) => view.id)).toEqual(['a', 'b']);
    expect(replica.getSnapshot().model.agents[0]).toBe(held.model.agents[0]);

    expect(replica.apply(change(10, 11, { removed: ['a'] }))).toBe(true);
    frames.frame();
    expect(replica.getSnapshot().model.agents.map((view) => view.id)).toEqual(['b']);
    expect(replica.getSnapshot().model.revision).toBe(11);
    expect(gap).toHaveBeenCalledTimes(2);
  });

  it('joins this window’s facts and re-joins only the rows they touch', () => {
    const { frames, replica, listener } = setup();
    replica.apply(
      snapshot(1, [
        row('a'),
        row('b', { createdAt: 2_000, project: { name: 'beta', seq: 1 } }),
        row('c', { createdAt: 3_000 }),
      ]),
    );
    frames.frame();
    const first = replica.getSnapshot().model;
    expect(first.agents.map((view) => [view.active, view.receded, view.attachment, view.spawnHint])).toEqual([
      [false, false, undefined, undefined],
      [false, false, undefined, undefined],
      [false, false, undefined, undefined],
    ]);

    replica.setLocal(
      local({ attachments: new Map([['a', { panes: 2, colour: 'pane-red' }]]), activeIds: new Set(['b']) }),
    );
    frames.frame();
    const second = replica.getSnapshot();
    expect(second.changes).toEqual({ added: [], updated: ['a', 'b'], removed: [] });
    expect(second.model.byId.get('a')?.attachment).toEqual({ panes: 2, colour: 'pane-red' });
    expect(second.model.byId.get('b')?.active).toBe(true);
    expect(second.model.byId.get('c')).toBe(first.byId.get('c'));

    // The same facts in new collections: nothing moved, nothing is published.
    replica.setLocal(
      local({ attachments: new Map([['a', { panes: 2, colour: 'pane-red' }]]), activeIds: new Set(['b']) }),
    );
    frames.frame();
    expect(replica.getSnapshot()).toBe(second);

    // A third pane on `a`: only `a` moves, and the spawn hint lands on `c`.
    replica.setLocal(
      local({
        attachments: new Map([['a', { panes: 3, colour: 'pane-red' }]]),
        activeIds: new Set(['b']),
        spawnHints: new Map([['c', { x: 40, y: 60 }]]),
      }),
    );
    frames.frame();
    const third = replica.getSnapshot();
    expect(third.changes).toEqual({ added: [], updated: ['a', 'c'], removed: [] });
    expect(third.model.byId.get('a')?.attachment).toEqual({ panes: 3, colour: 'pane-red' });
    expect(third.model.byId.get('c')?.spawnHint).toEqual({ x: 40, y: 60 });
    expect(third.model.byId.get('b')).toBe(second.model.byId.get('b'));

    // Receding asks every row again, but only a row whose answer flipped gets a new view.
    replica.setLocal({ ...local(), ...pick(third), receded: (entry) => entry.project.name === 'beta' });
    frames.frame();
    const fourth = replica.getSnapshot();
    expect(fourth.changes.updated).toEqual(['b']);
    expect(fourth.model.byId.get('b')?.receded).toBe(true);
    replica.setLocal({ ...local(), ...pick(third), receded: (entry) => entry.project.seq === 1 });
    frames.frame();
    expect(replica.getSnapshot()).toBe(fourth);
    expect(listener).toHaveBeenCalledTimes(4);

    function pick(published: typeof third): Partial<MonitorReplicaLocal> {
      const attachments = new Map<string, MonitorReplicaAttachment>();
      const spawnHints = new Map<string, { x: number; y: number }>();
      const activeIds = new Set<string>();
      for (const view of published.model.agents) {
        if (view.attachment) attachments.set(view.id, { ...view.attachment });
        if (view.spawnHint) spawnHints.set(view.id, { ...view.spawnHint });
        if (view.active) activeIds.add(view.id);
      }
      return { attachments, spawnHints, activeIds };
    }
  });

  it('re-joins only the rows a local change touches: the host’s predicate is asked of those alone', () => {
    const { frames, replica } = setup();
    replica.apply(snapshot(1, [row('a'), row('b', { createdAt: 2_000 }), row('c', { createdAt: 3_000 })]));
    const receded = vi.fn((entry: MonitorAgentRow) => entry.id === 'c');
    replica.setLocal(local({ receded }));
    frames.frame();
    expect(receded).toHaveBeenCalledTimes(3);

    receded.mockClear();
    replica.setLocal(local({ receded, attachments: new Map([['a', { panes: 1 }]]), activeIds: new Set(['b']) }));
    frames.frame();
    expect(receded.mock.calls.map(([entry]) => entry.id).sort()).toEqual(['a', 'b']);
    expect(replica.getSnapshot().changes.updated).toEqual(['a', 'b']);

    // A backend change re-joins its own row only.
    receded.mockClear();
    replica.apply(change(1, 2, { upserts: [row('c', { createdAt: 3_000, status: 'working' })] }));
    frames.frame();
    expect(receded.mock.calls.map(([entry]) => entry.id)).toEqual(['c']);
  });

  it('a row that arrives later is joined with the facts already set', () => {
    const { frames, replica } = setup();
    replica.setLocal(local({ activeIds: new Set(['late']), spawnHints: new Map([['late', { x: 1, y: 2 }]]) }));
    expect(frames.pending()).toBe(0);
    replica.apply(snapshot(1, [row('late')]));
    frames.frame();
    expect(replica.getSnapshot().model.byId.get('late')).toMatchObject({ active: true, spawnHint: { x: 1, y: 2 } });
  });

  it('colours by project sequence, and re-colours only when the theme key changes (L7)', () => {
    const { frames, replica, listener } = setup();
    replica.apply(
      snapshot(1, [
        row('a'),
        row('a2', { createdAt: 1_500 }),
        row('b', { createdAt: 2_000, project: { name: 'beta', seq: 1 } }),
        row('t', { kind: 'terminal', project: { name: '' } }),
      ]),
    );
    frames.frame();
    expect(replica.getSnapshot().model.agents.map((view) => view.colour)).toEqual(Array(4).fill(NO_THEME_COLOUR));

    const light = vi.fn((seq?: number) => (seq === undefined ? 'ramp' : `light-${seq}`));
    replica.setTheme({ key: 'light', colourFor: light });
    frames.frame();
    const lit = replica.getSnapshot();
    expect(lit.model.agents.map((view) => [view.id, view.colour])).toEqual([
      ['a', 'light-0'],
      ['a2', 'light-0'],
      ['b', 'light-1'],
      ['t', 'ramp'],
    ]);
    // Once per sequence, not once per row.
    expect(light).toHaveBeenCalledTimes(3);

    // The same key promises the same colours: nothing is re-coloured, nothing is published.
    replica.setTheme({ key: 'light', colourFor: () => 'never' });
    expect(frames.pending()).toBe(0);
    expect(replica.getSnapshot()).toBe(lit);

    // A new key re-colours, and a row whose colour came out the same keeps its view.
    replica.setTheme({ key: 'dark', colourFor: (seq?: number) => (seq === undefined ? 'ramp' : `dark-${seq}`) });
    frames.frame();
    const dark = replica.getSnapshot();
    expect(dark.changes).toEqual({ added: [], updated: ['a', 'a2', 'b'], removed: [] });
    expect(dark.model.byId.get('b')?.colour).toBe('dark-1');
    expect(dark.model.byId.get('t')).toBe(lit.model.byId.get('t'));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('notifies at most once a frame, however much moved inside it', () => {
    const { frames, replica, listener } = setup();
    replica.apply(snapshot(1, [row('a')]));
    replica.apply(change(1, 2, { upserts: [row('b', { createdAt: 2_000 })] }));
    replica.apply(change(2, 3, { upserts: [row('b', { createdAt: 2_000, status: 'blocked' })] }));
    replica.setLocal(local({ activeIds: new Set(['a']) }));
    replica.setTheme({ key: 'light', colourFor: () => 'ink' });
    expect(frames.pending()).toBe(1);
    frames.frame();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(replica.getSnapshot().model.byId.get('b')?.status).toBe('blocked');
    expect(replica.getSnapshot().changes.added).toEqual(['a', 'b']);

    // Nothing moved: no frame is even asked for.
    replica.apply(change(3, 4, { upserts: [wire(row('a'))] }));
    expect(frames.pending()).toBe(0);
  });

  it('hears a change a listener makes in the next frame, never in the one being published', () => {
    const { frames, replica, listener } = setup();
    let applied = false;
    replica.subscribe(() => {
      if (applied) return;
      applied = true;
      replica.apply(change(1, 2, { removed: ['a'] }));
    });
    replica.apply(snapshot(1, [row('a'), row('b', { createdAt: 2_000 })]));
    frames.frame();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(replica.getSnapshot().model.agents.map((view) => view.id)).toEqual(['a', 'b']);
    expect(frames.pending()).toBe(1);
    frames.frame();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(replica.getSnapshot().model.agents.map((view) => view.id)).toEqual(['b']);
  });

  it('a subscriber’s own request on the shared scheduler lands in the frame that notified it (M7)', () => {
    const { frames, replica } = setup();
    const updates: { frame: number; revision: number }[] = [];
    // The view host's slot: it hears the replica, then asks the SAME scheduler for its update.
    replica.subscribe(() => {
      frames.scheduler.request(() => {
        updates.push({ frame: frames.current(), revision: replica.getSnapshot().model.revision });
      });
    });
    replica.apply(snapshot(1, [row('a')]));
    expect(frames.pending()).toBe(1);
    frames.frame();
    expect(updates).toEqual([{ frame: 1, revision: 1 }]);
    expect(frames.pending()).toBe(0);

    replica.apply(change(1, 2, { upserts: [row('b', { createdAt: 2_000 })] }));
    frames.frame();
    expect(updates).toEqual([
      { frame: 1, revision: 1 },
      { frame: 2, revision: 2 },
    ]);
  });

  it('publishes the spawn menu, and keeps the model when only the menu moved', () => {
    const { frames, replica, listener } = setup();
    replica.apply(snapshot(1, [row('a')], spawnMenu));
    frames.frame();
    const first = replica.getSnapshot();
    expect(first.spawn).toEqual(spawnMenu);

    const asleep: MonitorSpawnMenu = {
      devices: [...spawnMenu.devices, { id: 'desk-2', label: 'Laptop', state: 'asleep', word: 'ASLEEP · 2 H' }],
    };
    replica.apply(change(1, 2, { spawn: asleep }));
    frames.frame();
    const second = replica.getSnapshot();
    expect(second.model).toBe(first.model);
    expect(second.changes).toEqual({ added: [], updated: [], removed: [] });
    expect(second.spawn).toEqual(asleep);

    // The same menu off the wire is no change.
    replica.apply(change(2, 3, { spawn: wire(asleep) }));
    expect(frames.pending()).toBe(0);
    expect(replica.getSnapshot()).toBe(second);

    // A snapshot is whole: no menu in it means none is offered.
    replica.apply(snapshot(3, [row('a')]));
    frames.frame();
    expect(replica.getSnapshot().spawn).toBeUndefined();
    expect('spawn' in replica.getSnapshot()).toBe(false);
    expect(replica.getSnapshot().model).toBe(first.model);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('freezes what it publishes', () => {
    const { frames, replica } = setup();
    replica.apply(snapshot(1, [row('a', { cost: { usd: 1.5, coverage: 'complete' } })]));
    replica.setLocal(local({ attachments: new Map([['a', { panes: 1 }]]) }));
    frames.frame();
    const { model } = replica.getSnapshot();
    const view = model.agents[0]!;
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.agents)).toBe(true);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.cost)).toBe(true);
    expect(Object.isFrozen(view.project)).toBe(true);
    expect(Object.isFrozen(view.attachment)).toBe(true);
    expect(() => {
      (view as { status: string }).status = 'working';
    }).toThrow(TypeError);
  });

  it('hears what listeners and host callbacks throw without stopping a publication', () => {
    const errors: unknown[] = [];
    const frames = manualFrames();
    const replica = createMonitorReplica({
      scheduler: frames.scheduler,
      onListenerError: (error) => errors.push(error),
    });
    const after = vi.fn();
    replica.subscribe(() => {
      throw new Error('listener');
    });
    replica.subscribe(after);
    replica.setTheme({
      key: 'broken',
      colourFor: () => {
        throw new Error('colour');
      },
    });
    replica.setLocal({
      ...local(),
      receded: () => {
        throw new Error('receded');
      },
    });
    replica.apply(snapshot(1, [row('a')]));
    frames.frame();
    expect(after).toHaveBeenCalledTimes(1);
    expect(replica.getSnapshot().model.byId.get('a')).toMatchObject({ colour: NO_THEME_COLOUR, receded: false });
    expect(errors.map((error) => (error as Error).message).sort()).toEqual(['colour', 'listener', 'receded']);
  });

  it('dispose cancels the pending frame and hears nothing more', () => {
    const { frames, replica, listener } = setup();
    replica.apply(snapshot(1, [row('a')]));
    expect(frames.pending()).toBe(1);
    replica.dispose();
    expect(frames.pending()).toBe(0);
    expect(replica.apply(snapshot(2, [row('b')]))).toBe(false);
    frames.frame();
    expect(listener).not.toHaveBeenCalled();
  });

  it('defaults to requestAnimationFrame where there is one', () => {
    const frames: ((time: number) => void)[] = [];
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const replica = createMonitorReplica();
    const listener = vi.fn();
    replica.subscribe(listener);
    replica.apply(snapshot(1, [row('a')]));
    replica.apply(change(1, 2, { upserts: [row('b', { createdAt: 2_000 })] }));
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(listener).toHaveBeenCalledTimes(1);
    replica.apply(change(2, 3, { removed: ['a'] }));
    replica.dispose();
    expect(cancel).toHaveBeenCalledWith(2);
  });

  it('falls back to a 16 ms timer where there is no frame', () => {
    vi.useFakeTimers();
    expect('requestAnimationFrame' in globalThis).toBe(false);
    const replica = createMonitorReplica();
    const listener = vi.fn();
    replica.subscribe(listener);
    replica.apply(snapshot(1, [row('a')]));
    vi.advanceTimersByTime(15);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
