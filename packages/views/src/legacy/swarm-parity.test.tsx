// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  MonitorModel,
  MonitorSpawnMenu,
  MonitorSpawnTarget,
  MonitorViewInstance,
  StageGeometry,
} from '@vibecook/puppeteer-view-sdk';
import {
  agentViewFixture,
  countingCommands,
  fixtureModel,
  fixtureTheme,
  parameterDefaults,
} from '@vibecook/puppeteer-view-sdk/testing';
import { detailLine } from '@vibecook/puppeteer-view-sdk/toolkit';
import { labModel, LAB_DEVICE } from '../lab/lab-model.js';
import { LAB_NOW_MS, seededRandom } from '../lab/lab-world.js';
import { MONITOR_CHROME_ATTRIBUTE, MONITOR_STAGE_CLASS } from '../monitor/chrome.js';
import type { MonitorPalette } from '../monitor/palette.js';
import type { MonitorAgent } from '../monitor/types.js';
import { BLOOM_SCENARIOS } from '../views/swarm/bloom/scenarios.js';
import { bodyIdOf } from '../views/swarm/body-id.js';
import type { RenderBody, SwarmFrame } from '../views/swarm/gpu/swarm-renderer.js';
import { SWARM_MANIFEST, swarmMonitorView } from '../views/swarm/index.js';
import { SwarmPhysicsProvider } from '../views/swarm/physics/context.js';
import { createInlineSwarmPhysicsDriver } from '../views/swarm/physics/inline-driver.js';
import { AgentSwarm as LegacySwarm } from './frozen/swarm/AgentSwarm.js';
import { toMonitorAgent, toMonitorAgents, type LegacyShimOptions } from './index.js';

// PARITY ACROSS BOTH HOSTS (MV-5, design-mv §5: no regressions). The ported
// swarm and its legacy self (`frozen/swarm`, as it shipped) draw the same model
// over the same frames, the legacy one through the shim under a host's options,
// exactly as the view host's bridge fed it; the inline physics step on the same
// fake frames from the same seed, and a paint spy records what each hands its
// renderer. Everything must match but the differences named here, and each named
// difference is asserted to be exactly what it is:
//
//   - Godview's options (`headline-cost`, `map`): only M4's line, where the swarm
//     shows it — a body's title (the tooltip) and its accessible name; nothing
//     on the canvas carries it, so the frames' models differ in those two keys
//     and nothing else;
//   - VibeField's options (`reply-first`, `omit`): only M9's peers, which now
//     draw the facts the model carries. Said exactly: the ported swarm draws what
//     the legacy drew with a peer's facts MAPPED (`reply-first`, `map`), frame for
//     frame and model for model, and only peers' bodies separate `omit` from `map`;
//   - in either, the view's own custom properties and class under their L18
//     names, and the field focusable (MV-D8).
//
// This is mv5-vf's early warning: a change to the swarm that VibeField would see
// fails here first.

const { paint } = vi.hoisted(() => ({ paint: vi.fn<(frame: SwarmFrame) => void>() }));
vi.mock('../views/swarm/gpu/swarm-renderer.js', async (original) => ({
  ...(await original<object>()),
  createSwarmRenderer: async () => ({
    ok: true,
    renderer: { render: paint, resize: () => {}, destroy: () => {}, lost: new Promise(() => {}) },
  }),
}));

const GODVIEW: LegacyShimOptions = { detail: 'headline-cost', peerMonitor: 'map' };
const VIBEFIELD: LegacyShimOptions = { detail: 'reply-first', peerMonitor: 'omit' };
/** What the ported swarm draws, said in the shim's terms: VibeField's line, every fact mapped. */
const PORTED_AS_SHIM: LegacyShimOptions = { detail: 'reply-first', peerMonitor: 'map' };

const theme = fixtureTheme('light');
const palette = theme.tokens as MonitorPalette;
const parameters = parameterDefaults(SWARM_MANIFEST);
const WIDTH = 1180;
const HEIGHT = 252;
/** Godview's usage column as the host measures it: the chrome the legacy swarm read off the DOM, the stage the
 * ported one is handed (MV-D19). */
