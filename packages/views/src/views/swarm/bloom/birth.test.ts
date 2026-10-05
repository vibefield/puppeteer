import { describe, expect, it } from 'vitest';
import type { AgentView } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture } from '@vibecook/puppeteer-view-sdk/testing';
import { FRAME_HEADER_FLOATS, frameFloatsFor, SwarmPhysics } from '../physics/world.js';
import {
  BIRTH_GIVE_UP_MS,
  BIRTH_WAIT_MS,
  birthAgent,
  birthOf,
  birthOverdue,
  birthRow,
  profileLineFor,
} from './birth.js';
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
const row = (id: string, spawnHint?: { x: number; y: number }): AgentView =>
  agentViewFixture({
    id,
    kind: 'terminal',
    createdAt: 0,
    project: { name: 'p', seq: undefined },
    colour: '#888',
    ...(spawnHint ? { spawnHint } : {}),
  });

describe('a birth', () => {
  const birth = birthOf({
    id: 'b1',
    choice: choice(),
    menu: BLOOM_SCENARIOS.two,
    idleRadius: 50,
    field: { width: 1000, height: 600 },
    now: 1000,
    nowMs: 5_000,
    rows: [row('old', { x: 420.5, y: 210.25 })],
  });

  it('starts from the chosen bud’s hot size, where the person let go, under the profile it was born under', () => {
    expect(birth.from).toBeCloseTo((48 * BLOOM.hot) / 100, 6);
    expect(birth.at).toEqual({ x: 420.5, y: 210.25 });
    expect(birth.drawAt).toEqual(birth.at);
    expect(birth.on).toBeUndefined();
    expect(birth.profile).toEqual({ label: 'Work', glyph: 'briefcase', kind: 'managed', isDefault: true });
    // its body: a terminal on this desktop, in no folder, wearing the ramp it is handed
    expect(birthAgent(birth, 'rgba(0, 0, 0, 0.4)')).toMatchObject({
      id: 'b1',
      kind: 'terminal',
      status: 'idle',
      createdAt: 5_000,
      project: { name: '~' },
      colour: 'rgba(0, 0, 0, 0.4)',
      device: { self: true },
    });
  });

  it('on a peer says where, and keeps no profile line (its body has its host line)', () => {
    const peer = birthOf({
      id: 'b2',
      choice: choice({ deviceId: mini.id, device: mini, profileSet: 'personal', profile: mini.profiles![1]! }),
      menu: BLOOM_SCENARIOS.two,
      idleRadius: 50,
      field: { width: 1000, height: 600 },
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

  it('let go at an edge, is drawn where the physics will stand its row, and is still matched on the point asked for', () => {
    const edge = { x: 20, y: 590 };
    const field = { width: 1000, height: 600 };
    const input = {
      id: 'b3',
      choice: choice({ at: edge }),
      menu: BLOOM_SCENARIOS.two,
      idleRadius: 50,
      field,
      now: 0,
      nowMs: 0,
      rows: [],
    };
    const near = birthOf(input);
    // the row that takes it over, as the physics stands it (an idle terminal's radius)
    const physics = new SwarmPhysics({
      parameters: { gravityPull: 0, restitution: 0, frictionAir: 0.2, physicsHz: 30 },
      bounds: field,
      agents: [{ id: 'row', radius: 50, spawnHint: edge }],
      random: () => 0.5,
    });
    const frame = new Float32Array(frameFloatsFor(1));
    physics.writeFrame(frame);
    physics.dispose();
    expect(near.drawAt).not.toEqual(edge);
    expect(near.drawAt.x).toBeCloseTo(frame[FRAME_HEADER_FLOATS]!, 4);
    expect(near.drawAt.y).toBeCloseTo(frame[FRAME_HEADER_FLOATS + 1]!, 4);
    expect(near.at).toEqual(edge);
    expect(birthRow(near, [row('new', edge)])?.id).toBe('new');
    // a field not measured yet draws it where it was asked for
    expect(birthOf({ ...input, field: { width: 0, height: 0 } }).drawAt).toEqual(edge);
  });

  it('waits for its row once the host has answered, then is given up', () => {
    const answered = { ...birth, answeredAt: 2000 };
    expect(birthOverdue(answered, 2000 + BIRTH_WAIT_MS - 1)).toBe(false);
    expect(birthOverdue(answered, 2000 + BIRTH_WAIT_MS)).toBe(true);
    expect(birthOverdue({ ...answered, failedAt: 2100 }, 1_000_000)).toBe(false);
  });

  it('a host that never answers: waits for it, and is given up long after it was born', () => {
    expect(birthOverdue(birth, birth.bornAt + BIRTH_GIVE_UP_MS - 1)).toBe(false);
    expect(birthOverdue(birth, birth.bornAt + BIRTH_GIVE_UP_MS)).toBe(true);
    // a late answer still gets its full wait
    const late = { ...birth, answeredAt: birth.bornAt + BIRTH_GIVE_UP_MS - 1000 };
    expect(birthOverdue(late, birth.bornAt + BIRTH_GIVE_UP_MS)).toBe(false);
    expect(birthOverdue(late, late.answeredAt + BIRTH_WAIT_MS)).toBe(true);
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
