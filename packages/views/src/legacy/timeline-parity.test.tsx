// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentView, MonitorModel, MonitorViewInstance } from '@vibecook/puppeteer-view-sdk';
import {
  agentViewFixture,
  countingCommands,
  createFixtureClock,
  createFrameDriver,
  fixtureInput,
  fixtureModel,
  fixtureStage,
  fixtureTheme,
  parameterDefaults,
} from '@vibecook/puppeteer-view-sdk/testing';
import { labModel, LAB_DEVICE } from '../lab/lab-model.js';
import { LAB_NOW_MS } from '../lab/lab-world.js';
import type { MonitorPalette } from '../monitor/palette.js';
import type { MonitorAgent } from '../monitor/types.js';
import { TIMELINE_MANIFEST, timelineMonitorView } from '../views/timeline/index.js';
import { pulseRowsFor } from '../views/timeline/pulse-map.js';
import { resolveTimelineInks } from '../views/timeline/timeline-inks.js';
import { stateAt, timelineLanes, type TimelineLane } from '../views/timeline/timeline-lanes.js';
import { laneLabel, readoutAt } from '../views/timeline/timeline-words.js';
import { pulseRowsFor as legacyPulseRows } from './frozen/timeline/pulse-map.js';
import {
  EMPTY_STATUS_LEDGER,
  observeStatuses,
  statusHistoryBook,
  type StatusLedger,
} from './frozen/timeline/status-ledger.js';
import type { MonitorHistoryBook } from './frozen/timeline/status-history.js';
import {
  stateAt as legacyStateAt,
  timelineLanes as legacyTimelineLanes,
  type TimelineLane as LegacyLane,
} from './frozen/timeline/timeline-lanes.js';
import { resolveTimelineInks as legacyInks } from './frozen/timeline/timeline-paint.js';
import { laneLabel as legacyLaneLabel, readoutAt as legacyReadoutAt } from './frozen/timeline/timeline-words.js';
import { TimelineView as LegacyTimeline } from './frozen/timeline/TimelineView.js';
import { toMonitorAgents, type LegacyShimOptions } from './index.js';

// PARITY ACROSS BOTH HOSTS (MV-6, design-mv §5: no regressions). The ported
// timeline and its legacy self (`frozen/timeline/`, as it shipped) render the
// same model. The legacy one is fed exactly what its host fed it: the shim's
// rows under a host's options, and the book Godview's window kept by folding
// each model it published into the status ledger.
//
// OVER A FRESH DAEMON (no row has changed since the window first saw it) the
// legacy's book holds one open span per row, from the row's current state, so
// the runtime-only port must draw the same, but these named differences, each
// asserted to be exactly what it is:
//
//   - RT5: a row the legacy shape gave no time (a bare terminal, a run the
//     runtime has not reported yet, and under VibeField's options a peer: M9)
//     was dated by the window's first sight. Every AgentView carries its
//     statusSince, so the port starts its current stretch there.
//   - M9 (VibeField's options): a peer's blocked lane says what it waits on
//     (its kind and words); the legacy peer carried no blocker ("failed").
//   - L18: the view's own custom properties under their `--mv-timeline-*`
//     names, two of them new: the stage's inset and the palette's ground.
//   - M4 moves nothing here: the timeline never drew the line under a name.
//
// OVER A MODEL WITH HISTORY (rows that changed while the window watched, one
// that ended) the differences are exactly runtime only's: each live lane is its
// legacy's last span, and nothing before it (RT1); the ended lane is gone (RT2);
// the map counts current stretches only (RT3).

const GODVIEW: LegacyShimOptions = { detail: 'headline-cost', peerMonitor: 'map' };
const VIBEFIELD: LegacyShimOptions = { detail: 'reply-first', peerMonitor: 'omit' };
const HOSTS = [
  ['puppeteer’s Godview', GODVIEW],
  ['VibeField', VIBEFIELD],
] as const;

const NOW = LAB_NOW_MS;
const MIN = 60_000;
const theme = fixtureTheme('dark');
const palette = theme.tokens as MonitorPalette;
const stage = fixtureStage('default');
const parameters = parameterDefaults(TIMELINE_MANIFEST);
const LAPTOP = { id: 'desk-2', name: 'Laptop', os: 'linux', self: false } as const;

