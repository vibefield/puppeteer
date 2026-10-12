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
  fixtureStage,
  fixtureTheme,
  parameterDefaults,
  runConformance,
  type FixtureClock,
  type FrameDriver,
} from '@vibefield/puppeteer-view-sdk/testing';
import { formatClock, keyLegend } from '@vibefield/puppeteer-view-sdk/toolkit';
import { SPEND_MANIFEST, SPEND_ROOT_CLASS, spendMonitorView } from './index.js';
import { spendWorld } from './lab/spend-fixtures.js';
import { SPEND_WINDOW_MS } from './spend-scale.js';
import { spendSet, spentAt, valueAt } from './spend-series.js';
import { est, money } from './spend-words.js';
import { geometryFor } from './SpendView.js';

// The spend view on the SDK (MV-7), mounted as a host mounts it. happy-dom lays
// nothing out and has no 2D context, so the tests give the view a size and a
// recording context: with them its paint really runs, and the conformance
// suite sees its loop ask for frames while a head waves, stop when motion is
// off, and let go at unmount (MV-W4). The clock is the fixture's: the view
// reads `Date.now()`, so the afternoon's buckets line up with the view's now.

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
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6.4 });
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

const realGetContext = HTMLCanvasElement.prototype.getContext;
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
const sizes = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
/** The view's root as the lab's wide plate lays it out. */
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
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => size.width });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => size.height });
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  for (const key of ['clientWidth', 'clientHeight'] as const) {
    if (sizes[key]) Object.defineProperty(HTMLElement.prototype, key, sizes[key]);
  }
});

const PARAMETERS = parameterDefaults(SPEND_MANIFEST);
const NOW = Date.parse('2026-10-03T21:12:15.000Z');
const MIN = 60_000;
const WIDE = { width: 1178, height: 638 };

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

async function mount(
  input: Partial<Parameters<typeof fixtureInput>[0]> = {},
  options: { width?: number; height?: number } = {},
): Promise<Mounted> {
  size = { width: options.width ?? WIDE.width, height: options.height ?? WIDE.height };
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
  const commands = countingCommands();
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = spendMonitorView.mount(root, fixtureInput({ parameters: PARAMETERS, ...input }), commands.commands);
  });
  const view = root.querySelector<HTMLElement>('.vf-monitor-spend')!;
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

const afternoon = (options: { crowd?: boolean } = {}): AgentView[] => spendWorld(NOW, undefined, options);
const rowIds = (root: Element): string[] =>
  [...root.querySelectorAll<HTMLElement>('button.vf-monitor-spend-row')].map((row) => row.dataset.id ?? '');
const rowOf = (root: Element, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
/** What a row shows: its money (or the dash), and line 2's state words. */
const figure = (row: Element): string | undefined => row.querySelector('.vf-monitor-spend-v')?.textContent ?? undefined;
const stateText = (row: Element): string | undefined =>
  row.querySelector('.vf-monitor-spend-state')?.textContent ?? undefined;
const text = (root: Element, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent ?? '');

/** Press empty chart at `t`, near the plot's top, as a person sets a moment (SV-D18). happy-dom's rects sit at 0. */
async function setMoment(view: Mounted, t: number, box = WIDE): Promise<void> {
  const g = geometryFor(box.width, box.height);
  const x = g.x0 + ((t - (NOW - SPEND_WINDOW_MS)) / SPEND_WINDOW_MS) * (g.x1 - g.x0);
  const y = g.y0 + 2;
  const hit = view.root.querySelector('.vf-monitor-spend-hit')!;
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 };
  await act(async () => {
    hit.dispatchEvent(new PointerEvent('pointerdown', init));
    hit.dispatchEvent(new PointerEvent('pointerup', init));
  });
}

