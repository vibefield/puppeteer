import { describe, expect, it } from 'vitest';
import { AgentProfileSchema, ProfileProviderSchema, type AgentProfile } from '@vibecook/puppeteer-core';
import { CODEX_PROFILE_ROOT_VARIABLE, codexProfileIdentityFrom, createCodexProfileService } from './profiles.js';
import type { Transport } from '../transport/app-server-client.js';

const HOME = '/Users/test';
const NOW = new Date('2026-09-06T12:00:00.000Z');

const managed: AgentProfile = AgentProfileSchema.parse({
  id: 'codex:7a10',
  provider: 'codex',
  label: 'Work',
  kind: 'managed',
  dataRoot: '/Users/test/.puppeteer/profiles/codex/7a10',
  createdAt: '2026-09-06T00:00:00.000Z',
});

const nativeDefault: AgentProfile = AgentProfileSchema.parse({
  id: 'codex:native-default',
  provider: 'codex',
  label: 'Default',
  kind: 'native-default',
  dataRoot: '/Users/test/.codex',
  createdAt: '2026-09-06T00:00:00.000Z',
});

/** A scripted app-server: answers `initialize` and `account/read` and records how it was spawned. */
function fakeAppServer(accountRead: unknown | (() => never)): {
  spawnTransport: (options: { executable?: string; env?: Record<string, string> }) => Transport;
  spawns: Array<{ executable?: string; env?: Record<string, string> }>;
  methods: string[];
  closed: () => boolean;
} {
  const spawns: Array<{ executable?: string; env?: Record<string, string> }> = [];
  const methods: string[] = [];
  let isClosed = false;
  return {
    spawns,
    methods,
    closed: () => isClosed,
    spawnTransport(options) {
      spawns.push(options);
      let onMessage: ((message: unknown) => void) | undefined;
      return {
        send(message) {
          const request = message as Record<string, unknown>;
          if (typeof request.method === 'string') methods.push(request.method);
          if (request.id === undefined) return;
          const result =
            request.method === 'account/read'
              ? typeof accountRead === 'function'
                ? (accountRead as () => never)()
                : accountRead
              : {};
          queueMicrotask(() => onMessage?.({ jsonrpc: '2.0', id: request.id, result }));
        },
        onMessage(handler) {
          onMessage = handler;
        },
        onClose() {},
        close() {
          isClosed = true;
        },
      };
    },
  };
}

function service(
  server: ReturnType<typeof fakeAppServer>,
  overrides: Partial<Parameters<typeof createCodexProfileService>[0]> = {},
): ReturnType<typeof createCodexProfileService> {
  return createCodexProfileService({
    executable: '/opt/node/bin/codex',
    home: HOME,
    env: {},
    now: () => NOW,
    spawnTransport: server.spawnTransport,
    ...overrides,
  });
}

describe('Codex profile provider', () => {
  it('declares a valid provider with the native default root and shared skills', () => {
    const { provider } = service(fakeAppServer({ account: null }));
    expect(() => ProfileProviderSchema.parse(provider)).not.toThrow();
    expect(provider.support).toMatchObject({
      supported: true,
      identity: 'native-protocol',
      nativeDefaultRoot: '/Users/test/.codex',
    });
    expect(provider.support.sharedSurfaces).toContain('~/.agents/skills');
  });

  it('binds a managed profile to its root and leaves the native default alone', () => {
    const profiles = service(fakeAppServer({ account: null }));
    expect(profiles.bindingEnvironment(managed)).toEqual({
      [CODEX_PROFILE_ROOT_VARIABLE]: '/Users/test/.puppeteer/profiles/codex/7a10',
    });
    expect(profiles.bindingEnvironment(nativeDefault)).toEqual({});
  });

  it('describes the native interactive login as a terminal spec', () => {
    const spec = service(fakeAppServer({ account: null })).loginInvocation(managed, { cwd: '/work/repo' });
    expect(spec).toEqual({
      command: '/opt/node/bin/codex',
      args: ['login'],
      cwd: '/work/repo',
      env: { [CODEX_PROFILE_ROOT_VARIABLE]: '/Users/test/.puppeteer/profiles/codex/7a10' },
    });
  });
});

