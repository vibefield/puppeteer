// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MonitorSpawnMenu, MonitorViewInstance, StageGeometry } from '@vibecook/puppeteer-view-sdk';
import {
  agentViewsFixture,
  countingCommands,
  fixtureModel,
  fixtureTheme,
  parameterDefaults,
} from '@vibecook/puppeteer-view-sdk/testing';
import { BLOOM_SCENARIOS } from './bloom/scenarios.js';
import { SWARM_MANIFEST, swarmMonitorView } from './index.js';

// THE SWARM AS ITS HOST MOUNTS IT: the shipping view through `mount`, its physics inline (happy-dom has no Worker),
// a stub renderer. These are what the parity against the frozen legacy swarm held until MV-8 deleted both, and that
// no other test or golden witnesses: the view's own properties under their L18 names (M59.4), what it reports in place
// of the DOM a host used to read, and the bloom's keys held while it is open (MV-D8).

vi.mock('./gpu/swarm-renderer.js', async (original) => ({
  ...(await original<object>()),
  createSwarmRenderer: async () => ({
    ok: true,
    renderer: { render: () => {}, resize: () => {}, destroy: () => {}, lost: new Promise(() => {}) },
  }),
}));

const theme = fixtureTheme('light');
const parameters = parameterDefaults(SWARM_MANIFEST);
const WIDTH = 1180;
const HEIGHT = 252;
const STAGE: StageGeometry = {
  width: WIDTH,
  height: HEIGHT,
  insets: { top: 0, right: 0, bottom: 0, left: 59 },
  obstacles: [{ x: 13, y: 11, width: 46, height: HEIGHT - 17 }],
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function mounted(spawn?: MonitorSpawnMenu) {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => WIDTH);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => HEIGHT);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, WIDTH, HEIGHT));
  const root = document.createElement('div');
  document.body.append(root);
  cleanups.push(() => root.remove());
  const counting = countingCommands();
  let instance!: MonitorViewInstance;
  await act(async () => {
    instance = swarmMonitorView.mount(
      root,
      {
        model: fixtureModel(agentViewsFixture(3)),
        changes: { added: [], updated: [], removed: [] },
        stage: STAGE,
        theme,
        parameters,
        capabilities: spawn ? { spawn } : {},
      },
      counting.commands,
    );
  });
  cleanups.push(() => act(async () => instance.unmount()));
  for (let frame = 0; frame < 3; frame += 1) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
  }
  return { root, field: root.querySelector<HTMLElement>('.vf-monitor-swarm')!, counting };
}

describe('the swarm mounted', () => {
  it('sets its own properties from its input, under its own names (L18, M59.4), and its field takes focus (MV-D8)', async () => {
    const { root, field } = await mounted();
    expect(root.classList.contains('mv-swarm')).toBe(true);
    expect(field.style.getPropertyValue('--mv-swarm-orange')).toBe(theme.tokens.swarm.orange);
    // The ground is the skin's `--monitor-bg`, read by the view's CSS; the root carries none of its own.
    expect(field.style.getPropertyValue('--mv-swarm-ground')).toBe('');
    expect(field.getAttribute('tabindex')).toBe('-1');
    expect(field.hasAttribute('data-swarm-renderer')).toBe(false);
  });

  it('reports what draws it and where its physics run, where a host once read its DOM', async () => {
    const { counting } = await mounted();
    expect(counting.reports).toContainEqual({ renderer: 'webgpu' });
    expect(counting.reports).toContainEqual({ physics: 'inline' });
  });

  it('opens the bloom from the keys door, holds the keys while it is open, and commits the chosen desktop (MV-D8)', async () => {
    const { root, field, counting } = await mounted(BLOOM_SCENARIOS.two);
    await act(async () => root.querySelector<HTMLButtonElement>('[data-swarm-new-terminal]')!.click());
    const menu = root.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(field.querySelector('.vf-bloom')?.getAttribute('data-bloom-mode')).toBe('keys');
    expect(counting.reports).toContainEqual({ keysHeld: true });
    for (const key of ['ArrowRight', 'Enter', 'Enter']) {
      await act(async () => {
        menu!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    }
    for (let frame = 0; frame < 2; frame += 1) {
      await act(async () => {
        vi.advanceTimersToNextFrame();
      });
    }
    expect(counting.creates).toHaveLength(1);
    expect(counting.creates[0]?.target).toEqual({ deviceId: 'mini', profileSet: 'native' });
    expect(counting.reports.at(-1)).toEqual({ keysHeld: false });
  });
});
