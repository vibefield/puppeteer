// A birth on its way (SB §2.6): after a bloom commits, the swarm draws a
// pending terminal where the person let go until the host's row arrives — the
// row the host spawns at the very point it was asked for (`spawnHint`) — and
// that row then takes over in place. A refused create, or one answered with no
// row in time, shrinks away (M4). Pure: AgentSwarm keeps the birth and its
// clock; this decides what it is and when it is done.

import type { MonitorAgent, MonitorSpawnMenu } from '../../../../monitor/types.js';
import { clampSpawnPosition } from '../../../../views/swarm/physics/spawn-clamp.js';
import { selfDevice } from '../../../../views/swarm/bloom/menu.js';
import type { BloomChoice } from './model.js';

/** Once the host has answered, a birth waits this long for its row, then shrinks away. */
export const BIRTH_WAIT_MS = 4000;
/** A host that never answers at all: the birth is given up this long after it was born. */
export const BIRTH_GIVE_UP_MS = 30_000;
/** A row's spawn hint is the point asked for within this (the host copies the numbers it was given). */
const HINT_SLOP = 0.5;

/** The profile line a terminal body names (SB §2.10). */
export interface BirthProfile {
  readonly label: string;
  readonly glyph?: string | undefined;
  readonly kind?: 'native' | 'managed' | undefined;
  readonly isDefault?: boolean | undefined;
}

export interface BloomBirth {
  /** The pending body's own id: never a row's. */
  readonly id: string;
  /** Where it is born: the point handed to `createAt`, which the host's row carries as its spawn hint (the match). */
  readonly at: { readonly x: number; readonly y: number };
  /** Where it is DRAWN: `at` moved inside the field exactly as the physics will move the row that takes it
   * over (`clampSpawnPosition`), so a birth let go near an edge never jumps when its row arrives. */
  readonly drawAt: { readonly x: number; readonly y: number };
  /** The arrival's clock (the render loop's). */
  readonly bornAt: number;
  /** The models' clock (`Date.now()`) at the commit: its `opening.sinceMs`. */
  readonly sinceMs: number;
  /** The chosen bud at its hot size over an idle body's diameter: where the arrival starts (0: nothing). */
  readonly from: number;
  /** A peer it opens on (OPENING ON MINI); none for the desktop you sit at. */
  readonly on: string | undefined;
  readonly profile: BirthProfile | undefined;
  /** The rows there were when it was asked for: its row is a new one. */
  readonly before: ReadonlySet<string>;
  /** When the host answered: the wait for its row runs from then. */
  readonly answeredAt: number | null;
  /** When it was given up: it shrinks away from then. */
  readonly failedAt: number | null;
}

/** The profile line for a terminal born under `profileSet`, when the desktop you sit at has more than
 * one profile and that is one of them — naming the only profile there is tells nobody anything. */
export function profileLineFor(
  menu: MonitorSpawnMenu | undefined,
  profileSet: string | undefined,
): BirthProfile | undefined {
  if (!menu || !profileSet) return undefined;
  const profiles = selfDevice(menu)?.profiles ?? [];
  if (profiles.length < 2) return undefined;
  const profile = profiles.find((p) => p.id === profileSet);
  if (!profile) return undefined;
  return { label: profile.label, glyph: profile.glyph, kind: profile.kind, isDefault: profile.isDefault };
}

/** A birth for a bloom's commit. */
export function birthOf(input: {
  readonly id: string;
  readonly choice: BloomChoice;
  readonly menu: MonitorSpawnMenu | undefined;
  readonly idleRadius: number;
  /** The field's size, as the physics bounds it: where the row that takes the birth over may stand. */
  readonly field: { readonly width: number; readonly height: number };
  readonly now: number;
  readonly nowMs: number;
  readonly rows: readonly MonitorAgent[];
}): BloomBirth {
  const { choice } = input;
  const peer = choice.device && !choice.device.self ? choice.device : null;
  return {
    id: input.id,
    at: { x: choice.at.x, y: choice.at.y },
    drawAt:
      input.field.width > 0 && input.field.height > 0
        ? clampSpawnPosition(input.field.width, input.field.height, input.idleRadius, choice.at)
        : { x: choice.at.x, y: choice.at.y },
    bornAt: input.now,
    sinceMs: input.nowMs,
    from: choice.from ? choice.from.d / Math.max(1, input.idleRadius * 2) : 0,
    on: peer ? peer.label : undefined,
    // a peer's body keeps its host line; the one you sit at names its profile
    profile: peer ? undefined : profileLineFor(input.menu, choice.profileSet),
    before: new Set(input.rows.map((row) => row.visualId ?? row.id)),
    answeredAt: null,
    failedAt: null,
  };
}

/** The row that takes a birth over: new since it was asked for, spawned at the point it was born at. */
export function birthRow(birth: BloomBirth, rows: readonly MonitorAgent[]): MonitorAgent | undefined {
  return rows.find(
    (row) =>
      !birth.before.has(row.visualId ?? row.id) &&
      !!row.spawnHint &&
      Math.abs(row.spawnHint.x - birth.at.x) <= HINT_SLOP &&
      Math.abs(row.spawnHint.y - birth.at.y) <= HINT_SLOP,
  );
}

/** Whether a birth is to be given up now: answered and still rowless after the wait, or never answered at all
 * long after it was born (a host whose create never settles). A refusal gives it up where it is caught. */
export function birthOverdue(birth: BloomBirth, now: number): boolean {
  if (birth.failedAt !== null) return false;
  return birth.answeredAt !== null ? now - birth.answeredAt >= BIRTH_WAIT_MS : now - birth.bornAt >= BIRTH_GIVE_UP_MS;
}

/** The pending body's row, for its model: a terminal with no job and no folder yet. */
export function birthAgent(birth: BloomBirth): MonitorAgent {
  return {
    id: birth.id,
    createdAtMs: birth.sinceMs,
    status: 'idle',
    project: '~',
    detail: '',
    color: 'var(--text-faint)',
    active: false,
  };
}
