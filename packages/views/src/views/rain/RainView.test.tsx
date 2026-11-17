// @vitest-environment happy-dom
import { act } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentView, MonitorViewInput, MonitorViewInstance } from '@vibefield/puppeteer-view-sdk';
import {
  agentViewFixture,
  countingCommands,
  createFixtureClock,
  createFrameDriver,
  fixtureInput,
  fixtureTheme,
  parameterDefaults,
  runConformance,
  type FrameDriver,
} from '@vibefield/puppeteer-view-sdk/testing';
import { RAIN_MANIFEST, RAIN_ROOT_CLASS, rainMonitorView } from './index.js';

// The rain on the SDK (MV-4), mounted as a host mounts it. happy-dom has no 2D
// context, so a recording one stands in: with it the rain's loop really runs,
// and the conformance suite sees it ask for frames, stop when motion is off,
// and let go at unmount (MV-W4).

interface DrawCall {
  readonly op: 'fillText' | 'fillRect';
  readonly text?: string;
  /** A rect's width and the fill it was drawn in: the stage's fill spans the field. */
  readonly width?: number;
  readonly fillStyle?: unknown;
}

const draws: DrawCall[] = [];
function recordingContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key === 'fillText') return (text: string) => draws.push({ op: 'fillText', text });
      if (key === 'fillRect') {
        return (_x: number, _y: number, width: number) =>
          draws.push({ op: 'fillRect', width, fillStyle: target.fillStyle });
      }
      if (key === 'setTransform') return () => undefined;
      return target[key as string];
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const realGetContext = HTMLCanvasElement.prototype.getContext;
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
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
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

const PARAMETERS = parameterDefaults(RAIN_MANIFEST);
const LAPTOP = { id: 'desk-2', name: 'Laptop', os: 'linux', self: false } as const;

interface Mounted {
  readonly root: HTMLElement;
  readonly instance: MonitorViewInstance;
  readonly commands: ReturnType<typeof countingCommands>;
  update(input: MonitorViewInput): Promise<void>;
}

let frames: FrameDriver;
let restoreFrames: () => void = () => undefined;
const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) {
    await act(async () => each.instance.unmount());
    each.root.remove();
  }
  restoreFrames();
  draws.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(input: Partial<Parameters<typeof fixtureInput>[0]> = {}): Promise<Mounted> {
  // Frames and `performance.now()` read one clock, as a browser's do: the loop's refresh cap measures between them.
  const clock = createFixtureClock();
  const restoreClock = clock.install();
  frames = createFrameDriver({ clock });
  const restoreDriver = frames.install();
  restoreFrames = () => {
    restoreDriver();
    restoreClock();
  };
  const root = document.createElement('div');
  document.body.append(root);
  const commands = countingCommands();
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = rainMonitorView.mount(root, fixtureInput({ parameters: PARAMETERS, ...input }), commands.commands);
  });
  const result: Mounted = { root, instance, commands, update: (next) => act(async () => instance.update(next)) };
  mounted.push(result);
  return result;
}

const agents: readonly AgentView[] = [
  agentViewFixture({
    id: 'a',
    status: 'working',
    project: { name: 'vibe-field', branch: 'main' },
    model: 'Opus',
    detail: 'Reading src/app.ts',
    cost: { usd: 2, coverage: 'complete', burnPerHour: 6 },
    context: { usedPercent: 42.6 },
  }),
  agentViewFixture({ id: 'b', status: 'idle', reply: { text: 'Done.' }, createdAt: 2 }),
];

/** The stage's own fills, one per field drawn (a pane's wash and stripes are filled in its agent's colour). */
const stageFills = (): number =>
  draws.filter((call) => call.op === 'fillRect' && call.fillStyle === fixtureTheme('dark').tokens.rain.stage).length;

