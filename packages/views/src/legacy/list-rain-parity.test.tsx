// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentView,
  MonitorModel,
  MonitorSpawnMenu,
  MonitorView,
  MonitorViewInstance,
} from '@vibecook/puppeteer-view-sdk';
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
import { detailLine, formatPercent } from '@vibecook/puppeteer-view-sdk/toolkit';
import { labModel, LAB_DEVICE } from '../lab/lab-model.js';
import { seededRandom } from '../lab/lab-world.js';
import type { MonitorPalette } from '../monitor/palette.js';
import type { AgentMonitorProps, MonitorSpawnMenu as LegacySpawnMenu } from '../monitor/types.js';
import { LIST_MANIFEST, listMonitorView } from '../views/list/index.js';
import { RAIN_MANIFEST, rainMonitorView } from '../views/rain/index.js';
import { rainDataString, rainTailLength } from '../views/rain/rain-streams.js';
import { AgentList as LegacyList } from './frozen/AgentList.js';
import { RainView as LegacyRain } from './frozen/RainView.js';
import { rainDataString as legacyDataString, rainTailLength as legacyTailLength } from './frozen/rain-streams.js';
import { toMonitorAgent, toMonitorAgents, type LegacyShimOptions } from './index.js';

// PARITY ACROSS BOTH HOSTS (MV-4, design-mv §5: no regressions). Each ported
// view and its legacy self (`frozen/`, as it shipped) render the same model,
// the legacy one through the shim under a host's options, exactly as the view
// host's bridge fed it. Everything they draw must match but the differences
// named here, and each named difference is asserted to be exactly what it is:
//
//   - Godview's options (`headline-cost`, `map`): only M4's line under the name;
//   - VibeField's options (`reply-first`, `omit`): only M9's peers, which now
//     draw the facts the model carries (their context and account here);
//   - in either, the view's own custom properties under their L18 names, the
//     empty stage's own class, and the spawn menu's ids (M34).
//
// This is mv4-vf's early warning: a change to either view that VibeField would
// see fails here first.

const GODVIEW: LegacyShimOptions = { detail: 'headline-cost', peerMonitor: 'map' };
const VIBEFIELD: LegacyShimOptions = { detail: 'reply-first', peerMonitor: 'omit' };
const HOSTS = [
  ['puppeteer’s Godview', GODVIEW],
  ['VibeField', VIBEFIELD],
] as const;

const theme = fixtureTheme('dark');
const palette = theme.tokens as MonitorPalette;
const stage = fixtureStage('default');
const LAPTOP = { id: 'desk-2', name: 'Laptop', os: 'linux', self: false } as const;

/** The seeded world (every status, wait kind, kind, unread, receded, active and attachment, peers writable and
 * not, a starting run), plus what it lacks: runs nothing drives yet, a peer's terminal, a peer asking a question. */
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
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function element(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  cleanups.push(() => root.remove());
  return root;
}

/** The legacy view as the bridge mounted it: its own root, the shim's rows, the palette, no history. */
async function mountLegacy(
  Component: ComponentType<AgentMonitorProps>,
  model: MonitorModel,
  options: LegacyShimOptions,
  parameters: Readonly<Record<string, number>>,
  spawnMenu?: LegacySpawnMenu,
): Promise<HTMLElement> {
  const root = element();
  // As the host's stage published it, for the legacy list's padding.
  root.style.setProperty('--vf-monitor-chrome-right', `${stage.insets.left}px`);
  let react!: Root;
  await act(async () => {
    react = createRoot(root);
    react.render(
      createElement(Component, {
        agents: [...toMonitorAgents(model, options)],
        parameters,
        actions: { select: () => undefined, createAt: () => undefined },
        palette,
        ...(spawnMenu ? { spawnMenu } : {}),
      }),
    );
  });
  cleanups.push(() => act(() => react.unmount()));
  return root;
}

async function mountPorted(
  view: MonitorView,
  model: MonitorModel,
  parameters: Readonly<Record<string, number>>,
  spawn?: MonitorSpawnMenu,
): Promise<HTMLElement> {
  const root = element();
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = view.mount(
      root,
      fixtureInput({ model, stage, theme, parameters, ...(spawn ? { capabilities: { spawn } } : {}) }),
      countingCommands().commands,
    );
  });
  cleanups.push(() => act(() => instance.unmount()));
  return root;
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

