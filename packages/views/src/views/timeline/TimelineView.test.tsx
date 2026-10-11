// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  EndedLaneView,
  MonitorHistory,
  MonitorViewInput,
  MonitorViewInstance,
} from '@vibecook/puppeteer-view-sdk';
import {
  agentViewFixture,
  agentViewsFixture,
  countingCommands,
  createFixtureClock,
  createFrameDriver,
  fixtureHistory,
  fixtureInput,
  fixtureStage,
  fixtureTheme,
  parameterDefaults,
  runConformance,
  type FixtureClock,
  type FrameDriver,
} from '@vibecook/puppeteer-view-sdk/testing';
import { TIMELINE_MANIFEST, TIMELINE_ROOT_CLASS, timelineMonitorView } from './index.js';
import { timelineWorld } from './lab/timeline-fixtures.js';
import { laneLabel, laneSubLine, OPENS_IN_HISTORY } from './timeline-words.js';

// Two of the view's words, spied on and called through: what a publish rebuilds shows in who they are asked about.
vi.mock('./timeline-words.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./timeline-words.js')>();
  return { ...actual, laneLabel: vi.fn(actual.laneLabel), laneSubLine: vi.fn(actual.laneSubLine) };
});

// The timeline on the SDK (MV-6), mounted as a host mounts it. happy-dom lays
// nothing out and has no 2D context or Path2D, so the tests that draw give the
// view a size and a recording context: with them its draw really runs, and the
// conformance suite sees its loop ask for frames, stop when motion is off, and
// let go at unmount (MV-W4).

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

const calls: Call[] = [];
function recordingContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
      if (key === 'measureText') return (text: string) => ({ width: text.length * 5 });
      if (typeof key === 'string' && !(key in target) && /^[a-z]/.test(key) && key !== 'then') {
        return (...args: unknown[]) => calls.push({ op: key, args });
      }
      return target[key as string];
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class RecordingPath {
  readonly ops: string[] = [];
  moveTo(): void {
    this.ops.push('M');
  }
  lineTo(): void {
    this.ops.push('L');
  }
  bezierCurveTo(): void {
    this.ops.push('C');
  }
  arc(): void {
    this.ops.push('A');
  }
  closePath(): void {
    this.ops.push('Z');
  }
}

const realGetContext = HTMLCanvasElement.prototype.getContext;
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
const sizes = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
/** The view's root as Godview's default stage lays it out, past the usage column. */
let size = { width: 0, height: 0 };
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    let context = contexts.get(this);
    if (!context) {
      context = recordingContext();
      contexts.set(this, context);
    }
    return context;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  (globalThis as { Path2D?: unknown }).Path2D = RecordingPath;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => size.width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => size.height });
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  delete (globalThis as { Path2D?: unknown }).Path2D;
  for (const key of ['clientWidth', 'clientHeight'] as const) {
    if (sizes[key]) Object.defineProperty(HTMLElement.prototype, key, sizes[key]);
  }
});

const PARAMETERS = parameterDefaults(TIMELINE_MANIFEST);
/** The afternoon's clock: 15:00:00 on the day the fixtures count from, local time. */
const NOW = new Date(2026, 0, 1, 15, 0, 0).getTime();

interface Mounted {
  readonly root: HTMLElement;
  readonly view: HTMLElement;
  readonly instance: MonitorViewInstance;
  readonly commands: ReturnType<typeof countingCommands>;
  update(input: MonitorViewInput): Promise<void>;
}

let clock: FixtureClock;
let frames: FrameDriver;
let restore: () => void = () => undefined;
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) {
    await act(async () => each.instance.unmount());
    each.root.remove();
  }
  restore();
  restore = () => undefined;
  vi.useRealTimers();
  calls.length = 0;
  size = { width: 0, height: 0 };
});

interface MountOptions {
  width?: number;
  height?: number;
  /** The host lends TV-8's `openEnded` (default: it does not, as puppeteer's own Godview). */
  openEnded?: boolean;
}

/** A stage to mount on: the root's size, the afternoon's clock and frames by hand, and a root in the document. */
function arrange(options: MountOptions = {}): HTMLElement {
  size = { width: options.width ?? 1064, height: options.height ?? 320 };
  clock = createFixtureClock(NOW);
  const restoreClock = clock.install();
  frames = createFrameDriver({ clock });
  const restoreDriver = frames.install();
  restore = () => {
    restoreDriver();
    restoreClock();
  };
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

async function mount(
  input: Partial<Parameters<typeof fixtureInput>[0]> = {},
  options: MountOptions = {},
): Promise<Mounted> {
  const root = arrange(options);
  const commands = countingCommands({ openEnded: options.openEnded });
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = timelineMonitorView.mount(root, fixtureInput({ parameters: PARAMETERS, ...input }), commands.commands);
  });
  const view = root.querySelector<HTMLElement>('.vf-monitor-timeline')!;
  const result: Mounted = {
    root,
    view,
    instance,
    commands,
    update: (next) => act(async () => instance.update(next)),
  };
  mounted.push(result);
  return result;
}

const afternoon = (): AgentView[] => timelineWorld(NOW);
const names = (root: Element): string[] =>
  [...root.querySelectorAll('.vf-monitor-timeline-who b')].map((name) => name.textContent ?? '');
