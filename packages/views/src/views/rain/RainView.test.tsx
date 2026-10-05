// @vitest-environment happy-dom
import { act } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentView, MonitorViewInput, MonitorViewInstance } from '@vibecook/puppeteer-view-sdk';
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
} from '@vibecook/puppeteer-view-sdk/testing';
import { RAIN_MANIFEST, RAIN_ROOT_CLASS, rainMonitorView } from './index.js';

// The rain on the SDK (MV-4), mounted as a host mounts it. happy-dom has no 2D
// context, so a recording one stands in: with it the rain's loop really runs,
// and the conformance suite sees it ask for frames, stop when motion is off,
// and let go at unmount (MV-W4).

interface DrawCall {
  readonly op: 'fillText' | 'fillRect';
  readonly text?: string;
}

const draws: DrawCall[] = [];
function recordingContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get(target, key) {
      if (key === 'fillText') return (text: string) => draws.push({ op: 'fillText', text });
      if (key === 'fillRect') return () => draws.push({ op: 'fillRect' });
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

describe('the rain’s loop and the theme', () => {
  it('runs while animations are on and motion is not reduced', async () => {
    await mount({ agents });
    expect(frames.pending).toBeGreaterThan(0);
    await act(async () => frames.step(6));
    expect(draws.some((call) => call.op === 'fillText')).toBe(true);
  });

  it('asks for no frame while animations are off, and draws the field once where it stands', async () => {
    const view = await mount({ agents, theme: fixtureTheme('dark', { animations: false }) });
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

  it('draws again, still, when what it shows changes while motion is off', async () => {
    const theme = fixtureTheme('dark', { animations: false });
    const view = await mount({ agents, theme });
    draws.length = 0;
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: agents.slice(0, 1), theme }));
    expect(draws.some((call) => call.op === 'fillRect')).toBe(true);
    expect(frames.pending).toBe(0);
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