describe('the rain’s loop and the theme', () => {
  it('runs while animations are on and motion is not reduced', async () => {
    await mount({ agents });
    expect(frames.pending).toBeGreaterThan(0);
    await act(async () => frames.step(6));
    expect(draws.some((call) => call.op === 'fillText')).toBe(true);
  });

  it('asks for no frame loop while animations are off, and draws the field where it stands', async () => {
    const view = await mount({ agents, theme: fixtureTheme('dark', { animations: false }) });
    // The mount's one still frame, and then nothing.
    expect(frames.pending).toBe(1);
    await act(async () => frames.step(1));
    expect(frames.pending).toBe(0);
    const still = draws.filter((call) => call.op === 'fillText').map((call) => call.text);
    expect(still.length).toBeGreaterThan(0);
    // A still field scrambles nothing: every glyph is the column's own text.
    expect(still.every((glyph) => glyph !== undefined && glyph.length === 1 && /[a-zA-Z0-9\s%.]/.test(glyph))).toBe(
      true,
    );
    // Turning the switch on starts the loop; off again, it stops.
    await view.update(fixtureInput({ parameters: PARAMETERS, agents, theme: fixtureTheme('dark') }));
    expect(frames.pending).toBeGreaterThan(0);
    await view.update(
      fixtureInput({ parameters: PARAMETERS, agents, theme: fixtureTheme('dark', { reducedMotion: true }) }),
    );
    await act(async () => frames.step(2));
    expect(frames.pending).toBe(0);
  });

  it('draws again, still, once on the next frame, when what it shows changes while motion is off', async () => {
    const theme = fixtureTheme('dark', { animations: false });
    const view = await mount({ agents, theme });
    await act(async () => frames.step(1));
    draws.length = 0;
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: agents.slice(0, 1), theme }));
    // A publish asks for one still frame: a burst of them is drawn once.
    expect(draws).toEqual([]);
    expect(frames.pending).toBe(1);
    await act(async () => frames.step(1));
    expect(stageFills()).toBe(1);
    expect(frames.pending).toBe(0);
  });

  it('draws nothing while its stage is out of sight, and the field once where it stands when it is shown', async () => {
    const hidden = fixtureTheme('dark', { hidden: true });
    // The host's animations switch is on: only the stage being out of sight holds the field.
    const view = await mount({ agents, theme: hidden });
    expect(frames.pending).toBe(0);
    expect(draws).toEqual([]);
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: agents.slice(0, 1), theme: hidden }));
    await act(async () => frames.step(3));
    expect(draws).toEqual([]);
    expect(frames.pending).toBe(0);
    // Shown with the switch off: one still frame, with what changed while it was out of sight.
    const still = fixtureTheme('dark', { animations: false });
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: agents.slice(0, 1), theme: still }));
    expect(frames.pending).toBe(1);
    await act(async () => frames.step(1));
    expect(stageFills()).toBe(1);
    expect(frames.pending).toBe(0);
  });
});

describe('the rain’s canvas', () => {
  it('sizes its canvas only when the size changes, so a publish never clears the field', async () => {
    // Writing a canvas's width or height clears it, even at the size it already has.
    const widths = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set');
    const heights = vi.spyOn(HTMLCanvasElement.prototype, 'height', 'set');
    const written = (): number => widths.mock.calls.length + heights.mock.calls.length;
    const view = await mount({ agents });
    // Mounting sizes it: happy-dom lays the stage out at 0, so 300×150 becomes 1×1.
    expect(written()).toBeGreaterThan(0);
    widths.mockClear();
    heights.mockClear();
    for (const step of [1, 2, 3, 4, 5]) {
      const changed: AgentView = { ...agents[0]!, reply: { text: `Step ${step}.` } };
      await view.update(fixtureInput({ parameters: PARAMETERS, agents: [changed, agents[1]!] }));
    }
    expect(view.root.querySelector('.vf-monitor-rain-agents button')?.textContent).toBe(
      'vibe-field, Opus, working: Step 5.',
    );
    expect(written()).toBe(0);
  });

  it('draws the field at once when its canvas is resized, before the loop’s next frame', async () => {
    let observeResize: (() => void) | undefined;
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
    await mount({ agents });
    await act(async () => frames.step(6));
    expect(frames.pending).toBeGreaterThan(0);
    draws.length = 0;
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(280);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(140);
    // Resizing the backing store clears it: waiting for the loop's next capped frame would show the cleared canvas.
    observeResize?.();
    const stage = fixtureTheme('dark').tokens.rain.stage;
    expect(draws).toContainEqual({ op: 'fillRect', width: 280, fillStyle: stage });
    // Drawn inside the observer's callback: the loop still runs, and no frame was stepped.
    expect(frames.pending).toBeGreaterThan(0);
  });

  it('draws a still field at once when a zoom moves its columns and leaves its backing store as it was', async () => {
    let observeResize: (() => void) | undefined;
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
    const ratio = vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(280);
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(140);
    const view = await mount({ agents, theme: fixtureTheme('dark', { animations: false }) });
    // The mount's one still frame; then the field is held, with no frame to come.
    await act(async () => frames.step(1));
    expect(frames.pending).toBe(0);
    const canvas = view.root.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([280, 140]);
    draws.length = 0;
    // A page zoom to 200%: the stage halves in CSS pixels as the ratio doubles, so the backing store keeps its size and
    // nothing clears it. The columns and the transform are new all the same, and a held-still field has no next frame.
    ratio.mockReturnValue(2);
    width.mockReturnValue(140);
    height.mockReturnValue(70);
    observeResize?.();
    expect([canvas.width, canvas.height]).toEqual([280, 140]);
    const stage = fixtureTheme('dark').tokens.rain.stage;
    expect(draws).toContainEqual({ op: 'fillRect', width: 140, fillStyle: stage });
  });
});

