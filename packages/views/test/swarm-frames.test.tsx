// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorModel, MonitorViewInput, MonitorViewInstance, StageGeometry } from '@vibecook/puppeteer-view-sdk';
import { countingCommands, parameterDefaults } from '@vibecook/puppeteer-view-sdk/testing';
import { labModel } from '../src/lab/lab-model.js';
import { LAB_NOW_MS, seededRandom } from '../src/lab/lab-world.js';
import { readMonitorPalette } from '../src/monitor/palette.js';
import type { SwarmFrame } from '../src/views/swarm/gpu/swarm-renderer.js';
import { SWARM_MANIFEST, swarmMonitorView } from '../src/views/swarm/index.js';

// The swarm's frame parity (MV-0, on the SDK since MV-5): the frames the shipping
// swarm hands its renderer, for the seeded world at a fixed timestep, against
// goldens recorded on the ported view (re-recorded for M4: a body's title and
// accessible name are reply-first now, and the models carry them). Only GPU
// submission is replaced: a paint spy records each frame, while the view, its
// bubble models and the inline physics (the same host the worker runs; there is
// no Worker in happy-dom, so the driver runs inline from the start and says so)
// all run as shipped. Each scenario runs 60 frames from mount, moves the world on
// (`labModel({ churn: true })`), and runs 60 more.
//
// happy-dom lays nothing out, so the stage's box and the usage column's rect are
// Godview's geometry, given by hand as the stage the host would measure (MV-D19);
// apps/godview/goldens/swarm records the same sequences with real layout in
// Electron. This file lives outside the view's folder because its world is the
// lab's (the wall, W1, reads a view's tests too). Re-record after an INTENTIONAL
// change: `pnpm exec vitest run test/swarm-frames.test.tsx -u`.

const { paint } = vi.hoisted(() => ({ paint: vi.fn<(frame: SwarmFrame) => void>() }));
vi.mock('../src/views/swarm/gpu/swarm-renderer.js', async (original) => ({
  ...(await original<object>()),
  createSwarmRenderer: async () => ({
    ok: true,
    renderer: { render: paint, resize: () => {}, destroy: () => {}, lost: new Promise(() => {}) },
  }),
}));

const SCENARIOS = [
  { name: 'default-n20', width: 1180, height: 252, n: 20 },
  { name: 'compact-n20', width: 680, height: 170, n: 20 },
  { name: 'default-n1', width: 1180, height: 252, n: 1 },
] as const;
const BEFORE = 60;
const AFTER = 60;
const KEEP_EVERY = 4;
const NO_CHANGES = Object.freeze({ added: [], updated: [], removed: [] });

let stage = { width: 0, height: 0 };
let root: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
    now: LAB_NOW_MS,
  });
  vi.spyOn(Math, 'random').mockImplementation(seededRandom('mv0:random'));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => stage.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => stage.height);
  paint.mockClear();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
const rounded = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(rounded)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rounded(entry)]))
      : typeof value === 'number'
        ? round(value, 4)
        : value;

/** A frame as the golden keeps it; models go by hash, stored once. */
function project(frame: SwarmFrame, index: number, models: Record<string, unknown>) {
  return {
    index,
    time: round(frame.time, 4),
    motion: frame.motion,
    ...(frame.veil ? { veil: round(frame.veil, 3) } : {}),
    ...(frame.hold ? { hold: rounded(frame.hold) } : {}),
    bodies: frame.bodies.map((body) => {
      const json = JSON.stringify(rounded(body.model));
      const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
      models[hash] ??= JSON.parse(json);
      return {
        id: body.model.id,
        x: round(body.x, 2),
        y: round(body.y, 2),
        radius: round(body.radius, 2),
        scale: round(body.scale, 3),
        opacity: round(body.opacity, 3),
        focus: body.focus,
        seed: round(body.seed, 4),
        accent: body.accent.map((channel) => round(channel, 3)),
        ...(body.link ? { link: body.link.map((channel) => round(channel, 3)) } : {}),
        model: hash,
      };
    }),
  };
}

/** Godview's stage as the host measures it (MV-D19): the usage column (godview.css) at (13, 11), 46 wide, the
 * stage's height less 17, as an obstacle and the left inset. */
function stageOf(width: number, height: number): StageGeometry {
  return {
    width,
    height,
    insets: { top: 0, right: 0, bottom: 0, left: 13 + 46 },
    obstacles: [{ x: 13, y: 11, width: 46, height: height - 17 }],
  };
}

function inputFor(model: MonitorModel, geometry: StageGeometry): MonitorViewInput {
  return {
    model,
    changes: NO_CHANGES,
    stage: geometry,
    theme: { scheme: 'light', tokens: readMonitorPalette(), reducedMotion: false, animations: true },
    parameters: parameterDefaults(SWARM_MANIFEST),
    capabilities: {},
  };
}

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }
}

describe('the swarm’s frames', () => {
  it.each(SCENARIOS)('match the golden for $name', async ({ name, width, height, n }) => {
    stage = { width, height };
    const geometry = stageOf(width, height);
    const { commands, reports } = countingCommands();
    let instance!: MonitorViewInstance;
    await act(async () => {
      instance = swarmMonitorView.mount(root, inputFor(labModel({ n }), geometry), commands);
    });
    await frames(BEFORE);
    const before = paint.mock.calls.length;
    await act(async () => instance.update(inputFor(labModel({ n, churn: true }), geometry)));
    await frames(AFTER);
    const recorded = paint.mock.calls.map(([frame]) => frame);
    // One frame per animation frame once the renderer answered, and the change landed between them.
    expect(recorded.length).toBeGreaterThanOrEqual(BEFORE + AFTER - 2);
    const models: Record<string, unknown> = {};
    const kept = recorded
      .map((frame, index) => ({ frame, index }))
      .filter(
        ({ index }) =>
          index % KEEP_EVERY === 0 || index === before - 1 || index === before || index === recorded.length - 1,
      )
      .map(({ frame, index }) => project(frame, index, models));
    const ids = (frame: SwarmFrame | undefined) => new Set(frame?.bodies.map((body) => body.model.id));
    expect(ids(recorded[before - 1]).has('late-arrival')).toBe(false);
    expect(ids(recorded.at(-1)).has('late-arrival')).toBe(true);
    // No Worker here: the physics ran in this thread from the start, and the view said so (MV-D7).
    expect(reports).toContainEqual({ physics: 'inline' });
    await act(async () => instance.unmount());
    const golden = { scenario: name, recorded: recorded.length, changedAt: before, frames: kept, models };
    await expect(`${JSON.stringify(golden, null, 1)}\n`).toMatchFileSnapshot(`./goldens/swarm/${name}.json`);
  });
});
