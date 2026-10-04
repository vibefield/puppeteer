// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAB_NOW_MS, labWorld, seededRandom } from '../../lab/lab-world.js';
import { MONITOR_CHROME_ATTRIBUTE, MONITOR_STAGE_CLASS } from '../../monitor/chrome.js';
import { readMonitorPalette } from '../../monitor/palette.js';
import { monitorParameterDefaults } from '../../monitor/parameters.js';
import { AgentSwarm } from './AgentSwarm.js';
import type { SwarmFrame } from './gpu/swarm-renderer.js';
import { SwarmPhysicsProvider } from './physics/context.js';
import { createInlineSwarmPhysicsDriver } from './physics/inline-driver.js';
import { SWARM_PARAMETER_GROUPS } from './swarm-parameters.js';

// The swarm's frame parity (MV-0): the frames the shipping AgentSwarm hands its
// renderer, for the seeded world at a fixed timestep, against goldens recorded
// on today's view. Only GPU submission is replaced: a paint spy records each
// frame, while the view, its bubble models and the inline physics (the same
// host the worker runs) all run as shipped. Each scenario runs 60 frames from
// mount, moves the world on (`labWorld({ churn: true })`), and runs 60 more.
//
// happy-dom lays nothing out, so the stage's box and the usage column's rect are
// Godview's geometry, given by hand; apps/godview/goldens/swarm records the same
// sequences with real layout in Electron. Re-record after an INTENTIONAL change:
// `pnpm exec vitest run src/views/swarm/AgentSwarm.frames.test.tsx -u`.

const { paint } = vi.hoisted(() => ({ paint: vi.fn<(frame: SwarmFrame) => void>() }));
vi.mock('./gpu/swarm-renderer.js', async (original) => ({
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

let stage = { width: 0, height: 0 };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
    now: LAB_NOW_MS,
  });
  vi.spyOn(Math, 'random').mockImplementation(seededRandom('mv0:random'));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => stage.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => stage.height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
    // godview.css's usage column: 46 px wide at (13, 11), the stage's height less 17.
    return this.hasAttribute(MONITOR_CHROME_ATTRIBUTE)
      ? new DOMRect(13, 11, 46, stage.height - 17)
      : new DOMRect(0, 0, stage.width, stage.height);
  });
  paint.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
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

async function show(n: number, churn: boolean): Promise<void> {
  await act(async () =>
    root.render(
      <section className={MONITOR_STAGE_CLASS}>
        <SwarmPhysicsProvider factory={createInlineSwarmPhysicsDriver}>
          <AgentSwarm
            agents={labWorld({ n, churn }).agents}
            parameters={monitorParameterDefaults(SWARM_PARAMETER_GROUPS)}
            palette={readMonitorPalette()}
            actions={{ select: () => undefined, createAt: () => undefined }}
          />
        </SwarmPhysicsProvider>
        <div className="vf-monitor-chrome" {...{ [MONITOR_CHROME_ATTRIBUTE]: '' }} />
      </section>,
    ),
  );
}

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }
}

describe('AgentSwarm frames', () => {
  it.each(SCENARIOS)('match the golden for $name', async ({ name, width, height, n }) => {
    stage = { width, height };
    await show(n, false);
    await frames(BEFORE);
    const before = paint.mock.calls.length;
    await show(n, true);
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
    const golden = { scenario: name, recorded: recorded.length, changedAt: before, frames: kept, models };
    await expect(`${JSON.stringify(golden, null, 1)}\n`).toMatchFileSnapshot(`./goldens/${name}.json`);
  });
});