/** The seeded world (every status, wait, kind, unread, receded, active and attachment case, peers, a starting run,
 * bare terminals), plus runs nothing drives yet, a peer asking a question, and a peer's terminal. */
const parityModel = (): MonitorModel => {
  const world = labModel({ n: 20, tint: palette.tint, neutral: palette.neutral });
  const extra: AgentView[] = [
    agentViewFixture({
      id: 'pending-here',
      device: LAB_DEVICE,
      observed: false,
      pending: true,
      detail: 'unobserved · resumes when idle',
      project: { name: 'paused', seq: 3 },
      provider: { id: 'codex', label: 'Codex' },
      createdAt: NOW - 40 * MIN,
      statusSince: NOW - 40 * MIN,
    }),
    agentViewFixture({
      id: 'asking-peer',
      device: LAPTOP,
      status: 'blocked',
      wait: { kind: 'question', since: NOW - 3 * MIN, header: 'Deploy', question: 'Ship it?' },
      project: { name: 'release', branch: 'main' },
      provider: { id: 'claude', label: 'Claude' },
      model: 'Sonnet 4.5',
      createdAt: NOW - 30 * MIN,
      statusSince: NOW - 3 * MIN,
    }),
    agentViewFixture({
      id: 'peer-shell',
      kind: 'terminal',
      device: LAPTOP,
      status: 'working',
      project: { name: 'notes' },
      detail: 'Unassigned terminal',
      createdAt: NOW - 20 * MIN,
      statusSince: NOW - 4 * MIN,
    }),
  ];
  return fixtureModel([...world.agents, ...extra]);
};

/** A fresh daemon: the window folded the first model it saw into its ledger, once, at now. */
const freshBook = (rows: readonly MonitorAgent[]): MonitorHistoryBook =>
  statusHistoryBook(observeStatuses(EMPTY_STATUS_LEDGER, rows, NOW));

/** RT5: the rows the legacy shape gave no time (no `agent.monitor.statusSince`): dated by first sight. */
const undated = (row: MonitorAgent): boolean => row.agent?.monitor?.statusSince === undefined;

// ───────────────────────────── a canvas that records, and a size to draw at

interface Call {
  readonly canvas: string;
  readonly entry: string;
}

let calls: Call[] = [];
const canvasNames = new WeakMap<object, string>();
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();

function argument(value: unknown): unknown {
  if (value instanceof RecordingPath) return `path(${value.ops.join(' ')})`;
  if (value !== null && typeof value === 'object' && 'tagName' in value)
    return `<${String((value as Element).tagName)}>`;
  if (value !== null && typeof value === 'object' && canvasNames.has(value)) return canvasNames.get(value);
  return value;
}

function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const name = (): string => canvas.className;
  // `filter` present, so both views take the glow paths ('filter' in ctx).
  const state: Record<string, unknown> = { filter: 'none' };
  let gradients = 0;
  const log = (entry: string): void => {
    calls.push({ canvas: name(), entry });
  };
  return new Proxy(state, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key === 'canvas') return canvas;
      if (key === 'createLinearGradient') {
        return (...args: unknown[]) => {
          const id = `gradient${gradients++}`;
          log(`createLinearGradient(${JSON.stringify(args)}) -> ${id}`);
          const gradient = {
            addColorStop: (offset: number, colour: string) => log(`${id}.addColorStop(${offset}, ${colour})`),
          };
          canvasNames.set(gradient, id);
          return gradient;
        };
      }
      if (key === 'measureText') return (text: string) => ({ width: text.length * 5 });
      if (key in target) return target[key];
      return (...args: unknown[]) => log(`${key}(${JSON.stringify(args.map(argument))})`);
    },
    set(target, key, value) {
      if (typeof key === 'string') {
        target[key] = value;
        log(`${key} = ${JSON.stringify(argument(value))}`);
      }
      return true;
    },
    has(target, key) {
      return key in target;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class RecordingPath {
  readonly ops: string[] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(`M${x},${y}`);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(`L${x},${y}`);
  }
  bezierCurveTo(...args: number[]): void {
    this.ops.push(`C${args.join(',')}`);
  }
  arc(...args: number[]): void {
    this.ops.push(`A${args.join(',')}`);
  }
  closePath(): void {
    this.ops.push('Z');
  }
}

