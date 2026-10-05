import { describe, expect, it } from 'vitest';
import type { MonitorSpawnDevice, MonitorSpawnMenu, MonitorSpawnProfile } from '../model.js';
import { fixtureSpawnMenu } from '../testing/fixtures.js';
import {
  blooms,
  budSub,
  defaultProfile,
  glyphName,
  initials,
  menuOf,
  profileWord,
  ready,
  selfDevice,
  spawnTargetFor,
} from './spawn-menu.js';
import { deviceWord } from './words.js';

const device = (patch: Partial<MonitorSpawnDevice> & { id: string }): MonitorSpawnDevice => ({
  label: patch.id,
  state: 'ready',
  ...patch,
});
const NATIVE: MonitorSpawnProfile = { id: 'native', label: 'This Mac', kind: 'native' };
const WORK: MonitorSpawnProfile = { id: 'work', label: 'Work', kind: 'managed', glyph: 'briefcase', isDefault: true };

describe('the tree a view offers', () => {
  it('two desktops bloom desktops, the hub being the one you sit at under its default', () => {
    const menu = menuOf(fixtureSpawnMenu());
    expect(menu.kind).toBe('devices');
    if (menu.kind === 'instant') throw new Error('unreachable');
    expect(menu.self.id).toBe('desk');
    expect(menu.hub).toMatchObject({ device: { id: 'desk' }, profile: { id: 'native' } });
    expect(menu.items.map((item) => item.device.id)).toEqual(['desk', 'studio', 'laptop', 'tower']);
  });

  it('one desktop blooms its profiles when it has two, and none when it has one or none', () => {
    const two = menuOf({ devices: [device({ id: 'desk', self: true, profiles: [NATIVE, WORK] })] });
    expect(two).toMatchObject({ kind: 'profiles', hub: { profile: { id: 'work' } } });
    const one = menuOf({ devices: [device({ id: 'desk', self: true, profiles: [NATIVE] })] });
    expect(one).toEqual({
      kind: 'instant',
      self: expect.objectContaining({ id: 'desk' }),
      hub: { device: expect.objectContaining({ id: 'desk' }), profile: NATIVE },
    });
    // Puppeteer's Godview today: this desktop with no profile sets. The hold creates at once.
    expect(menuOf({ devices: [device({ id: 'desk', self: true, profiles: [] })] }).kind).toBe('instant');
    expect(menuOf({ devices: [] })).toEqual({ kind: 'instant', self: null, hub: { device: null, profile: null } });
  });

  it('finds the desktop you sit at wherever it stands, else the first', () => {
    const tree: MonitorSpawnMenu = { devices: [device({ id: 'mini' }), device({ id: 'desk', self: true })] };
    expect(selfDevice(tree)?.id).toBe('desk');
    expect(selfDevice({ devices: [device({ id: 'mini' })] })?.id).toBe('mini');
  });

  it('reads defaults, readiness and blooming as the bloom does', () => {
    expect(defaultProfile(device({ id: 'a', profiles: [NATIVE, WORK] }))?.id).toBe('work');
    expect(defaultProfile(device({ id: 'a', profiles: [NATIVE] }))?.id).toBe('native');
    expect(defaultProfile(device({ id: 'a', state: 'reading' }))).toBeNull();
    expect(ready(device({ id: 'a', state: 'reading' }))).toBe(true);
    for (const state of ['asleep', 'silent', 'incompatible'] as const)
      expect(ready(device({ id: 'a', state }))).toBe(false);
    expect(blooms(device({ id: 'a', profiles: [NATIVE, WORK] }))).toBe(true);
    expect(blooms(device({ id: 'a', state: 'asleep', profiles: [NATIVE, WORK] }))).toBe(false);
  });
});

describe('its words and faces', () => {
  it('faces a desktop by its initial, two letters where they clash, by label or by what a view calls it', () => {
    const list = ['studio', 'mini', 'Mac-Studio', 'air', '—'].map((label) => device({ id: label, label }));
    expect(initials(list)).toEqual(['S', 'MI', 'MA', 'A', '?']);
    const named = [device({ id: 'desk', label: 'Studio', self: true }), device({ id: 'tower', label: 'tower' })];
    expect(initials(named)).toEqual(['S', 'T']);
    // By the word a view shows: the desktop you sit at reads "This desktop", so its face is T, and T clashes.
    expect(initials(named, deviceWord)).toEqual(['TH', 'TO']);
  });

  it('a peer’s native set reads DEFAULT (SB-D10); the one you sit at keeps its name', () => {
    const peer = device({ id: 'mini', profiles: [NATIVE] });
    const here = device({ id: 'desk', self: true, profiles: [NATIVE] });
    expect(profileWord(NATIVE, peer)).toBe('DEFAULT');
    expect(profileWord(NATIVE, here)).toBe('THIS MAC');
    expect(profileWord(WORK, peer)).toBe('WORK');
    expect(profileWord(null, peer)).toBe('ITS DEFAULT');
  });

  it('says a desktop’s state line: HERE, a peer’s own line, or why a faint one cannot', () => {
    const menu = menuOf(fixtureSpawnMenu());
    if (menu.kind === 'instant') throw new Error('unreachable');
    expect(menu.items.map(budSub)).toEqual(['HERE', '2 RUNNING', 'ASLEEP · 2 H', '']);
    expect(budSub({ kind: 'device', device: device({ id: 'x', state: 'silent' }), profile: null })).toBe('UNAVAILABLE');
    expect(budSub({ kind: 'profile', device: device({ id: 'x' }), profile: WORK })).toBe('');
  });

  it('draws the laptop for a native set, its own glyph, or the star', () => {
    expect(glyphName(NATIVE)).toBe('laptop');
    expect(glyphName(WORK)).toBe('briefcase');
    expect(glyphName({ id: 'w', label: 'W', glyph: 'no-such-glyph' })).toBe('star');
  });
});

describe('what a choice asks for', () => {
  it('keys on self: the desktop you sit at is named by leaving the device out, never by its id (M34)', () => {
    const here = device({ id: 'mbp-7', label: 'Studio', self: true });
    expect(spawnTargetFor(here, WORK)).toEqual({ profileSet: 'work' });
    expect(spawnTargetFor(here, null)).toBeUndefined();
    expect(spawnTargetFor(device({ id: 'here', self: true }))).toBeUndefined();
  });

  it('names a peer by its id, with the profile chosen under it', () => {
    const peer = device({ id: 'studio' });
    expect(spawnTargetFor(peer, NATIVE)).toEqual({ deviceId: 'studio', profileSet: 'native' });
    expect(spawnTargetFor(peer)).toEqual({ deviceId: 'studio' });
    expect(spawnTargetFor(null, null)).toBeUndefined();
  });
});