const CHROME = { x: 13, y: 11, width: 46, height: HEIGHT - 17 };
const STAGE: StageGeometry = {
  width: WIDTH,
  height: HEIGHT,
  insets: { top: 0, right: 0, bottom: 0, left: CHROME.x + CHROME.width },
  obstacles: [CHROME],
};
const LAPTOP = { id: 'desk-2', name: 'Laptop', os: 'linux', self: false } as const;
const BEFORE = 45;
const AFTER = 45;

/** The seeded world, plus what it lacks: runs nothing drives yet, a peer's terminal, a peer asking a question. */
function parityModel(churn = false): MonitorModel {
  const world = labModel({ n: 20, churn });
  const extra: AgentView[] = [
    agentViewFixture({
      id: 'pending-here',
      device: LAB_DEVICE,
      observed: false,
      pending: true,
      detail: 'unobserved · resumes when idle',
      project: { name: 'paused', seq: 3 },
      provider: { id: 'codex', label: 'Codex' },
      createdAt: 1,
    }),
    agentViewFixture({
      id: 'pending-peer',
      device: LAPTOP,
      observed: false,
      pending: true,
      project: { name: 'remote-paused' },
      provider: { id: 'claude', label: 'Claude' },
      model: 'Opus 5.5',
      account: 'team',
      context: { usedPercent: 33 },
      createdAt: 2,
    }),
    agentViewFixture({
      id: 'asking-peer',
      device: LAPTOP,
      status: 'blocked',
      wait: { kind: 'question', since: 3, header: 'Deploy', question: 'Ship it?' },
      reply: { text: 'Ready when you are.' },
      effort: { value: 'high', intent: 'configured' },
      cost: { usd: 2.5, coverage: 'complete', burnPerHour: 6 },
      project: { name: 'release', branch: 'main' },
      provider: { id: 'claude', label: 'Claude' },
      model: 'Sonnet 4.5',
      account: 'ops',
      context: { usedPercent: 71.9 },
      createdAt: 3,
    }),
    agentViewFixture({
      id: 'peer-shell',
      kind: 'terminal',
      device: LAPTOP,
      project: { name: 'notes' },
      detail: 'Unassigned terminal',
      writable: false,
      createdAt: 4,
    }),
  ];
  return fixtureModel([...world.agents, ...extra]);
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One run: a fresh clock, the same seed, Godview's geometry by hand (happy-dom lays nothing out). Returns the
 * teardown, so two runs in one test never share a clock or a document. */
function arrange(): () => Promise<void> {
  const mark = cleanups.length;
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
    now: LAB_NOW_MS,
  });
  // One seeded stream for both the physics' spawns and the bodies' seeds. React's act() queue draws a random of its
  // own (`enqueueTask`, the development build); it is not the view's and must not move the stream.
  const stream = seededRandom('mv5-parity:random');
  vi.spyOn(Math, 'random').mockImplementation(() =>
    (new Error().stack ?? '').includes('react.development') ? 0.5 : stream(),
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => WIDTH);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => HEIGHT);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
    return this.hasAttribute(MONITOR_CHROME_ATTRIBUTE)
      ? new DOMRect(CHROME.x, CHROME.y, CHROME.width, CHROME.height)
      : new DOMRect(0, 0, WIDTH, HEIGHT);
  });
  paint.mockClear();
  cleanups.push(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  return async () => {
    for (const cleanup of cleanups.splice(mark).reverse()) await cleanup();
  };
}

function element(): HTMLDivElement {
  const root = document.createElement('div');
  document.body.append(root);
  cleanups.push(() => root.remove());
  return root;
}

async function frames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }
}

interface Mounted {
  readonly root: HTMLDivElement;
  /** The field's section. */
  readonly field: () => HTMLElement;
  update(model: MonitorModel): Promise<void>;
  readonly created: unknown[];
}