describe('the rain’s words', () => {
  it('offers every agent as a control, in the line under the name’s one rule (M4)', async () => {
    const view = await mount({ agents });
    const buttons = [...view.root.querySelectorAll<HTMLButtonElement>('.vf-monitor-rain-agents button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'vibe-field, Opus, working: working',
      'project, , idle: Done.',
    ]);
    await act(async () => buttons[1]!.click());
    expect(view.commands.selects).toEqual(['b']);
  });

  it('shows the column under the pointer: its project, status, branch, model, line and context', async () => {
    const view = await mount({ agents });
    const surface = view.root.querySelector('.vf-monitor-rain-surface')!;
    await act(async () => {
      surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 0, clientY: 0 }));
    });
    const tooltip = view.root.querySelector('.vf-monitor-rain-tooltip');
    expect(tooltip?.className).toBe('vf-monitor-rain-tooltip is-working');
    expect(tooltip?.querySelector('strong')?.textContent).toBe('vibe-field');
    expect([...(tooltip?.querySelectorAll('dd') ?? [])].map((cell) => cell.textContent)).toEqual([
      'main',
      'Opus',
      'working',
    ]);
    expect(tooltip?.querySelector('.vf-monitor-rain-context')?.textContent).toBe('CTX 43%');
    await act(async () => {
      // React hears a pointer leaving through `pointerout` with where it went.
      surface.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(view.root.querySelector('.vf-monitor-rain-tooltip')).toBeNull();
  });

  it('keeps the tooltip on the row as it is now, and lets it go when the row leaves', async () => {
    const view = await mount({ agents });
    const surface = view.root.querySelector('.vf-monitor-rain-surface')!;
    const tooltip = (): Element | null => view.root.querySelector('.vf-monitor-rain-tooltip');
    await act(async () => {
      surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 0, clientY: 0 }));
    });
    expect(tooltip()?.className).toBe('vf-monitor-rain-tooltip is-working');
    // The pointer rests while its row changes: a changed row arrives as a new object (MV-D21).
    const blocked: AgentView = {
      ...agents[0]!,
      status: 'blocked',
      wait: { kind: 'permission', tool: 'Bash', since: 1 },
    };
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: [blocked, agents[1]!] }));
    expect(tooltip()?.className).toBe('vf-monitor-rain-tooltip is-blocked');
    expect(tooltip()?.querySelector('.vf-monitor-rain-tooltip-head span')?.textContent).toBe('blocked');
    expect([...(tooltip()?.querySelectorAll('dd') ?? [])].map((cell) => cell.textContent)).toEqual([
      'main',
      'Opus',
      'permission · Bash',
    ]);
    // Then the row leaves, the pointer still resting where it was.
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: agents.slice(1) }));
    expect(tooltip()).toBeNull();
  });

  it('says a peer’s line after its desktop’s name', async () => {
    const view = await mount({
      agents: [agentViewFixture({ id: 'p', device: LAPTOP, status: 'blocked', wait: { kind: 'question', since: 1 } })],
    });
    expect(view.root.querySelector('.vf-monitor-rain-agents button')?.textContent).toBe(
      'project, , blocked: Laptop · question',
    );
  });

  it('says so with no agents, in its own words and its own class', async () => {
    const view = await mount();
    expect(view.root.querySelector('.vf-monitor-rain-empty')?.textContent).toBe(
      'NO ACTIVE AGENTS' + 'Launch an agent from a terminal pane.',
    );
    expect(view.root.querySelector('.vf-monitor-empty')).toBeNull();
  });
});

describe('the view on its root', () => {
  it('scopes its stylesheet under its root class, and hands it the palette’s rain colours (M46)', async () => {
    const view = await mount({ agents });
    expect(view.root.classList.contains(RAIN_ROOT_CLASS)).toBe(true);
    const rain = view.root.querySelector<HTMLElement>('.vf-monitor-rain')!;
    const palette = fixtureTheme('dark').tokens;
    expect(rain.style.getPropertyValue('--mv-rain-stage')).toBe(palette.rain.stage);
    expect(rain.style.getPropertyValue('--mv-rain-title')).toBe(palette.text.primary);
    expect(rain.style.getPropertyValue('--mv-rain-ink-working')).toBe(palette.rain.ink.working);
    expect(rain.style.getPropertyValue('--mv-rain-ink-blocked')).toBe(palette.rain.ink.blocked);
    expect(rain.style.getPropertyValue('--mv-rain-ink-idle')).toBe(palette.rain.ink.idle);
    expect(rain.style.getPropertyValue('--mv-rain-focus')).toBe(palette.rain.focus);
  });
});

runConformance(rainMonitorView);