/** Renames a legacy row's / section's own custom properties to their L18 names (values untouched). */
function renameLegacyProperties(root: HTMLElement): void {
  const renames: Readonly<Record<string, string>> = {
    '--vf-monitor-row-height': '--mv-list-row-height',
    '--vf-monitor-project-width': '--mv-list-project-width',
    '--agent-color': '--mv-list-colour',
  };
  for (const element of root.querySelectorAll<HTMLElement>('[style]')) {
    for (const [from, to] of Object.entries(renames)) {
      const value = element.style.getPropertyValue(from);
      if (!value) continue;
      element.style.removeProperty(from);
      element.style.setProperty(to, value);
    }
    // Set by the legacy list for nobody: no rule read them. Gone in the port.
    for (const unread of ['--vf-monitor-working', '--vf-monitor-blocked', '--vf-monitor-idle']) {
      element.style.removeProperty(unread);
    }
  }
}

describe('the list: legacy and ported, over one model', () => {
  const parameters = parameterDefaults(LIST_MANIFEST);

  /** The two DOMs, with the differences every host shares already asserted and folded: L18's properties. */
  async function both(model: MonitorModel, options: LegacyShimOptions) {
    const legacy = await mountLegacy(LegacyList, model, options, parameters);
    const ported = await mountPorted(listMonitorView, model, parameters);
    renameLegacyProperties(legacy);
    // The port's two new properties replace what the legacy read from the host: the stage's inset (once
    // --vf-monitor-chrome-right) and the palette's blocked (once --vf-orange). Asserted, then folded.
    const section = ported.querySelector<HTMLElement>('.vf-monitor-list')!;
    expect(section.style.getPropertyValue('--mv-list-inset-left')).toBe(`${stage.insets.left}px`);
    expect(section.style.getPropertyValue('--mv-list-blocked')).toBe(palette.status.blocked);
    section.style.removeProperty('--mv-list-inset-left');
    section.style.removeProperty('--mv-list-blocked');
    const rowsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.vf-monitor-list-row')];
    expect(rowsOf(ported)).toHaveLength(model.agents.length);
    expect(rowsOf(legacy)).toHaveLength(model.agents.length);
    return { legacy, ported, rows: { legacy: rowsOf(legacy), ported: rowsOf(ported) } };
  }

  /** The row each button draws, by its project and aria-label, in the order both views sort. */
  const viewOfRow = (model: MonitorModel, row: HTMLElement, ported: readonly HTMLElement[]): AgentView => {
    const index = ported.indexOf(row);
    const ids = [...model.agents]
      .map((agent) => agent)
      .sort((left, right) => {
        if (left.receded !== right.receded) return left.receded ? 1 : -1;
        if ((left.kind === 'agent') !== (right.kind === 'agent')) return left.kind === 'agent' ? -1 : 1;
        const order = { blocked: 0, working: 1, idle: 2 } as const;
        const byStatus = order[left.status] - order[right.status];
        return byStatus !== 0 ? byStatus : left.createdAt - right.createdAt;
      });
    return ids[index]!;
  };

  it('under Godview’s options, draws the same but M4’s line under the name, which is reply-first now', async () => {
    const model = parityModel();
    const { legacy, ported, rows } = await both(model, GODVIEW);
    let changed = 0;
    for (const [index, row] of rows.ported.entries()) {
      const view = viewOfRow(model, row, rows.ported);
      const before = rows.legacy[index]!;
      const shim = toMonitorAgent(view, GODVIEW).detail;
      const after = detailLine(view);
      expect(before.querySelector('.vf-monitor-list-detail')?.textContent).toBe(shim);
      expect(row.querySelector('.vf-monitor-list-detail')?.textContent).toBe(after);
      expect(before.getAttribute('aria-label')?.endsWith(`: ${shim}`)).toBe(true);
      expect(row.getAttribute('aria-label')?.endsWith(`: ${after}`)).toBe(true);
      // Godview's old line always ended in the cost's words, reply-first never says them: every agent's line moves,
      // and no terminal's (both say the backend's own line for one).
      expect(shim !== after).toBe(view.kind === 'agent');
      if (shim !== after) changed += 1;
      // Folded: the line, in the cell and at the end of the row's name.
      for (const [cell, button, text] of [
        [before.querySelector('.vf-monitor-list-detail')!, before, shim],
        [row.querySelector('.vf-monitor-list-detail')!, row, after],
      ] as const) {
        cell.textContent = '«detail»';
        const label = button.getAttribute('aria-label')!;
        button.setAttribute('aria-label', `${label.slice(0, label.length - text.length)}«detail»`);
      }
    }
    expect(changed).toBe(model.agents.filter((agent) => agent.kind === 'agent').length);
    expect(tree(ported)).toEqual(tree(legacy));
  });

  it('under VibeField’s options, draws the same but M9: a peer’s row now shows its context and account', async () => {
    const model = parityModel();
    const { legacy, ported, rows } = await both(model, VIBEFIELD);
    let peers = 0;
    for (const [index, row] of rows.ported.entries()) {
      const view = viewOfRow(model, row, rows.ported);
      const before = rows.legacy[index]!;
      // The line under the name was VibeField's rule already: the same, peers included.
      expect(row.querySelector('.vf-monitor-list-detail')?.textContent).toBe(
        before.querySelector('.vf-monitor-list-detail')?.textContent,
      );
      if (view.device.self || view.kind !== 'agent') continue;
      peers += 1;
      // M9: the context column says the peer's context; the account stands beside its model, and in its name.
      expect(before.querySelector('.vf-monitor-list-context')?.textContent).toBe('—');
      expect(row.querySelector('.vf-monitor-list-context')?.textContent).toBe(formatPercent(view.context?.usedPercent));
      row.querySelector('.vf-monitor-list-context')!.textContent = '—';
      const account = row.querySelector('.vf-monitor-list-agent small');
      expect(account?.textContent ?? undefined).toBe(view.account);
      expect(before.querySelector('.vf-monitor-list-agent small')).toBeNull();
      account?.remove();
      if (view.account) {
        const label = row.getAttribute('aria-label')!;
        expect(label).toContain(`, ${view.account}, ${view.status}`);
        row.setAttribute('aria-label', label.replace(`, ${view.account}, ${view.status}`, `, ${view.status}`));
      }
    }
    expect(peers).toBeGreaterThanOrEqual(4);
    expect(tree(ported)).toEqual(tree(legacy));
  });

  it('with nothing to show, says the same in its own class', async () => {
    for (const [, options] of HOSTS) {
      const model = fixtureModel([]);
      const { legacy, ported } = await both(model, options);
      const empty = legacy.querySelector('.vf-monitor-empty')!;
      expect(ported.querySelector('.vf-monitor-empty')).toBeNull();
      empty.className = 'vf-monitor-list-empty';
      expect(tree(ported)).toEqual(tree(legacy));
    }
  });

  it('opens the same spawn menu from VibeField’s tree and the backend’s: "This desktop" keyed on self (M34)', async () => {
    const profiles = [
      { id: 'native', label: 'This Mac', kind: 'native', isDefault: true, signedIn: ['Claude'] },
      { id: 'work', label: 'Work', kind: 'managed', glyph: 'briefcase', blocked: true, signedIn: ['Codex'] },
    ] as const;
    // VibeField's own tree today (spawn-menu.ts: id `here`, "This desktop"), and the backend's: the real desktop.
    const vibefield: LegacySpawnMenu = {
      devices: [{ id: 'here', label: 'This desktop', self: true, state: 'ready', profiles: [...profiles] }],
    };
    const backend: MonitorSpawnMenu = {
      devices: [{ id: 'mbp-7', label: 'Studio', self: true, state: 'ready', profiles: [...profiles] }],
    };
    const model = fixtureModel([agentViewFixture({ id: 'a' })]);
    const legacy = await mountLegacy(LegacyList, model, VIBEFIELD, parameters, vibefield);
    const ported = await mountPorted(listMonitorView, model, parameters, backend);
    for (const root of [legacy, ported]) {
      await act(async () => root.querySelector<HTMLButtonElement>('.vf-monitor-list-new')!.click());
      expect(root.querySelector('[role="menu"]')).not.toBeNull();
    }
    const menu = (root: HTMLElement) => serialize(root.querySelector('[role="menu"]')!);
    // The one difference: the desktop's id, which only ever names it to the host (targets key on self).
    expect(menu(ported).map((line) => line.replaceAll('"mbp-7"', '"here"'))).toEqual(menu(legacy));
    expect(menu(ported).join('\n')).toContain('Profile on This desktop');
  });
});