/** The legacy swarm as the bridge mounted it: its own root, the shim's rows, the stage's chrome beside it. */
async function mountLegacy(
  model: MonitorModel,
  options: LegacyShimOptions,
  spawnMenu?: MonitorSpawnMenu,
): Promise<Mounted> {
  const root = element();
  const created: unknown[] = [];
  let react!: Root;
  const render = (current: MonitorModel): void => {
    react.render(
      createElement(
        'section',
        { className: MONITOR_STAGE_CLASS },
        createElement(
          SwarmPhysicsProvider,
          { factory: createInlineSwarmPhysicsDriver },
          createElement(LegacySwarm, {
            agents: [...toMonitorAgents(current, options)],
            parameters,
            palette,
            actions: {
              select: () => undefined,
              createAt: (at?: { x: number; y: number }, target?: MonitorSpawnTarget) =>
                void created.push({ ...(at ? { at } : {}), ...(target ? { target } : {}) }),
            },
            ...(spawnMenu ? { spawnMenu } : {}),
          }),
        ),
        createElement('div', { className: 'vf-monitor-chrome', [MONITOR_CHROME_ATTRIBUTE]: '' }),
      ),
    );
  };
  await act(async () => {
    react = createRoot(root);
    render(model);
  });
  cleanups.push(() => act(async () => react.unmount()));
  return {
    root,
    field: () => root.querySelector<HTMLElement>('.vf-monitor-swarm')!,
    update: (current) => act(async () => render(current)),
    created,
  };
}

async function mountPorted(
  model: MonitorModel,
  spawn?: MonitorSpawnMenu,
): Promise<Mounted & { reports: readonly unknown[] }> {
  const root = element();
  const { commands, reports, creates } = countingCommands();
  const input = (current: MonitorModel) => ({
    model: current,
    changes: { added: [], updated: [], removed: [] },
    stage: STAGE,
    theme,
    parameters,
    capabilities: spawn ? { spawn } : {},
  });
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = swarmMonitorView.mount(root, input(model), commands);
  });
  cleanups.push(() => act(async () => instance.unmount()));
  return {
    root,
    field: () => root.querySelector<HTMLElement>('.vf-monitor-swarm')!,
    update: (current) => act(async () => instance.update(input(current))),
    created: creates as unknown[],
    reports,
  };
}

/** A frame as the comparison reads it: its numbers rounded as the goldens round them, the model whole. */
function projection(frame: SwarmFrame) {
  const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    time: round(frame.time, 4),
    motion: frame.motion,
    veil: frame.veil ?? 0,
    hold: frame.hold ?? null,
    clearings: frame.clearings?.length ?? 0,
    bodies: frame.bodies.map((body: RenderBody) => ({
      id: body.model.id,
      x: round(body.x, 2),
      y: round(body.y, 2),
      radius: round(body.radius, 2),
      scale: round(body.scale, 3),
      opacity: round(body.opacity, 3),
      focus: body.focus,
      seed: round(body.seed, 4),
      accent: body.accent.map((channel) => round(channel, 3)),
      link: body.link?.map((channel) => round(channel, 3)) ?? null,
      above: body.aboveClearings === true,
      model: body.model,
    })),
  };
}
type Frame = ReturnType<typeof projection>;
interface Sequence {
  readonly frames: Frame[];
  /** The first frame drawn after the world moved on. */
  readonly changedAt: number;
}

/** Mount, step, move the world on, step again: every frame the swarm handed its renderer. */
async function sequence(mount: (model: MonitorModel) => Promise<Mounted>): Promise<Sequence> {
  const teardown = arrange();
  const mounted = await mount(parityModel());
  await frames(BEFORE);
  const changedAt = paint.mock.calls.length;
  await mounted.update(parityModel(true));
  await frames(AFTER);
  const recorded = paint.mock.calls.map(([frame]) => projection(frame));
  await teardown();
  return { frames: recorded, changedAt };
}

/** The row a body draws in a frame: the world before the change, or after it. */
function rowsByFrame(sequenceOf: Sequence): (index: number, bodyId: string) => AgentView {
  const before = new Map(parityModel().agents.map((row) => [bodyIdOf(row), row]));
  const after = new Map(parityModel(true).agents.map((row) => [bodyIdOf(row), row]));
  return (index, bodyId) => (index < sequenceOf.changedAt ? before : after).get(bodyId)!;
}

/** The line's own slots, folded: the title's ` · <line>` and the accessible name's `: <line>,`. The slot, not the first
 * occurrence of the words: a reply-first line that is just the status word would otherwise fold the status itself. */