const buttons = (root: Element): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>('.vf-monitor-timeline-agents button'),
];
/** The pointer comes to rest over a lane, no button down. */
const over = (body: HTMLElement, lane: HTMLElement) =>
  act(async () => {
    body.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 40, clientY: parseFloat(lane.style.top) + 4, bubbles: true }),
    );
  });

describe('the timeline’s lanes', () => {
  it('draws the example afternoon: agents in birth order, terminals below, and no lane for a run the model lacks', async () => {
    const view = await mount({ agents: afternoon() });
    expect(names(view.root)).toEqual([
      'dotfiles',
      'vibe-field',
      'rosetta',
      'rosetta',
      'rosetta',
      'notes',
      'refactor-auth',
      'billing-api',
      'swarm-lab',
      'vibe-field',
      '~',
    ]);
    expect(view.root.textContent).toContain('TERMINALS');
    expect(view.root.querySelector('.is-ended')).toBeNull();
  });

  it('offers the map as a slider and every lane as a button, worded for a screen reader; a press selects it', async () => {
    const view = await mount({ agents: afternoon() });
    const slider = view.root.querySelector('[role="slider"]')!;
    expect(slider.getAttribute('aria-label')).toBe('The head’s moment in the day');
    expect(slider.getAttribute('aria-valuetext')).toBe('Now, 15:00');
    expect(Number(slider.getAttribute('aria-valuemin'))).toBeLessThan(Number(slider.getAttribute('aria-valuemax')));
    const labels = buttons(view.root).map((button) => button.textContent);
    expect(labels).toHaveLength(11);
    expect(labels).toContain(
      'billing-api, gpt-5, blocked on a permission for 4 minutes: Bash · git push origin billing/ledger-reader',
    );
    expect(labels).toContain(
      'on studio, rosetta, gpt-5, blocked on a question for 12 minutes: Should the grant expire with the session, or after an hour?',
    );
    expect(labels).toContain('swarm-lab, fast-4, reply unseen for 38 minutes');
    expect(labels).toContain('~, terminal, quiet');
    await act(async () =>
      buttons(view.root)
        .find((button) => button.textContent?.startsWith('billing-api'))!
        .click(),
    );
    expect(view.commands.selects).toEqual(['billing-api']);
  });

  it('draws a receded row quiet in its slot, still a button to open', async () => {
    const agents = afternoon().map((row) => (row.id === 'notes' ? { ...row, receded: true } : row));
    const view = await mount({ agents });
    expect(names(view.root)[5]).toBe('notes');
    expect(view.root.querySelectorAll('.vf-monitor-timeline-name.is-receded')).toHaveLength(1);
    expect(view.root.querySelectorAll('.vf-monitor-timeline-head.is-receded')).toHaveLength(1);
    expect(buttons(view.root).map((button) => button.textContent)).toContain(
      'on tower, notes, haiku, idle for 47 minutes',
    );
  });

  it('says so when there is nothing to draw, in its own words and its own class', async () => {
    const view = await mount();
    expect(view.root.querySelector('.vf-monitor-timeline-empty')?.textContent).toBe(
      'NO ACTIVE AGENTS' + 'Launch an agent from a terminal pane.',
    );
    expect(view.root.querySelector('.vf-monitor-empty')).toBeNull();
  });
});

describe('the timeline’s draw', () => {
  it('lights each body with its current state, following now: lengths and words', async () => {
    const view = await mount({ agents: afternoon() });
    await act(async () => frames.step(2));
    const heads = [...view.root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-head')];
    const said = heads.map((head) => [
      head.dataset.tone,
      head.querySelector('b')?.textContent,
      head.querySelector('small')?.textContent,
    ]);
    expect(said[7]).toEqual(['blocked', '4:12', 'blocked · permission']);
    expect(said[8]).toEqual(['unseen', '38:02', 'reply unseen']);
    expect(said[0]).toEqual(['idle', '1h 02m', 'idle']);
    expect(said[9]).toEqual(['working', '3:02', 'running']);
    // A wait you owe rings; nothing else does.
    expect(heads.filter((head) => head.dataset.owed === 'true')).toHaveLength(3);
    // The wakes and the map were painted: a dotted unrecorded thread from each birth, a wake for each current state.
    expect(calls.filter((call) => call.op === 'setLineDash').length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.op === 'fill').length).toBeGreaterThan(0);
    expect(view.root.querySelector('.vf-monitor-timeline-chip')?.textContent).toBe('15:00:00');
  });

  it('runs a frame loop while motion is on', async () => {
    await mount({ agents: afternoon() });
    expect(frames.pending).toBeGreaterThan(0);
    await act(async () => frames.step(3));
    expect(frames.pending).toBeGreaterThan(0);
  });

  it('still (animations off, or motion reduced) it asks for no frame loop, and keeps the time once a second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const theme = fixtureTheme('dark', { animations: false });
    const view = await mount({ agents: afternoon(), theme });
    await act(async () => frames.step(3));
    expect(frames.pending).toBe(0);
    const chip = view.root.querySelector('.vf-monitor-timeline-chip')!;
    expect(chip.textContent).toBe('15:00:00');
    expect(view.view.dataset.motion).toBe('off');
    for (const second of ['15:00:01', '15:00:02']) {
      clock.advance(1000);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(chip.textContent).toBe(second);
      expect(frames.pending).toBe(0);
    }
    // Reduced motion stills it too; motion back on starts the loop, and the timer stops.
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: afternoon(), theme: fixtureTheme('dark') }));
    expect(frames.pending).toBeGreaterThan(0);
    expect(view.view.dataset.motion).toBe('on');
    await view.update(
      fixtureInput({
        parameters: PARAMETERS,
        agents: afternoon(),
        theme: fixtureTheme('dark', { reducedMotion: true }),
      }),
    );
    await act(async () => frames.step(3));
    expect(frames.pending).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('draws once when what it shows changes while still', async () => {
    const theme = fixtureTheme('dark', { animations: false });
    const agents = afternoon();
    const view = await mount({ agents, theme });
    await act(async () => frames.step(3));
    const before = calls.length;
    const moved = agents.map((row) => (row.id === 'vibe-field' ? { ...row, status: 'blocked' as const } : row));
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: moved, theme }));
    expect(frames.pending).toBe(1);
    await act(async () => frames.step(1));
    expect(frames.pending).toBe(0);
    expect(calls.length).toBeGreaterThan(before);
    const head = view.root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-head')[1]!;
    expect(head.dataset.tone).toBe('blocked');
  });
});

