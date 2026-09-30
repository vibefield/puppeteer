import { describe, expect, it } from 'vitest';
import type { MonitorAgent } from '../../../monitor/types.js';
import { BIRTH_WAIT_MS, birthAgent, birthOf, birthOverdue, birthRow, profileLineFor } from './birth.js';
import { BLOOM } from './constants.js';
import type { BloomChoice } from './model.js';
import { BLOOM_SCENARIOS } from './scenarios.js';

const studio = BLOOM_SCENARIOS.two.devices[0]!;
const mini = BLOOM_SCENARIOS.two.devices[1]!;
const work = studio.profiles!.find((p) => p.id === 'work')!;

const choice = (patch: Partial<BloomChoice> = {}): BloomChoice => ({
  deviceId: studio.id,
  profileSet: work.id,
  at: { x: 420.5, y: 210.25 },
  device: studio,
  profile: work,
  via: 'profile',
  from: { d: 48 * BLOOM.hot, fill: 'ink' },
  ...patch,
});
const row = (id: string, spawnHint?: { x: number; y: number }): MonitorAgent => ({
  id,
  createdAtMs: 0,
  status: 'idle',
  project: 'p',
  detail: '',
  color: '#888',
  active: false,
  ...(spawnHint ? { spawnHint } : {}),
});

describe('a birth', () => {
  const birth = birthOf({
    id: 'b1',
    choice: choice(),
    menu: BLOOM_SCENARIOS.two,
    idleRadius: 50,
    now: 1000,
    nowMs: 5_000,
    rows: [row('old', { x: 420.5, y: 210.25 })],
  });

  it('starts from the chosen bud’s hot size, where the person let go, under the profile it was born under', () => {
    expect(birth.from).toBeCloseTo((48 * BLOOM.hot) / 100, 6);
    expect(birth.at).toEqual({ x: 420.5, y: 210.25 });
    expect(birth.on).toBeUndefined();
    expect(birth.profile).toEqual({ label: 'Work', glyph: 'briefcase', kind: 'managed', isDefault: true });
    expect(birthAgent(birth)).toMatchObject({ id: 'b1', status: 'idle', createdAtMs: 5_000 });
  });

  it('on a peer says where, and keeps no profile line (its body has its host line)', () => {
    const peer = birthOf({
      id: 'b2',
      choice: choice({ deviceId: mini.id, device: mini, profileSet: 'personal', profile: mini.profiles![1]! }),
      menu: BLOOM_SCENARIOS.two,
      idleRadius: 50,
      now: 0,
      nowMs: 0,
      rows: [],
    });
    expect(peer.on).toBe('mini');
    expect(peer.profile).toBeUndefined();
  });

  it('is taken over by a NEW row spawned at its point, not by one that was there', () => {
    expect(birthRow(birth, [row('old', { x: 420.5, y: 210.25 })])).toBeUndefined();
    expect(birthRow(birth, [row('elsewhere', { x: 10, y: 10 }), row('no-hint')])).toBeUndefined();
    expect(birthRow(birth, [row('new', { x: 420.5, y: 210.5 })])?.id).toBe('new');
  });

  it('waits for its row once the host has answered, then is given up', () => {
    expect(birthOverdue(birth, 1_000_000)).toBe(false);
    const answered = { ...birth, answeredAt: 2000 };
    expect(birthOverdue(answered, 2000 + BIRTH_WAIT_MS - 1)).toBe(false);
    expect(birthOverdue(answered, 2000 + BIRTH_WAIT_MS)).toBe(true);
    expect(birthOverdue({ ...answered, failedAt: 2100 }, 1_000_000)).toBe(false);
  });
});

describe('the profile line', () => {
  it('names a profile of the desktop you sit at only when it has more than one', () => {
    expect(profileLineFor(BLOOM_SCENARIOS['one-three'], 'demo')).toEqual({
      label: 'Demo',
      glyph: 'flask',
      kind: 'managed',
      isDefault: undefined,
    });
    expect(profileLineFor(BLOOM_SCENARIOS['one-one'], 'native')).toBeUndefined();
    expect(profileLineFor(BLOOM_SCENARIOS['one-three'], 'elsewhere')).toBeUndefined();
    expect(profileLineFor(BLOOM_SCENARIOS['one-three'], undefined)).toBeUndefined();
    expect(profileLineFor(undefined, 'demo')).toBeUndefined();
  });
});