const realGetContext = HTMLCanvasElement.prototype.getContext;
const sizes = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) {
      context = recordingContext(this);
      contexts.set(this, context);
    }
    return context;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  (globalThis as { Path2D?: unknown }).Path2D = RecordingPath;
  // The view's root as Godview's default stage lays it out past the usage column, tall enough for every lane.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1064 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 });
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  delete (globalThis as { Path2D?: unknown }).Path2D;
  for (const key of ['clientWidth', 'clientHeight'] as const) {
    if (sizes[key]) Object.defineProperty(HTMLElement.prototype, key, sizes[key]);
  }
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  calls = [];
});

/** Mounts one view on a fresh clock at now, lets it draw `frames` frames, and gives back its DOM and its canvas. */
async function drawn(
  mount: (root: HTMLElement) => Promise<void>,
  frames = 3,
): Promise<{ root: HTMLElement; calls: Call[] }> {
  calls = [];
  const clock = createFixtureClock(NOW);
  const restoreClock = clock.install();
  const driver = createFrameDriver({ clock });
  const restoreFrames = driver.install();
  const root = document.createElement('div');
  document.body.append(root);
  try {
    await mount(root);
    await act(async () => driver.step(frames));
  } finally {
    restoreFrames();
    restoreClock();
  }
  const recorded = calls;
  calls = [];
  return { root, calls: recorded };
}

/** The legacy view as Godview's bridge mounted it: its own root, the shim's rows, the palette and the book. */
function mountLegacy(rows: readonly MonitorAgent[], history: MonitorHistoryBook) {
  return async (root: HTMLElement): Promise<void> => {
    let react!: Root;
    await act(async () => {
      react = createRoot(root);
      react.render(
        createElement(LegacyTimeline, {
          agents: [...rows],
          parameters,
          actions: { select: () => undefined, createAt: () => undefined },
          palette,
          history,
        }),
      );
    });
    cleanups.push(() => {
      void act(() => react.unmount());
      root.remove();
    });
  };
}

function mountPorted(model: MonitorModel) {
  return async (root: HTMLElement): Promise<void> => {
    let instance!: MonitorViewInstance;
    await act(async () => {
      instance = timelineMonitorView.mount(
        root,
        fixtureInput({ model, stage, theme, parameters }),
        countingCommands().commands,
      );
    });
    cleanups.push(() => {
      void act(() => instance.unmount());
      root.remove();
    });
  };
}

/** An element's style as sorted `name: value` declarations, custom properties included. */
function styleOf(element: Element): string[] {
  const style = (element as HTMLElement).style;
  const declarations: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    declarations.push(`${name}: ${style.getPropertyValue(name).trim()}`);
  }
  return declarations.sort();
}

/** The DOM under a root as text: tags, attributes (sorted; style as its sorted declarations) and text. */
function serialize(node: Node, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) return node.textContent ? [`${pad}"${node.textContent}"`] : [];
  if (node.nodeType !== 1) return [];
  const element = node as Element;
  const attributes = [...element.attributes]
    .filter((attribute) => attribute.name !== 'style')
    .map((attribute) => `${attribute.name}="${attribute.value}"`)
    .sort();
  const style = styleOf(element);
  if (style.length > 0) attributes.push(`style{${style.join('; ')}}`);
  return [
    `${pad}<${element.tagName.toLowerCase()}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>`,
    ...[...element.childNodes].flatMap((child) => serialize(child, depth + 1)),
  ];
}

const tree = (root: HTMLElement): string[] => [...root.childNodes].flatMap((child) => serialize(child));