describe('the spend view', () => {
  it("captions the chart as the window's spend, and heads the list's money as each run's TOTAL (SV-D2)", async () => {
    const agents = afternoon();
    const view = await mount({ agents });
    expect(text(view.root, '.vf-monitor-spend-colcap')).toEqual(['Spent in the last 10 minutes']);
    expect(text(view.root, '.vf-monitor-spend-head span')).toEqual(['By spend', 'Total']);
    // A line's head is what its run spent in the window; its row prints the run's total, a different figure.
    const line = spendSet(agents, NOW).lines.find((candidate) => candidate.id === 'vibe-field')!;
    const spent = spentAt(line, NOW - SPEND_WINDOW_MS, NOW)!;
    expect(spent).toBeCloseTo(line.total - valueAt(line, NOW - SPEND_WINDOW_MS)!);
    expect(spent).toBeLessThan(line.total / 4);
    expect(figure(rowOf(view.root, 'vibe-field'))).toBe(est(line.total, false));
  });

  it('draws each line from $0 at the left edge, or at a birth inside the window (SV-D2)', async () => {
    const agents = afternoon();
    const view = await mount({ agents });
    const g = geometryFor(WIDE.width, WIDE.height);
    // The plot's $0 is its foot: the first point of every line the canvas strokes sits on it.
    const strokes = calls.filter((call) => call.op === 'moveTo').map((call) => call.args as [number, number]);
    const starts = strokes.filter(([, y]) => Math.abs(y - g.y1) < 0.01);
    expect(starts.length).toBeGreaterThan(0);
    // vibe-field was working long before the window: its line starts at the left edge. changelog was born 4.5 minutes
    // ago: its line starts there, at its birth, on $0.
    const xBorn = g.x0 + ((NOW - 4.5 * MIN - (NOW - SPEND_WINDOW_MS)) / SPEND_WINDOW_MS) * (g.x1 - g.x0);
    expect(starts.some(([x]) => Math.abs(x - g.x0) < 0.01)).toBe(true);
    expect(starts.some(([x]) => Math.abs(x - xBorn) < 0.01)).toBe(true);
    expect(view.root.querySelector('.vf-monitor-spend-canvas')).not.toBeNull();
  });

  it('keeps a slim header in the compact form — Total over the money, who had started only while some had not — and the rows still fit', async () => {
    const squeezed = { width: 1178, height: 298 };
    const view = await mount({ agents: afternoon() }, squeezed);
    const head = view.root.querySelector('.vf-monitor-spend-head')!;
    expect(head.className).toContain('is-slim');
    expect(text(view.root, '.vf-monitor-spend-head span')).toEqual(['', 'Total']);
    const moment = NOW - 6 * MIN;
    await setMoment(view, moment, squeezed);
    expect(text(view.root, '.vf-monitor-spend-head span')).toEqual([
      '9 of 10 started',
      `Total by ${formatClock(moment)}`,
    ]);
    // The slim line's 14 px come out of the rows' room: the slots left are filled exactly, every row under the
    // header, inside the stage, none over another.
    const top = 12 + 14;
    const slots = Math.floor((squeezed.height - 4 - top - 30 - 6) / 30);
    const boxes = [...view.root.querySelectorAll<HTMLElement>('.vf-monitor-spend-row')]
      .filter((row) => !row.hidden)
      .map((row) => {
        const box = row.style.transform.match(/translate\([\d.]+px, ([\d.]+)px\)/)!;
        return { top: Number(box[1]), height: Number.parseFloat(row.style.height) };
      })
      .sort((a, b) => a.top - b.top);
    expect(boxes).toHaveLength(slots + 1);
    expect(boxes[0]!.top).toBe(top);
    boxes.forEach((box, i) => {
      if (i > 0) expect(box.top).toBeGreaterThanOrEqual(boxes[i - 1]!.top + boxes[i - 1]!.height);
    });
    expect(boxes.at(-1)!.top + boxes.at(-1)!.height).toBeLessThanOrEqual(squeezed.height - 4);
  });

  it('draws the live rows and nothing else: no range control and no look-back', async () => {
    const view = await mount({ agents: afternoon() });
    const html = view.root.innerHTML;
    expect(html).not.toContain('vf-monitor-spend-ranges');
    expect(html).not.toContain('How far back');
    expect(html).not.toMatch(/>(15m|1h|4h|All)</);
    expect(html).not.toContain('Looking back');
  });

  it("lists the priced agents most spent first, each row printing its run's total, and the unpriced at the foot", async () => {
    const agents = afternoon();
    const view = await mount({ agents });
    const set = spendSet(agents, NOW);
    const bySpend = [...set.lines].sort((a, b) => b.total - a.total || a.bornMs - b.bornMs).map((line) => line.id);
    expect(rowIds(view.root)).toEqual([...bySpend, 'swarm-lab']);
    for (const line of set.lines) {
      expect(valueAt(line, NOW)).toBe(line.agent.cost!.usd);
      expect(figure(rowOf(view.root, line.id))).toBe(est(line.total, line.partial));
    }
    const none = rowOf(view.root, 'swarm-lab');
    expect(figure(none)).toBe('—');
    expect(none.className).toContain('is-none');
    expect(none.textContent).toContain('no price');
  });

  it("says the field's total honestly: every run's meter, a plus for a partial one, the burn now, and who it leaves out", async () => {
    const agents = afternoon();
    const view = await mount({ agents });
    const total = spendSet(agents, NOW).lines.reduce((sum, line) => sum + line.total, 0);
    expect(text(view.root, '.vf-monitor-spend-big')).toEqual([`~${money(total)}+`]);
    expect(text(view.root, '.vf-monitor-spend-cap i')).toEqual([
      'since each agent started, at API prices · not counting swarm-lab',
    ]);
    expect(text(view.root, '.vf-monitor-spend-cap b')[0]).toMatch(/^\$[\d.]+\/hr now$/);
    // Without the partly priced run and the unpriced one: no plus, and nobody left out.
    const plain = agents.filter((agent) => agent.id !== 'billing-api' && agent.id !== 'swarm-lab');
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: plain }));
    expect(text(view.root, '.vf-monitor-spend-big')[0]).toMatch(/^~\$[\d,.]+$/);
    expect(text(view.root, '.vf-monitor-spend-cap i')).toEqual(['since each agent started, at API prices']);
  });

  it("prints another desktop's total now and draws it no line; before now it says in words that nobody recorded it (SV-D2)", async () => {
    const agents = afternoon();
    const peer = agents.find((agent) => agent.id === 'notes')!;
    expect(peer.device.self).toBe(false);
    const view = await mount({ agents });
    const now = rowOf(view.root, 'notes');
    expect(figure(now)).toBe(est(peer.cost!.usd, false));
    expect(now.querySelector('[aria-label="on tower"]')).not.toBeNull();
    // No line and no head: nothing of the peer is on the chart.
    expect(spendSet(agents, NOW).lines.find((line) => line.id === 'notes')!.recorded).toBe(false);
    await setMoment(view, NOW - 6 * MIN);
    const then = rowOf(view.root, 'notes');
    expect(then.className).toContain('is-unrecorded');
    expect(figure(then)).toBe('—');
    expect(stateText(then)).toBe('not recorded');
    expect(then.querySelector('.vf-monitor-spend-state')?.getAttribute('data-tone')).toBe('muted');
  });

  it('reads a set moment in the list, the header and the hero; a row born after it fades and says when it starts', async () => {
    const agents = afternoon();
    const view = await mount({ agents });
    const order = rowIds(view.root);
    const moment = NOW - 6 * MIN;
    await setMoment(view, moment);
    expect(text(view.root, '.vf-monitor-spend-head span')).toEqual([
      '9 of 10 started',
      `Total by ${formatClock(moment)}`,
    ]);
    expect(text(view.root, '.vf-monitor-spend-cap b')[0]).toMatch(
      new RegExp(`^by ${formatClock(moment)} · \\$[\\d.]+/hr then$`),
    );
    const young = rowOf(view.root, 'changelog');
    expect(young.className).toContain('is-before');
    expect(stateText(young)).toBe(`starts ${formatClock(NOW - 4.5 * MIN)}`);
    // The rows hold now's order (SV-D16).
    expect(rowIds(view.root)).toEqual(order);
    // With every run complete, only the peer's unrecorded money makes the moment's total a floor.
    const complete = agents.filter((agent) => agent.id !== 'billing-api');
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: complete }));
    expect(text(view.root, '.vf-monitor-spend-big')[0]).toMatch(/^~\$[\d,.]+\+$/);
  });

  it('prints End’s legend under the Now pill’s glyph from the toolkit’s one table, the pill itself the key; the pill lets go (M177 ruling 4, M181)', async () => {
    const view = await mount({ agents: afternoon() });
    expect(view.root.querySelector('.vf-monitor-spend-back')).toBeNull();
    await setMoment(view, NOW - 6 * MIN);
    const back = view.root.querySelector<HTMLButtonElement>('.vf-monitor-spend-back')!;
    // The legend sits under the glyph, inside the pill: no keycap chip, no outlined box, no corner digit.
    const key = back.querySelector('.vf-monitor-spend-now-key')!;
    expect(key.querySelector('.vf-monitor-spend-now-mark')).not.toBeNull();
    expect(key.lastElementChild?.className).toBe('vf-monitor-spend-legend');
    // ↘, as the timeline's now button and the bar's tooltip print End (M181).
    expect(key.lastElementChild?.textContent).toBe(keyLegend('End'));
    expect(keyLegend('End')).toBe('↘');
    expect(back.querySelector('.vf-monitor-spend-keycap')).toBeNull();
    expect(back.getAttribute('aria-keyshortcuts')).toBe('End');
    expect(back.getAttribute('aria-label')).toBe('Back to now');
    expect(back.title).toBe('Back to now (End)');
    await act(async () => back.click());
    expect(view.root.querySelector('.vf-monitor-spend-back')).toBeNull();
    expect(text(view.root, '.vf-monitor-spend-head span')).toEqual(['By spend', 'Total']);
  });

  it('keeps a moment inside the window: once the window has slid past it, it lets go', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const view = await mount({ agents: afternoon() });
    await setMoment(view, NOW - 9 * MIN);
    expect(view.root.querySelector('.vf-monitor-spend-back')).not.toBeNull();
    clock.advance(MIN);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(view.root.querySelector('.vf-monitor-spend-back')).toBeNull();
    expect(text(view.root, '.vf-monitor-spend-head span')).toEqual(['By spend', 'Total']);
    expect(text(view.root, '.vf-monitor-spend-cap b')[0]).toMatch(/^\$[\d.]+\/hr now$/);
  });

  it('names each row in words: the line under the name (M178), a wait in its own words, an unseen reply, a burn in the live green', async () => {
    const view = await mount({ agents: afternoon() });
    const task = (id: string) => rowOf(view.root, id).querySelector('.vf-monitor-spend-task')?.textContent;
    // Where the held row printed the agent's task (its terminal's title, no model fact), the line under the name:
    // the reply, else the wait, else — a bare status the state words already say — the model, as the held row fell back.
    expect(task('vibe-field')).toMatch(/^Porting the History view into the/);
    expect(task('billing-api')).toBe('permission · Bash');
    expect(task('rosetta-grants')).toBe('question');
    expect(task('notes')).toMatch(/^tower · Sorting Tuesday/);
    expect(task('refactor-auth')).toBe('opus · refactor-auth');
    expect(view.root.textContent).not.toContain('port the History view into the frame');
    expect(stateText(rowOf(view.root, 'rosetta-grants'))).toBe('waiting · 3m');
    expect(stateText(rowOf(view.root, 'rosetta-docs'))).toBe('reply unseen · 5m');
    const vibe = rowOf(view.root, 'vibe-field').querySelector('.vf-monitor-spend-state')!;
    expect(vibe.getAttribute('data-tone')).toBe('live');
    expect(vibe.textContent).toMatch(/^\$[\d.]+\/hr$/);
    expect(view.root.textContent).not.toMatch(/ended \d/);
  });

  it('docks waiting rows the scroll leaves out, when twenty do not fit (SV-D19)', async () => {
    const view = await mount({ agents: afternoon({ crowd: true }) }, { width: 1178, height: 518 });
    expect(view.root.textContent).toMatch(/more below · scroll/);
    expect(view.root.querySelector('.is-docked')).not.toBeNull();
  });

  it('opens a row in your pane with a click, by its id', async () => {
    const view = await mount({ agents: afternoon() });
    await act(async () => rowOf(view.root, 'billing-api').click());
    expect(view.commands.selects).toEqual(['billing-api']);
  });

  it('moves between rows with ↑ ↓ and opens one with Enter, on its own root only (MV-D8)', async () => {
    const view = await mount({ agents: afternoon() });
    const key = (name: string, target: EventTarget = view.view) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
      });
    await key('ArrowDown');
    await key('ArrowDown');
    await key('Enter');
    expect(view.commands.selects).toEqual([rowIds(view.root)[1]]);
    expect(rowOf(view.root, rowIds(view.root)[1]!).className).toContain('is-focus');
    // The window hears nothing: a key pressed outside the view moves nothing.
    await key('ArrowDown', window);
    await key('Enter', window);
    expect(view.commands.selects).toHaveLength(1);
  });

  it('lets go of a set moment with End', async () => {
    const view = await mount({ agents: afternoon() });
    await setMoment(view, NOW - 6 * MIN);
    expect(view.root.querySelector('.vf-monitor-spend-back')).not.toBeNull();
    await act(async () => {
      view.view.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(view.root.querySelector('.vf-monitor-spend-back')).toBeNull();
  });

  it('says so when there is nothing to draw, in its own words and its own class', async () => {
    const view = await mount();
    expect(view.root.querySelector('.vf-monitor-spend-empty')?.textContent).toBe(
      'NO ACTIVE AGENTS' + 'Launch an agent from a terminal pane.',
    );
    expect(view.root.querySelector('.vf-monitor-empty')).toBeNull();
  });
});