describe('Codex managed root initialization', () => {
  it('writes the credential store mode into a fresh root', async () => {
    const written: Array<{ path: string; contents: string }> = [];
    const profiles = service(fakeAppServer({ account: null }), {
      configExists: async () => false,
      writeConfig: async (path, contents) => {
        written.push({ path, contents });
      },
    });
    await profiles.initializeRoot?.(managed);
    expect(written).toEqual([
      {
        path: '/Users/test/.puppeteer/profiles/codex/7a10/config.toml',
        contents: 'cli_auth_credentials_store = "file"\n',
      },
    ]);
  });

  it('never overwrites a root that already has a config', async () => {
    const written: string[] = [];
    const profiles = service(fakeAppServer({ account: null }), {
      configExists: async () => true,
      writeConfig: async (path) => {
        written.push(path);
      },
    });
    await profiles.initializeRoot?.(managed);
    expect(written).toEqual([]);
  });

  it('writes nothing for the native default root', async () => {
    const written: string[] = [];
    const profiles = service(fakeAppServer({ account: null }), {
      configExists: async () => false,
      writeConfig: async (path) => {
        written.push(path);
      },
    });
    await profiles.initializeRoot?.(nativeDefault);
    expect(written).toEqual([]);
  });
});

describe('Codex profile verification', () => {
  it('reads a ChatGPT account through the app-server bound to the profile root', async () => {
    const server = fakeAppServer({
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    });
    const identity = await service(server).verify(managed);
    expect(identity).toEqual({
      loggedIn: true,
      method: 'chatgpt',
      email: 'dev@example.com',
      plan: 'pro',
      verifiedAt: NOW.toISOString(),
      source: { kind: 'native-protocol', stability: 'documented' },
    });
    expect(server.spawns).toEqual([
      { executable: '/opt/node/bin/codex', env: { CODEX_HOME: '/Users/test/.puppeteer/profiles/codex/7a10' } },
    ]);
    expect(server.methods).toEqual(['initialize', 'initialized', 'account/read']);
    expect(server.closed()).toBe(true);
  });

  it('spawns the app-server without a binding for the native default profile', async () => {
    const server = fakeAppServer({ account: { type: 'apikey' }, requiresOpenaiAuth: false });
    const identity = await service(server).verify(nativeDefault);
    expect(identity).toMatchObject({ loggedIn: true, method: 'apikey' });
    expect(server.spawns).toEqual([{ executable: '/opt/node/bin/codex' }]);
  });

  it('reports a root with no account as logged out', async () => {
    const identity = await service(fakeAppServer({ account: null, requiresOpenaiAuth: true })).verify(managed);
    expect(identity).toEqual({
      loggedIn: false,
      verifiedAt: NOW.toISOString(),
      source: { kind: 'native-protocol', stability: 'documented' },
    });
  });

  it('fails when the app-server cannot answer', async () => {
    const server = fakeAppServer(() => {
      throw new Error('app-server exploded');
    });
    expect(await service(server).verify(managed)).toMatchObject({
      status: 'unavailable',
      provider: 'codex',
      retryable: true,
    });
    expect(server.closed()).toBe(true);
  });
});

describe('Codex account decoding', () => {
  it('treats a response without the account key as unrecognized, not logged out', () => {
    expect(codexProfileIdentityFrom({ requiresOpenaiAuth: true }, NOW.toISOString())).toMatchObject({
      status: 'unavailable',
    });
    expect(codexProfileIdentityFrom(undefined, NOW.toISOString())).toMatchObject({ status: 'unavailable' });
  });

  it('keeps an unfamiliar account type rather than dropping it', () => {
    expect(codexProfileIdentityFrom({ account: { type: 'device' } }, NOW.toISOString())).toMatchObject({
      loggedIn: true,
      method: 'device',
    });
  });
});
