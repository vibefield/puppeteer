// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  MonitorSpawnMenu,
  MonitorTheme,
  MonitorViewCommands,
  MonitorViewInput,
  MonitorViewInstance,
  StageGeometry,
} from '@vibefield/puppeteer-view-sdk';
import {
  agentViewFixture,
  agentViewsFixture,
  countingCommands,
  fixtureModel,
  fixtureTheme,
  parameterDefaults,
} from '@vibefield/puppeteer-view-sdk/testing';
import { WORKER_READY } from '@vibefield/puppeteer-view-sdk/toolkit';
import { BLOOM_SCENARIOS } from './bloom/scenarios.js';
import { DEPARTURE_MS, DEPARTURE_REDUCED_MS } from './departure.js';
import type { SwarmFrame } from './gpu/swarm-renderer.js';
import { SWARM_MANIFEST, swarmMonitorView } from './index.js';
import { createSwarmPhysicsHost } from './physics/host.js';
import type { SwarmPhysicsCommand } from './physics/protocol.js';

// THE SWARM AS ITS HOST MOUNTS IT: the shipping view through `mount`, its physics inline (happy-dom has no Worker),
// a stub renderer. These are what the parity against the frozen legacy swarm held until MV-8 deleted both, and that
// no other test or golden witnesses: the view's own properties under their L18 names (M59.4), what it reports in place
// of the DOM a host used to read, the bloom's keys held while it is open (MV-D8), a body leaving the field as the
// renderer is asked to draw it (DESIGN §6, the departure), a field held still drawing each change it shows (MV-W4),
// its physics in a worker whose answers come after the change that asked for them, and the hidden list and the
// tooltip saying the rows of the update that hands them over.

/** What the stub renderer was asked to draw, oldest first. */
const drawn = vi.hoisted(() => ({ frames: [] as SwarmFrame[] }));

vi.mock('./gpu/swarm-renderer.js', async (original) => ({
  ...(await original<object>()),
  createSwarmRenderer: async () => ({
    ok: true,
    renderer: {
      render: (frame: SwarmFrame) => {
        drawn.frames.push(frame);
      },
      resize: () => {},
      destroy: () => {},
      lost: new Promise(() => {}),
    },
  }),
}));

const theme = fixtureTheme('light');
const parameters = parameterDefaults(SWARM_MANIFEST);
const WIDTH = 1180;
const HEIGHT = 252;
const STAGE: StageGeometry = {
  width: WIDTH,
  height: HEIGHT,
  insets: { top: 0, right: 0, bottom: 0, left: 59 },
  obstacles: [{ x: 13, y: 11, width: 46, height: HEIGHT - 17 }],
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Drives `count` animation frames, 16ms apart. */
async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }
}

/**
 * Lets a worker hear what was posted and answer, and its answers be heard, short of the next frame: each hop is a
 * task of its own (`setTimeout(0)`), a millisecond or less apart under the fake clock, and a frame is 16.
 */
async function answers(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(4);
  });
}

/** The body the renderer was last asked to draw for this id, if it was. */
const lastDrawn = (id: string) => drawn.frames.at(-1)?.bodies.find((body) => body.model.id === id);

/**
 * A worker as the platform gives one, with the swarm's own physics host inside it as `swarm-physics.worker.ts` serves
 * it: it proves itself, and every message either way lands on a task of its own (`setTimeout`, which the fake timers
 * drive), never inside the post that sent it. Held still, its host is paused and solves nothing, so it keeps no timer.
 */
class FakeWorker {
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  private readonly host = createSwarmPhysicsHost({ post: (message) => this.later(() => this.say(message)) });

  constructor() {
    this.later(() => this.say(WORKER_READY));
  }

  postMessage(message: unknown): void {
    this.later(() => this.host.handle(message as SwarmPhysicsCommand));
  }

