// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  MonitorSpawnDevice,
  MonitorSpawnMenu,
  MonitorSpawnProfile,
  MonitorViewInput,
  MonitorViewInstance,
} from '@vibefield/puppeteer-view-sdk';
import {
  agentViewFixture,
  countingCommands,
  fixtureInput,
  fixtureStage,
  parameterDefaults,
  runConformance,
} from '@vibefield/puppeteer-view-sdk/testing';
import { LIST_MANIFEST, LIST_ROOT_CLASS, listMonitorView } from './index.js';

// The list on the SDK (MV-4): mounted as a host mounts it, through its own
// `mount`, reading only its input. The spawn menu's keys, clicks and
// dismissals behave exactly as before the port; only the way it hears a press
// outside it changed (MV-W2: the view's own element and focus, never the
// document).

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const PARAMETERS = parameterDefaults(LIST_MANIFEST);
const LAPTOP = { id: 'desk-2', name: 'Laptop', os: 'linux', self: false } as const;

interface Mounted {
  readonly root: HTMLElement;
  /** A control of the host's own, outside the view's root: the bar, a pane. */
  readonly chrome: HTMLButtonElement;
  readonly instance: MonitorViewInstance;
  readonly commands: ReturnType<typeof countingCommands>;
  update(input: MonitorViewInput): Promise<void>;
}

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const each of mounted.splice(0)) {
    await act(async () => each.instance.unmount());
    each.root.parentElement?.remove();
  }
});

async function mount(input: Partial<Parameters<typeof fixtureInput>[0]> = {}): Promise<Mounted> {
  const host = document.createElement('div');
  const chrome = document.createElement('button');
  chrome.textContent = 'bar';
  const root = document.createElement('div');
  host.append(chrome, root);
  document.body.append(host);
  const commands = countingCommands();
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = listMonitorView.mount(root, fixtureInput({ parameters: PARAMETERS, ...input }), commands.commands);
  });
  const result: Mounted = {
    root,
    chrome,
    instance,
    commands,
    update: (next) => act(async () => instance.update(next)),
  };
  mounted.push(result);
  return result;
}

const rows = (root: HTMLElement): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>('.vf-monitor-list-row'),
];
const projects = (root: HTMLElement): string[] =>
  rows(root).map((row) => row.querySelector('strong')?.textContent ?? '');

describe('the list, receding', () => {
  const blocked = agentViewFixture({ id: 'a1', project: { name: 'billing-api', seq: 1 }, status: 'blocked' });
  const working = agentViewFixture({ id: 'a2', project: { name: 'vibe-field', seq: 2 }, status: 'working' });
  const idle = agentViewFixture({ id: 'a3', project: { name: 'rosetta', seq: 3 }, status: 'idle' });

  it('orders what the host shows first, keeps the rest below at the recede weight, and counts both', async () => {
    const { root } = await mount({ agents: [{ ...blocked, receded: true }, working, idle] });
    expect(projects(root)).toEqual(['vibe-field', 'rosetta', 'billing-api']);
    expect(root.querySelectorAll('.is-receded')).toHaveLength(1);
    expect(root.textContent).toContain('2 OF 3 SESSIONS');
    expect(root.querySelector('.is-all-receded')).toBeNull();
  });

  it('says every session when nothing recedes, and marks a stage where everything does', async () => {
    expect((await mount({ agents: [blocked, working] })).root.textContent).toContain('2 SESSIONS');
    const all = await mount({
      agents: [
        { ...blocked, receded: true },
        { ...working, receded: true },
      ],
    });
    expect(all.root.querySelector('.vf-monitor-list.is-all-receded')).not.toBeNull();
    expect(all.root.textContent).toContain('0 OF 2 SESSIONS');
  });

  it('orders agents before bare terminals, then blocked, working, idle, then by birth', async () => {
    const { root } = await mount({
      agents: [
        agentViewFixture({ id: 't', kind: 'terminal', status: 'working', project: { name: 'shell' }, createdAt: 1 }),
        agentViewFixture({ id: 'i', status: 'idle', project: { name: 'idle-1' }, createdAt: 2 }),
        agentViewFixture({ id: 'w2', status: 'working', project: { name: 'work-2' }, createdAt: 9 }),
        agentViewFixture({ id: 'w1', status: 'working', project: { name: 'work-1' }, createdAt: 3 }),
        agentViewFixture({ id: 'b', status: 'blocked', project: { name: 'blocked-1' }, createdAt: 8 }),
      ],
    });
    expect(projects(root)).toEqual(['blocked-1', 'work-1', 'work-2', 'idle-1', 'shell']);
  });
});

