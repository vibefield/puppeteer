import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MonitorSpawnDevice, MonitorSpawnMenu, MonitorSpawnProfile } from '@vibecook/puppeteer-view-sdk';
import { fixtureInput, parameterDefaults } from '@vibecook/puppeteer-view-sdk/testing';
import { menuOf, type BloomOpenMenu } from '@vibecook/puppeteer-view-sdk/toolkit';
import { AgentList } from './AgentList.js';
import { LIST_MANIFEST } from './index.js';
import { ListSpawnMenu, menuDefaultIndex, menuProfiles } from './ListSpawnMenu.js';

// The list's two-step menu (SB-D11) as markup: what a screen reader and a
// host's tests reach. The keys, the clicks and the dismissals are
// AgentList.test.tsx's (happy-dom). The trees are the bloom's own scenarios.

const NATIVE: MonitorSpawnProfile = {
  id: 'native',
  label: 'This Mac',
  kind: 'native',
  signedIn: ['Alpha', 'Beta', 'Gamma', 'Delta'],
};
const WORK: MonitorSpawnProfile = {
  id: 'work',
  label: 'Work',
  kind: 'managed',
  glyph: 'briefcase',
  isDefault: true,
  blocked: true,
  signedIn: ['Alpha', 'Beta'],
};
const DEMO: MonitorSpawnProfile = { id: 'demo', label: 'Demo', kind: 'managed', glyph: 'flask', signedIn: ['Alpha'] };
const PERSONAL: MonitorSpawnProfile = {
  id: 'personal',
  label: 'Personal',
  kind: 'managed',
  glyph: 'house',
  signedIn: ['Alpha', 'Beta'],
};
const studio = (profiles: readonly MonitorSpawnProfile[]): MonitorSpawnDevice => ({
  id: 'studio',
  label: 'studio',
  self: true,
  state: 'ready',
  profiles,
});
const MINI: MonitorSpawnDevice = {
  id: 'mini',
  label: 'mini',
  state: 'ready',
  word: '2 RUNNING',
  profiles: [{ ...NATIVE, isDefault: true }, PERSONAL],
};
const AIR: MonitorSpawnDevice = {
  id: 'air',
  label: 'air',
  state: 'asleep',
  word: 'ASLEEP · 2 H',
  phrase: 'is asleep',
  profiles: [{ ...NATIVE, isDefault: true }],
};
const SCENARIOS = {
  'one-three': { devices: [studio([NATIVE, WORK, DEMO])] },
  'one-one': { devices: [studio([{ ...NATIVE, isDefault: true }])] },
  two: { devices: [studio([NATIVE, WORK, DEMO]), MINI] },
  three: { devices: [studio([NATIVE, WORK, DEMO]), MINI, AIR] },
} satisfies Record<string, MonitorSpawnMenu>;

const open = (tree: MonitorSpawnMenu): BloomOpenMenu => {
  const menu = menuOf(tree);
  if (menu.kind === 'instant') throw new Error('expected a choice');
  return menu;
};
const html = (tree: MonitorSpawnMenu) =>
  renderToStaticMarkup(<ListSpawnMenu menu={open(tree)} onChoose={() => undefined} onClose={() => undefined} />);
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

