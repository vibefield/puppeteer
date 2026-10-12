import { describe, expect, it } from 'vitest';
import type { MonitorSpawnDevice, MonitorSpawnProfile } from '@vibefield/puppeteer-view-sdk';
import {
  blooms,
  budSub,
  defaultProfile,
  deviceWord,
  glyphName,
  initials,
  menuOf,
  profileWord,
  ready,
  selfDevice,
} from './menu.js';
import { BLOOM_SCENARIOS } from './scenarios.js';

const device = (patch: Partial<MonitorSpawnDevice> & { id: string }): MonitorSpawnDevice => ({
  label: patch.id,
  state: 'ready',
  ...patch,
});

describe('menuOf', () => {
  it('blooms desktops when there are two, the hub being this desktop under its default', () => {
    const menu = menuOf(BLOOM_SCENARIOS.two);
    expect(menu.kind).toBe('devices');
    if (menu.kind === 'instant') throw new Error('unreachable');
    expect(menu.items.map((i) => [i.kind, i.device.id, i.profile?.id])).toEqual([
      ['device', 'studio', 'work'],
      ['device', 'mini', 'native'],
    ]);
    expect(menu.hub.device.id).toBe('studio');
    expect(menu.hub.profile?.id).toBe('work');
  });

  it('blooms one desktop’s profiles when it has two or more', () => {
    const menu = menuOf(BLOOM_SCENARIOS['one-three']);
    expect(menu.kind).toBe('profiles');
    if (menu.kind === 'instant') throw new Error('unreachable');
    expect(menu.items.map((i) => i.profile?.id)).toEqual(['native', 'work', 'demo']);
    expect(menu.hub.profile?.id).toBe('work');
  });

  it('does not bloom one desktop with one profile, or none', () => {
    const one = menuOf(BLOOM_SCENARIOS['one-one']);
    expect(one.kind).toBe('instant');
    expect(one.hub.device?.id).toBe('studio');
    expect(one.hub.profile?.id).toBe('native');
    const bare = menuOf({ devices: [device({ id: 'studio', self: true })] });
    expect(bare).toMatchObject({ kind: 'instant', hub: { profile: null } });
    expect(menuOf({ devices: [] })).toEqual({ kind: 'instant', self: null, hub: { device: null, profile: null } });
  });

  it('finds the desktop you sit at wherever it is in the list', () => {
    const tree = { devices: [device({ id: 'mini' }), device({ id: 'studio', self: true })] };
    expect(selfDevice(tree)?.id).toBe('studio');
    expect(selfDevice({ devices: [device({ id: 'mini' })] })?.id).toBe('mini');
  });
});

describe('the menu’s words and faces', () => {
  it('a default profile is the one marked, else the first, else none', () => {
    const [studio, mini] = BLOOM_SCENARIOS.two.devices as [MonitorSpawnDevice, MonitorSpawnDevice];
    expect(defaultProfile(studio)?.id).toBe('work');
    expect(defaultProfile(mini)?.id).toBe('native');
    expect(defaultProfile(device({ id: 'x', profiles: [{ id: 'a', label: 'A' }] }))?.id).toBe('a');
    expect(defaultProfile(device({ id: 'x', state: 'reading' }))).toBeNull();
  });

  it('ready: a ready desktop, and one still reading its profiles', () => {
    expect(ready(device({ id: 'a' }))).toBe(true);
    expect(ready(device({ id: 'a', state: 'reading' }))).toBe(true);
    for (const state of ['asleep', 'silent', 'incompatible'] as const)
      expect(ready(device({ id: 'a', state }))).toBe(false);
    // reading has no profiles yet: it does not bloom
    expect(blooms(device({ id: 'a', state: 'reading' }))).toBe(false);
  });

  it('initials take two letters where they clash', () => {
    const list = ['studio', 'mini', 'Mac-Studio', 'air', '—'].map((label) => device({ id: label, label }));
    expect(initials(list)).toEqual(['S', 'MI', 'MA', 'A', '?']);
  });

  it('a peer’s native set reads DEFAULT (SB-D10); this desktop’s keeps its name', () => {
    const [studio, mini] = BLOOM_SCENARIOS.two.devices as [MonitorSpawnDevice, MonitorSpawnDevice];
    const native = (mini.profiles ?? [])[0] as MonitorSpawnProfile;
    expect(profileWord(native, mini)).toBe('DEFAULT');
    expect(profileWord((studio.profiles ?? [])[0], studio)).toBe('THIS MAC');
    expect(profileWord((mini.profiles ?? [])[1], mini)).toBe('PERSONAL');
    expect(profileWord(null, mini)).toBe('ITS DEFAULT');
    expect(deviceWord(mini)).toBe('MINI');
  });

  it('a desktop’s state line: HERE, a peer’s own line, or why a faint one cannot', () => {
    const menu = menuOf(BLOOM_SCENARIOS.three);
    if (menu.kind === 'instant') throw new Error('unreachable');
    expect(menu.items.map(budSub)).toEqual(['HERE', '2 RUNNING', 'ASLEEP · 2 H']);
    expect(budSub({ kind: 'device', device: device({ id: 'x', state: 'silent' }), profile: null })).toBe('UNAVAILABLE');
  });

  it('a profile draws the laptop for a native set, its own glyph, or the star', () => {
    expect(glyphName({ id: 'native', label: 'This Mac', kind: 'native' })).toBe('laptop');
    expect(glyphName({ id: 'w', label: 'Work', glyph: 'briefcase' })).toBe('briefcase');
    expect(glyphName({ id: 'w', label: 'Work', glyph: 'no-such-glyph' })).toBe('star');
  });
});