describe('a row', () => {
  it('puts the line under the name by the one rule, reply-first (M4): never the headline or the cost', async () => {
    const { root } = await mount({
      agents: [
        agentViewFixture({
          id: 'w',
          status: 'working',
          model: 'fixture-model',
          detail: 'Reading src/app.ts',
          cost: { usd: 1.2, coverage: 'complete', burnPerHour: 6 },
        }),
        agentViewFixture({ id: 'r', status: 'idle', reply: { text: ' Done. ' }, createdAt: 2 }),
        agentViewFixture({
          id: 'b',
          status: 'blocked',
          wait: { kind: 'permission', since: 1, tool: 'Bash' },
          createdAt: 3,
        }),
      ],
    });
    const details = [...root.querySelectorAll('.vf-monitor-list-detail')].map((cell) => cell.textContent);
    expect(details).toEqual(['permission · Bash', 'working', 'Done.']);
    expect(rows(root)[1]!.getAttribute('aria-label')).toBe('project, fixture-model, working: working');
  });

  it('names what runs it, its account, its branch and its context, the colour its own property', async () => {
    const { root } = await mount({
      agents: [
        agentViewFixture({
          id: 'a',
          project: { name: 'puppeteer', branch: 'mv/land', seq: 1 },
          provider: { id: 'claude', label: 'Claude' },
          model: 'Opus 5.5',
          account: 'work',
          context: { usedPercent: 42.6 },
          colour: '#123456',
          active: true,
          attachment: { panes: 2, colour: '#654321' },
          stale: true,
        }),
      ],
    });
    const [row] = rows(root);
    expect(row!.className).toBe('vf-monitor-list-row is-idle is-active is-stale is-linked');
    expect(row!.getAttribute('aria-current')).toBe('true');
    expect(row!.style.getPropertyValue('--mv-list-colour')).toBe('#123456');
    expect(row!.querySelector('.vf-monitor-list-project small')?.textContent).toBe('mv/land');
    expect(row!.querySelector('.vf-monitor-list-agent')?.textContent).toBe('Opus 5.5work');
    expect(row!.querySelector('.vf-monitor-list-agent svg')).not.toBeNull();
    expect(row!.querySelector('.vf-monitor-list-context')?.textContent).toBe('42%');
    expect(row!.getAttribute('aria-label')).toBe('puppeteer, Opus 5.5, work, idle: idle');
  });

  it('a peer’s row names its desktop first, and no write word, whatever its row’s `writable`', async () => {
    const { root } = await mount({
      agents: [
        agentViewFixture({
          id: 'p',
          device: LAPTOP,
          model: 'fixture-model',
          status: 'blocked',
          wait: { kind: 'question', since: 1, question: 'Ship it?' },
          writable: false,
          account: 'team',
          context: { usedPercent: 10 },
        }),
      ],
    });
    const [row] = rows(root);
    expect(row!.classList.contains('is-remote')).toBe(true);
    expect(row!.getAttribute('aria-label')).toBe('on Laptop, project, fixture-model, team, blocked: Laptop · Ship it?');
    // M9: a peer's row draws the facts the model carries, as a local one does.
    expect(row!.querySelector('.vf-monitor-list-context')?.textContent).toBe('10%');
  });

  it('a terminal on another desktop wears the host chip; one here reads "terminal"', async () => {
    const { root } = await mount({
      agents: [
        agentViewFixture({
          id: 't1',
          kind: 'terminal',
          device: LAPTOP,
          project: { name: 'notes' },
          writable: true,
          createdAt: 1,
        }),
        agentViewFixture({ id: 't2', kind: 'terminal', project: { name: '' }, detail: '/Users/me', createdAt: 2 }),
      ],
    });
    const [peer, local] = rows(root);
    const chip = peer!.querySelector('.vf-monitor-list-host');
    // The desktop's name alone: no mark, no hover, nothing spoken about who may type (James, 2026-10-28).
    expect(chip?.textContent).toBe('Laptop');
    expect(chip?.children).toHaveLength(0);
    expect(chip?.getAttribute('title')).toBeNull();
    expect(peer!.getAttribute('aria-label')).toBe('on Laptop, notes, remote session, idle: ');
    expect(local!.querySelector('.vf-monitor-list-terminal')?.textContent).toBe('terminal');
    expect(local!.getAttribute('aria-label')).toBe('terminal, terminal, idle: /Users/me');
    expect(local!.querySelector('.vf-monitor-list-context')?.textContent).toBe('—');
  });

  it('selects by id', async () => {
    const view = await mount({ agents: [agentViewFixture({ id: 'pick-me' })] });
    await act(async () => rows(view.root)[0]!.click());
    expect(view.commands.selects).toEqual(['pick-me']);
  });
});