describe('the spend view’s motion', () => {
  it('waves a waiting head on the frame loop while motion is on', async () => {
    const view = await mount({ agents: afternoon() });
    expect(view.view.dataset.motion).toBe('on');
    expect(frames.pending).toBeGreaterThan(0);
    calls.length = 0;
    await act(async () => frames.step(4));
    // Two heads wait (a question and a permission) and one reply is unseen: their rings move.
    expect(calls.filter((call) => call.op === 'arc').length).toBeGreaterThan(0);
    expect(frames.pending).toBeGreaterThan(0);
  });

  it('still (animations off, or motion reduced) it asks for no frame and nothing glides', async () => {
    for (const theme of [fixtureTheme('dark', { animations: false }), fixtureTheme('dark', { reducedMotion: true })]) {
      const view = await mount({ agents: afternoon(), theme });
      await act(async () => frames.step(3));
      expect(frames.pending).toBe(0);
      expect(view.view.dataset.motion).toBe('off');
      await act(async () => view.instance.unmount());
      mounted.splice(mounted.indexOf(view), 1);
      view.root.remove();
      restore();
      restore = () => undefined;
    }
  });

  it('starts the loop when motion comes back, and stops it when it goes', async () => {
    const view = await mount({ agents: afternoon(), theme: fixtureTheme('dark', { animations: false }) });
    await act(async () => frames.step(2));
    expect(frames.pending).toBe(0);
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: afternoon(), theme: fixtureTheme('dark') }));
    expect(frames.pending).toBeGreaterThan(0);
    await view.update(
      fixtureInput({
        parameters: PARAMETERS,
        agents: afternoon(),
        theme: fixtureTheme('dark', { reducedMotion: true }),
      }),
    );
    await act(async () => frames.step(3));
    expect(frames.pending).toBe(0);
  });
});

