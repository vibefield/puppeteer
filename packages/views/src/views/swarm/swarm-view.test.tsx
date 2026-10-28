// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  MonitorSpawnMenu,
  MonitorTheme,
  MonitorViewInput,
  MonitorViewInstance,
  StageGeometry,
} from '@vibefield/puppeteer-view-sdk';
import {
  agentViewsFixture,
  countingCommands,
  fixtureModel,
  fixtureTheme,
  parameterDefaults,
} from '@vibefield/puppeteer-view-sdk/testing';
import { BLOOM_SCENARIOS } from './bloom/scenarios.js';
import { DEPARTURE_MS, DEPARTURE_REDUCED_MS } from './departure.js';
import type { SwarmFrame } from './gpu/swarm-renderer.js';
import { SWARM_MANIFEST, swarmMonitorView } from './index.js';

// THE SWARM AS ITS HOST MOUNTS IT: the shipping view through `mount`, its physics inline (happy-dom has no Worker),
// a stub renderer. These are what the parity against the frozen legacy swarm held until MV-8 deleted both, and that
// no other test or golden witnesses: the view's own properties under their L18 names (M59.4), what it reports in place
// of the DOM a host used to read, the bloom's keys held while it is open (MV-D8), and a body leaving the field as the
// renderer is asked to draw it (DESIGN §6, the departure).

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

async function mounted(spawn?: MonitorSpawnMenu, mountTheme: MonitorTheme = theme) {
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
  const agents = agentViewsFixture(3);
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
    instance = swarmMonitorView.mount(root, input(agents), counting.commands);
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
  /** The body the renderer was last asked to draw for this id, if it was. */
  const lastDrawn = (id: string) => drawn.frames.at(-1)?.bodies.find((body) => body.model.id === id);

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
    // The change is drawn once where it stands, the body still whole…
    expect(lastDrawn(id)).toEqual(expect.objectContaining({ scale: 1, opacity: 1 }));
    // …then fades on frames of its own, at its size.
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

  it('on a still stage (the host’s animations switch off) is gone at once, with no frame asked for', async () => {
    const { agents, show } = await mounted(undefined, fixtureTheme('light', { animations: false }));
    const before = drawn.frames.length;
    await show(agents.slice(0, 2));
    expect(drawn.frames.length).toBeGreaterThan(before);
    expect(lastDrawn(agents[2]!.id)).toBeUndefined();
    expect(lastDrawn(agents[0]!.id)).toBeDefined();
    const drawnThen = drawn.frames.length;
    await frames(10);
    expect(drawn.frames.length).toBe(drawnThen);
  });
});