  terminate(): void {
    this.host.dispose();
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  private later(run: () => void): void {
    setTimeout(run, 0);
  }

  private say(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }
}

interface MountOptions {
  /** The rows the host shows at mount. Default: three. */
  readonly agents?: readonly AgentView[];
  /** The host refuses every terminal it is asked for (SB §2.6): the ask is counted, then answered no. */
  readonly refuse?: boolean;
}

async function mounted(spawn?: MonitorSpawnMenu, mountTheme: MonitorTheme = theme, options: MountOptions = {}) {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => WIDTH);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => HEIGHT);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, WIDTH, HEIGHT));
  drawn.frames.length = 0;
  const root = document.createElement('div');
  document.body.append(root);
  cleanups.push(() => root.remove());
  const counting = countingCommands();
  const commands: MonitorViewCommands = options.refuse
    ? {
        ...counting.commands,
        create: (at, target) => counting.commands.create(at, target).then(() => ({ opened: false })),
      }
    : counting.commands;
  const agents = options.agents ?? agentViewsFixture(3);
  let revision = 1;
  const input = (rows: readonly AgentView[]): MonitorViewInput => ({
    model: fixtureModel(rows, revision),
    changes: { added: [], updated: [], removed: [] },
    stage: STAGE,
    theme: mountTheme,
    parameters,
    capabilities: spawn ? { spawn } : {},
  });
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = swarmMonitorView.mount(root, input(agents), commands);
  });
  cleanups.push(() => act(async () => instance.unmount()));
  await frames(3);
  /** The host's rows become these. */
  const show = async (rows: readonly AgentView[]): Promise<void> => {
    revision += 1;
    await act(async () => instance.update(input(rows)));
  };
  return { root, field: root.querySelector<HTMLElement>('.vf-monitor-swarm')!, counting, agents, show };
}