describe('the view on its root', () => {
  it('scopes its stylesheet under its root class, and sets its own properties from its input (L18)', async () => {
    const stage = fixtureStage('default');
    const theme = fixtureTheme('dark');
    const view = await mount({ agents: afternoon(), stage, theme });
    expect(view.root.classList.contains(SPEND_ROOT_CLASS)).toBe(true);
    const style = view.view.style;
    expect(style.getPropertyValue('--mv-spend-inset-left')).toBe(`${stage.insets.left}px`);
    expect(style.getPropertyValue('--mv-spend-inset-top')).toBe('0px');
    expect(style.getPropertyValue('--mv-spend-list')).toBe('316px');
    expect(style.getPropertyValue('--mv-spend-select')).toBe(theme.tokens.swarm.blue);
    expect(style.getPropertyValue('--mv-spend-deep')).toBe(theme.tokens.stage);
    expect(style.getPropertyValue('--mv-spend-orange-ink')).toMatch(/^rgba\(/);
    expect(style.getPropertyValue('--mv-spend-green-ink')).toMatch(/^rgba\(/);
    expect(view.view.dataset.ground).toBe('dark');
    const row = rowOf(view.root, 'vibe-field');
    expect(row.style.getPropertyValue('--mv-spend-key')).toMatch(/^rgba\(/);
  });

  it('starts below the stage’s top inset, where a host keeps chrome over the stage (M58)', async () => {
    // VibeField's claims strip sits over the stage's top, and its stage says so as `insets.top`; puppeteer's passes 0.
    const compact = fixtureStage('compact');
    const view = await mount({ agents: afternoon(), stage: { ...compact, insets: { ...compact.insets, top: 40 } } });
    expect(view.view.style.getPropertyValue('--mv-spend-inset-top')).toBe('40px');
  });

  it('draws at the stage’s size until its root is laid out', async () => {
    const stage = fixtureStage('default');
    const view = await mount({ agents: afternoon(), stage }, { width: 0, height: 0 });
    // The list's column sits at the right of the stage past its chrome: 1280 − 216 wide, 316 px from its right.
    const head = view.root.querySelector<HTMLElement>('.vf-monitor-spend-head')!;
    const g = geometryFor(stage.width - stage.insets.left, stage.height);
    expect(head.style.transform).toBe(`translate(${g.lx0}px, ${g.ly0}px)`);
  });

  it('declares what it is to the bar and the audit: its mark, its keys, a clock at rest', () => {
    expect(SPEND_MANIFEST).toMatchObject({ id: 'spend', label: 'SPEND', sdk: 1, motion: { loops: true } });
    // A line climbing to a now line, its head a dot: the filled outlines of the 1.6 strokes, and the dot a disc (MV-D6).
    expect(SPEND_MANIFEST.mark.viewBox).toBe('0 0 24 24');
    expect(SPEND_MANIFEST.mark.paths).toHaveLength(3);
    expect(SPEND_MANIFEST.mark.paths[1]).toBe('M19.7 4L19.7 20A0.8 0.8 0 0 0 21.3 20L21.3 4A0.8 0.8 0 0 0 19.7 4Z');
    expect(SPEND_MANIFEST.mark.paths[2]).toBe('M14.8 9A2.2 2.2 0 1 0 19.2 9A2.2 2.2 0 1 0 14.8 9Z');
    expect(SPEND_MANIFEST.mark.paths[0]!.match(/M/g)).toHaveLength(3);
    expect(SPEND_MANIFEST.keys).toEqual([
      { key: 'ArrowUp', label: 'the agent above' },
      { key: 'ArrowDown', label: 'the agent below' },
      { key: 'Enter', label: 'open the agent in your pane' },
      { key: 'End', label: 'let go of a set moment (Now)' },
    ]);
  });
});

describe('a line is its row alone (runtime only)', () => {
  it('draws a priced row from its cost alone, and keeps nothing a row said before', async () => {
    const steps = [...new Array<number>(18).fill(0), 0.2, 0];
    const lastStepAt = Math.floor(NOW / 30_000) * 30_000;
    const row = agentViewFixture({
      id: 'a',
      project: { name: 'solo', seq: 0 },
      status: 'working',
      createdAt: NOW - 60 * MIN,
      cost: { usd: 1.25, coverage: 'complete', series: { stepMs: 30_000, steps, lastStepAt } },
    });
    const view = await mount({ agents: [row] });
    expect(figure(rowOf(view.root, 'a'))).toBe('~$1.25');
    // A model that drops its series leaves a total alone: the row keeps its total, the chart its nothing.
    const bare = { ...row, cost: { usd: 1.25, coverage: 'complete' as const } };
    await view.update(fixtureInput({ parameters: PARAMETERS, agents: [bare] }));
    expect(figure(rowOf(view.root, 'a'))).toBe('~$1.25');
  });
});

// At a size, so the suite's every mount really lays out and paints, and the still cases prove the view itself asks for
// no next frame.
describe('at a size to draw at', () => {
  beforeAll(() => {
    size = { width: 1064, height: 320 };
  });
  afterAll(() => {
    size = { width: 0, height: 0 };
  });
  runConformance(spendMonitorView);
});