describe('the timeline’s keys and pointer', () => {
  it('lights lanes with ↑ ↓ (stepping over a receded one) and opens the lit one with Enter, on its own body', async () => {
    const agents = afternoon().map((row) => (row.id === 'vibe-field' ? { ...row, receded: true } : row));
    const view = await mount({ agents });
    const body = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-body')!;
    const key = (name: string) =>
      act(async () => {
        body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
      });
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    // dotfiles, then past the receded vibe-field to rosetta-grants, the next lane by birth.
    expect(view.commands.selects).toEqual(['rosetta-grants']);
  });

  it('prints End on the now button, the one control a declared key does the work of (M177 ruling 4)', async () => {
    const view = await mount({ agents: afternoon() });
    const now = view.root.querySelector<HTMLButtonElement>('.vf-monitor-timeline-tool.is-now')!;
    const legend = now.querySelector('.vf-monitor-timeline-key')!;
    expect(legend.textContent).toBe('↘');
    expect(legend.getAttribute('aria-hidden')).toBe('true');
    // Under the mark, from the manifest's own key.
    expect(legend.previousElementSibling?.classList.contains('vf-monitor-timeline-now-mark')).toBe(true);
    expect(TIMELINE_MANIFEST.keys?.find((key) => key.label === 'now (the map)')?.key).toBe('End');
    // Every other key does work no button does (lighting, opening the lit lane, panning, zooming by steps, the start
    // of the day), so no other control prints one.
    expect(view.root.querySelectorAll('.vf-monitor-timeline-key')).toHaveLength(1);
  });

  it('goes home on End in the map, as the now button does on a press', async () => {
    const view = await mount({ agents: afternoon() });
    const map = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-map-box')!;
    const now = view.root.querySelector<HTMLButtonElement>('.vf-monitor-timeline-tool.is-now')!;
    const press = (name: string) =>
      act(async () => {
        map.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
        frames.step(2);
      });
    expect(now.getAttribute('aria-pressed')).toBe('true');
    await press('ArrowLeft');
    expect(now.getAttribute('aria-pressed')).toBe('false');
    await press('End');
    expect(now.getAttribute('aria-pressed')).toBe('true');
    await press('ArrowLeft');
    expect(now.getAttribute('aria-pressed')).toBe('false');
    await act(async () => {
      now.click();
      frames.step(2);
    });
    expect(now.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the view on its root', () => {
  it('scopes its stylesheet under its root class, and sets its own properties from its input (L18)', async () => {
    const stage = fixtureStage('default');
    const view = await mount({ agents: afternoon(), stage });
    expect(view.root.classList.contains(TIMELINE_ROOT_CLASS)).toBe(true);
    const style = view.view.style;
    expect(style.getPropertyValue('--mv-timeline-inset-left')).toBe(`${stage.insets.left}px`);
    expect(style.getPropertyValue('--mv-timeline-inset-top')).toBe('0px');
    expect(style.getPropertyValue('--mv-timeline-ground')).toBe(fixtureTheme('dark').tokens.timeline.ground);
    expect(style.getPropertyValue('--mv-timeline-x1')).toBe('894px');
    expect(style.getPropertyValue('--mv-timeline-orange')).toMatch(/^rgba\(/);
    expect(view.view.dataset.ground).toBe('dark');
    const name = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-name')!;
    expect(name.style.getPropertyValue('--mv-timeline-colour')).toBe(afternoon()[7]!.colour);
  });

  it('starts below the stage’s top inset, where a host keeps chrome over the stage (M58)', async () => {
    // VibeField's claims strip sits over the stage's top, and its stage says so as `insets.top`; the timeline's box
    // starts below it, so its lanes are sized to what is left. Puppeteer's Godview passes 0.
    const compact = fixtureStage('compact');
    const view = await mount({ agents: afternoon(), stage: { ...compact, insets: { ...compact.insets, top: 40 } } });
    expect(view.view.style.getPropertyValue('--mv-timeline-inset-top')).toBe('40px');
  });

  it('declares what it is to the bar and the audit: its mark, its keys, a clock at rest', () => {
    expect(TIMELINE_MANIFEST).toMatchObject({ id: 'timeline', label: 'TIMELINE', motion: { loops: true } });
    // Three spans and the now line: the filled outlines of the 1.6 strokes the bar drew (MV-D6, ruled fill at MV-8).
    expect(TIMELINE_MANIFEST.mark).toEqual({
      viewBox: '0 0 24 24',
      paths: [
        'M4.5 8.3L12.5 8.3A0.8 0.8 0 0 0 12.5 6.7L4.5 6.7A0.8 0.8 0 0 0 4.5 8.3Z' +
          'M8 12.8L16.5 12.8A0.8 0.8 0 0 0 16.5 11.2L8 11.2A0.8 0.8 0 0 0 8 12.8Z' +
          'M4.5 17.3L9.5 17.3A0.8 0.8 0 0 0 9.5 15.7L4.5 15.7A0.8 0.8 0 0 0 4.5 17.3Z',
        'M18.7 4.5L18.7 19.5A0.8 0.8 0 0 0 20.3 19.5L20.3 4.5A0.8 0.8 0 0 0 18.7 4.5Z',
      ],
    });
    expect(TIMELINE_MANIFEST.keys?.map((key) => key.key)).toEqual([
      'ArrowUp',
      'ArrowDown',
      'Enter',
      'ArrowLeft',
      'ArrowRight',
      '-',
      '=',
      'Home',
      'End',
    ]);
  });
});

describe('a lane is its row alone (runtime only)', () => {
  it('draws a row’s birth and its current state, and nothing it did before', async () => {
    const born = NOW - 60 * 60_000;
    const row = agentViewFixture({ id: 'a', createdAt: born, status: 'working', statusSince: NOW - 10 * 60_000 });
    const view = await mount({ agents: [row] });
    await act(async () => frames.step(2));
    const head = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-head')!;
    expect([head.dataset.tone, head.querySelector('b')?.textContent]).toEqual(['working', '10:00']);
    // One dotted thread (birth → the current state) and one wake (the current state → now), nothing between.
    expect(calls.filter((call) => call.op === 'setLineDash')).toHaveLength(1);
  });
});

// At a size, so the suite's every mount really draws (its wakes, its map, its readouts), and the still cases prove the
// draw itself asks for no next frame.
describe('at a size to draw at', () => {
  beforeAll(() => {
    size = { width: 1064, height: 320 };
  });
  afterAll(() => {
    size = { width: 0, height: 0 };
  });
  runConformance(timelineMonitorView);
});

// The record's past, as a host lends it (`history`): built by hand, so each case says what it holds.
const MIN = 60_000;

function endedRun(
  id: string,
  startedAgo: number,
  endedAgo: number,
  overrides: Partial<EndedLaneView> = {},
): EndedLaneView {
  return {
    id: `past:claude:${id}`,
    provider: { id: 'claude', label: 'Claude Code' },
    project: { name: 'notes', seq: 1 },
    device: { id: 'here', name: 'here', self: true },
    startedAt: NOW - startedAgo * MIN,
    endedAt: NOW - endedAgo * MIN,
    spans: [{ kind: 'worked', from: NOW - startedAgo * MIN, to: NOW - endedAgo * MIN }],
    colour: 'oklch(0.7 0.1 200)',
    receded: false,
    ...overrides,
  };
}

function pastHistory(partial: Partial<MonitorHistory> = {}): MonitorHistory {
  return {
    sinceMs: NOW - 24 * 60 * MIN,
    untilMs: NOW,
    readAt: NOW,
    fidelity: 'turns',
    state: 'complete',
    live: [],
    ended: [],
    ...partial,
  };
}

describe("with the record's past (history)", () => {
  /** Born 50 minutes ago; worked, then quiet up to its current state, working these ten minutes. */
  const row = agentViewFixture({
    id: 'a',
    createdAt: NOW - 50 * MIN,
    status: 'working',
    statusSince: NOW - 10 * MIN,
    project: { name: 'billing', seq: 0 },
  });
  const lent = pastHistory({
    live: [
      {
        id: 'a',
        seamAt: NOW - 10 * MIN,
        spans: [
          { kind: 'worked', from: NOW - 50 * MIN, to: NOW - 30 * MIN },
          { kind: 'quiet', from: NOW - 30 * MIN, to: NOW - 10 * MIN },
        ],
      },
    ],
    ended: [
      endedRun('y', 55, 25),
      endedRun('x', 40, 20, { title: 'Split the invoice writer' }),
      // Ended two hours ago: scrolled out of the hour in view (TL-D6).
      endedRun('gone', 5 * 60, 2 * 60),
    ],
  });
  const heads = (root: Element) =>
    [...root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-head')].map((head) => [
      head.dataset.tone,
      head.querySelector('b')?.textContent,
      head.querySelector('small')?.textContent,
    ]);

  it('draws the runs that ended faint in their birth slots, until they scroll out', async () => {
    const view = await mount({ agents: [row], capabilities: { history: lent } });
    await act(async () => frames.step(2));
    expect(names(view.root)).toEqual(['Claude Code · notes', 'billing', 'Split the invoice writer']);
    expect(view.root.querySelectorAll('.vf-monitor-timeline-name.is-ended')).toHaveLength(2);
    // Following now, an ended run says its last activity (the record holds no exit); the row says its state.
    expect(heads(view.root)).toEqual([
      ['ended', '', 'last active 25m ago'],
      ['working', '10:00', 'working'],
      ['ended', '', 'last active 20m ago'],
    ]);
    // Words from the record may take a second line rather than be cut; a current state keeps its one line.
    const recorded = [...view.root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-head')].map(
      (head) => head.dataset.recorded,
    );
    expect(recorded).toEqual(['true', undefined, 'true']);
  });

  it('reads the past as the record says it, looking back', async () => {
    const view = await mount({ agents: [row], capabilities: { history: lent } });
    const map = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-map-box')!;
    await act(async () => {
      map.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
      frames.step(2);
    });
    // Thirty minutes back: the row was quiet; both ended runs were working, 25 and 10 minutes into stretches of 30 and 20.
    expect(heads(view.root)).toEqual([
      ['working', '25:00', 'working · of 30m'],
      ['idle', '', 'quiet'],
      ['working', '10:00', 'working · of 20m'],
    ]);
  });

  it('with no openEnded lent, lights an ended run but never opens it: no key, press or button sends its past: id', async () => {
    const view = await mount({ agents: [row], capabilities: { history: lent } });
    expect(view.commands.commands.openEnded).toBeUndefined();
    await act(async () => frames.step(2));
    const body = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-body')!;
    const key = (name: string) =>
      act(async () => {
        body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
      });
    await key('ArrowDown');
    await key('Enter');
    expect(view.commands.selects).toEqual([]);
    await key('ArrowDown');
    await key('Enter');
    expect(view.commands.selects).toEqual(['a']);
    // A press on the ended run's lane selects nothing; one on the row's selects it.
    const lanes = [...view.root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-name')];
    const press = (lane: HTMLElement) =>
      act(async () => {
        const at = { clientX: 40, clientY: parseFloat(lane.style.top) + 4, button: 0, bubbles: true };
        body.dispatchEvent(new PointerEvent('pointerdown', at));
        body.dispatchEvent(new PointerEvent('pointerup', at));
      });
    await press(lanes[0]!);
    expect(view.commands.selects).toEqual(['a']);
    await press(lanes[1]!);
    expect(view.commands.selects).toEqual(['a', 'a']);
    // A screen reader reads an ended run but finds nothing to press.
    expect(buttons(view.root)).toHaveLength(1);
    const read = [...view.root.querySelectorAll('.vf-monitor-timeline-agents li > span')].map(
      (item) => item.textContent,
    );
    expect(read).toEqual([
      'notes, Claude Code, ended, last active 25 minutes ago',
      'Split the invoice writer, notes, Claude Code, ended, last active 20 minutes ago',
    ]);
    // Nothing but the two selects was ever called, and no cursor says an ended lane is a control.
    expect(view.commands.calls - view.commands.reports.length).toBe(2);
    await over(body, lanes[0]!);
    expect(view.view.hasAttribute('data-opens')).toBe(false);
  });

  it('where the host lends openEnded (TV-8), a press on an ended lane asks the host to open it, once, and selects nothing', async () => {
    const view = await mount({ agents: [row], capabilities: { history: lent } }, { openEnded: true });
    await act(async () => frames.step(2));
    const body = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-body')!;
    const lanes = [...view.root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-name')];
    const y = (lane: HTMLElement): number => parseFloat(lane.style.top) + 4;
    const pointer = (type: string, clientX: number, lane: HTMLElement, buttons = 0) =>
      body.dispatchEvent(new PointerEvent(type, { clientX, clientY: y(lane), button: 0, buttons, bubbles: true }));
    await act(async () => {
      pointer('pointerdown', 40, lanes[0]!, 1);
      pointer('pointerup', 40, lanes[0]!);
    });
    expect(view.commands.opens).toEqual(['past:claude:y']);
    expect(view.commands.selects).toEqual([]);
    // The row's lane still selects, and opens nothing.
    await act(async () => {
      pointer('pointerdown', 40, lanes[1]!, 1);
      pointer('pointerup', 40, lanes[1]!);
    });
    expect([view.commands.selects, view.commands.opens]).toEqual([['a'], ['past:claude:y']]);
    // A drag along an ended lane moves through time and opens nothing; nor does a scrub on the map.
    const chip = view.root.querySelector('.vf-monitor-timeline-chip')!;
    await act(async () => {
      pointer('pointerdown', 400, lanes[2]!, 1);
      pointer('pointermove', 460, lanes[2]!, 1);
      pointer('pointermove', 520, lanes[2]!, 1);
      pointer('pointerup', 520, lanes[2]!);
      frames.step(2);
    });
    expect(view.view.dataset.detached).toBe('true');
    expect(chip.textContent).not.toBe('15:00:00');
    const map = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-map-box')!;
    await act(async () => {
      map.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, clientY: 20, button: 0, bubbles: true }));
      map.dispatchEvent(new PointerEvent('pointermove', { clientX: 340, clientY: 20, buttons: 1, bubbles: true }));
      map.dispatchEvent(new PointerEvent('pointerup', { clientX: 340, clientY: 20, button: 0, bubbles: true }));
    });
    expect([view.commands.selects, view.commands.opens]).toEqual([['a'], ['past:claude:y']]);
  });

  it('where the host lends openEnded, Enter on a lit ended lane opens it: the key a row already has, and no new one', async () => {
    const view = await mount({ agents: [row], capabilities: { history: lent } }, { openEnded: true });
    await act(async () => frames.step(2));
    const body = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-body')!;
    const key = (name: string) =>
      act(async () => {
        body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
      });
    await key('ArrowDown');
    await key('Enter');
    expect([view.commands.selects, view.commands.opens]).toEqual([[], ['past:claude:y']]);
    await key('ArrowDown');
    await key('Enter');
    expect([view.commands.selects, view.commands.opens]).toEqual([['a'], ['past:claude:y']]);
    // No other key reaches the host, and the manifest declares the keys it always did.
    for (const name of [' ', 'o', 'h', 'ArrowRight', '=']) await key(name);
    expect(view.commands.opens).toEqual(['past:claude:y']);
    expect(TIMELINE_MANIFEST.keys).toHaveLength(9);
  });

  it('where the host lends openEnded, an ended run is a button for a screen reader, saying where it opens', async () => {
    const view = await mount({ agents: [row], capabilities: { history: lent } }, { openEnded: true });
    await act(async () => frames.step(2));
    expect(view.root.querySelectorAll('.vf-monitor-timeline-agents li > span')).toHaveLength(0);
    const [first, live, last] = buttons(view.root);
    expect(buttons(view.root).map((button) => button.type)).toEqual(['button', 'button', 'button']);
    expect(first!.textContent).toBe('notes, Claude Code, ended, last active 25 minutes ago, opens in History');
    expect(last!.textContent).toBe(
      'Split the invoice writer, notes, Claude Code, ended, last active 20 minutes ago, opens in History',
    );
    // The row between them is worded as it always was: only an ended run says where it opens.
    expect(live!.textContent).toMatch(/^billing, .*working for 10 minutes$/);
    expect(OPENS_IN_HISTORY).toBe('opens in History');
    await act(async () => buttons(view.root)[2]!.click());
    expect([view.commands.selects, view.commands.opens]).toEqual([[], ['past:claude:x']]);
    await act(async () => buttons(view.root)[1]!.click());
    expect([view.commands.selects, view.commands.opens]).toEqual([['a'], ['past:claude:x']]);
  });

  it('shows a control’s cursor over an ended lane the host can open, and only there', async () => {
    const view = await mount({ agents: [row], capabilities: { history: lent } }, { openEnded: true });
    await act(async () => frames.step(2));
    const body = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-body')!;
    const lanes = [...view.root.querySelectorAll<HTMLElement>('.vf-monitor-timeline-name')];
    expect(view.view.hasAttribute('data-opens')).toBe(false);
    await over(body, lanes[0]!);
    expect(view.view.dataset.opens).toBe('true');
    await over(body, lanes[1]!);
    expect(view.view.hasAttribute('data-opens')).toBe(false);
    await over(body, lanes[2]!);
    expect(view.view.dataset.opens).toBe('true');
    // The pointer leaves the lanes (React reads a leave from the out that bubbles).
    await act(async () => {
      body.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    });
    expect(view.view.hasAttribute('data-opens')).toBe(false);
    // A lane that leaves under a resting pointer takes its cursor with it.
    await over(body, lanes[2]!);
    expect(view.view.dataset.opens).toBe('true');
    await view.update(
      fixtureInput({
        parameters: PARAMETERS,
        agents: [row],
        capabilities: { history: { ...lent, ended: [lent.ended[0]!] } },
      }),
    );
    expect(view.view.hasAttribute('data-opens')).toBe(false);
  });

  it('changes nothing else for the command: the two markups differ only in an ended run’s spoken line', async () => {
    const theme = fixtureTheme('dark', { animations: false });
    const markup = async (openEnded: boolean): Promise<string> => {
      const view = await mount({ agents: [row], theme, capabilities: { history: lent } }, { openEnded });
      for (let frame = 0; frame < 5 && frames.pending > 0; frame += 1) await act(async () => frames.step(1));
      return view.root.outerHTML;
    };
    const without = await markup(false);
    const lentOne = await markup(true);
    expect(lentOne).not.toBe(without);
    expect(lentOne.replace(/<button type="button">([^<]*), opens in History<\/button>/g, '<span>$1</span>')).toBe(
      without,
    );
  });

  it("cuts the seam where the runtime takes over, and ticks each ended run's last activity", async () => {
    await mount({ agents: [row], capabilities: { history: lent } });
    await act(async () => frames.step(2));
    const rects = calls.filter((call) => call.op === 'fillRect').map((call) => call.args as number[]);
    // Three lanes of 36 px: the row's seam is a 1 px cut across its 7.5 px wake (2r + 2), off the top edge.
    expect(rects.some(([, y, w, h]) => w === 1 && h === 17 && y! > 0)).toBe(true);
    expect(rects.filter(([, , w, h]) => w === 2 && h === 12).length).toBeGreaterThanOrEqual(2);
    // Every lane's record covers its whole life here, so no dotted thread is drawn (the gap rule draws only gaps).
    expect(calls.filter((call) => call.op === 'setLineDash')).toHaveLength(0);
  });

  it("prints the backend's sentence when the record is not whole, and nothing when it is", async () => {
    const record = (root: Element) => root.querySelector('.vf-monitor-timeline-record');
    const partial = await mount({
      agents: [row],
      capabilities: {
        history: pastHistory({ state: 'partial', detail: 'tower is asleep; its runs are not in this record.' }),
      },
    });
    expect(record(partial.root)?.textContent).toBe('tower is asleep; its runs are not in this record.');
    expect(record(partial.root)?.getAttribute('role')).toBe('status');
    await partial.update(
      fixtureInput({
        parameters: PARAMETERS,
        agents: [row],
        capabilities: { history: pastHistory({ state: 'complete', detail: 'unused' }) },
      }),
    );
    expect(record(partial.root)).toBeNull();
    await partial.update(fixtureInput({ parameters: PARAMETERS, agents: [row] }));
    expect(record(partial.root)).toBeNull();
    // Unavailable: today's floor (the row alone), and the sentence.
    await partial.update(
      fixtureInput({
        parameters: PARAMETERS,
        agents: [row],
        capabilities: { history: pastHistory({ state: 'unavailable', detail: 'The record index is starting.' }) },
      }),
    );
    expect(record(partial.root)?.textContent).toBe('The record index is starting.');
    expect(names(partial.root)).toEqual(['billing']);
  });

  it('says only the state in a head too narrow for the sentence, which stays for a reader and the title', async () => {
    const sentence = 'tower is asleep; its runs are not in this record.';
    const narrow = await mount(
      { agents: [row], capabilities: { history: pastHistory({ state: 'partial', detail: sentence }) } },
      { width: 600 },
    );
    const record = narrow.root.querySelector<HTMLElement>('.vf-monitor-timeline-record')!;
    expect(record.querySelector('.vf-monitor-timeline-record-state')?.textContent).toBe('RECORD PARTIAL');
    expect(record.querySelector('.vf-monitor-timeline-record-state')?.getAttribute('aria-hidden')).toBe('true');
    expect(record.querySelector('.vf-monitor-timeline-unseen-text')?.textContent).toBe(sentence);
    expect([record.getAttribute('role'), record.title]).toEqual(['status', sentence]);
    await narrow.update(
      fixtureInput({
        parameters: PARAMETERS,
        agents: [row],
        capabilities: { history: pastHistory({ state: 'unavailable', detail: 'The record index is starting.' }) },
      }),
    );
    expect(narrow.root.querySelector('.vf-monitor-timeline-record-state')?.textContent).toBe('NO RECORD NOW');
  });

  const asked = (spy: unknown): string[] =>
    (spy as ReturnType<typeof vi.fn>).mock.calls.map(([lane]) => (lane as { id: string }).id).sort();

  it.each([
    ['with no openEnded lent', false],
    ['with openEnded lent (TV-8)', true],
  ])(
    "holds an ended run's rows by identity, %s: a model publish builds the live lanes' rows again, never theirs",
    async (_case, openEnded) => {
      const theme = fixtureTheme('dark', { animations: false });
      const view = await mount({ agents: [row], theme, capabilities: { history: lent } }, { openEnded });
      for (let frame = 0; frame < 5 && frames.pending > 0; frame += 1) await act(async () => frames.step(1));
      const spoken = () => [...view.root.querySelectorAll('.vf-monitor-timeline-agents li > *')];
      const before = spoken();
      expect(before.map((item) => item.tagName)).toEqual(
        openEnded ? ['BUTTON', 'BUTTON', 'BUTTON'] : ['SPAN', 'BUTTON', 'SPAN'],
      );
      vi.mocked(laneSubLine).mockClear();
      vi.mocked(laneLabel).mockClear();
      const moved = { ...row, status: 'blocked' as const, statusSince: NOW - MIN };
      await view.update(
        fixtureInput({ parameters: PARAMETERS, agents: [moved], theme, capabilities: { history: lent } }),
      );
      // The row's name row and spoken line were built again; the two ended runs' were not.
      expect(asked(laneSubLine)).toEqual(['a']);
      expect(asked(laneLabel)).toEqual(['a']);
      expect(names(view.root)).toEqual(['Claude Code · notes', 'billing', 'Split the invoice writer']);
      expect(spoken()).toEqual(before);
      // A new history object builds them again.
      vi.mocked(laneSubLine).mockClear();
      await view.update(
        fixtureInput({ parameters: PARAMETERS, agents: [moved], theme, capabilities: { history: { ...lent } } }),
      );
      expect(asked(laneSubLine)).toEqual(['a', 'past:claude:x', 'past:claude:y']);
    },
  );

  it("keys an ended run's spoken line on the command's presence, never on the commands object", async () => {
    const theme = fixtureTheme('dark', { animations: false });
    const input = fixtureInput({ parameters: PARAMETERS, agents: [row], theme, capabilities: { history: lent } });
    const root = arrange();
    root.classList.add(TIMELINE_ROOT_CLASS);
    const reactRoot = createRoot(root);
    const render = (commands: ReturnType<typeof countingCommands>) =>
      act(async () =>
        reactRoot.render(createElement(timelineMonitorView.Component, { input, commands: commands.commands })),
      );
    try {
      const first = countingCommands({ openEnded: true });
      await render(first);
      for (let frame = 0; frame < 5 && frames.pending > 0; frame += 1) await act(async () => frames.step(1));
      // The same door on a new commands object: the row's line is worded again, the ended runs' are not…
      vi.mocked(laneLabel).mockClear();
      const second = countingCommands({ openEnded: true });
      await render(second);
      expect(asked(laneLabel)).toEqual(['a']);
      // …and a press reaches the commands the view holds now, not the ones the line was built under.
      await act(async () => buttons(root)[0]!.click());
      expect([first.opens, second.opens]).toEqual([[], ['past:claude:y']]);
      // The door gone: each ended run's line is built again, as words alone. And back.
      vi.mocked(laneLabel).mockClear();
      await render(countingCommands());
      expect(asked(laneLabel)).toEqual(['a', 'past:claude:x', 'past:claude:y']);
      expect(buttons(root)).toHaveLength(1);
      expect(root.querySelectorAll('.vf-monitor-timeline-agents li > span')).toHaveLength(2);
      vi.mocked(laneLabel).mockClear();
      await render(countingCommands({ openEnded: true }));
      expect(asked(laneLabel)).toEqual(['a', 'past:claude:x', 'past:claude:y']);
      expect(buttons(root)).toHaveLength(3);
    } finally {
      await act(async () => reactRoot.unmount());
      root.remove();
    }
  });

  it('repaints both canvases once for a new history, and nothing for the same one', async () => {
    const theme = fixtureTheme('dark', { animations: false });
    const agents = [row];
    const view = await mount({ agents, theme, capabilities: { history: lent } });
    // Settle: the first draw scrolls the two-hour-old run out, which lays the lanes out again and draws once more.
    for (let frame = 0; frame < 5 && frames.pending > 0; frame += 1) await act(async () => frames.step(1));
    expect(frames.pending).toBe(0);
    const clears = () => calls.filter((call) => call.op === 'clearRect').length;
    let before = clears();
    await view.update(fixtureInput({ parameters: PARAMETERS, agents, theme, capabilities: { history: lent } }));
    await act(async () => frames.step(2));
    expect(clears()).toBe(before);
    before = clears();
    await view.update(fixtureInput({ parameters: PARAMETERS, agents, theme, capabilities: { history: { ...lent } } }));
    expect(frames.pending).toBe(1);
    await act(async () => frames.step(1));
    expect(clears() - before).toBe(2);
  });

  it('sizes the wake canvas to the window when ended runs make the rows tall, and moves it as the lanes scroll', async () => {
    const tall = pastHistory({ ended: Array.from({ length: 40 }, (_, index) => endedRun(`r${index}`, 50 + index, 5)) });
    const view = await mount({ agents: [row], capabilities: { history: tall } });
    await act(async () => frames.step(2));
    const wake = view.root.querySelector<HTMLCanvasElement>('.vf-monitor-timeline-wakes')!;
    const rows = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-rows')!;
    // The body shows 252 px of 41 lanes; the canvas covers that and 120 px either side, never all of them.
    expect(parseFloat(rows.style.height)).toBeGreaterThan(900);
    expect(wake.style.height).toBe(`${252 + 240}px`);
    const body = view.root.querySelector<HTMLElement>('.vf-monitor-timeline-body')!;
    Object.defineProperty(body, 'scrollTop', { configurable: true, value: 400 });
    await act(async () => {
      body.dispatchEvent(new Event('scroll'));
      frames.step(1);
    });
    expect(wake.style.top).toBe('280px');
    // Without ended runs the canvas is as tall as the rows, as before.
    const short = await mount({ agents: agentViewsFixture(20), capabilities: { history: pastHistory() } });
    await act(async () => frames.step(2));
    const shortWake = short.root.querySelector<HTMLCanvasElement>('.vf-monitor-timeline-wakes')!;
    const shortRows = short.root.querySelector<HTMLElement>('.vf-monitor-timeline-rows')!;
    expect(shortWake.style.height).toBe(`${Math.max(parseFloat(shortRows.style.height), 252)}px`);
  });
});

// The suite again with the record lent: the view keeps every rule with history in its input (MV-W4).
describe('at a size to draw at, with history', () => {
  beforeAll(() => {
    size = { width: 1064, height: 320 };
  });
  afterAll(() => {
    size = { width: 0, height: 0 };
  });
  runConformance(timelineMonitorView, { capabilities: { history: fixtureHistory({ live: agentViewsFixture(20) }) } });
});

// And again where the host can open an ended run (TV-8): the view keeps every rule with the command lent.
describe('at a size to draw at, with history and openEnded', () => {
  beforeAll(() => {
    size = { width: 1064, height: 320 };
  });
  afterAll(() => {
    size = { width: 0, height: 0 };
  });
  runConformance(timelineMonitorView, {
    capabilities: { history: fixtureHistory({ live: agentViewsFixture(20) }) },
    openEnded: true,
  });
});