/** The legacy's own custom properties under their L18 names (values untouched); the port's two new ones asserted. */
function foldProperties(legacy: HTMLElement, ported: HTMLElement): void {
  const renames: readonly [RegExp, string][] = [
    [/^--vf-monitor-timeline-/, '--mv-timeline-'],
    [/^--pc$/, '--mv-timeline-colour'],
    [/^--h$/, '--mv-timeline-lane-height'],
  ];
  for (const element of legacy.querySelectorAll<HTMLElement>('[style]')) {
    const names = [...Array(element.style.length).keys()].map((index) => element.style.item(index));
    for (const name of names) {
      const rule = renames.find(([from]) => from.test(name));
      if (!rule) continue;
      const value = element.style.getPropertyValue(name);
      element.style.removeProperty(name);
      element.style.setProperty(name.replace(rule[0], rule[1]), value);
    }
  }
  const root = ported.querySelector<HTMLElement>('.vf-monitor-timeline')!;
  expect(root.style.getPropertyValue('--mv-timeline-inset-left')).toBe(`${stage.insets.left}px`);
  expect(root.style.getPropertyValue('--mv-timeline-ground')).toBe(palette.timeline.ground);
  root.style.removeProperty('--mv-timeline-inset-left');
  root.style.removeProperty('--mv-timeline-ground');
  // The mount element wears the root class (L18); the legacy root had none.
  expect(ported.classList.contains('mv-timeline')).toBe(true);
  ported.classList.remove('mv-timeline');
}

/** The head and the offscreen button each lane draws, by index in the placed order (both views place alike). */
const headsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-head')];
const buttonsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-agents li > *')];
const placedIds = (set: { agents: readonly { id: string }[]; terminals: readonly { id: string }[] }): string[] => [
  ...set.agents.map((lane) => lane.id),
  ...set.terminals.map((lane) => lane.id),
];

/** Writes what a head says into the legacy's DOM: the fold after a named difference is asserted. */
function sayInHead(head: HTMLElement, readout: { tone: string; big: string; small: string; owed: boolean }): void {
  head.dataset.tone = readout.tone;
  head.dataset.owed = readout.owed ? 'true' : 'false';
  head.querySelector('b')!.textContent = readout.big;
  head.querySelector('small')!.textContent = readout.small;
}

describe('the timeline’s inks: the swarm’s light math, copied into the view', () => {
  it('resolves every ink as the swarm’s own rule does, in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const tokens = fixtureTheme(scheme).tokens as MonitorPalette;
      const ported = resolveTimelineInks(tokens, undefined);
      const legacy = legacyInks(tokens, undefined);
      for (const key of [
        'dark',
        'ground',
        'ink',
        'muted',
        'faint',
        'border',
        'grid',
        'orange',
        'blue',
        'orangeInk',
        'blueInk',
        'orangeGround',
        'blueGround',
      ] as const) {
        expect([scheme, key, ported[key]]).toEqual([scheme, key, legacy[key]]);
      }
      for (const colour of ['#4c8dff', 'rgb(10, 20, 30)', 'rgba(255, 255, 255, 0.4)', 'transparent']) {
        expect(ported.project(colour)).toEqual(legacy.project(colour));
      }
    }
  });
});