describe('the view on its root', () => {
  it('starts its top band below the stage’s top inset, where a host keeps chrome over the stage (M58)', async () => {
    // VibeField's claims strip sits over the stage's top, and its stage says so as `insets.top`; the band starts
    // below it. Puppeteer's Godview passes 0, so its list starts where it always did.
    const compact = fixtureStage('compact');
    const view = await mount({ stage: { ...compact, insets: { ...compact.insets, top: 40 } } });
    const section = view.root.querySelector<HTMLElement>('.vf-monitor-list')!;
    expect(section.style.getPropertyValue('--mv-list-inset-top')).toBe('40px');
  });

  it('scopes its stylesheet under its root class while mounted, and clears the chrome by the stage’s inset', async () => {
    const view = await mount({ stage: fixtureStage('compact') });
    expect(view.root.classList.contains(LIST_ROOT_CLASS)).toBe(true);
    const section = view.root.querySelector<HTMLElement>('.vf-monitor-list')!;
    expect(section.style.getPropertyValue('--mv-list-inset-left')).toBe('120px');
    expect(section.style.getPropertyValue('--mv-list-row-height')).toBe('38px');
    expect(section.style.getPropertyValue('--mv-list-project-width')).toBe('150px');
    expect(section.style.getPropertyValue('--mv-list-blocked')).toBe('#fd7e14');
    await act(async () => view.instance.unmount());
    expect(view.root.classList.contains(LIST_ROOT_CLASS)).toBe(false);
    mounted.splice(mounted.indexOf(view), 1);
    view.root.parentElement?.remove();
  });

  it('says so with no agents, in its own words and its own class', async () => {
    const { root } = await mount();
    const empty = root.querySelector('.vf-monitor-list-empty');
    expect(empty?.textContent).toBe('NO ACTIVE AGENTS' + 'Launch an agent from a terminal pane.');
    expect(root.querySelector('.vf-monitor-empty')).toBeNull();
  });
});

// The spawn menu. Trees as the backend words them: this desktop under its real name, `self` true (M34).
const NATIVE: MonitorSpawnProfile = { id: 'native', label: 'This Mac', kind: 'native', signedIn: ['Claude'] };
const WORK: MonitorSpawnProfile = { id: 'work', label: 'Work', kind: 'managed', glyph: 'briefcase', isDefault: true };
const DEMO: MonitorSpawnProfile = { id: 'demo', label: 'Demo', kind: 'managed', glyph: 'flask' };
const HERE: MonitorSpawnDevice = {
  id: 'mbp-7',
  label: 'Studio',
  self: true,
  state: 'ready',
  profiles: [NATIVE, WORK, DEMO],
};
const MINI: MonitorSpawnDevice = {
  id: 'mini',
  label: 'mini',
  state: 'ready',
  word: '2 RUNNING',
  profiles: [
    { ...NATIVE, isDefault: true },
    { id: 'personal', label: 'Personal', kind: 'managed', glyph: 'house' },
  ],
};
const AIR: MonitorSpawnDevice = { id: 'air', label: 'air', state: 'asleep', word: 'ASLEEP · 2 H' };
const TWO: MonitorSpawnMenu = { devices: [HERE, MINI, AIR] };
const ONE: MonitorSpawnMenu = { devices: [HERE] };

