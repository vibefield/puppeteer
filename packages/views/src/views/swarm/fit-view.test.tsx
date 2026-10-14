// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentView, MonitorViewInput, MonitorViewInstance, StageGeometry } from '@vibefield/puppeteer-view-sdk';
import {
  agentViewsFixture,
  countingCommands,
  fixtureModel,
  fixtureTheme,
  parameterDefaults,
} from '@vibefield/puppeteer-view-sdk/testing';
import { baseRadius, workingShares } from './bubble-model.js';
import { fitScale } from './fit.js';
import type { SwarmFrame } from './gpu/swarm-renderer.js';
import { SWARM_MANIFEST, swarmMonitorView } from './index.js';
import { DEFAULT_SWARM_PARAMETERS } from './swarm-parameters.js';

// THE CROWD FITS ITS FIELD, as the host mounts the view (SWF): the shipping
// swarm through `mount`, its physics inline (happy-dom has no Worker), and a
// paint spy where the renderer was. What the fit's own tests cannot see: that
// every body is drawn and solved at its base size times one shared scale, that
// births take it, that the visual eases to a new one on the radius spring, that
// nothing refits per frame, and that a field held still is drawn at the fitted
// size at once.

const { paint, fits } = vi.hoisted(() => ({
  paint: vi.fn<(frame: SwarmFrame) => void>(),
  fits: { count: 0 },
}));
vi.mock('./gpu/swarm-renderer.js', async (original) => ({
  ...(await original<object>()),
  createSwarmRenderer: async () => ({
    ok: true,
    renderer: { render: paint, resize: () => {}, destroy: () => {}, lost: new Promise(() => {}) },
  }),
}));
vi.mock('./fit.js', async (original) => {
  const actual = await original<typeof import('./fit.js')>();
  return {
    ...actual,
    fitScale: (...args: Parameters<typeof actual.fitScale>) => {
      fits.count += 1;
      return actual.fitScale(...args);
    },
  };
});

const parameters = parameterDefaults(SWARM_MANIFEST);
/** VibeField's default stage: 1164 × 288 under its 56 px head, a full-width obstacle. */
let field = { width: 1164, height: 288 };
const stageOf = (width: number, height: number): StageGeometry => ({
  width,
  height,
  insets: { top: 56, right: 0, bottom: 0, left: 0 },
  obstacles: [{ x: 0, y: 0, width, height: 56 }],
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  paint.mockClear();
  fits.count = 0;
  field = { width: 1164, height: 288 };
});

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }
}

function inputFor(agents: readonly AgentView[], stage: StageGeometry, animations = true): MonitorViewInput {
  return {
    model: fixtureModel(agents),
    changes: { added: [], updated: [], removed: [] },
    stage,
    theme: fixtureTheme('light', { animations }),
    parameters,
    capabilities: {},
  };
}

async function mounted(agents: readonly AgentView[], animations = true) {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => field.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => field.height);
  const root = document.createElement('div');
  document.body.append(root);
  cleanups.push(() => root.remove());
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = swarmMonitorView.mount(
      root,
      inputFor(agents, stageOf(field.width, field.height), animations),
      countingCommands().commands,
    );
  });
  cleanups.push(() => act(async () => instance.unmount()));
  return {
    instance,
    resize: async (width: number, height: number) => {
      field = { width, height };
      await act(async () => instance.update(inputFor(agents, stageOf(width, height), animations)));
    },
  };
}

/** The scale the fit gives these rows on this field, from 1. */
function expectedScale(agents: readonly AgentView[], width: number, height: number, previous = 1): number {
  const shares = workingShares(agents);
  return fitScale(
    {
      field: { width, height },
      obstacles: stageOf(width, height).obstacles,
      radii: agents.map((agent) => baseRadius(agent, DEFAULT_SWARM_PARAMETERS, shares.get(agent.id) ?? 0)),
      smallestBase: 50,
    },
    previous,
  );
}

const lastFrame = (): SwarmFrame => paint.mock.calls.at(-1)![0];

/** Each painted body's base size, from its row. */
function bases(agents: readonly AgentView[]): Map<string, number> {
  const shares = workingShares(agents);
  return new Map(
    agents.map((agent) => [agent.id, baseRadius(agent, DEFAULT_SWARM_PARAMETERS, shares.get(agent.id) ?? 0)]),
  );
}

describe('the crowd fits its field (SWF)', () => {
  const crowd = agentViewsFixture(27);
  /** A crowd with room to shrink on this stage: above the floor at 1164 wide, smaller at 760. */
  const shrinking = agentViewsFixture(14);

  it('draws every body at its base size times one shared scale, below 1 for a crowd bigger than its field', async () => {
    await mounted(crowd);
    await frames(30);
    const k = expectedScale(crowd, 1164, 288);
    expect(k).toBeLessThan(1);
    const base = bases(crowd);
    const frame = lastFrame();
    expect(frame.bodies).toHaveLength(27);
    for (const body of frame.bodies) {
      expect(body.model.radius).toBeCloseTo(base.get(body.model.id)! * k, 9);
      // Born at the fitted size: the visual never had a base-size body to ease down from.
      expect(body.radius).toBeCloseTo(body.model.radius, 9);
    }
  });

  it('leaves a crowd with room at today’s sizes (k = 1)', async () => {
    const few = agentViewsFixture(3);
    await mounted(few);
    await frames(10);
    const base = bases(few);
    for (const body of lastFrame().bodies) expect(body.model.radius).toBe(base.get(body.model.id));
  });

  it('refits when the field changes, never per frame, and eases the bodies to the new size on the spring', async () => {
    const { resize } = await mounted(shrinking);
    await frames(30);
    const settled = fits.count;
    await frames(90);
    // Ninety frames, a model refresh among them, and no refit: nothing it reads moved.
    expect(fits.count).toBe(settled);

    const before = expectedScale(shrinking, 1164, 288);
    const after = expectedScale(shrinking, 760, 288, before);
    expect(after).toBeLessThan(before);
    await resize(760, 288);
    expect(fits.count).toBeGreaterThan(settled);
    await frames(1);
    const base = bases(shrinking);
    const id = lastFrame().bodies[0]!.model.id;
    const easing = lastFrame().bodies[0]!;
    // The model (and the physics) jumped to the new size; the drawn radius is on its way there, not there yet.
    expect(easing.model.radius).toBeCloseTo(base.get(id)! * after, 9);
    expect(easing.radius).toBeGreaterThan(easing.model.radius + 0.01);
    expect(easing.radius).toBeLessThan(base.get(id)! * before);
    await frames(90);
    const landed = lastFrame().bodies.find((body) => body.model.id === id)!;
    expect(landed.radius).toBe(landed.model.radius);
  });

  it('draws a field held still at the fitted size at once, with no spring to run', async () => {
    const { resize } = await mounted(shrinking, false);
    await frames(3);
    const drawnAtMount = paint.mock.calls.length;
    // The host re-measures the same stage: a still field draws once per change.
    await resize(1164, 288);
    expect(paint.mock.calls.length).toBeGreaterThan(drawnAtMount);
    const before = expectedScale(shrinking, 1164, 288);
    const base = bases(shrinking);
    const first = lastFrame();
    expect(first.motion).toBe(false);
    for (const body of first.bodies) expect(body.radius).toBeCloseTo(base.get(body.model.id)! * before, 9);
    const after = expectedScale(shrinking, 760, 288, before);
    expect(after).toBeLessThan(before);
    await resize(760, 288);
    for (const body of lastFrame().bodies) expect(body.radius).toBeCloseTo(base.get(body.model.id)! * after, 9);
  });
});
