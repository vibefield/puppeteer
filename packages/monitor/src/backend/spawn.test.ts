import { describe, expect, it } from 'vitest';
import type { MonitorAgentRow } from '@vibecook/puppeteer-view-sdk/model';
import type { MonitorHostProfileSet } from './ports.js';
import { blockedProfileSets, signedInLabels, spawnMenuOf } from './spawn.js';
import { DEVICE, T0 } from './testing/fixtures.js';

const native: MonitorHostProfileSet = {
  id: 'native',
  label: 'This Mac',
  kind: 'native',
  isDefault: true,
  personas: [
    { profileId: 'p-claude', providerLabel: 'Claude Code', loggedIn: true },
    { profileId: 'p-codex', providerLabel: 'Codex' },
    { profileId: 'p-claude-2', providerLabel: 'Claude Code', loggedIn: true },
  ],
};
const work: MonitorHostProfileSet = {
  id: 'work',
  label: 'Work',
  kind: 'managed',
  glyph: 'W',
  isDefault: false,
  personas: [
    { profileId: 'w-codex', providerLabel: 'Codex' },
    { profileId: 'w-claude', providerLabel: 'Claude Code', loggedIn: false },
  ],
};

const row = (overrides: Partial<MonitorAgentRow>): MonitorAgentRow => ({
  id: 'r',
  kind: 'agent',
  createdAt: T0,
  status: 'blocked',
  statusSince: T0,
  stale: false,
  alive: true,
  detail: 'permission · Bash',
  project: { name: 'repo' },
  unread: false,
  device: DEVICE,
  attachable: true,
  ...overrides,
});

describe('the spawn menu', () => {
  it('reads as one desktop with no profiles until the feed answers', () => {
    expect(spawnMenuOf({ device: DEVICE, profileSets: null }, new Set())).toEqual({
      devices: [{ id: 'desk-1', label: 'Studio', self: true, state: 'reading' }],
    });
  });

  it("lists this desktop's profiles in the feed's order, with the dot, the default and who is signed in", () => {
    const menu = spawnMenuOf({ device: DEVICE, profileSets: [native, work] }, new Set(['work']));
    expect(menu).toEqual({
      devices: [
        {
          id: 'desk-1',
          label: 'Studio',
          self: true,
          state: 'ready',
          profiles: [
            { id: 'native', label: 'This Mac', kind: 'native', isDefault: true, signedIn: ['Claude Code'] },
            {
              id: 'work',
              label: 'Work',
              glyph: 'W',
              kind: 'managed',
              isDefault: false,
              blocked: true,
              signedIn: ['Codex', 'Claude Code'],
            },
          ],
        },
      ],
    });
  });

  it('counts a managed profile’s sign-ins in any state and the native set’s only when logged in, once each', () => {
    expect(signedInLabels(native)).toEqual(['Claude Code']);
    expect(signedInLabels(work)).toEqual(['Codex', 'Claude Code']);
  });

  it('lights a profile only for a blocked agent row under it', () => {
    expect([
      ...blockedProfileSets([
        row({ id: 'a', status: 'blocked', profileSet: 'work' }),
        row({ id: 'b', status: 'working', profileSet: 'native' }),
        row({ id: 'c', status: 'blocked' }),
        row({ id: 't', kind: 'terminal', status: 'blocked', profileSet: 'play' }),
      ]),
    ]).toEqual(['work']);
  });

  it('appends the peers as the host words them', () => {
    const peer = { id: 'desk-2', label: 'Laptop', state: 'asleep' as const, word: 'ASLEEP · 2 H', phrase: 'is asleep' };
    expect(spawnMenuOf({ device: DEVICE, profileSets: [], spawnPeers: [peer] }, new Set()).devices).toEqual([
      { id: 'desk-1', label: 'Studio', self: true, state: 'ready', profiles: [] },
      peer,
    ]);
  });
});
