// The prototype's scenarios (draft/spawn-bloom/data.js) as spawn menus: the
// trees the design was audited on, for tests, the lab and a host's catalog.

import type { MonitorSpawnDevice, MonitorSpawnMenu, MonitorSpawnProfile } from '../../../monitor/types.js';

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

export type BloomScenarioId = 'one-three' | 'one-one' | 'two' | 'three';

/** One Mac with three profiles (today's desktop: the bloom opens straight into
 * profiles, Work the default and blocked); one Mac with one profile (nothing
 * blooms); two desktops; three with one asleep. */
export const BLOOM_SCENARIOS: Readonly<Record<BloomScenarioId, MonitorSpawnMenu>> = {
  'one-three': { devices: [studio([NATIVE, WORK, DEMO])] },
  'one-one': { devices: [studio([{ ...NATIVE, isDefault: true }])] },
  two: { devices: [studio([NATIVE, WORK, DEMO]), MINI] },
  three: { devices: [studio([NATIVE, WORK, DEMO]), MINI, AIR] },
};