const trigger = (root: HTMLElement): HTMLButtonElement => root.querySelector('.vf-monitor-list-new')!;
const menuOf = (root: HTMLElement): HTMLElement | null => root.querySelector('[role="menu"]');
const items = (root: HTMLElement, column: 'devices' | 'profiles'): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>(`[data-list-spawn-column="${column}"] [role="menuitem"]`),
];
const focused = (root: HTMLElement): Element | null => root.ownerDocument.activeElement;
const key = (target: Element, name: string): Promise<void> =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
/** A press as the browser delivers one: pointerdown on the target, then the focus moves (or leaves, onto nothing). */
const press = (target: Element, focus: HTMLElement | 'nothing'): Promise<void> =>
  act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    if (focus === 'nothing') (target.ownerDocument.activeElement as HTMLElement | null)?.blur();
    else focus.focus();
  });
const openMenu = async (spawn: MonitorSpawnMenu = TWO): Promise<Mounted> => {
  const view = await mount({ agents: [agentViewFixture({ id: 'a' })], capabilities: { spawn } });
  await act(async () => trigger(view.root).focus());
  await act(async () => trigger(view.root).click());
  expect(menuOf(view.root)).not.toBeNull();
  return view;
};

describe('＋ TERMINAL', () => {
  it('with no tree creates at once and asks for nothing in particular', async () => {
    const view = await mount();
    await act(async () => trigger(view.root).click());
    expect(view.commands.creates).toEqual([{}]);
  });

  it('with no choice to make creates under this desktop, named by leaving it out (M34)', async () => {
    // Puppeteer's Godview today: this desktop with no profile sets.
    const bare = await mount({ capabilities: { spawn: { devices: [{ ...HERE, profiles: [] }] } } });
    await act(async () => trigger(bare.root).click());
    expect(bare.commands.creates).toEqual([{}]);
    expect(menuOf(bare.root)).toBeNull();
    // One profile is no choice either: it is asked for, the desktop still left out.
    const single = await mount({ capabilities: { spawn: { devices: [{ ...HERE, profiles: [WORK] }] } } });
    await act(async () => trigger(single.root).click());
    expect(single.commands.creates).toEqual([{ target: { profileSet: 'work' } }]);
  });
});

