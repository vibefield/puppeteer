// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MONITOR_VIEWS } from '../monitor/registry.js';
import { InstrumentBar, keyLegend, ViewMark, type InstrumentBarView } from './InstrumentBar.js';

const NOOP = () => undefined;
const base = {
  counts: { blocked: 1, working: 2, idle: 3 },
  onSelectStatus: NOOP,
  viewId: 'swarm',
  onSelectView: NOOP,
  theme: 'light' as const,
  onThemeChange: NOOP,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

/** The subpaths of a path's data, each from its moveto. */
const subpaths = (d: string): string[] => d.split(/(?=M)/).filter(Boolean);

describe('the bar draws each view’s mark from its manifest (MV-D6)', () => {
  it('fills every registered view’s paths in currentColor, and keeps no mark table of its own for them', () => {
    const html = renderToStaticMarkup(<InstrumentBar {...base} views={MONITOR_VIEWS} />);
    const group = html.slice(html.indexOf('aria-label="Monitor view"'));
    for (const entry of MONITOR_VIEWS) {
      const control = group.slice(group.indexOf(`aria-label="${entry.label} view"`));
      const svg = control.slice(0, control.indexOf('</svg>'));
      expect(svg).toContain(`<svg class="vf-godview-bar-mark is-filled" viewBox="${entry.mark.viewBox}"`);
      expect([...svg.matchAll(/<path d="([^"]*)"/g)].map((match) => match[1])).toEqual(entry.mark.paths);
    }
    // The old table stroked circles for the swarm; a filled mark has none.
    expect(group).not.toContain('<circle');
  });

  it('a manifest’s mark is closed outlines, fit to fill: every subpath ends where it began', () => {
    for (const entry of MONITOR_VIEWS) {
      expect(entry.mark.paths.length, entry.id).toBeGreaterThan(0);
      for (const path of entry.mark.paths) {
        for (const subpath of subpaths(path)) expect([entry.id, subpath.endsWith('Z')]).toEqual([entry.id, true]);
      }
    }
  });

  it('shows a view with no paths by its label’s initial', () => {
    const blank: InstrumentBarView = { id: 'plain', label: 'PLAIN', mark: { viewBox: '0 0 16 16', paths: [] } };
    const html = renderToStaticMarkup(<InstrumentBar {...base} views={[blank]} viewId="plain" />);
    expect(html).toContain('<span aria-hidden="true">P</span>');
    expect(html).not.toContain('is-filled');
  });
});

it('updates a replaced manifest mark and its label fallback', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  cleanups.push(() => {
    act(() => root.unmount());
    element.remove();
  });
  const first = { viewBox: '0 0 16 16', paths: ['M0 0H8V8Z'] };
  await act(async () => root.render(<ViewMark mark={first} fallback="FIRST" />));
  expect(element.querySelector('path')?.getAttribute('d')).toBe(first.paths[0]);
  const next = { viewBox: '0 0 24 24', paths: ['M1 1H9V9Z', 'M2 2H4V4Z'] };
  await act(async () => root.render(<ViewMark mark={next} fallback="NEXT" />));
  expect(element.querySelector('svg')?.getAttribute('viewBox')).toBe(next.viewBox);
  expect([...element.querySelectorAll('path')].map((path) => path.getAttribute('d'))).toEqual(next.paths);
  const empty = { viewBox: '0 0 24 24', paths: [] };
  await act(async () => root.render(<ViewMark mark={empty} fallback="NEXT" />));
  expect(element.textContent).toBe('N');
  await act(async () => root.render(<ViewMark mark={empty} fallback="LAST" />));
  expect(element.textContent).toBe('L');
});

describe('the bar prints a view’s declared keys on its control (MV-D8)', () => {
  it('prints each key as the keyboard’s legend', () => {
    expect(
      ['Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', '-', '=', 'k', 'F5'].map(
        keyLegend,
      ),
    ).toEqual(['⎋', '↵', '↑', '↓', '←', '→', '↖', '↘', '−', '=', 'K', 'F5']);
  });

  async function hovered(label: string): Promise<HTMLElement> {
    vi.useFakeTimers();
    const element = document.createElement('div');
    document.body.append(element);
    let root!: Root;
    await act(async () => {
      root = createRoot(element);
      root.render(<InstrumentBar {...base} views={MONITOR_VIEWS} />);
    });
    cleanups.push(() => {
      act(() => root.unmount());
      element.remove();
    });
    const host = element
      .querySelector(`[aria-label="${label} view"]`)!
      .closest<HTMLElement>('.vf-godview-bar-tip-host')!;
    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    return host;
  }

  it('in the tip of the control that shows the view: its name, then the keys it takes while focused', async () => {
    const swarm = MONITOR_VIEWS.find((entry) => entry.id === 'swarm')!;
    const host = await hovered('SWARM');
    const tip = host.querySelector('[role="tooltip"]')!;
    expect(tip.textContent).toBe(`SWARM${swarm.keys!.map((key) => keyLegend(key.key)).join(' ')}`);
    const keys = tip.querySelector('.vf-godview-bar-keys')!;
    expect(keys.textContent).toBe('⎋ ↵ → ←');
    expect(keys.getAttribute('aria-label')).toBe(
      'while focused: Escape, put the bloom away; Enter, open where the bloom points; ArrowRight, the next bud; ' +
        'ArrowLeft, the bud before',
    );
  });

  it('prints nothing for a view that declares no keys', async () => {
    const host = await hovered('LIST');
    const tip = host.querySelector('[role="tooltip"]')!;
    expect(tip.textContent).toBe('LIST');
    expect(tip.querySelector('.vf-godview-bar-keys')).toBeNull();
  });
});