const foldTitle = (title: string, detail: string): string => title.replace(` · ${detail}`, ' · «detail»');
const foldAria = (label: string, detail: string): string => label.replace(`: ${detail},`, ': «detail»,');

/** A model with its title and accessible name read with `detail` folded, so two lines can be compared. */
function foldDetail<T extends { title: string; ariaLabel: string }>(model: T, detail: string): T {
  return { ...model, title: foldTitle(model.title, detail), ariaLabel: foldAria(model.ariaLabel, detail) };
}

describe('the swarm: legacy and ported, frame for frame', () => {
  it('under VibeField’s options with every fact mapped, hands its renderer identical frames', async () => {
    const legacy = await sequence((model) => mountLegacy(model, PORTED_AS_SHIM));
    const ported = await sequence((model) => mountPorted(model));
    expect(ported.frames.length).toBeGreaterThanOrEqual(BEFORE + AFTER - 2);
    expect(ported.frames.length).toBe(legacy.frames.length);
    expect(ported.changedAt).toBe(legacy.changedAt);
    expect(ported.frames.at(-1)?.bodies.map((body) => body.id)).toContain('late-arrival');
    expect(ported.frames).toEqual(legacy.frames);
  }, 60_000);

  it('under Godview’s options, draws the same but M4’s line where the swarm shows it: a body’s title and accessible name', async () => {
    const legacy = await sequence((model) => mountLegacy(model, GODVIEW));
    const ported = await sequence((model) => mountPorted(model));
    expect(ported.frames.length).toBe(legacy.frames.length);
    expect(ported.changedAt).toBe(legacy.changedAt);
    const rowOf = rowsByFrame(ported);
    let changed = 0;
    let bodies = 0;
    for (const [index, frame] of ported.frames.entries()) {
      const before = legacy.frames[index]!;
      const { bodies: portedBodies, ...portedRest } = frame;
      const { bodies: legacyBodies, ...legacyRest } = before;
      expect(portedRest).toEqual(legacyRest);
      expect(portedBodies.length).toBe(legacyBodies.length);
      for (const [at, body] of portedBodies.entries()) {
        const twin = legacyBodies[at]!;
        const row = rowOf(index, body.id);
        const { model: portedModel, ...portedBody } = body;
        const { model: legacyModel, ...legacyBody } = twin;
        expect(portedBody).toEqual(legacyBody);
        bodies += 1;
        const shimDetail = toMonitorAgent(row, GODVIEW).detail;
        const after = detailLine(row);
        if (portedModel.title !== legacyModel.title) {
          // Godview's old line always ended in the cost's words; reply-first never says them: every agent's line moves.
          expect(row.kind).toBe('agent');
          expect(legacyModel.title.includes(shimDetail)).toBe(true);
          expect(portedModel.title.includes(after)).toBe(true);
          changed += 1;
        } else {
          expect(row.kind).toBe('terminal');
        }
        expect(foldDetail(portedModel, after)).toEqual(foldDetail(legacyModel, shimDetail));
      }
    }
    expect(bodies).toBeGreaterThan(1000);
    expect(changed).toBeGreaterThan(500);
  }, 60_000);

  it('under VibeField’s options, differs from the legacy only on peers’ bodies, which draw their facts now (M9)', async () => {
    const omitted = (await sequence((model) => mountLegacy(model, VIBEFIELD))).frames;
    const mapped = (await sequence((model) => mountLegacy(model, PORTED_AS_SHIM))).frames;
    const peers = new Set(
      [...parityModel().agents, ...parityModel(true).agents].filter((row) => !row.device.self).map(bodyIdOf),
    );
    expect(peers.size).toBeGreaterThanOrEqual(5);
    let separated = 0;
    for (const [index, frame] of mapped.entries()) {
      const before = omitted[index]!;
      const { bodies: mappedBodies, ...mappedRest } = frame;
      const { bodies: omittedBodies, ...omittedRest } = before;
      expect(mappedRest).toEqual(omittedRest);
      for (const [at, body] of mappedBodies.entries()) {
        const twin = omittedBodies[at]!;
        if (JSON.stringify(body) === JSON.stringify(twin)) continue;
        // only a peer's body separates the two, and only in what its model says: its place is the same
        expect(peers.has(body.id)).toBe(true);
        const { model: a, ...bodyA } = body;
        const { model: b, ...bodyB } = twin;
        expect(bodyA).toEqual(bodyB);
        expect(a).not.toEqual(b);
        separated += 1;
      }
    }
    expect(separated).toBeGreaterThan(0);
  }, 60_000);
});