describe('over a fresh daemon: legacy (fed its book) and ported, over one model', () => {
  for (const [host, options] of HOSTS) {
    it(`builds the same lanes under ${host}’s options, but RT5’s and M9’s`, () => {
      const model = parityModel();
      const rows = toMonitorAgents(model, options);
      const legacy = legacyTimelineLanes({ agents: rows, history: freshBook(rows), nowMs: NOW });
      const ported = timelineLanes(model.agents, NOW);
      expect(placedIds(ported)).toEqual(placedIds(legacy));
      const legacyById = new Map([...legacy.agents, ...legacy.terminals].map((lane) => [lane.id, lane]));
      let named = 0;
      for (const lane of [...ported.agents, ...ported.terminals]) {
        const before = legacyById.get(lane.id)!;
        expect(before.spans, lane.id).toHaveLength(1);
        expect(before.endedAtMs).toBeUndefined();
        const span = before.spans[0]!;
        expect([lane.id, lane.kind, lane.bornMs, lane.receded, lane.row.colour, lane.current.status]).toEqual([
          before.id,
          before.kind,
          before.bornMs,
          before.receded,
          before.agent.color,
          span.status,
        ]);
        if (undated(before.agent)) {
          // RT5: the window's first sight (now) where the row now says when its state began.
          named += 1;
          expect([lane.id, before.recordedFromMs, span.fromMs]).toEqual([lane.id, NOW, NOW]);
          expect(lane.sinceMs).toBe(Math.min(NOW, Math.max(lane.row.createdAt, lane.row.statusSince)));
          expect(lane.sinceMs).toBeLessThan(NOW);
        } else {
          expect([lane.id, lane.sinceMs, lane.current.fromMs]).toEqual([lane.id, before.recordedFromMs, span.fromMs]);
        }
        const wordsBefore = span.blocker
          ? { kind: span.blocker.kind, ...(span.blocker.detail ? { detail: span.blocker.detail } : {}) }
          : undefined;
        if (options.peerMonitor === 'omit' && !lane.row.device.self && lane.current.status === 'blocked') {
          // M9: VibeField's peer carried no blocker; the model's peer says its wait.
          expect(wordsBefore).toBeUndefined();
          expect(lane.current.wait?.kind).toBe(lane.row.wait?.kind);
        } else {
          expect([lane.id, lane.current.wait]).toEqual([lane.id, wordsBefore]);
        }
      }
      // Every bare terminal, the starting run and the pending ones; under VibeField's options its peers too.
      expect(named).toBeGreaterThanOrEqual(5);
    });

    it(`draws the same DOM under ${host}’s options, but L18’s names and the named lanes’ readouts and words`, async () => {
      const model = parityModel();
      const rows = toMonitorAgents(model, options);
      const book = freshBook(rows);
      const legacy = await drawn(mountLegacy(rows, book));
      const ported = await drawn(mountPorted(model));
      foldProperties(legacy.root, ported.root);
      const legacyLanes = legacyTimelineLanes({ agents: rows, history: book, nowMs: NOW });
      const portedLanes = timelineLanes(model.agents, NOW);
      const order = placedIds(portedLanes);
      const portedById = new Map([...portedLanes.agents, ...portedLanes.terminals].map((lane) => [lane.id, lane]));
      const legacyById = new Map([...legacyLanes.agents, ...legacyLanes.terminals].map((lane) => [lane.id, lane]));
      const heads = headsOf(legacy.root);
      const buttons = buttonsOf(legacy.root);
      expect(heads).toHaveLength(order.length);
      let folded = 0;
      order.forEach((id, index) => {
        const before: LegacyLane = legacyById.get(id)!;
        const after: TimelineLane = portedById.get(id)!;
        const said = legacyReadoutAt(before, legacyStateAt(before, NOW), NOW, true, NOW);
        const says = readoutAt(after, stateAt(after, NOW), NOW, true, NOW);
        const heard = legacyLaneLabel(before, NOW);
        const hears = laneLabel(after, NOW);
        if (JSON.stringify(said) === JSON.stringify(says) && heard === hears) return;
        // A difference only where it is named: RT5 (a row the legacy dated by first sight) or M9 (a peer's wait).
        const peerWait = options.peerMonitor === 'omit' && !after.row.device.self && after.current.status === 'blocked';
        expect([id, undated(before.agent) || peerWait]).toEqual([id, true]);
        expect(heads[index]!.querySelector('b')?.textContent).toBe(said.big);
        expect(buttons[index]!.textContent).toBe(heard);
        sayInHead(heads[index]!, says);
        buttons[index]!.textContent = hears;
        folded += 1;
      });
      expect(folded).toBeGreaterThan(0);
      expect(tree(ported.root)).toEqual(tree(legacy.root));
    });

    it(`paints every frame alike, call for call, over the rows that carry their own time (${host})`, async () => {
      const full = parityModel();
      const dated = new Set(
        toMonitorAgents(full, options)
          .filter((row) => !undated(row))
          .map((row) => row.id),
      );
      const model = fixtureModel(
        full.agents.filter(
          (row) =>
            dated.has(row.id) && !(options.peerMonitor === 'omit' && !row.device.self && row.status === 'blocked'),
        ),
      );
      const rows = toMonitorAgents(model, options);
      const legacy = await drawn(mountLegacy(rows, freshBook(rows)));
      const ported = await drawn(mountPorted(model));
      const wakes = (recorded: Call[]) => recorded.filter((call) => call.canvas === 'vf-monitor-timeline-wakes');
      const maps = (recorded: Call[]) => recorded.filter((call) => call.canvas === 'vf-monitor-timeline-map-canvas');
      expect(wakes(legacy.calls).filter((call) => call.entry.startsWith('fill(')).length).toBeGreaterThan(10);
      expect(maps(legacy.calls).filter((call) => call.entry.startsWith('fill(')).length).toBeGreaterThan(2);
      expect(wakes(ported.calls).map((call) => call.entry)).toEqual(wakes(legacy.calls).map((call) => call.entry));
      expect(maps(ported.calls).map((call) => call.entry)).toEqual(maps(legacy.calls).map((call) => call.entry));
    });
  }
});