describe('the list’s spawn menu: legacy and ported, step for step', () => {
  const parameters = parameterDefaults(LIST_MANIFEST);
  const PROFILES = [
    { id: 'native', label: 'This Mac', kind: 'native', isDefault: true, signedIn: ['Claude'] },
    { id: 'work', label: 'Work', kind: 'managed', glyph: 'briefcase', signedIn: ['Codex'] },
    { id: 'demo', label: 'Demo', kind: 'managed', glyph: 'flask' },
  ] as const;
  const MINI = {
    id: 'mini',
    label: 'mini',
    state: 'ready',
    word: '2 RUNNING',
    profiles: [{ id: 'native', label: 'This Mac', kind: 'native', isDefault: true }, PROFILES[1]],
  } as const;
  // VibeField's tree as its host builds it today (`here`, "This desktop"), and the backend's (the real desktop).
  const trees = (peers: boolean) => ({
    legacy: {
      devices: [
        { id: 'here', label: 'This desktop', self: true, state: 'ready', profiles: [...PROFILES] },
        ...(peers ? [MINI] : []),
      ],
    } as LegacySpawnMenu,
    ported: {
      devices: [
        { id: 'mbp-7', label: 'Studio', self: true, state: 'ready', profiles: [...PROFILES] },
        ...(peers ? [MINI] : []),
      ],
    } as MonitorSpawnMenu,
  });

  type Step =
    | 'open'
    | 'chrome'
    | 'row'
    | 'nothing'
    | 'trigger'
    | 'Escape'
    | 'Tab'
    | 'ArrowDown'
    | 'ArrowUp'
    | 'ArrowRight'
    | 'ArrowLeft'
    | 'Enter'
    | 'second profile';

  /** One host's list with its chrome beside it, driven by `steps`; after each, what a person could tell. */
  async function play(which: 'legacy' | 'ported', peers: boolean, steps: readonly Step[]): Promise<string[]> {
    const tree = trees(peers);
    const created: unknown[] = [];
    const model = fixtureModel([agentViewFixture({ id: 'a', project: { name: 'alpha' } })]);
    const root = element();
    const chrome = document.createElement('button');
    chrome.textContent = 'chrome';
    root.before(chrome);
    cleanups.push(() => chrome.remove());
    if (which === 'legacy') {
      let react!: Root;
      await act(async () => {
        react = createRoot(root);
        react.render(
          createElement(LegacyList, {
            agents: [...toMonitorAgents(model, VIBEFIELD)],
            parameters,
            actions: { select: () => undefined, createAt: (_at, target) => void created.push(target) },
            palette,
            spawnMenu: tree.legacy,
          }),
        );
      });
      cleanups.push(() => act(() => react.unmount()));
    } else {
      let instance!: MonitorViewInstance;
      const commands = {
        select: () => undefined,
        create: (_at?: unknown, target?: unknown) => {
          created.push(target);
          return Promise.resolve({ opened: true });
        },
        report: () => undefined,
      };
      await act(async () => {
        instance = listMonitorView.mount(
          root,
          fixtureInput({ model, stage, theme, parameters, capabilities: { spawn: tree.ported } }),
          commands,
        );
      });
      cleanups.push(() => act(() => instance.unmount()));
    }
    const trigger = () => root.querySelector<HTMLButtonElement>('.vf-monitor-list-new')!;
    const focused = (): string => {
      const active = root.ownerDocument.activeElement;
      if (active === trigger()) return 'the button';
      if (active === chrome) return 'the chrome';
      if (active === root.ownerDocument.body || active === null) return 'nothing';
      return active.getAttribute('aria-label') ?? active.className;
    };
    const press = async (target: Element, focus: HTMLElement | null): Promise<void> => {
      await act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        if (focus) focus.focus();
        else (root.ownerDocument.activeElement as HTMLElement | null)?.blur();
      });
    };
    const key = (name: string) =>
      act(async () => {
        root.ownerDocument.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
        );
      });
    const seen: string[] = [];
    for (const step of steps) {
      if (step === 'open') {
        await act(async () => trigger().focus());
        await act(async () => trigger().click());
      } else if (step === 'chrome') await press(chrome, chrome);
      else if (step === 'row')
        await press(root.querySelector('.vf-monitor-list-row')!, root.querySelector('.vf-monitor-list-row'));
      else if (step === 'nothing') await press(root.querySelector('.vf-monitor-list-count')!, null);
      else if (step === 'trigger') {
        await press(trigger(), trigger());
        await act(async () => trigger().click());
      } else if (step === 'Enter' || step === 'second profile') {
        const target =
          step === 'Enter'
            ? (root.ownerDocument.activeElement as HTMLElement)
            : root.querySelectorAll<HTMLElement>('[data-list-spawn-column="profiles"] [role="menuitem"]')[1]!;
        await act(async () => target.click());
      } else await key(step);
      const menu = root.querySelector('[role="menu"]');
      seen.push(
        `${step}: ${menu ? `open (${menu.getAttribute('data-list-spawn-step')})` : 'closed'}, focus on ${focused()}, ` +
          `asked ${JSON.stringify(created)}`,
      );
    }
    return seen;
  }

  const SCRIPT: readonly Step[] = [
    'open',
    'ArrowDown',
    'ArrowDown',
    'ArrowUp',
    'Escape',
    'open',
    'row',
    'open',
    'nothing',
    'open',
    'chrome',
    'open',
    'trigger',
    'open',
    'Tab',
    'open',
    'ArrowDown',
    'Enter',
    'open',
    'second profile',
  ];

  for (const peers of [false, true]) {
    it(`does what it did, step for step, ${peers ? 'with a peer to choose' : 'on one desktop'}`, async () => {
      const script: readonly Step[] = peers
        ? [...SCRIPT, 'open', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'Enter']
        : SCRIPT;
      const legacy = await play('legacy', peers, script);
      const ported = await play('ported', peers, script);
      // The one difference (M34): the desktop you sit at is asked for by leaving it out, never by an id.
      expect(ported).toEqual(legacy.map((line) => line.replaceAll('"deviceId":"here",', '')));
      expect(legacy.join('\n')).toContain('"deviceId":"here"');
    });
  }
});

