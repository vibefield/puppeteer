import { describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ExtensionInventory, ExtensionProvider, ExtensionService } from '@vibefield/puppeteer-core';
import { cloneExtensionProvider, composeExtensionProviders, createExtensionInventoryReader } from './inventory.js';

const PROVIDER: ExtensionProvider = {
  id: 'example',
  label: 'Example',
  support: {
    mcpServers: { store: 'profile', changes: 'command', read: true },
    skills: { store: 'shared', changes: 'folder', read: true },
  },
};

const NATIVE: AgentProfile = {
  id: 'example:native-default',
  provider: 'example',
  label: 'Default',
  kind: 'native-default',
  dataRoot: '/home/test/.example',
  createdAt: '1970-01-01T00:00:00.000Z',
};

const WORK: AgentProfile = {
  ...NATIVE,
  id: 'work-example',
  kind: 'managed',
  label: 'Work',
  dataRoot: '/profiles/work/example-0b7e2c4d',
};

function inventoryFor(profile: AgentProfile, items: ExtensionInventory['items'] = []): ExtensionInventory {
  return {
    provider: 'example',
    profileId: profile.id,
    fetchedAt: '2026-09-25T09:00:00.000Z',
    items,
    source: { kind: 'native-store', stability: 'documented' },
  };
}

function reader(service: ExtensionService, report = vi.fn()) {
  const profiles = new Map([NATIVE, WORK].map((profile) => [profile.id, profile]));
  return {
    report,
    reader: createExtensionInventoryReader({
      providers: new Map([['example', { provider: PROVIDER, service }]]),
      resolveProfile: async (providerId, profileId) => {
        const profile = profiles.get(profileId);
        return profile && profile.provider === providerId
          ? { profile }
          : { error: `unknown account profile: ${profileId}` };
      },
      nativeDefaultProfileId: (providerId) => (providerId === 'example' ? 'example:native-default' : undefined),
      report,
    }),
  };
}

describe('composeExtensionProviders', () => {
  it('keeps the providers that expose extensions and refuses one whose descriptor differs', () => {
    const service: ExtensionService = { provider: PROVIDER, inventory: async (profile) => inventoryFor(profile) };
    const entries = composeExtensionProviders([
      { descriptor: { id: 'example', label: 'Example' }, extensions: service },
      { descriptor: { id: 'plain', label: 'Plain' } },
    ]);
    expect([...entries.keys()]).toEqual(['example']);
    expect(() =>
      composeExtensionProviders([{ descriptor: { id: 'example', label: 'Other' }, extensions: service }]),
    ).toThrow(/does not match/);
  });

  it('hands out copies a caller cannot change', () => {
    const copy = cloneExtensionProvider(PROVIDER);
    copy.support.skills!.read = false;
    expect(PROVIDER.support.skills!.read).toBe(true);
    expect(copy.support.plugins).toBeUndefined();
  });
});

describe('createExtensionInventoryReader', () => {
  it('reads the native default when no profile is named, and a managed profile by id', async () => {
    const inventory = vi.fn(async (profile: AgentProfile) => inventoryFor(profile));
    const { reader: extensions } = reader({ provider: PROVIDER, inventory });
    expect(await extensions.inventory('example')).toMatchObject({ profileId: 'example:native-default' });
    expect(await extensions.inventory('example', 'work-example')).toMatchObject({ profileId: 'work-example' });
    expect(inventory.mock.calls.map(([profile]) => profile.kind)).toEqual(['native-default', 'managed']);
  });

  it('coalesces concurrent reads of one profile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inventory = vi.fn(async (profile: AgentProfile) => {
      await gate;
      return inventoryFor(profile);
    });
    const { reader: extensions } = reader({ provider: PROVIDER, inventory });
    const first = extensions.inventory('example', 'work-example');
    const second = extensions.inventory('example', 'work-example');
    release();
    expect(await first).toEqual(await second);
    expect(inventory).toHaveBeenCalledTimes(1);
    await extensions.inventory('example', 'work-example');
    expect(inventory).toHaveBeenCalledTimes(2);
  });

  it('answers typed failures for an unknown provider or profile', async () => {
    const { reader: extensions } = reader({ provider: PROVIDER, inventory: async (profile) => inventoryFor(profile) });
    expect(await extensions.inventory('nobody')).toMatchObject({ status: 'unsupported', retryable: false });
    expect(await extensions.inventory('example', 'missing')).toMatchObject({
      status: 'not-found',
      message: 'unknown account profile: missing',
    });
  });

  it('refuses an answer for another profile, a malformed one, and a kind the agent says it lacks', async () => {
    const answers: unknown[] = [
      inventoryFor(WORK),
      { ...inventoryFor(NATIVE), items: [{ kind: 'skill', id: 's', name: 's', origin: 'own', enabled: 'yes' }] },
      inventoryFor(NATIVE, [{ kind: 'plugin', id: 'p@m', name: 'p', origin: 'own', enabled: true }]),
    ];
    const { reader: extensions } = reader({
      provider: PROVIDER,
      inventory: async () => answers.shift() as ExtensionInventory,
    });
    expect(await extensions.inventory('example')).toMatchObject({
      status: 'invalid',
      message: expect.stringContaining('not example:native-default'),
    });
    expect(await extensions.inventory('example')).toMatchObject({
      status: 'invalid',
      message: expect.stringContaining('malformed'),
    });
    expect(await extensions.inventory('example')).toMatchObject({
      status: 'invalid',
      message: 'example declares no plugin kind but its inventory holds one',
    });
  });

  it('passes an adapter failure through under its provider, and turns a throw into a retryable one', async () => {
    const report = vi.fn();
    const answers: Array<() => unknown> = [
      () => ({ status: 'unavailable', message: 'store unreadable', retryable: true }),
      () => {
        throw new Error('boom');
      },
    ];
    const { reader: extensions } = reader(
      { provider: PROVIDER, inventory: async () => answers.shift()!() as ExtensionInventory },
      report,
    );
    expect(await extensions.inventory('example')).toEqual({
      status: 'unavailable',
      provider: 'example',
      message: 'store unreadable',
      retryable: true,
    });
    expect(await extensions.inventory('example')).toEqual({
      status: 'unavailable',
      provider: 'example',
      message: 'extension inventory failed for example',
      retryable: true,
    });
    expect(report).toHaveBeenCalledTimes(1);
  });
});
