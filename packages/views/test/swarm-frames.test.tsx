// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorModel, MonitorViewInput, MonitorViewInstance, StageGeometry } from '@vibefield/puppeteer-view-sdk';
import { countingCommands, parameterDefaults } from '@vibefield/puppeteer-view-sdk/testing';
import { labModel } from '../src/lab/lab-model.js';
import { LAB_NOW_MS, seededRandom } from '../src/lab/lab-world.js';
import { readMonitorPalette } from '../src/monitor/palette.js';
import { SWARM_FIT } from '../src/views/swarm/fit.js';
import type { SwarmFrame } from '../src/views/swarm/gpu/swarm-renderer.js';
import { SWARM_MANIFEST, swarmMonitorView } from '../src/views/swarm/index.js';
import { DEFAULT_SWARM_PARAMETERS } from '../src/views/swarm/swarm-parameters.js';

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
//
// A golden holds on every CPU this repo's CI runs, or it is no golden. The n = 20 crowds are compared EXACTLY only
// before EXACT_UNTIL_S; from there on every frame is held to the crowd's invariants instead (crowdKeepsItsShape),
// because a crowd that full is chaotic in the last bit: on x64 (CI's ubuntu-latest and windows-latest, run
// 40252549194, 2026-10-26) compact-n20's first frame to differ from the arm64-recorded golden is t = 0.592 s, body
// `idle-unread`, x 156.26 → 156.25 and y 82.64 → 82.66, and the crowd amplifies it to every later frame. n = 1 has no
// crowd to amplify anything and stays exact over its whole horizon. What the view promises is the crowd's behaviour,
// not its ulps (VF-PM's ruling B, 2026-10-26 02:10Z).

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
/** The n = 20 crowds' exact horizon, seconds: the first frame time x64 measured apart from arm64 (above). */
const EXACT_UNTIL_S = 0.592;
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