describe('the spawn menu', () => {
  it('opens with the keyboard on the desktop you sit at, or (one desktop) on its default', async () => {
    const two = await openMenu(TWO);
    expect(trigger(two.root).getAttribute('aria-expanded')).toBe('true');
    expect(focused(two.root)).toBe(items(two.root, 'devices')[0]);
    const one = await openMenu(ONE);
    expect(focused(one.root)).toBe(items(one.root, 'profiles')[1]);
  });

  it('⎋ closes it and gives the focus back to the button', async () => {
    const view = await openMenu();
    await key(focused(view.root)!, 'Escape');
    expect(menuOf(view.root)).toBeNull();
    expect(focused(view.root)).toBe(trigger(view.root));
    expect(view.commands.creates).toEqual([]);
  });

  it('a press elsewhere in the view closes it, and the focus stays where it went', async () => {
    const view = await openMenu();
    const row = rows(view.root)[0]!;
    await press(row, row);
    expect(menuOf(view.root)).toBeNull();
    expect(focused(view.root)).toBe(row);
    // A press on nothing focusable in the view closes it too.
    await act(async () => trigger(view.root).click());
    expect(menuOf(view.root)).not.toBeNull();
    await press(view.root.querySelector('.vf-monitor-list-count')!, 'nothing');
    expect(menuOf(view.root)).toBeNull();
  });

  it('each way of hearing a press is enough alone: the view’s own element, and the focus leaving', async () => {
    // A press in the view that moves no focus (its target takes none and keeps none from the menu).
    const view = await openMenu();
    const count = view.root.querySelector('.vf-monitor-list-count')!;
    await act(async () => {
      count.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(menuOf(view.root)).toBeNull();
    // The focus leaving for the host's chrome with no press in the view at all.
    await act(async () => trigger(view.root).click());
    expect(menuOf(view.root)).not.toBeNull();
    await act(async () => view.chrome.focus());
    expect(menuOf(view.root)).toBeNull();
  });

  it('a press on the host’s chrome outside the view’s root closes it', async () => {
    const view = await openMenu();
    await press(view.chrome, view.chrome);
    expect(menuOf(view.root)).toBeNull();
    expect(focused(view.root)).toBe(view.chrome);
    // …and a press outside on nothing focusable, which only blurs the menu.
    await act(async () => trigger(view.root).click());
    expect(menuOf(view.root)).not.toBeNull();
    await press(view.root.ownerDocument.body, 'nothing');
    expect(menuOf(view.root)).toBeNull();
  });

  it('the button toggles it: pressing it again closes it once, never closing and reopening', async () => {
    const view = await openMenu();
    const button = trigger(view.root);
    await press(button, button);
    expect(menuOf(view.root)).not.toBeNull();
    await act(async () => button.click());
    expect(menuOf(view.root)).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('↑↓ walk the desktops and show each one’s profiles; → steps in on the default, ← steps back', async () => {
    const view = await openMenu();
    const [here, mini, air] = items(view.root, 'devices');
    await key(here!, 'ArrowDown');
    expect(focused(view.root)).toBe(mini);
    expect(view.root.querySelector('[data-list-spawn-column="profiles"]')?.getAttribute('aria-label')).toBe(
      'Profile on mini',
    );
    await key(mini!, 'ArrowDown');
    expect(focused(view.root)).toBe(air);
    // a faint desktop is focused but not shown: the profiles stay mini's
    expect(view.root.querySelector('[data-list-spawn-column="profiles"]')?.getAttribute('aria-label')).toBe(
      'Profile on mini',
    );
    await key(air!, 'ArrowDown');
    expect(focused(view.root)).toBe(here);
    expect(view.root.querySelector('[role="menu"]')?.getAttribute('data-list-spawn-step')).toBe('devices');
    await key(here!, 'ArrowRight');
    expect(focused(view.root)).toBe(items(view.root, 'profiles')[1]);
    expect(view.root.querySelector('[role="menu"]')?.getAttribute('data-list-spawn-step')).toBe('profiles');
    await key(focused(view.root)!, 'ArrowUp');
    expect(focused(view.root)).toBe(items(view.root, 'profiles')[0]);
    await key(focused(view.root)!, 'ArrowLeft');
    expect(focused(view.root)).toBe(here);
    // Moving between the rows never closes the menu.
    expect(menuOf(view.root)).not.toBeNull();
  });

  it('Tab closes it and lets the focus move on', async () => {
    const view = await openMenu();
    await key(focused(view.root)!, 'Tab');
    expect(menuOf(view.root)).toBeNull();
  });

  it('a profile commits exactly it; the desktop you sit at is asked for by leaving it out (M34)', async () => {
    const view = await openMenu();
    await key(items(view.root, 'devices')[0]!, 'ArrowRight');
    await act(async () => items(view.root, 'profiles')[2]!.click());
    expect(view.commands.creates).toEqual([{ target: { profileSet: 'demo' } }]);
    expect(menuOf(view.root)).toBeNull();
    expect(focused(view.root)).toBe(trigger(view.root));
  });

  it('a peer commits under its default, named by its id; a faint one does nothing', async () => {
    const view = await openMenu();
    await act(async () => items(view.root, 'devices')[2]!.click());
    expect(menuOf(view.root)).not.toBeNull();
    expect(view.commands.creates).toEqual([]);
    await act(async () => items(view.root, 'devices')[1]!.click());
    expect(view.commands.creates).toEqual([{ target: { deviceId: 'mini', profileSet: 'native' } }]);
  });

  it('listens on nothing but its own element: never the window or the document (MV-W2)', async () => {
    const documentListens = vi.spyOn(document, 'addEventListener');
    const windowListens = vi.spyOn(window, 'addEventListener');
    try {
      const view = await openMenu();
      await key(focused(view.root)!, 'ArrowDown');
      await key(focused(view.root)!, 'Escape');
      const ours = (calls: unknown[][]) => calls.filter(([type]) => type === 'pointerdown' || type === 'keydown');
      expect(ours(documentListens.mock.calls)).toEqual([]);
      expect(ours(windowListens.mock.calls)).toEqual([]);
    } finally {
      documentListens.mockRestore();
      windowListens.mockRestore();
    }
  });
});

describe('the contract', () => {
  it('keeps an unchanged model’s rows: an update that moves nothing it reads costs no render', async () => {
    const agents: readonly AgentView[] = [agentViewFixture({ id: 'a' }), agentViewFixture({ id: 'b', createdAt: 5 })];
    const view = await mount({ agents });
    const before = rows(view.root);
    await view.update({ ...fixtureInput({ parameters: PARAMETERS, agents }) });
    expect(rows(view.root)).toEqual(before);
  });
});

runConformance(listMonitorView);
runConformance(listMonitorView, { capabilities: { spawn: TWO } });
