// Host-neutral pictures for the bloom's drawn fuel (`MonitorSpawnFuel.drawn`), for its tests: two bands at each bud
// size and a dashed thread. A host's own numbers are its own; these only exercise what the bud draws. Internal: the
// views index does not export this file, so the public surface is the port's types alone.

import type { MonitorSpawnFuel, MonitorSpawnFuelDrawing, MonitorSpawnMenu } from '@vibefield/puppeteer-view-sdk';
import { BLOOM_SCENARIOS, type BloomScenarioId } from './scenarios.js';

/** A first-ring bud's picture: two whole tracks, the outer a quarter filled, the inner three quarters filled hot and at
 * half, and a notch at three o'clock. */
export const FUEL_48: MonitorSpawnFuelDrawing = {
  size: 48,
  arcs: [
    { r: 21.6, width: 3.2, from: -90, to: 270, tone: 'ink', percent: 12, cap: 'round' },
    { r: 21.6, width: 3.2, from: -90, to: 0, tone: 'ink', percent: 64, cap: 'round' },
    { r: 17.6, width: 3.2, from: -90, to: 270, tone: 'ink', percent: 12 },
    { r: 17.6, width: 3.2, from: -90, to: 180, tone: 'hot', percent: 88, opacity: 0.5, cap: 'round' },
  ],
  notches: [{ x1: 42, y1: 24, x2: 49, y2: 24, width: 1.25, tone: 'ink', percent: 84 }],
};

/** The same picture drawn for a second-ring bud. */
export const FUEL_42: MonitorSpawnFuelDrawing = {
  size: 42,
  arcs: [
    { r: 18.9, width: 2.8, from: -90, to: 270, tone: 'ink', percent: 12, cap: 'round' },
    { r: 18.9, width: 2.8, from: -90, to: 0, tone: 'ink', percent: 64, cap: 'round' },
    { r: 15, width: 2.8, from: -90, to: 270, tone: 'ink', percent: 12 },
    { r: 15, width: 2.8, from: -90, to: 180, tone: 'hot', percent: 88, opacity: 0.5, cap: 'round' },
  ],
  notches: [{ x1: 36, y1: 21, x2: 42.5, y2: 21, width: 1.25, tone: 'ink', percent: 84 }],
};

/** A first-ring bud with no reading to draw, for a reason worth showing: a whole ring of dots (a near-zero dash with
 * round caps). */
export const FUEL_THREAD: MonitorSpawnFuelDrawing = {
  size: 48,
  arcs: [{ r: 19.5, width: 1.8, from: -90, to: 270, tone: 'ink', percent: 46, cap: 'round', dash: [0.01, 4.8] }],
};

/** A scenario's menu with some of its profiles' fuel set; a key holding `undefined` sets the field to nothing. */
export const fuelled = (
  id: BloomScenarioId,
  fuels: Readonly<Record<string, MonitorSpawnFuel | undefined>>,
): MonitorSpawnMenu => ({
  devices: BLOOM_SCENARIOS[id].devices.map((device) => ({
    ...device,
    profiles: device.profiles?.map((profile) =>
      profile.id in fuels ? { ...profile, fuel: fuels[profile.id] } : profile,
    ),
  })),
});