describe('over a model with history: exactly runtime only’s differences', () => {
  /**
   * What a watching window's ledger kept: four models folded at T−30, T−20, T−10 and now, rows changing state
   * between them (a reply arriving and being opened, a permission asked, work resumed), and one run that ended.
   */
  function watched(options: LegacyShimOptions) {
    const at = (minutes: number): number => NOW - minutes * MIN;
    const project = (name: string, seq: number) => ({ name, seq, branch: 'main' });
    const base = { device: LAB_DEVICE, provider: { id: 'claude', label: 'Claude' }, model: 'Opus 5.5' };
    /** Born `born` minutes ago, each a different birth so the lanes keep one order. */
    const births: Readonly<Record<string, number>> = { steady: 55, mover: 50, asker: 44, reader: 38, leaver: 34 };
    const row = (id: string, seq: number, overrides: Partial<AgentView>): AgentView =>
      agentViewFixture({ id, ...base, project: project(id, seq), createdAt: at(births[id]!), ...overrides });
    const steps: [number, AgentView[]][] = [
      [
        30,
        [
          row('mover', 0, { status: 'working', statusSince: at(45) }),
          row('asker', 1, { status: 'working', statusSince: at(40) }),
          row('reader', 2, { status: 'working', statusSince: at(35) }),
          row('leaver', 3, { status: 'working', statusSince: at(32) }),
          row('steady', 4, { status: 'working', statusSince: at(48) }),
        ],
      ],
      [
        20,
        [
          row('mover', 0, { status: 'idle', statusSince: at(25) }),
          row('asker', 1, { status: 'working', statusSince: at(40) }),
          row('reader', 2, { status: 'idle', unread: true, statusSince: at(22) }),
          row('leaver', 3, { status: 'idle', statusSince: at(21) }),
          row('steady', 4, { status: 'working', statusSince: at(48) }),
        ],
      ],
      [
        10,
        [
          row('mover', 0, { status: 'working', statusSince: at(15) }),
          row('asker', 1, {
            status: 'blocked',
            statusSince: at(12),
            wait: { kind: 'permission', since: at(12), tool: 'Bash', detail: 'Bash · pnpm verify' },
          }),
          row('reader', 2, { status: 'idle', statusSince: at(22) }),
          row('steady', 4, { status: 'working', statusSince: at(48) }),
        ],
      ],
    ];
    const final: AgentView[] = [
      row('mover', 0, { status: 'working', statusSince: at(15) }),
      row('asker', 1, {
        status: 'blocked',
        statusSince: at(12),
        wait: { kind: 'permission', since: at(12), tool: 'Bash', detail: 'Bash · pnpm verify' },
      }),
      row('reader', 2, { status: 'idle', statusSince: at(22) }),
      row('steady', 4, { status: 'working', statusSince: at(48) }),
    ];
    let ledger: StatusLedger = EMPTY_STATUS_LEDGER;
    for (const [minutes, views] of steps)
      ledger = observeStatuses(ledger, toMonitorAgents(fixtureModel(views), options), at(minutes));
    const model = fixtureModel(final);
    const rows = toMonitorAgents(model, options);
    ledger = observeStatuses(ledger, rows, NOW);
    return { model, rows, book: statusHistoryBook(ledger) };
  }

  for (const [host, options] of HOSTS) {
    it(`draws each live lane as its legacy’s last span and nothing before it; the ended lane is gone (${host})`, () => {
      const { model, rows, book } = watched(options);
      const legacy = legacyTimelineLanes({ agents: rows, history: book, nowMs: NOW });
      const ported = timelineLanes(model.agents, NOW);
      // RT2: the run that ended keeps a lane in the legacy, and none in the port.
      expect(legacy.agents.map((lane) => lane.id)).toEqual(['steady', 'mover', 'asker', 'reader', 'leaver']);
      expect(legacy.agents.find((lane) => lane.id === 'leaver')?.endedAtMs).toBe(NOW - 10 * MIN);
      expect(ported.agents.map((lane) => lane.id)).toEqual(['steady', 'mover', 'asker', 'reader']);
      for (const lane of ported.agents) {
        // reader is RT4's, asserted below.
        if (lane.id === 'reader') continue;
        const before = legacy.agents.find((each) => each.id === lane.id)!;
        const last = before.spans[before.spans.length - 1]!;
        // RT1: the current state is the legacy's open span, exactly.
        expect([lane.id, lane.current.status, lane.current.fromMs, lane.current.wait]).toEqual([
          lane.id,
          last.status,
          last.fromMs,
          last.blocker
            ? { kind: last.blocker.kind, ...(last.blocker.detail ? { detail: last.blocker.detail } : {}) }
            : undefined,
        ]);
        expect(lane.sinceMs).toBe(last.fromMs);
        expect(before.recordedFromMs).toBeLessThanOrEqual(lane.sinceMs);
        // Following now, the body and its words say the same.
        expect(readoutAt(lane, stateAt(lane, NOW), NOW, true, NOW)).toEqual(
          legacyReadoutAt(before, legacyStateAt(before, NOW), NOW, true, NOW),
        );
        expect(laneLabel(lane, NOW)).toBe(legacyLaneLabel(before, NOW));
      }
      // RT1: where the legacy remembered a past, the port claims nothing. mover worked, rested, worked again.
      const mover = { legacy: legacy.agents[1]!, ported: ported.agents[1]! };
      expect(mover.legacy.spans.map((span) => span.status)).toEqual(['working', 'idle', 'working']);
      const back = NOW - 22 * MIN;
      expect(legacyReadoutAt(mover.legacy, legacyStateAt(mover.legacy, back), back, false, NOW)).toMatchObject({
        tone: 'idle',
        small: 'idle · of 10m',
      });
      expect(readoutAt(mover.ported, stateAt(mover.ported, back), back, false, NOW)).toEqual({
        tone: 'unrecorded',
        big: '–',
        small: 'not recorded',
        owed: false,
      });
      // RT4: the reply that arrived at T−22 and was opened at T−10 left a blue stretch in the legacy, its idle
      // dated by the opening (the person's moment, which only a watching window knew); the port reads the lane idle
      // from statusSince, the turn's end, and keeps no blue.
      const reader = { legacy: legacy.agents[3]!, ported: ported.agents[3]! };
      expect(reader.legacy.spans.map((span) => [span.status, span.fromMs])).toEqual([
        ['working', NOW - 35 * MIN],
        ['unseen', NOW - 22 * MIN],
        ['idle', NOW - 10 * MIN],
      ]);
      expect([reader.ported.current.status, reader.ported.sinceMs]).toEqual(['idle', NOW - 22 * MIN]);
      expect(legacyReadoutAt(reader.legacy, legacyStateAt(reader.legacy, NOW), NOW, true, NOW).big).toBe('10:00');
      expect(readoutAt(reader.ported, stateAt(reader.ported, NOW), NOW, true, NOW).big).toBe('22:00');
      // RT3: the map counts each agent's current stretch only; the legacy's rows carried every recorded span, and the
      // ended run's too.
      const portedRows = pulseRowsFor(ported.agents, NOW);
      const legacyRows = legacyPulseRows(legacy.agents, NOW);
      expect(legacyRows).toHaveLength(5);
      expect(portedRows).toHaveLength(4);
      for (const pulse of portedRows) {
        const before = legacyRows.find((each) => each.color === pulse.color)!;
        expect([pulse.status, pulse.endMs]).toEqual([before.spans[before.spans.length - 1]!.status, before.endMs]);
      }
      expect(legacyRows.reduce((count, pulse) => count + pulse.spans.length, 0)).toBe(1 + 3 + 2 + 3 + 2);
    });
  }
});