/** An element's style as sorted `name: value` declarations, custom properties included. */
function styleOf(node: Element): string[] {
  const style = (node as HTMLElement).style;
  const declarations: string[] = [];
  for (let index = 0; index < style.length; index += 1) {
    const name = style.item(index);
    declarations.push(`${name}: ${style.getPropertyValue(name).trim()}`);
  }
  return declarations.sort();
}

/** The DOM under a node as text: tags, attributes (sorted; style as its sorted declarations) and text. */
function serialize(node: Node, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) return node.textContent ? [`${pad}"${node.textContent}"`] : [];
  if (node.nodeType !== 1) return [];
  const el = node as Element;
  const attributes = [...el.attributes]
    .filter((attribute) => attribute.name !== 'style')
    .map((attribute) => `${attribute.name}="${attribute.value}"`)
    .sort();
  const style = styleOf(el);
  if (style.length > 0) attributes.push(`style{${style.join('; ')}}`);
  // React's id prefix is the root's (`useId`); the bud's own part is what both draw.
  const folded = attributes.map((attribute) =>
    attribute.replace(/^((?:id|aria-activedescendant)=")[^"]*?-bud-\d+-/, '$1«root»-bud-«t»-'),
  );
  return [
    `${pad}<${el.tagName.toLowerCase()}${folded.length > 0 ? ` ${folded.join(' ')}` : ''}>`,
    ...[...el.childNodes].flatMap((child) => serialize(child, depth + 1)),
  ];
}

/** The legacy field's DOM with the port's own names folded in: L18's properties, the empty notice's class, the
 * renderer word the host used to read, and the field's own focusability. */
function foldLegacyField(field: HTMLElement): void {
  field.removeAttribute('data-swarm-renderer');
  field.setAttribute('tabindex', '-1');
  field.style.setProperty('--mv-swarm-ground', palette.timeline.ground);
  field.style.setProperty('--mv-swarm-orange', palette.swarm.orange);
  for (const empty of field.querySelectorAll('.vf-monitor-empty')) empty.className = 'vf-monitor-swarm-empty';
  for (const empty of field.querySelectorAll('[data-swarm-renderer]')) empty.removeAttribute('data-swarm-renderer');
  for (const styled of field.querySelectorAll<HTMLElement>('[style]')) {
    for (let index = styled.style.length - 1; index >= 0; index -= 1) {
      const name = styled.style.item(index);
      if (!name.startsWith('--vf-bloom-')) continue;
      const value = styled.style.getPropertyValue(name);
      styled.style.removeProperty(name);
      styled.style.setProperty(name.replace('--vf-bloom-', '--mv-swarm-bloom-'), value);
    }
  }
}