describe('the list’s two-step menu', () => {
  it('two or more desktops: the desktops, then the one you sit at’s profiles, the default marked', () => {
    const markup = html(SCENARIOS.three);
    expect(markup).toContain('role="menu" aria-label="New terminal" data-list-spawn-step="devices"');
    expect(count(markup, /data-bloom-bud-kind="device"/g)).toBe(3);
    // the desktop you sit at is shown, is called "This desktop" whatever its name (M34), says HERE, and blooms
    expect(markup).toMatch(
      /class="vf-monitor-list-spawn-row is-on" aria-label="This desktop, this desktop" data-bloom-bud-kind="device" data-bloom-bud-id="studio"/,
    );
    expect(markup).toContain('<span class="vf-monitor-list-spawn-name">This desktop</span><small>HERE</small>');
    // its face is the initial of what the menu calls it
    expect(markup).toContain('<span class="vf-monitor-list-spawn-init" aria-hidden="true">T</span>');
    // a faint desktop is disabled and says why; it has no profiles to step into
    expect(markup).toMatch(
      /aria-disabled="true" aria-label="air, asleep · 2 h" data-bloom-bud-kind="device" data-bloom-bud-id="air"/,
    );
    expect(markup).toContain('<small>ASLEEP · 2 H</small>');
    expect(count(markup, /vf-monitor-list-spawn-chev/g)).toBe(2);
    // studio's profiles in the feed's order (the bloom's and the tabs'); Work the default, filled, waiting on you
    expect(markup).toContain('role="group" aria-label="Profile on This desktop"');
    const ids = [...markup.matchAll(/data-bloom-bud-kind="profile" data-bloom-bud-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['native', 'work', 'demo']);
    expect(markup).toMatch(
      /data-bloom-bud-id="work"[^>]*><svg[^>]*fill="currentColor"[^>]*data-profile-glyph="briefcase"/,
    );
    expect(count(markup, /class="vf-monitor-list-spawn-dot"/g)).toBe(1);
    expect(markup).toContain('<small>DEFAULT · ALPHA · BETA</small>');
    expect(markup).toContain('aria-label="WORK, default, waiting on you, alpha, beta signed in"');
    expect(markup).toContain('↵ on a desktop takes its default');
  });

  it('one desktop: its profiles alone', () => {
    const markup = html(SCENARIOS['one-three']);
    expect(markup).toContain('data-list-spawn-step="profiles"');
    expect(markup).not.toContain('data-list-spawn-column="devices"');
    expect(count(markup, /data-bloom-bud-kind="profile"/g)).toBe(3);
    expect(markup).not.toContain('takes its default');
  });

  it('a peer’s native default is called DEFAULT once, not DEFAULT · DEFAULT', () => {
    const menu = open(SCENARIOS.two);
    // the menu opens on the desktop you sit at; seat it on the peer to show the peer's profiles
    const markup = renderToStaticMarkup(
      <ListSpawnMenu menu={{ ...menu, self: MINI }} onChoose={() => undefined} onClose={() => undefined} />,
    );
    expect(markup).toContain(
      '<span class="vf-monitor-list-spawn-name">DEFAULT</span><small>ALPHA · BETA · GAMMA · DELTA</small>',
    );
    expect(markup).not.toContain('DEFAULT · DEFAULT');
    expect(markup).toContain('aria-label="Profile on mini"');
  });

  it('lists a desktop’s profiles in the feed’s order, and the keys land on its default', () => {
    expect(menuProfiles(MINI).map((p) => p.id)).toEqual(['native', 'personal']);
    expect(menuDefaultIndex(MINI)).toBe(0);
    const here = studio([NATIVE, WORK, DEMO]);
    expect(menuProfiles(here).map((p) => p.id)).toEqual(['native', 'work', 'demo']);
    expect(menuDefaultIndex(here)).toBe(1);
    const reading: MonitorSpawnDevice = { id: 'r', label: 'r', state: 'reading' };
    expect(menuProfiles(reading)).toEqual([]);
    expect(menuDefaultIndex(reading)).toBe(0);
  });

  it('a desktop still reading its profiles says so, and ↵ on it takes its default', () => {
    const tree: MonitorSpawnMenu = {
      devices: [{ ...studio([]), profiles: undefined, state: 'reading' }, MINI],
    };
    expect(html(tree)).toContain('Reading its profiles');
  });
});

describe('the list’s ＋ TERMINAL', () => {
  const markup = (spawn?: MonitorSpawnMenu) =>
    renderToStaticMarkup(
      <AgentList
        input={fixtureInput({
          parameters: parameterDefaults(LIST_MANIFEST),
          ...(spawn ? { capabilities: { spawn } } : {}),
        })}
        commands={{ select: () => undefined, create: () => Promise.resolve({ opened: true }), report: () => undefined }}
      />,
    );

  it('without a tree, today’s button', () => {
    expect(markup()).toContain('<button type="button" class="vf-monitor-list-new">＋ TERMINAL</button>');
  });

  it('with a tree that offers a choice, a menu button (closed until pressed)', () => {
    const text = markup(SCENARIOS.two);
    expect(text).toContain(
      '<button type="button" class="vf-monitor-list-new" aria-haspopup="menu" aria-expanded="false" data-list-spawn-button="">＋ TERMINAL</button>',
    );
    expect(text).not.toContain('role="menu"');
  });

  it('with a tree that offers none, a plain button again (it creates under the one choice)', () => {
    expect(markup(SCENARIOS['one-one'])).toContain(
      '<button type="button" class="vf-monitor-list-new">＋ TERMINAL</button>',
    );
  });
});