describe('the rain: legacy and ported, over one model', () => {
  const parameters = parameterDefaults(RAIN_MANIFEST);

  // A stage with room for every column, a recording 2D context, one clock for frames and `performance.now()`, and
  // one seeded randomness: what both draw, call for call.
  interface Call {
    readonly op: string;
    readonly args: readonly unknown[];
    readonly state: string;
  }
  let calls: Call[] = [];
  const realGetContext = HTMLCanvasElement.prototype.getContext;
  const realRandom = Math.random;
  const sizes = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = function getContext() {
      const state: Record<string, unknown> = {};
      const snapshot = () =>
        ['fillStyle', 'globalAlpha', 'shadowBlur', 'shadowColor', 'font', 'textAlign']
          .map((key) => `${key}=${String(state[key])}`)
          .join(' ');
      return new Proxy(state, {
        get(target, key) {
          if (key === 'fillText' || key === 'fillRect' || key === 'setTransform') {
            return (...args: unknown[]) => calls.push({ op: key, args, state: snapshot() });
          }
          return target[key as string];
        },
        set(target, key, value) {
          target[key as string] = value;
          return true;
        },
      }) as unknown as CanvasRenderingContext2D;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => stage.width });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => stage.height });
  });
  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = realGetContext;
    for (const key of ['clientWidth', 'clientHeight'] as const) {
      if (sizes[key]) Object.defineProperty(HTMLElement.prototype, key, sizes[key]);
    }
  });

  /** Mounts one rain on a fresh clock and seed, steps it, and gives back what it drew and its DOM. */
  async function drawn(mount: () => Promise<HTMLElement>, frames = 90): Promise<{ root: HTMLElement; calls: Call[] }> {
    calls = [];
    const clock = createFixtureClock();
    const restoreClock = clock.install();
    const driver = createFrameDriver({ clock });
    const restoreFrames = driver.install();
    Math.random = seededRandom('mv4-parity:random');
    cleanups.push(() => {
      Math.random = realRandom;
      restoreFrames();
      restoreClock();
    });
    const root = await mount();
    await act(async () => driver.step(frames));
    return { root, calls };
  }

  it('under Godview’s options, draws every frame alike, call for call: the canvas has no line under a name', async () => {
    const model = parityModel();
    const legacy = await drawn(() => mountLegacy(LegacyRain, model, GODVIEW, parameters));
    const ported = await drawn(() => mountPorted(rainMonitorView, model, parameters));
    expect(legacy.calls.filter((call) => call.op === 'fillText').length).toBeGreaterThan(1000);
    expect(ported.calls).toEqual(legacy.calls);
  });

  it('under VibeField’s options, draws every frame alike where no peer stands', async () => {
    const model = fixtureModel(parityModel().agents.filter((agent) => agent.device.self));
    const legacy = await drawn(() => mountLegacy(LegacyRain, model, VIBEFIELD, parameters));
    const ported = await drawn(() => mountPorted(rainMonitorView, model, parameters));
    expect(ported.calls).toEqual(legacy.calls);
  });

  it('says every column as before, but M9: under VibeField’s options a peer’s column carries its context', () => {
    const model = parityModel();
    for (const [host, options] of HOSTS) {
      for (const view of model.agents) {
        const before = toMonitorAgent(view, options);
        const peerFacts = host === 'VibeField' && !view.device.self && view.kind === 'agent';
        const context = view.context?.usedPercent;
        if (peerFacts && context !== undefined) {
          const ctx = ` CTX ${Math.round(context).toString().padStart(2, '0')}% `;
          expect(legacyDataString(before).endsWith(ctx)).toBe(false);
          expect(rainDataString(view)).toBe(`${legacyDataString(before).trimEnd()}${ctx.trimEnd()} `);
          expect(rainTailLength(view, 21, 1, 10)).toBe(Math.max(Math.max(3, (context / 100) * 21 * 0.9), 16));
          expect(legacyTailLength(before, 21, 1, 10)).toBe(Math.max(Math.max(3, 0.5 * 21 * 0.9), 16));
          continue;
        }
        expect(rainDataString(view)).toBe(legacyDataString(before));
        expect(rainTailLength(view, 21, 1, 10)).toBe(legacyTailLength(before, 21, 1, 10));
        expect(rainTailLength(view, 4, 2.5, 30)).toBe(legacyTailLength(before, 4, 2.5, 30));
      }
    }
  });

  it('offers the same controls, but M4’s line under Godview’s options, and the palette in its own properties', async () => {
    const model = parityModel();
    for (const [host, options] of HOSTS) {
      const legacy = await mountLegacy(LegacyRain, model, options, parameters);
      const ported = await mountPorted(rainMonitorView, model, parameters);
      const buttons = (root: HTMLElement) => [...root.querySelectorAll('.vf-monitor-rain-agents button')];
      for (const [index, button] of buttons(ported).entries()) {
        const view = model.agents[index]!;
        const before = buttons(legacy)[index]!;
        const shim = toMonitorAgent(view, options).detail;
        expect(before.textContent?.endsWith(`: ${shim}`)).toBe(true);
        expect(button.textContent?.endsWith(`: ${detailLine(view)}`)).toBe(true);
        if (host === 'VibeField') expect(button.textContent).toBe(before.textContent);
        button.textContent = `${button.textContent!.slice(0, -detailLine(view).length)}«detail»`;
        before.textContent = `${before.textContent!.slice(0, -shim.length)}«detail»`;
      }
      // M46: the rain's DOM colours, once host variables, are its own properties now, from the palette.
      const rain = ported.querySelector<HTMLElement>('.vf-monitor-rain')!;
      expect(styleOf(rain)).toEqual(
        [
          `--mv-rain-focus: ${palette.rain.focus}`,
          `--mv-rain-ink-blocked: ${palette.rain.ink.blocked}`,
          `--mv-rain-ink-idle: ${palette.rain.ink.idle}`,
          `--mv-rain-ink-working: ${palette.rain.ink.working}`,
          `--mv-rain-stage: ${palette.rain.stage}`,
          `--mv-rain-title: ${palette.text.primary}`,
        ].sort(),
      );
      rain.removeAttribute('style');
      // The canvas's own size is the stage's in both; the rest of the DOM is the same.
      expect(tree(ported)).toEqual(tree(legacy));
    }
  });

  it('with nothing to show, says the same in its own class', async () => {
    const legacy = await mountLegacy(LegacyRain, fixtureModel([]), GODVIEW, parameters);
    const ported = await mountPorted(rainMonitorView, fixtureModel([]), parameters);
    legacy.querySelector('.vf-monitor-empty')!.className = 'vf-monitor-rain-empty';
    ported.querySelector<HTMLElement>('.vf-monitor-rain')!.removeAttribute('style');
    expect(tree(ported)).toEqual(tree(legacy));
  });
});