describe('the swarm: legacy and ported, as markup', () => {
  async function both(options: LegacyShimOptions, spawn?: MonitorSpawnMenu) {
    arrange();
    const model = parityModel();
    const legacy = await mountLegacy(model, options, spawn);
    const ported = await mountPorted(model, spawn);
    await frames(3);
    // The port's own properties replace what the legacy read from the host: asserted, then folded.
    const field = ported.field();
    expect(field.style.getPropertyValue('--mv-swarm-ground')).toBe(palette.timeline.ground);
    expect(field.style.getPropertyValue('--mv-swarm-orange')).toBe(palette.swarm.orange);
    expect(field.getAttribute('tabindex')).toBe('-1');
    expect(legacy.field().getAttribute('data-swarm-renderer')).toBe('webgpu');
    expect(ported.reports).toContainEqual({ renderer: 'webgpu' });
    expect(ported.reports).toContainEqual({ physics: 'inline' });
    foldLegacyField(legacy.field());
    return { legacy, ported, model };
  }

  it('under Godview’s options, draws the same DOM but M4’s line in each body’s accessible name', async () => {
    const { legacy, ported, model } = await both(GODVIEW);
    const buttons = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-agent-bubble-id]')];
    expect(buttons(ported.root)).toHaveLength(model.agents.length);
    let changed = 0;
    for (const [index, button] of buttons(ported.root).entries()) {
      const before = buttons(legacy.root)[index]!;
      const row = model.agents.find((candidate) => bodyIdOf(candidate) === button.dataset.agentBubbleId)!;
      const shim = toMonitorAgent(row, GODVIEW).detail;
      const after = detailLine(row);
      const legacyLabel = before.getAttribute('aria-label')!;
      const portedLabel = button.getAttribute('aria-label')!;
      if (legacyLabel !== portedLabel) {
        expect(row.kind).toBe('agent');
        changed += 1;
      }
      before.setAttribute('aria-label', foldAria(legacyLabel, shim));
      button.setAttribute('aria-label', foldAria(portedLabel, after));
      // the hidden button's text is the body's title: folded the same way
      before.textContent = foldTitle(before.textContent!, shim);
      button.textContent = foldTitle(button.textContent!, after);
    }
    expect(changed).toBe(model.agents.filter((row) => row.kind === 'agent').length);
    expect(serialize(ported.field())).toEqual(serialize(legacy.field()));
  }, 30_000);

  it('under VibeField’s options with every fact mapped, draws the same DOM', async () => {
    const { legacy, ported } = await both(PORTED_AS_SHIM);
    expect(serialize(ported.field())).toEqual(serialize(legacy.field()));
  }, 30_000);

  it('with nothing to show, says the same in its own class', async () => {
    arrange();
    const legacy = await mountLegacy(fixtureModel([]), GODVIEW);
    const ported = await mountPorted(fixtureModel([]));
    await frames(2);
    foldLegacyField(legacy.field());
    expect(serialize(ported.field())).toEqual(serialize(legacy.field()));
    expect(ported.field().querySelector('.vf-monitor-swarm-empty')?.textContent).toContain('NO ACTIVE AGENTS');
  });

  it('opens the same bloom from the keys door, walks it and commits the same choice, holding the keys while open (MV-D8)', async () => {
    const menu = BLOOM_SCENARIOS.two;
    const { legacy, ported } = await both(PORTED_AS_SHIM, menu);
    const key = (target: Element, name: string) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
      });
    const bloom = (mounted: Mounted) => serialize(mounted.field().querySelector('.vf-bloom')!);
    // One at a time: two blooms open in one document would take the keyboard from each other.
    const walk = async (mounted: Mounted, fold: boolean) => {
      await act(async () => mounted.root.querySelector<HTMLButtonElement>('[data-swarm-new-terminal]')!.click());
      const menuElement = mounted.root.querySelector('[role="menu"]');
      expect(menuElement).not.toBeNull();
      expect(mounted.field().querySelector('.vf-bloom')?.getAttribute('data-bloom-mode')).toBe('keys');
      if (fold) foldLegacyField(mounted.field());
      const opened = bloom(mounted);
      for (const name of ['ArrowRight', 'Enter', 'Enter']) await key(menuElement!, name);
      if (fold) foldLegacyField(mounted.field());
      const committed = bloom(mounted);
      await frames(2);
      return { opened, committed };
    };
    const before = await walk(legacy, true);
    const after = await walk(ported, false);
    expect(after.opened).toEqual(before.opened);
    expect(after.committed).toEqual(before.committed);
    expect(ported.created).toEqual(legacy.created);
    expect(ported.created).toHaveLength(1);
    expect((ported.created[0] as { target: MonitorSpawnTarget }).target).toEqual({
      deviceId: 'mini',
      profileSet: 'native',
    });
    // the view said it held the keys while the bloom was open, and let go once it closed
    expect(ported.reports).toContainEqual({ keysHeld: true });
    expect(ported.reports.at(-1)).toEqual({ keysHeld: false });
  }, 30_000);
});

describe('the frozen swarm is the one that shipped', () => {
  it('reads the legacy row (the shim’s) and nothing of the model', () => {
    const row = toMonitorAgent(parityModel().agents[0]!, GODVIEW) as MonitorAgent;
    expect(row).toHaveProperty('createdAtMs');
    expect(row).not.toHaveProperty('createdAt');
  });
});
