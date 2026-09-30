import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults } from '../../monitor/parameters.js';
import { readMonitorPalette } from '../../monitor/palette.js';
import type { MonitorSpawnDevice, MonitorSpawnMenu } from '../../monitor/types.js';
import { menuOf, type BloomOpenMenu } from '../swarm/bloom/menu.js';
import { BLOOM_SCENARIOS } from '../swarm/bloom/scenarios.js';
import { AgentList } from './AgentList.js';
import { LIST_PARAMETER_GROUPS } from './list-parameters.js';
import { ListSpawnMenu, menuDefaultIndex, menuProfiles } from './ListSpawnMenu.js';

// The list's two-step menu (SB-D11) as markup: what a screen reader and a
// host's tests reach. Opening it, the keys and the clicks are VibeField's
// happy-dom lane; the tree is the bloom's own scenarios.

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
    const markup = html(BLOOM_SCENARIOS.three);
    expect(markup).toContain('role="menu" aria-label="New terminal" data-list-spawn-step="devices"');
    expect(count(markup, /data-bloom-bud-kind="device"/g)).toBe(3);
    // the desktop you sit at is shown, says HERE, and blooms
    expect(markup).toMatch(
      /class="vf-monitor-list-spawn-row is-on" aria-label="studio, this desktop" data-bloom-bud-kind="device" data-bloom-bud-id="studio"/,
    );
    expect(markup).toContain('<small>HERE</small>');
    // a faint desktop is disabled and says why; it has no profiles to step into
    expect(markup).toMatch(
      /aria-disabled="true" aria-label="air, asleep · 2 h" data-bloom-bud-kind="device" data-bloom-bud-id="air"/,
    );
    expect(markup).toContain('<small>ASLEEP · 2 H</small>');
    expect(count(markup, /vf-monitor-list-spawn-chev/g)).toBe(2);
    // studio's profiles in the feed's order (the bloom's and the tabs'); Work the default, filled, waiting on you
    expect(markup).toContain('role="group" aria-label="Profile on studio"');
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
    const markup = html(BLOOM_SCENARIOS['one-three']);
    expect(markup).toContain('data-list-spawn-step="profiles"');
    expect(markup).not.toContain('data-list-spawn-column="devices"');
    expect(count(markup, /data-bloom-bud-kind="profile"/g)).toBe(3);
    expect(markup).not.toContain('takes its default');
  });

  it('a peer’s native default is called DEFAULT once, not DEFAULT · DEFAULT', () => {
    const menu = open(BLOOM_SCENARIOS.two);
    // the menu opens on the desktop you sit at; seat it on the peer to show the peer's profiles
    const markup = renderToStaticMarkup(
      <ListSpawnMenu
        menu={{ ...menu, self: BLOOM_SCENARIOS.two.devices[1] as MonitorSpawnDevice }}
        onChoose={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(markup).toContain(
      '<span class="vf-monitor-list-spawn-name">DEFAULT</span><small>ALPHA · BETA · GAMMA · DELTA</small>',
    );
    expect(markup).not.toContain('DEFAULT · DEFAULT');
  });

  it('lists a desktop’s profiles in the feed’s order, and the keys land on its default', () => {
    const mini = BLOOM_SCENARIOS.two.devices[1] as MonitorSpawnDevice;
    expect(menuProfiles(mini).map((p) => p.id)).toEqual(['native', 'personal']);
    expect(menuDefaultIndex(mini)).toBe(0);
    const studio = BLOOM_SCENARIOS.two.devices[0] as MonitorSpawnDevice;
    expect(menuProfiles(studio).map((p) => p.id)).toEqual(['native', 'work', 'demo']);
    expect(menuDefaultIndex(studio)).toBe(1);
    const reading: MonitorSpawnDevice = { id: 'r', label: 'r', state: 'reading' };
    expect(menuProfiles(reading)).toEqual([]);
    expect(menuDefaultIndex(reading)).toBe(0);
  });

  it('a desktop still reading its profiles says so, and ↵ on it takes its default', () => {
    const tree: MonitorSpawnMenu = {
      devices: [
        { ...(BLOOM_SCENARIOS.two.devices[0] as MonitorSpawnDevice), profiles: undefined, state: 'reading' },
        BLOOM_SCENARIOS.two.devices[1] as MonitorSpawnDevice,
      ],
    };
    const markup = html(tree);
    expect(markup).toContain('Reading its profiles');
  });
});

describe('the list’s ＋ TERMINAL', () => {
  const markup = (spawnMenu?: MonitorSpawnMenu) =>
    renderToStaticMarkup(
      <AgentList
        agents={[]}
        parameters={monitorParameterDefaults(LIST_PARAMETER_GROUPS)}
        actions={{ select: () => undefined, createAt: () => undefined }}
        palette={readMonitorPalette()}
        {...(spawnMenu ? { spawnMenu } : {})}
      />,
    );

  it('without a tree, today’s button', () => {
    expect(markup()).toContain('<button type="button" class="vf-monitor-list-new">＋ TERMINAL</button>');
  });

  it('with a tree that offers a choice, a menu button (closed until pressed)', () => {
    const html = markup(BLOOM_SCENARIOS.two);
    expect(html).toContain(
      '<button type="button" class="vf-monitor-list-new" aria-haspopup="menu" aria-expanded="false" data-list-spawn-button="">＋ TERMINAL</button>',
    );
    expect(html).not.toContain('role="menu"');
  });

  it('with a tree that offers none, a plain button again (it creates under the one choice)', () => {
    expect(markup(BLOOM_SCENARIOS['one-one'])).toContain(
      '<button type="button" class="vf-monitor-list-new">＋ TERMINAL</button>',
    );
  });
});
