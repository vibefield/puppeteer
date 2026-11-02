// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MonitorViewInput, MonitorViewInstance } from '@vibefield/puppeteer-view-sdk';
import {
  agentViewsFixture,
  countingCommands,
  fixtureModel,
  fixtureTheme,
  parameterDefaults,
} from '@vibefield/puppeteer-view-sdk/testing';
import type { SwarmFrame } from './gpu/swarm-renderer.js';
import { SWARM_MANIFEST, swarmMonitorView } from './index.js';

const { paint, size, resize } = vi.hoisted(() => {
  const size = { width: 0, height: 0, dpr: 1 };
  return {
    size,
    resize: vi.fn((width: number, height: number, dpr: number) => Object.assign(size, { width, height, dpr })),
    paint: vi.fn<(frame: SwarmFrame) => void>(),
  };
});
vi.mock('./gpu/swarm-renderer.js', async (original) => ({
  ...(await original<object>()),
  createSwarmRenderer: async () => ({
    ok: true,
    renderer: { render: paint, resize, destroy: () => {}, lost: new Promise(() => {}) },
  }),
}));

let field = { width: 1000, height: 280 };
let observeResize: (() => void) | undefined;
const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  paint.mockClear();
  resize.mockClear();
  field = { width: 1000, height: 280 };
  observeResize = undefined;
});

async function frames(count: number) {
  for (let i = 0; i < count; i += 1)
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
}
async function mount(animations: boolean, bottom = 0) {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => field.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => field.height);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observeResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const root = document.createElement('div');
  document.body.append(root);
  cleanups.push(() => root.remove());
  let instance!: MonitorViewInstance;
  let input: MonitorViewInput = {
    model: fixtureModel(agentViewsFixture(1)),
    changes: { added: [], updated: [], removed: [] },
    stage: { ...field, insets: { top: 0, right: 0, bottom, left: 0 }, obstacles: [] },
    theme: fixtureTheme('dark', { animations }),
    parameters: parameterDefaults(SWARM_MANIFEST),
    capabilities: {},
  };
  await act(async () => {
    instance = swarmMonitorView.mount(root, input, countingCommands().commands);
  });
  cleanups.push(() => act(async () => instance.unmount()));
  await frames(90);
  return async (bottom: number) => {
    input = { ...input, stage: { ...input.stage, insets: { ...input.stage.insets, bottom } } };
    await act(async () => instance.update(input));
  };
}

const body = () => paint.mock.calls.at(-1)![0].bodies[0]!;
describe('a full canvas and an eased terminal wall', () => {
  for (const animations of [true, false]) {
    it(`repaints in ResizeObserver before another animation frame (motion ${animations ? 'on' : 'off'})`, async () => {
      await mount(animations);
      const radius = body().radius;
      for (const height of [900, 280, 900, 280]) {
        const paints = paint.mock.calls.length;
        field = { ...field, height };
        // Browser ordering: layout changed after rAF. Waiting for the next rAF would present a stretched/blank canvas.
        await act(async () => {
          observeResize?.();
        });
        expect(paint.mock.calls.length).toBeGreaterThan(paints);
        expect(size.height).toBe(height);
        // Resizing the backing store never rebases a body's coordinates.
        expect(Number.isFinite(body().y)).toBe(true);
        expect(body().radius).toBe(radius);
        const resizedAt = resize.mock.invocationCallOrder.at(-1)!;
        expect(paint.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(resizedAt);
        await frames(15);
      }
    });
  }

  it('measures before drawing if layout changed before the observer delivered', async () => {
    await mount(true);
    field = { width: 800, height: 900 };
    await frames(1);
    expect(size).toMatchObject(field);
    expect(body().x).toBeCloseTo(500, 0);
    expect(body().y).toBeCloseTo(140, 0);
    const before = body().y;
    // The observer may run afterwards in the same paint: no relocation.
    await act(async () => {
      observeResize?.();
    });
    expect(body().y).toBe(before);
  });

  for (const animations of [true, false]) {
    it(`keeps the full canvas and continuous positions when the pane moves (motion ${animations})`, async () => {
      field = { width: 1000, height: 900 };
      const pane = await mount(animations, 620);
      expect(body().y).toBeCloseTo(140, 2);
      const resizes = resize.mock.calls.length;
      for (const bottom of [0, 620, 0, 620]) {
        const start = body().y;
        await pane(bottom);
        expect(body().y).toBe(start);
        const path: number[] = [];
        for (let frame = 0; frame < 240; frame += 1) {
          const previous = body().y;
          await frames(1);
          path.push(body().y);
          expect(Math.abs(body().y - previous)).toBeLessThan(40);
        }
        expect(size).toMatchObject(field);
        expect(resize).toHaveBeenCalledTimes(resizes);
        if (animations) {
          expect(Math.abs(body().y - (900 - bottom) / 2)).toBeLessThan(3);
          expect(path.some((at) => at > 170 && at < 400)).toBe(true);
        } else expect(body().y).toBe(start);
      }
    });
  }

  it('ignores a temporarily collapsed layout and redraws at the current display scale', async () => {
    await mount(true);
    const paints = paint.mock.calls.length;
    field = { width: 0, height: 0 };
    await act(async () => {
      observeResize?.();
    });
    expect(paint).toHaveBeenCalledTimes(paints);
    field = { width: 1000, height: 280 };
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2);
    await frames(1);
    expect(size).toEqual({ ...field, dpr: 2 });
    expect(body().y).toBeCloseTo(140, 3);
  });
});