/** A model's key, as the Electron golden hashes it (sha256, 12 hex): the platform's digest, no `node:` import (M59). */
async function hash12(json: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

/** A frame as the golden keeps it; models go by hash, stored once, in the order the bodies were met. */
async function project(frame: SwarmFrame, index: number, models: Record<string, unknown>) {
  const bodies = [];
  for (const body of frame.bodies) {
    const json = JSON.stringify(rounded(body.model));
    const hash = await hash12(json);
    models[hash] ??= JSON.parse(json);
    bodies.push({
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
    });
  }
  return {
    index,
    time: round(frame.time, 4),
    motion: frame.motion,
    ...(frame.veil ? { veil: round(frame.veil, 3) } : {}),
    ...(frame.hold ? { hold: rounded(frame.hold) } : {}),
    bodies,
  };
}

/**
 * What a crowd keeps on every CPU, every frame from the first in which every body has landed (its arrival `scale` is
 * 1), measured on the arm64 goldens and bounded from them:
 * - every body's centre inside the field: right of the usage column's inset, within the stage (measured: none out);
 * - no body's centre inside another body's disc — the round pull packs the crowd and Matter's contacts yield under it
 *   by design (SWF, a30d3984), so discs overlap, but by less than the smaller one's radius (measured: at most 0.82 of
 *   it in compact-n20, 0.45 in default-n20);
 * - ONE scale for the whole crowd (SWF's fit): every radius at or above the floor, and the largest over the smallest
 *   at most the largest base over the smallest (80 / 50 here), the ratio one shared k keeps (measured: exactly 1.6);
 * - the settled crowd centred on the field, as the radial pull puts it: its centroid within a tenth of the field's
 *   width and height of the field's centre at the end of each phase (measured: 36 px and 5 px at most).
 */
function crowdKeepsItsShape(
  recorded: readonly SwarmFrame[],
  geometry: StageGeometry,
  settled: readonly number[],
): void {
  const left = geometry.insets.left;
  const fieldWidth = geometry.width - left;
  const bases = [
    DEFAULT_SWARM_PARAMETERS.radiusIdle,
    DEFAULT_SWARM_PARAMETERS.radiusWorking,
    DEFAULT_SWARM_PARAMETERS.radiusWorkingMax,
    DEFAULT_SWARM_PARAMETERS.radiusBlocked,
  ];
  const ratio = Math.max(...bases) / Math.min(...bases);
  const first = recorded.findIndex(
    (frame) => frame.bodies.length > 0 && frame.bodies.every((body) => body.scale >= 0.999),
  );
  expect(first).toBeGreaterThanOrEqual(0);
  recorded.forEach((frame, index) => {
    if (index < first) return;
    const bodies = frame.bodies.filter((body) => body.opacity > 0 && body.scale >= 0.999);
    for (const body of bodies) {
      expect(body.x, `frame ${index} ${body.model.id} x`).toBeGreaterThanOrEqual(left);
      expect(body.x, `frame ${index} ${body.model.id} x`).toBeLessThanOrEqual(geometry.width);
      expect(body.y, `frame ${index} ${body.model.id} y`).toBeGreaterThanOrEqual(0);
      expect(body.y, `frame ${index} ${body.model.id} y`).toBeLessThanOrEqual(geometry.height);
      expect(body.radius, `frame ${index} ${body.model.id} radius`).toBeGreaterThanOrEqual(
        SWARM_FIT.floorRadius - 0.01,
      );
    }
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const depth = a.radius + b.radius - Math.hypot(a.x - b.x, a.y - b.y);
        expect(depth, `frame ${index} ${a.model.id} × ${b.model.id}`).toBeLessThan(Math.min(a.radius, b.radius));
      }
    }
    if (bodies.length > 1) {
      const radii = bodies.map((body) => body.radius);
      expect(Math.max(...radii) / Math.min(...radii), `frame ${index} one scale`).toBeLessThanOrEqual(ratio * 1.02);
    }
  });
  for (const index of settled) {
    const bodies = recorded[index]!.bodies.filter((body) => body.opacity > 0);
    const cx = bodies.reduce((sum, body) => sum + body.x, 0) / bodies.length;
    const cy = bodies.reduce((sum, body) => sum + body.y, 0) / bodies.length;
    expect(Math.abs(cx - (left + fieldWidth / 2)), `frame ${index} centroid x`).toBeLessThanOrEqual(fieldWidth / 10);
    expect(Math.abs(cy - geometry.height / 2), `frame ${index} centroid y`).toBeLessThanOrEqual(geometry.height / 10);
  }
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
    const sampled = recorded
      .map((frame, index) => ({ frame, index }))
      .filter(
        ({ index }) =>
          index % KEEP_EVERY === 0 || index === before - 1 || index === before || index === recorded.length - 1,
      );
    const crowd = n > 1;
    const kept = [];
    for (const { frame, index } of sampled) {
      if (crowd && frame.time >= EXACT_UNTIL_S) continue;
      kept.push(await project(frame, index, models));
    }
    if (crowd) crowdKeepsItsShape(recorded, geometry, [before - 1, recorded.length - 1]);
    const ids = (frame: SwarmFrame | undefined) => new Set(frame?.bodies.map((body) => body.model.id));
    expect(ids(recorded[before - 1]).has('late-arrival')).toBe(false);
    expect(ids(recorded.at(-1)).has('late-arrival')).toBe(true);
    // No Worker here: the physics ran in this thread from the start, and the view said so (MV-D7).
    expect(reports).toContainEqual({ physics: 'inline' });
    await act(async () => instance.unmount());
    const golden = {
      scenario: name,
      recorded: recorded.length,
      changedAt: before,
      ...(crowd ? { exactUntil: EXACT_UNTIL_S } : {}),
      frames: kept,
      models,
    };
    await expect(`${JSON.stringify(golden, null, 1)}\n`).toMatchFileSnapshot(`./goldens/swarm/${name}.json`);
  });
});