describe('the swarm mounted', () => {
  it('sets its own properties from its input, under its own names (L18, M59.4), and its field takes focus (MV-D8)', async () => {
    const { root, field } = await mounted();
    expect(root.classList.contains('mv-swarm')).toBe(true);
    expect(field.style.getPropertyValue('--mv-swarm-orange')).toBe(theme.tokens.swarm.orange);
    // The ground is the skin's `--monitor-bg`, read by the view's CSS; the root carries none of its own.
    expect(field.style.getPropertyValue('--mv-swarm-ground')).toBe('');
    expect(field.getAttribute('tabindex')).toBe('-1');
    expect(field.hasAttribute('data-swarm-renderer')).toBe(false);
  });

  it('reports what draws it and where its physics run, where a host once read its DOM', async () => {
    const { counting } = await mounted();
    expect(counting.reports).toContainEqual({ renderer: 'webgpu' });
    expect(counting.reports).toContainEqual({ physics: 'inline' });
  });

  it('opens the bloom from the keys door, holds the keys while it is open, and commits the chosen desktop (MV-D8)', async () => {
    const { root, field, counting } = await mounted(BLOOM_SCENARIOS.two);
    await act(async () => root.querySelector<HTMLButtonElement>('[data-swarm-new-terminal]')!.click());
    const menu = root.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(field.querySelector('.vf-bloom')?.getAttribute('data-bloom-mode')).toBe('keys');
    expect(counting.reports).toContainEqual({ keysHeld: true });
    for (const key of ['ArrowRight', 'Enter', 'Enter']) {
      await act(async () => {
        menu!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    }
    for (let frame = 0; frame < 2; frame += 1) {
      await act(async () => {
        vi.advanceTimersToNextFrame();
      });
    }
    expect(counting.creates).toHaveLength(1);
    expect(counting.creates[0]?.target).toEqual({ deviceId: 'mini', profileSet: 'native' });
    expect(counting.reports.at(-1)).toEqual({ keysHeld: false });
  });
});

describe('a body leaving the field (DESIGN §6, the departure; M4: depart is not vanish)', () => {
  /** A frame's length under the fake clock. */
  const FRAME_MS = 16;
  /** Frames enough for every body's arrival (the swarm's 720ms pop) to have landed. */
  const LANDED = Math.ceil(720 / FRAME_MS) + 4;
  /** Frames safely inside a departure this long. */
  const inside = (ms: number): number => Math.floor(ms / FRAME_MS) - 1;

  it.each([
    ['spawn', 'motion'],
    ['stop', 'motion'],
    ['spawn', 'reduced'],
    ['stop', 'reduced'],
    ['spawn', 'still'],
    ['stop', 'still'],
  ] as const)(
    '%s merges a late identity into its existing body without a stale departure (%s)',
    async (action, motion) => {
      const { agents, show } = await mounted(
        undefined,
        fixtureTheme('light', { animations: motion !== 'still', reducedMotion: motion === 'reduced' }),
      );
      const [first, second, other] = agents as [AgentView, AgentView, AgentView];
      const incoming = { ...first, kind: action === 'spawn' ? 'agent' : 'terminal', status: 'idle' } as const;
      const previous = { ...second, kind: action === 'spawn' ? 'terminal' : 'agent', status: 'idle' } as const;
      await show([incoming, previous, other]);
      await frames(LANDED);
      const held = lastDrawn(previous.id)!;
      const start = drawn.frames.length;
      // The board can beat the launch/exit handoff. Once it names the body the
      // incoming row continues, no provisional body may linger beside it.
      await show([{ ...incoming, visualId: previous.id }, other]);
      await frames(inside(DEPARTURE_MS));
      const handoffFrames = drawn.frames.slice(start);
      expect(handoffFrames.length).toBeGreaterThan(0);
      for (const frame of handoffFrames) {
        expect(frame.bodies.map((body) => body.model.id).sort()).toEqual([previous.id, other.id].sort());
        const continued = frame.bodies.find((body) => body.model.id === previous.id)!;
        expect(continued.seed).toBe(held.seed);
        expect(continued.scale).toBe(1);
        expect(continued.model.rowId).toBe(incoming.id);
        expect(continued.model.state).toBe(action === 'spawn' ? 'idle' : 'terminal-empty');
      }
      const continued = handoffFrames[0]!.bodies.find((body) => body.model.id === previous.id)!;
      expect(Math.hypot(continued.x - held.x, continued.y - held.y)).toBeLessThan(2);
    },
  );

  it.each(['incoming', 'previous'] as const)(
    'keeps one body when the %s row briefly left before the identity handoff arrived',
    async (absent) => {
      const { agents, show } = await mounted();
      await frames(LANDED);
      const [incoming, previous, other] = agents as [AgentView, AgentView, AgentView];
      const seed = lastDrawn(previous.id)!.seed;
      await show([absent === 'incoming' ? previous : incoming, other]);
      await frames(3);
      expect(lastDrawn(absent === 'incoming' ? incoming.id : previous.id)?.scale).toBeLessThan(1);
      const start = drawn.frames.length;
      await show([{ ...incoming, visualId: previous.id }, other]);
      await frames(inside(DEPARTURE_MS));
      for (const frame of drawn.frames.slice(start)) {
        expect(frame.bodies.map((body) => body.model.id).sort()).toEqual([previous.id, other.id].sort());
        expect(frame.bodies.find((body) => body.model.id === previous.id)?.seed).toBe(seed);
      }
    },
  );

  it('shrinks where it stands for the departure’s length, out of reach, then the field lets it go', async () => {
    const { root, agents, show } = await mounted();
    await frames(LANDED);
    const id = agents[2]!.id;
    expect(lastDrawn(id)?.scale).toBe(1);
    await show(agents.slice(0, 2));
    // The row's button leaves with the row, at once: only the drawing departs.
    expect(root.querySelector(`[data-agent-bubble-id="${id}"]`)).toBeNull();
    let previous = 1;
    for (let frame = 0; frame < inside(DEPARTURE_MS); frame += 1) {
      await frames(1);
      const body = lastDrawn(id);
      expect(body?.opacity).toBe(1);
      expect(body?.focus).toBe(false);
      expect(body?.scale).toBeGreaterThan(0);
      expect(body?.scale).toBeLessThan(previous);
      previous = body?.scale ?? 0;
    }
    await frames(3);
    expect(lastDrawn(id)).toBeUndefined();
    expect(lastDrawn(agents[0]!.id)?.scale).toBe(1);
    // Let go, its state and visual with it: a row back now is a new arrival, from nothing.
    await show(agents);
    await frames(1);
    expect(lastDrawn(id)?.scale).toBeLessThan(0.5);
  });

  it('is put back when its row returns while it leaves: one body, growing from where it got to', async () => {
    const { agents, show } = await mounted();
    await frames(LANDED);
    const id = agents[2]!.id;
    await show(agents.slice(0, 2));
    await frames(5);
    const shrunk = lastDrawn(id)?.scale ?? 0;
    expect(shrunk).toBeLessThan(1);
    expect(shrunk).toBeGreaterThan(0.5);
    await show(agents);
    await frames(1);
    // A new arrival would start from nothing; this one pops back from the size its shrink reached.
    expect(lastDrawn(id)?.scale).toBeGreaterThan(shrunk);
    expect(drawn.frames.at(-1)?.bodies.filter((body) => body.model.id === id)).toHaveLength(1);
    await frames(LANDED);
    expect(lastDrawn(id)?.scale).toBe(1);
  });

  it('under reduced motion fades at its size in half the time, and the field is still after (M6)', async () => {
    const { agents, show } = await mounted(undefined, fixtureTheme('light', { reducedMotion: true }));
    const id = agents[2]!.id;
    await show(agents.slice(0, 2));
    // The change asks for a still frame: on the next one it is drawn where it stands, at its size, its fade begun;
    // then it fades on frames of its own.
    let previous = 1;
    for (let frame = 0; frame < inside(DEPARTURE_REDUCED_MS); frame += 1) {
      await frames(1);
      const body = lastDrawn(id);
      expect(body?.scale).toBe(1);
      expect(body?.opacity).toBeGreaterThan(0);
      expect(body?.opacity).toBeLessThan(previous);
      previous = body?.opacity ?? 0;
    }
    await frames(3);
    expect(lastDrawn(id)).toBeUndefined();
    // Gone, the field asks for no frame: held still again (MV-W4).
    const drawnThen = drawn.frames.length;
    await frames(10);
    expect(drawn.frames.length).toBe(drawnThen);
  });

  it('under reduced motion, put back while it fades, fades up from where its fade got to: one body, never snapping whole (M6)', async () => {
    const { agents, show } = await mounted(undefined, fixtureTheme('light', { reducedMotion: true }));
    const id = agents[2]!.id;
    await show(agents.slice(0, 2));
    await frames(3);
    const faded = lastDrawn(id)?.opacity ?? 0;
    expect(faded).toBeGreaterThan(0);
    expect(faded).toBeLessThan(1);
    await show(agents);
    await frames(1);
    // On the next frame, drawn where it stands, at its size, up from as faint as its fade had left it: never whole in
    // one frame.
    expect(lastDrawn(id)?.scale).toBe(1);
    expect(lastDrawn(id)?.opacity).toBeLessThan(1);
    expect(drawn.frames.at(-1)?.bodies.filter((body) => body.model.id === id)).toHaveLength(1);
    // …then up on frames of its own, until it is whole and the field is still again (MV-W4).
    let previous = lastDrawn(id)?.opacity ?? 0;
    for (let frame = 0; frame < 2; frame += 1) {
      await frames(1);
      const opacity = lastDrawn(id)?.opacity ?? 0;
      expect(opacity).toBeGreaterThanOrEqual(previous);
      previous = opacity;
    }
    await frames(inside(DEPARTURE_REDUCED_MS) + 3);
    expect(lastDrawn(id)?.opacity).toBe(1);
    const drawnThen = drawn.frames.length;
    await frames(10);
    expect(drawn.frames.length).toBe(drawnThen);
  });

  it('on a still stage (the host’s animations switch off) is gone at once, with no fade asked for', async () => {
    const { agents, show } = await mounted(undefined, fixtureTheme('light', { animations: false }));
    const before = drawn.frames.length;
    await show(agents.slice(0, 2));
    // The change's still frame, then the physics' answer to the body let go (its table and frame): one frame each.
    await frames(2);
    expect(drawn.frames.length).toBeGreaterThan(before);
    expect(lastDrawn(agents[2]!.id)).toBeUndefined();
    expect(lastDrawn(agents[0]!.id)).toBeDefined();
    const drawnThen = drawn.frames.length;
    await frames(10);
    expect(drawn.frames.length).toBe(drawnThen);
  });
});

describe('a field held still draws each change it shows, on a frame of its own (MV-W4)', () => {
  const still = fixtureTheme('light', { reducedMotion: true });

  describe('its physics in a worker, whose answers come after the change that asked for them', () => {
    beforeEach(() => {
      vi.stubGlobal('Worker', FakeWorker);
    });

    it('draws every row once the worker has placed it at mount, then asks for no frame', async () => {
      const { agents, counting } = await mounted(undefined, still);
      expect(counting.reports).toContainEqual({ physics: 'worker' });
      // The renderer is ready before the worker's first frame: what the field draws is the worker's answer.
      const ids = drawn.frames.at(-1)?.bodies.map((body) => body.model.id);
      expect(ids?.sort()).toEqual(agents.map((agent) => agent.id).sort());
      const drawnThen = drawn.frames.length;
      await frames(10);
      expect(drawn.frames.length).toBe(drawnThen);
    });

    it('draws a row that arrives once the worker has placed it, where it spawned, on one frame', async () => {
      const rows = agentViewsFixture(2);
      const { show } = await mounted(undefined, still, { agents: rows.slice(0, 1) });
      const before = drawn.frames.length;
      await show(rows);
      // The worker hears the rows and answers, its table and then its frame, before the next frame.
      await answers();
      await frames(1);
      expect(drawn.frames.length).toBe(before + 1);
      expect(lastDrawn(rows[1]!.id)).toEqual(expect.objectContaining({ scale: 1, opacity: 1 }));
      const drawnThen = drawn.frames.length;
      await frames(10);
      expect(drawn.frames.length).toBe(drawnThen);
    });
  });

  it('rings the body whose button has the focus, and takes the ring away on blur', async () => {
    const { root, agents } = await mounted(undefined, still);
    const id = agents[0]!.id;
    const button = root.querySelector<HTMLButtonElement>(`[data-agent-bubble-id="${id}"]`)!;
    await act(async () => button.focus());
    await frames(1);
    expect(lastDrawn(id)?.focus).toBe(true);
    await act(async () => button.blur());
    await frames(1);
    expect(lastDrawn(id)?.focus).toBe(false);
  });

  it('lays the veil of a bloom opened from the keys door over the field', async () => {
    const { root } = await mounted(BLOOM_SCENARIOS.two, still);
    await act(async () => root.querySelector<HTMLButtonElement>('[data-swarm-new-terminal]')!.click());
    await frames(1);
    expect(drawn.frames.at(-1)?.veil ?? 0).toBeGreaterThan(0);
  });

  it('draws a birth the host refused gone at once, never left standing until the next change (SB §2.6)', async () => {
    const { root, counting } = await mounted(BLOOM_SCENARIOS.two, still, { refuse: true });
    await act(async () => root.querySelector<HTMLButtonElement>('[data-swarm-new-terminal]')!.click());
    const menu = root.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const start = drawn.frames.length;
    for (const key of ['ArrowRight', 'Enter', 'Enter']) {
      await act(async () => {
        menu!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    }
    await frames(2);
    expect(counting.creates).toHaveLength(1);
    const births = drawn.frames
      .slice(start)
      .flatMap((frame) => frame.bodies.filter((body) => body.model.id.startsWith('spawn-bloom-birth-')));
    expect(births.length).toBeGreaterThan(0);
    // Held still, its gone-form is nothing at all.
    expect(births.at(-1)?.opacity).toBe(0);
  });
});

describe('the hidden list says the row it was handed, and the tooltip follows it', () => {
  const still = fixtureTheme('light', { reducedMotion: true });

  /** A body's button in the hidden list. */
  const button = (root: HTMLElement, id: string): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>(`[data-agent-bubble-id="${id}"]`)!;

  /** The tooltip, while one is shown. */
  const tooltip = (root: HTMLElement): Element | null => root.querySelector('.vf-monitor-swarm-tooltip');

  /** A pointer come to rest on the middle of the body the renderer last drew for this id. */
  async function hover(field: HTMLElement, id: string): Promise<void> {
    const body = lastDrawn(id)!;
    await act(async () => {
      field.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: body.x, clientY: body.y }));
    });
  }

  it('says a row’s new state on its button in the update that brings it, never one input behind', async () => {
    const { root, agents, show } = await mounted();
    const [working, ...rest] = agents as [AgentView, ...AgentView[]];
    expect(working.status).toBe('working');
    expect(button(root, working.id).getAttribute('data-agent-bubble-visual')).toBe('working');
    const blocked: AgentView = {
      ...working,
      status: 'blocked',
      wait: { kind: 'permission', tool: 'Bash', detail: 'pnpm test --run', since: working.statusSince },
    };
    await show([blocked, ...rest]);
    // The status, the drawn state and the words, all from the row this update handed over.
    const asks = button(root, working.id);
    expect(asks.getAttribute('data-agent-bubble-status')).toBe('blocked');
    expect(asks.getAttribute('data-agent-bubble-visual')).toBe('blocked');
    expect(asks.getAttribute('aria-label')).toContain(', blocked:');
    expect(asks.getAttribute('aria-label')).not.toContain(', working:');
  });

  it('names the agent that took a shell’s body, never the shell it took over', async () => {
    const shell = agentViewFixture({
      id: 'shell-1',
      kind: 'terminal',
      project: { name: 'vibe-field', seq: undefined },
      detail: '/Users/james/Projects/vibe-field',
    });
    const { root, show } = await mounted(undefined, theme, { agents: [shell] });
    expect(button(root, shell.id).getAttribute('aria-label')).toContain('unassigned terminal');
    // The launcher's agent takes the shell's body (its `visualId`): the same button, now the agent's.
    const agent = agentViewFixture({
      id: 'run-1',
      status: 'working',
      project: { name: 'vibe-field', seq: 1 },
      provider: { id: 'claude', label: 'Claude' },
      model: 'Sonnet 5',
      visualId: shell.id,
    });
    await show([agent]);
    const took = button(root, shell.id);
    expect(took.getAttribute('data-agent-bubble-source')).toBe('agent');
    expect(took.getAttribute('aria-label')).not.toContain('unassigned terminal');
    expect(took.getAttribute('aria-label')).toMatch(/^vibe-field, Sonnet 5, working: /);
  });

  it('keeps a hovered body’s tooltip on what its row says now', async () => {
    const { root, field, agents, show } = await mounted(undefined, still);
    const [first, second, idle] = agents as [AgentView, AgentView, AgentView];
    await hover(field, idle.id);
    expect(tooltip(root)?.textContent).toContain('Done. The suite passes.');
    await show([first, second, { ...idle, reply: { ...idle.reply!, text: 'Merged the lane.' } }]);
    expect(tooltip(root)?.textContent).toContain('Merged the lane.');
    expect(tooltip(root)?.textContent).not.toContain('Done. The suite passes.');
  });

  it('takes the tooltip away with a row that leaves', async () => {
    const { root, field, agents, show } = await mounted(undefined, still);
    const [first, second, idle] = agents as [AgentView, AgentView, AgentView];
    await hover(field, idle.id);
    expect(tooltip(root)).not.toBeNull();
    await show([first, second]);
    // Its body fades where it stood (M6), out of reach; its words leave with its row.
    expect(tooltip(root)).toBeNull();
  });
});
