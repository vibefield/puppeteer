import type { MonitorSpawnDevice, MonitorSpawnMenu, MonitorSpawnProfile, MonitorSpawnTarget } from '../model.js';
import { profileGlyphName, type ProfileGlyphName } from './marks.js';

// THE SPAWN MENU'S TREE, AS A VIEW OFFERS IT (SB-D9, SB-D11): what blooms,
// what the hub means, and what every bud is called. The swarm's spawn bloom
// and the list's two-step menu read the same tree (capability `spawn`, MV-D4),
// so the reading is the toolkit's; it moved here from the bloom (the
// prototype's "the menu, from the host's tree" and "the words" helpers) with
// identical output, and the bloom re-exports it.

/** A desktop on the first ring; `profile` is its default (null while its profiles are being read). */
export interface BloomDeviceItem {
  readonly kind: 'device';
  readonly device: MonitorSpawnDevice;
  readonly profile: MonitorSpawnProfile | null;
}

/** An Agent Profile, on the first ring (one desktop) or the second (under a desktop). */
export interface BloomProfileItem {
  readonly kind: 'profile';
  readonly device: MonitorSpawnDevice;
  readonly profile: MonitorSpawnProfile;
}

export type BloomMenuItem = BloomDeviceItem | BloomProfileItem;

/** What the hub commits: the desktop you sit at, under its default. */
export interface BloomHub {
  readonly device: MonitorSpawnDevice;
  readonly profile: MonitorSpawnProfile | null;
}

/** A menu that blooms: desktops first (≥ 2 desktops), or one desktop's profiles (≥ 2 profiles). */
export interface BloomOpenMenu {
  readonly kind: 'devices' | 'profiles';
  readonly self: MonitorSpawnDevice;
  readonly hub: BloomHub;
  readonly items: readonly BloomMenuItem[];
}

/** No choice to make: one desktop with at most one profile (or none at all).
 * The hold creates at once, as it does today. */
export interface BloomInstantMenu {
  readonly kind: 'instant';
  readonly self: MonitorSpawnDevice | null;
  readonly hub: { readonly device: MonitorSpawnDevice | null; readonly profile: MonitorSpawnProfile | null };
}

export type BloomMenu = BloomOpenMenu | BloomInstantMenu;

/** A desktop's default profile: the one marked default, else its first; null while its profiles are being read. */
export function defaultProfile(device: MonitorSpawnDevice): MonitorSpawnProfile | null {
  const list = device.profiles ?? [];
  return list.find((p) => p.isDefault) ?? list[0] ?? null;
}

/** The desktop you sit at: the one marked `self`, else the first; null for an empty tree. */
export function selfDevice(tree: MonitorSpawnMenu): MonitorSpawnDevice | null {
  return tree.devices.find((d) => d.self) ?? tree.devices[0] ?? null;
}

/** Only real choices bloom: two desktops bloom desktops; one desktop with two
 * profiles blooms its profiles; one desktop with one profile does not bloom —
 * the hold creates at once, as it does today. */
export function menuOf(tree: MonitorSpawnMenu): BloomMenu {
  const self = selfDevice(tree);
  if (self && tree.devices.length >= 2) {
    return {
      kind: 'devices',
      self,
      hub: { device: self, profile: defaultProfile(self) },
      items: tree.devices.map((d): BloomDeviceItem => ({ kind: 'device', device: d, profile: defaultProfile(d) })),
    };
  }
  const profiles = self?.profiles ?? [];
  if (!self || profiles.length <= 1)
    return { kind: 'instant', self, hub: { device: self, profile: profiles[0] ?? null } };
  return {
    kind: 'profiles',
    self,
    hub: { device: self, profile: defaultProfile(self) },
    items: profiles.map((p): BloomProfileItem => ({ kind: 'profile', device: self, profile: p })),
  };
}

/** Whether a desktop can take a terminal now. `reading` counts: its profiles
 * are not known yet, so it does not bloom, and letting go on it opens its
 * default. The rest (asleep · silent · incompatible) stay in place, faint. */
export function ready(device: MonitorSpawnDevice): boolean {
  return device.state === 'ready' || device.state === 'reading';
}

/** Whether a desktop's bud opens a second ring: ready, with at least two profiles. */
export function blooms(device: MonitorSpawnDevice): boolean {
  return ready(device) && (device.profiles ?? []).length >= 2;
}

/**
 * A desktop's face: the initial of what it is called, two letters where
 * initials clash (DESIGN §13 has no desktop mark). `name` says what a view
 * calls it; by default its label.
 */
export function initials(
  devices: readonly MonitorSpawnDevice[],
  name: (device: MonitorSpawnDevice) => string = (device) => device.label,
): string[] {
  const names = devices.map((d) => (name(d) || '?').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || '?');
  return names.map((n, i) => {
    const one = n.slice(0, 1);
    const clash = names.some((m, j) => j !== i && m.slice(0, 1) === one);
    return clash ? n.slice(0, 2) : one;
  });
}

/** A profile's name, as its bud and the words say it. A PEER's native set is
 * not "This Mac" from where you stand: it reads DEFAULT (SB-D10, James: "let's
 * call it Default, which is more intuitive for users"). The native set on the
 * desktop you sit at keeps its own label. No profile (still being read): ITS DEFAULT. */
export function profileWord(
  profile: MonitorSpawnProfile | null | undefined,
  device?: MonitorSpawnDevice | null,
): string {
  if (!profile) return 'ITS DEFAULT';
  if (profile.kind === 'native' && device && !device.self) return 'DEFAULT';
  return profile.label.toUpperCase();
}

/** What the desktop you sit at is called in its state line and the words: its
 * `word` when the host gives one, else HERE (the prototype's `hereWord`). */
export function hereWord(device: MonitorSpawnDevice): string {
  return device.word || 'HERE';
}

/** The state line under a desktop's bud: why a faint one cannot take a
 * terminal, HERE for the one you sit at, a ready peer's own line. Profiles have none. */
export function budSub(item: BloomMenuItem): string {
  if (item.kind !== 'device') return '';
  const dv = item.device;
  if (!ready(dv)) return dv.word || 'UNAVAILABLE';
  if (dv.self) return hereWord(dv);
  return dv.word || '';
}

/** The glyph a profile's bud draws: the laptop for a native set, else its own (ProfileGlyph's names). */
export type BloomGlyphName = ProfileGlyphName | 'laptop';

export function glyphName(profile: MonitorSpawnProfile): BloomGlyphName {
  if (profile.kind === 'native') return 'laptop';
  return profileGlyphName(profile.glyph);
}

/**
 * What a choice asks the host for. It keys on `self`, never on an id string
 * (M34): the desktop you sit at is named by leaving the device out, which the
 * contract reads as this desktop; a peer is named by its id. A choice of
 * nothing in particular asks for nothing (`undefined`): this desktop, its default.
 */
export function spawnTargetFor(
  device: MonitorSpawnDevice | null | undefined,
  profile?: MonitorSpawnProfile | null,
): MonitorSpawnTarget | undefined {
  const deviceId = device && device.self !== true ? device.id : undefined;
  const profileSet = profile?.id;
  if (deviceId === undefined && profileSet === undefined) return undefined;
  return {
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(profileSet === undefined ? {} : { profileSet }),
  };
}
