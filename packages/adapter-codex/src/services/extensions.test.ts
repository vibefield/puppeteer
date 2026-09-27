import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentProfileSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type ExtensionInventory,
  type ExtensionItem,
} from '@vibecook/puppeteer-core';
import type { Transport } from '../transport/app-server-client.js';
import { createCodexExtensionService, type CodexExtensionOptions } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-extensions-')));
  made.push(dir);
  return dir;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

const managedProfile = (root: string) =>
  AgentProfileSchema.parse({
    id: 'work-codex',
    provider: 'codex',
    label: 'Work',
    kind: 'managed',
    dataRoot: root,
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const nativeProfile = (root: string) =>
  AgentProfileSchema.parse({
    id: 'codex:native-default',
    provider: 'codex',
    label: 'Default',
    kind: 'native-default',
    dataRoot: root,
    createdAt: '1970-01-01T00:00:00.000Z',
  });

type Answer = (params: Record<string, unknown>) => unknown;

/** A scripted app-server: answers by method, errors for a method it has no answer for, records every request. */
function fakeAppServer(answers: Record<string, Answer>) {
  const spawns: Array<{ executable?: string; env?: Record<string, string>; cwd?: string }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let closed = false;
  const spawnTransport = (options: { executable?: string; env?: Record<string, string>; cwd?: string }): Transport => {
    spawns.push(options);
    let onMessage: ((message: unknown) => void) | undefined;
    return {
      send(message) {
        const request = message as { id?: number; method?: string; params?: Record<string, unknown> };
        if (typeof request.method !== 'string') return;
        requests.push({ method: request.method, params: request.params });
        if (request.id === undefined) return;
        const answer = answers[request.method];
        queueMicrotask(() => {
          try {
            if (!answer) throw new Error(`no answer for ${request.method}`);
            onMessage?.({ jsonrpc: '2.0', id: request.id, result: answer(request.params ?? {}) });
          } catch (error) {
            onMessage?.({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String(error) } });
          }
        });
      },
      onMessage(handler) {
        onMessage = handler;
      },
      onClose() {},
      close() {
        closed = true;
      },
    };
  };
  return { spawnTransport, spawns, requests, closed: () => closed };
}

const user = (file: string) => ({ name: { type: 'user', file, profile: null }, version: 'sha256:user' });
const system = { name: { type: 'system', file: '/etc/codex/managed_config.toml' }, version: 'sha256:system' };

/** A profile as the reads would describe it, with a secret in every place a listing can carry one. */
function answersFor(home: string, root: string): Record<string, Answer> {
  const runtimeMarketplace = join(home, '.cache', 'codex-runtimes', 'plugins', 'openai-primary-runtime');
  return {
    initialize: () => ({ userAgent: 'codex/0.150.0', codexHome: root }),
    'skills/list': () => ({
      data: [
        {
          cwd: root,
          skills: [
            {
              name: 'release-notes',
              description: 'Drafts release notes from merged pull requests',
              path: join(home, '.agents', 'skills', 'release-notes', 'SKILL.md'),
              scope: 'user',
              enabled: true,
              pluginId: null,
            },
            {
              name: 'changelog',
              description: 'Writes the changelog entry',
              path: join(home, '.agents', 'skills', 'changelog', 'SKILL.md'),
              scope: 'user',
              enabled: false,
              pluginId: null,
            },
            {
              name: 'skill-creator',
              description: 'Creates a skill',
              path: join(root, 'skills', '.system', 'skill-creator', 'SKILL.md'),
              scope: 'system',
              enabled: true,
              pluginId: null,
            },
            {
              name: 'documents:documents',
              description: 'Reads and writes documents',
              path: join(root, 'plugins', 'cache', 'openai-primary-runtime', 'documents', '26.909.12148', 'SKILL.md'),
              scope: 'user',
              enabled: true,
              pluginId: 'documents@openai-primary-runtime',
            },
            {
              name: 'house-style',
              description: 'The organization’s style',
              path: '/etc/codex/skills/house-style/SKILL.md',
              scope: 'admin',
              enabled: true,
              pluginId: null,
            },
            {
              name: 'repo-only',
              description: 'Belongs to a repository',
              path: '/work/repo/.agents/skills/repo-only/SKILL.md',
              scope: 'repo',
              enabled: true,
              pluginId: null,
            },
          ],
          errors: [],
        },
      ],
    }),
    'plugin/installed': () => ({
      marketplaces: [
        {
          name: 'openai-primary-runtime',
          path: join(runtimeMarketplace, 'marketplace.json'),
          interface: null,
          plugins: [
            {
              id: 'documents@openai-primary-runtime',
              name: 'documents',
              version: null,
              localVersion: '26.909.12148',
              source: { type: 'local', path: join(runtimeMarketplace, 'documents') },
              installed: true,
              enabled: true,
              installPolicy: 'INSTALLED_BY_DEFAULT',
              installPolicySource: null,
              authPolicy: 'ON_USE',
              interface: { displayName: 'Documents', shortDescription: 'Create and edit documents' },
              keywords: [],
            },
          ],
        },
        {
          name: 'personal',
          path: join(home, '.agents', 'plugins', 'marketplace.json'),
          interface: null,
          plugins: [
            {
              id: 'review@personal',
              name: 'review',
              localVersion: 'local',
              source: { type: 'local', path: join(home, 'plugins', 'review') },
              installed: true,
              enabled: false,
              installPolicy: 'AVAILABLE',
              installPolicySource: null,
              authPolicy: 'ON_USE',
              interface: null,
            },
            {
              id: 'draft@personal',
              name: 'draft',
              source: { type: 'local', path: join(home, 'plugins', 'draft') },
              installed: false,
              enabled: false,
              installPolicy: 'AVAILABLE',
              authPolicy: 'ON_USE',
            },
          ],
        },
        {
          name: 'openai-curated-remote',
          path: null,
          interface: null,
          plugins: [
            {
              id: 'slack@openai-curated-remote',
              name: 'slack',
              version: '1.0.39',
              source: { type: 'remote' },
              installed: true,
              enabled: true,
              installPolicy: 'INSTALLED_BY_DEFAULT',
              installPolicySource: 'WORKSPACE_SETTING',
              authPolicy: 'ON_INSTALL',
              interface: null,
            },
          ],
        },
      ],
      marketplaceLoadErrors: [],
    }),
    'plugin/read': (params) => ({
      plugin: {
        marketplaceName: 'openai-primary-runtime',
        summary: { id: `${String(params.pluginName)}@openai-primary-runtime` },
        skills: [],
        hooks: [],
        apps: [],
        appTemplates: [],
        mcpServers: params.pluginName === 'documents' ? ['documents_mcp'] : [],
      },
    }),
    'config/read': () => ({
      // The merged config comes back whole, secrets included; only `origins` may be kept.
      config: {
        mcp_servers: {
          linear: { url: 'https://mcp.linear.app/mcp', bearer_token_env_var: 'LINEAR_TOKEN' },
          postgres: { command: 'npx', env: { PGPASSWORD: 'hunter2' } },
        },
        model_providers: { proxy: { experimental_bearer_token: 'sk-provider-secret' } },
      },
      origins: {
        model: user(join(root, 'config.toml')),
        'mcp_servers.linear.url': user(join(root, 'config.toml')),
        'mcp_servers.linear.bearer_token_env_var': user(join(root, 'config.toml')),
        'mcp_servers.postgres.command': user(join(root, 'config.toml')),
        'mcp_servers.postgres.env.PGPASSWORD': user(join(root, 'config.toml')),
        'mcp_servers.notion.url': user(join(root, 'config.toml')),
        'mcp_servers.sentry.url': user(join(root, 'config.toml')),
        'mcp_servers.corp-search.url': system,
      },
    }),
  };
}

const LISTING = JSON.stringify([
  {
    name: 'codex_apps',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'streamable_http',
      url: 'https://chatgpt.com/backend-api/wham/apps',
      bearer_token_env_var: null,
      http_headers: null,
      env_http_headers: null,
      http_headers_helper: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    auth_status: 'bearer_token',
  },
  {
    name: 'corp-search',
    enabled: true,
    transport: {
      type: 'streamable_http',
      url: 'https://search.corp.example/mcp?tenant=acme&key=sk-live-123',
      bearer_token_env_var: null,
      http_headers: { 'X-Api-Key': 'corp-secret-value' },
      env_http_headers: { 'X-Tenant': 'CORP_TENANT' },
      http_headers_helper: null,
    },
    auth_status: 'bearer_token',
  },
  {
    name: 'documents_mcp',
    enabled: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: null,
      env_vars: ['CODEX_HOME', { name: 'PATH', source: 'local' }],
      cwd: null,
    },
    auth_status: 'unsupported',
  },
  {
    name: 'linear',
    enabled: true,
    transport: {
      type: 'streamable_http',
      url: 'https://mcp.linear.app/mcp',
      bearer_token_env_var: 'LINEAR_TOKEN',
      http_headers: null,
      env_http_headers: null,
      http_headers_helper: null,
    },
    auth_status: 'bearer_token',
  },
  {
    name: 'notion',
    enabled: true,
    transport: { type: 'streamable_http', url: 'https://mcp.notion.com/mcp' },
    auth_status: 'o_auth',
  },
  {
    name: 'postgres',
    enabled: false,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://app:hunter2@localhost/dev'],
      env: { PGPASSWORD: 'hunter2' },
      env_vars: [],
      cwd: null,
    },
    auth_status: 'unsupported',
  },
  {
    name: 'sentry',
    enabled: true,
    transport: { type: 'streamable_http', url: 'https://mcp.sentry.dev/mcp' },
    auth_status: 'not_logged_in',
  },
]);

async function managedSetup() {
  const home = await tempHome();
  const root = join(home, 'profiles', 'work', 'codex-7a10');
  await mkdir(root, { recursive: true });
  await write(join(home, '.agents', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\n');
  const library = join(home, 'library', 'changelog');
  await write(join(library, 'SKILL.md'), '---\nname: changelog\n---\n');
  await symlink(library, join(home, '.agents', 'skills', 'changelog'));
  return { home, root, library };
}

function service(server: ReturnType<typeof fakeAppServer>, overrides: Partial<CodexExtensionOptions> = {}) {
  return createCodexExtensionService({
    executable: '/opt/node/bin/codex',
    env: {},
    now,
    spawnTransport: server.spawnTransport,
    listServers: async () => LISTING,
    ...overrides,
  });
}

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);

describe('Codex extensions', () => {
  it('declares the kinds Codex has and which it reads', () => {
    const { provider } = service(fakeAppServer({}));
    expect(ExtensionProviderSchema.parse(provider).support).toEqual({
      plugins: { store: 'profile', changes: 'command', read: true },
      marketplaces: { store: 'mixed', changes: 'command', read: false },
      mcpServers: { store: 'profile', changes: 'command', read: true },
      skills: { store: 'mixed', changes: 'folder', read: true },
    });
  });

  it('reads a managed profile through its app-server and `mcp list`, bound to its root, and keeps no secret', async () => {
    const { home, root, library } = await managedSetup();
    const server = fakeAppServer(answersFor(home, root));
    const listServers = vi.fn(async () => LISTING);
    const inventory = ExtensionInventorySchema.parse(
      await service(server, { home, listServers }).inventory(managedProfile(root)),
    );

    expect(server.spawns).toEqual([
      { executable: '/opt/node/bin/codex', env: { CODEX_HOME: root, HOME: home }, cwd: root },
    ]);
    expect(listServers).toHaveBeenCalledWith({
      executable: '/opt/node/bin/codex',
      env: { CODEX_HOME: root, HOME: home },
      cwd: root,
    });
    expect(server.requests.map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'skills/list',
      'plugin/installed',
      'config/read',
      'plugin/read',
    ]);
    expect(server.requests.find(({ method }) => method === 'skills/list')?.params).toEqual({ cwds: [root] });
    // Only an enabled plugin of a local marketplace is read; a remote one would go to the account's service.
    expect(server.requests.filter(({ method }) => method === 'plugin/read').map(({ params }) => params)).toEqual([
      {
        marketplacePath: join(
          home,
          '.cache',
          'codex-runtimes',
          'plugins',
          'openai-primary-runtime',
          'marketplace.json',
        ),
        pluginName: 'documents',
      },
    ]);
    expect(server.closed()).toBe(true);

    const document = JSON.stringify(inventory);
    for (const secret of ['hunter2', 'sk-live-123', 'corp-secret-value', 'sk-provider-secret', 'acme']) {
      expect(document).not.toContain(secret);
    }
    expect(inventory).toMatchObject({
      provider: 'codex',
      profileId: 'work-codex',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-protocol', stability: 'experimental' },
    });
    expect(inventory.unread).toBeUndefined();

    expect(find(inventory, 'mcp-server', 'linear')).toEqual({
      kind: 'mcp-server',
      id: 'linear',
      name: 'linear',
      origin: 'own',
      location: join(root, 'config.toml'),
      enabled: true,
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      env: ['LINEAR_TOKEN'],
      headers: ['Authorization'],
    });
    expect(find(inventory, 'mcp-server', 'postgres')).toMatchObject({
      origin: 'own',
      enabled: false,
      transport: 'stdio',
      target: 'npx -y @modelcontextprotocol/server-postgres postgresql://•••@localhost/dev',
      env: ['PGPASSWORD'],
    });
    expect(find(inventory, 'mcp-server', 'corp-search')).toMatchObject({
      origin: 'managed',
      location: '/etc/codex/managed_config.toml',
      target: 'https://search.corp.example/mcp?•••',
      env: ['CORP_TENANT'],
      headers: ['X-Api-Key', 'X-Tenant'],
    });
    expect(find(inventory, 'mcp-server', 'documents_mcp')).toMatchObject({
      origin: 'plugin',
      plugin: 'documents@openai-primary-runtime',
      target: 'node server.js',
      env: ['CODEX_HOME', 'PATH'],
    });
    // Neither in a config layer nor in a plugin: the account's connectors server.
    const apps = find(inventory, 'mcp-server', 'codex_apps');
    expect(apps).toMatchObject({ origin: 'managed', enabled: true });
    expect(apps).not.toHaveProperty('auth');
    expect(find(inventory, 'mcp-server', 'notion')).toMatchObject({ auth: 'signed-in' });
    expect(find(inventory, 'mcp-server', 'sentry')).toMatchObject({ auth: 'needs-sign-in' });

    expect(find(inventory, 'plugin', 'documents@openai-primary-runtime')).toEqual({
      kind: 'plugin',
      id: 'documents@openai-primary-runtime',
      name: 'documents',
      origin: 'own',
      enabled: true,
      version: '26.909.12148',
      marketplace: 'openai-primary-runtime',
      description: 'Create and edit documents',
    });
    expect(find(inventory, 'plugin', 'review@personal')).toMatchObject({ enabled: false, version: 'local' });
    expect(find(inventory, 'plugin', 'slack@openai-curated-remote')).toMatchObject({
      origin: 'managed',
      version: '1.0.39',
    });
    expect(find(inventory, 'plugin', 'draft@personal')).toBeUndefined();

    expect(find(inventory, 'skill', 'release-notes')).toEqual({
      kind: 'skill',
      id: 'release-notes',
      name: 'release-notes',
      origin: 'own',
      shared: true,
      switchable: true,
      enabled: true,
      location: join(home, '.agents', 'skills', 'release-notes'),
      description: 'Drafts release notes from merged pull requests',
    });
    expect(find(inventory, 'skill', 'changelog')).toMatchObject({ enabled: false, linkTarget: library });
    expect(find(inventory, 'skill', 'system:skill-creator')).toMatchObject({ origin: 'bundled' });
    expect(find(inventory, 'skill', 'admin:house-style')).toMatchObject({ origin: 'managed' });
    expect(find(inventory, 'skill', 'plugin:documents@openai-primary-runtime:documents')).toMatchObject({
      name: 'documents',
      origin: 'plugin',
      plugin: 'documents@openai-primary-runtime',
    });
    expect(inventory.items.some((item) => item.name === 'repo-only')).toBe(false);
  });

  it('binds the native default to nothing, and to the given home only when one is given', async () => {
    const home = await tempHome();
    const root = join(home, '.codex');
    await mkdir(root);
    const bare = fakeAppServer(answersFor(home, root));
    const listServers = vi.fn(async () => '[]');
    await service(bare, { listServers }).inventory(nativeProfile(root));
    expect(bare.spawns[0]).toEqual({ executable: '/opt/node/bin/codex', env: {}, cwd: root });
    expect(listServers).toHaveBeenLastCalledWith({ executable: '/opt/node/bin/codex', env: {}, cwd: root });

    const homed = fakeAppServer(answersFor(home, root));
    await service(homed, { home, listServers }).inventory(nativeProfile(root));
    expect(homed.spawns[0]?.env).toEqual({ HOME: home, CODEX_HOME: root });
  });

  it('answers not-found for a root that does not exist, without starting Codex', async () => {
    const home = await tempHome();
    const server = fakeAppServer(answersFor(home, join(home, 'missing')));
    const listServers = vi.fn(async () => LISTING);
    expect(await service(server, { listServers }).inventory(managedProfile(join(home, 'missing')))).toMatchObject({
      status: 'not-found',
      provider: 'codex',
      retryable: false,
    });
    expect(server.spawns).toEqual([]);
    expect(listServers).not.toHaveBeenCalled();
  });

  it('says which kind a read could not cover and lists the rest', async () => {
    const { home, root } = await managedSetup();
    const noSkills = answersFor(home, root);
    delete noSkills['skills/list'];
    const partial = ExtensionInventorySchema.parse(
      await service(fakeAppServer(noSkills), {
        listServers: async () => {
          throw new Error('`codex mcp list --json` did not complete');
        },
      }).inventory(managedProfile(root)),
    );
    expect(partial.unread).toEqual([
      { kind: 'mcp-server', message: '`codex mcp list --json` could not be run' },
      { kind: 'skill', message: '`skills/list` could not be read' },
    ]);
    expect(partial.items.every((item) => item.kind === 'plugin')).toBe(true);

    const noOrigins = answersFor(home, root);
    delete noOrigins['config/read'];
    const unattributed = ExtensionInventorySchema.parse(
      await service(fakeAppServer(noOrigins)).inventory(managedProfile(root)),
    );
    expect(unattributed.unread).toEqual([
      { kind: 'mcp-server', message: 'where each server comes from could not be read' },
    ]);
    expect(unattributed.items.some((item) => item.kind === 'mcp-server')).toBe(false);

    const garbled = ExtensionInventorySchema.parse(
      await service(fakeAppServer(answersFor(home, root)), {
        listServers: async () => 'Error: config.toml is invalid',
      }).inventory(managedProfile(root)),
    );
    expect(garbled.unread).toEqual([
      { kind: 'mcp-server', message: '`codex mcp list --json` printed an unrecognized document' },
    ]);
  });

  it('answers unavailable when the app-server does not initialize, and still stops it', async () => {
    const { home, root } = await managedSetup();
    const answers = answersFor(home, root);
    delete answers.initialize;
    const server = fakeAppServer(answers);
    expect(await service(server).inventory(managedProfile(root))).toEqual({
      status: 'unavailable',
      provider: 'codex',
      message: 'the Codex app-server could not be read for this profile',
      retryable: true,
    });
    expect(server.closed()).toBe(true);
  });

  it('runs `codex mcp list --json` in the root with the binding, and never repeats its output when it fails', async () => {
    const { home, root } = await managedSetup();
    const script = join(home, 'bin', 'codex.mjs');
    await write(
      script,
      [
        "if (process.env.FAIL_LISTING) { console.error('PGPASSWORD=hunter2'); process.exit(1); }",
        'console.log(JSON.stringify([{ name: "seen", enabled: true, auth_status: "unsupported",',
        '  transport: { type: "stdio", command: "probe", args: [process.cwd(), process.env.CODEX_HOME, process.argv.slice(2).join(" ")] } }]));',
      ].join('\n'),
    );
    await chmod(script, 0o755);
    const answers = answersFor(home, root);
    const origins = answers['config/read']!({}) as { origins: Record<string, unknown> };
    answers['config/read'] = () => ({
      origins: { ...origins.origins, 'mcp_servers.seen.command': user(join(root, 'config.toml')) },
    });

    const inventory = ExtensionInventorySchema.parse(
      await createCodexExtensionService({
        executable: script,
        env: {},
        now,
        spawnTransport: fakeAppServer(answers).spawnTransport,
      }).inventory(managedProfile(root)),
    );
    expect(find(inventory, 'mcp-server', 'seen')).toMatchObject({
      origin: 'own',
      target: `probe ${root} ${root} "mcp list --json"`,
    });

    process.env.FAIL_LISTING = '1';
    try {
      const failed = await createCodexExtensionService({
        executable: script,
        env: {},
        now,
        spawnTransport: fakeAppServer(answers).spawnTransport,
      }).inventory(managedProfile(root));
      expect(JSON.stringify(failed)).not.toContain('hunter2');
      expect(ExtensionInventorySchema.parse(failed).unread).toEqual([
        { kind: 'mcp-server', message: '`codex mcp list --json` could not be run' },
      ]);
    } finally {
      delete process.env.FAIL_LISTING;
    }
  });
});

describe('Codex extension acts', () => {
  const own = {
    kind: 'mcp-server' as const,
    id: 'linear',
    name: 'linear',
    origin: 'own' as const,
    enabled: true,
    transport: 'http' as const,
    target: 'https://mcp.linear.app/mcp',
  };
  const skill = {
    kind: 'skill' as const,
    id: 'release-notes',
    name: 'release-notes',
    origin: 'own' as const,
    enabled: true,
    shared: true as const,
    switchable: true as const,
    location: '/Users/test/.agents/skills/release-notes',
  };

  it("turns a server of the profile's own on and off through its config, and removes it with its own command", async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    expect(codex.plan!(managedProfile(root), own, 'disable')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'disable',
      available: true,
      runs: {
        kind: 'protocol',
        method: 'config/value/write',
        params: { keyPath: 'mcp_servers.linear.enabled', mergeStrategy: 'replace', value: false },
      },
      display: 'config/value/write mcp_servers.linear.enabled = false',
      reaches: [],
    });
    // the definition goes with a removal; the command is bound to the profile's root
    expect(codex.plan!(managedProfile(root), own, 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['/opt/node/bin/codex', 'mcp', 'remove', 'linear'], env: { CODEX_HOME: root } },
      display: '/opt/node/bin/codex mcp remove linear',
      reaches: ['definition'],
    });
    // the native default binds nothing: Codex finds its own home
    expect(codex.plan!(nativeProfile(root), own, 'remove')).toMatchObject({
      runs: { kind: 'command', argv: ['/opt/node/bin/codex', 'mcp', 'remove', 'linear'] },
    });
    expect((codex.plan!(nativeProfile(root), own, 'remove') as { runs: { env?: unknown } }).runs.env).toBeUndefined();
  });

  it('signs in with its own login in a terminal and out with its own command, a sign-in every Codex profile shares', async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    expect(codex.plan!(managedProfile(root), { ...own, auth: 'needs-sign-in' }, 'sign-in')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'sign-in',
      available: true,
      runs: { kind: 'terminal', argv: ['/opt/node/bin/codex', 'mcp', 'login', 'linear'], env: { CODEX_HOME: root } },
      display: '/opt/node/bin/codex mcp login linear',
      // the keychain entry is keyed by the server's name and address, not the profile's root
      reaches: process.platform === 'win32' ? [] : ['every-profile'],
    });
    expect(codex.plan!(managedProfile(root), { ...own, auth: 'signed-in' }, 'sign-out')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['/opt/node/bin/codex', 'mcp', 'logout', 'linear'], env: { CODEX_HOME: root } },
    });
    // Codex says nothing of a sign-in for a server that sends its own key, or a local one
    expect(codex.plan!(managedProfile(root), own, 'sign-in')).toMatchObject({
      available: false,
      reason: 'no-sign-in',
      message: 'Codex has no sign-in for linear: it sends a key, or asks for none',
    });
    expect(
      codex.plan!(managedProfile(root), { ...own, transport: 'stdio', target: 'npx linear-mcp' }, 'sign-out'),
    ).toMatchObject({ available: false, reason: 'no-sign-in' });
  });

  it("leaves a plugin's, a project's and the app's servers where they come from", async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    expect(codex.plan!(managedProfile(root), { ...own, origin: 'plugin', plugin: 'docs@openai' }, 'disable')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'disable',
      available: false,
      reason: 'not-own',
      message: 'It comes with the docs@openai plugin and changes with it',
    });
    expect(codex.plan!(managedProfile(root), { ...own, origin: 'managed' }, 'remove')).toMatchObject({
      available: false,
      reason: 'not-own',
    });
    expect(codex.plan!(managedProfile(root), { ...own, id: 'odd.name', name: 'odd.name' }, 'disable')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
  });

  it('switches a shared skill for this profile alone, and never removes one from the shared folder', async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    expect(codex.plan!(managedProfile(root), skill, 'disable')).toMatchObject({
      available: true,
      runs: {
        kind: 'protocol',
        method: 'skills/config/write',
        params: { path: '/Users/test/.agents/skills/release-notes/SKILL.md', enabled: false },
      },
      display: 'skills/config/write release-notes enabled = false',
      reaches: [],
    });
    expect(codex.plan!(managedProfile(root), skill, 'remove')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
    expect(
      codex.plan!(managedProfile(root), { ...skill, id: 'system:skill-creator', origin: 'bundled' }, 'disable'),
    ).toMatchObject({ available: false, reason: 'not-own', message: 'It ships with Codex' });
  });

  it("performs a protocol plan on a private app-server in the profile's root, and never repeats a refusal", async () => {
    const { home, root } = await managedSetup();
    const server = fakeAppServer({
      initialize: () => ({ codexHome: root }),
      'config/value/write': () => ({ status: 'ok', version: 'sha256:next', filePath: join(root, 'config.toml') }),
    });
    const codex = service(server, { home });
    const plan = codex.plan!(managedProfile(root), own, 'disable');
    if (!plan.available) throw new Error('expected a plan');
    const output: string[] = [];
    expect(await codex.perform!(managedProfile(root), plan, { onOutput: (chunk) => output.push(chunk) })).toEqual({
      ok: true,
    });
    expect(server.spawns).toEqual([
      { executable: '/opt/node/bin/codex', env: { CODEX_HOME: root, HOME: home }, cwd: root },
    ]);
    expect(server.requests.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'config/value/write']);
    expect(server.requests[2]?.params).toEqual({
      keyPath: 'mcp_servers.linear.enabled',
      mergeStrategy: 'replace',
      value: false,
    });
    expect(output.join('')).toBe(
      'config/value/write mcp_servers.linear.enabled = false\nCodex wrote it to its config.\n',
    );
    expect(server.closed()).toBe(true);

    // a refusal (here: no answer, so an error that quotes itself) is said without its words
    const refusing = fakeAppServer({ initialize: () => ({ codexHome: root }) });
    const skillPlan = service(refusing, { home }).plan!(managedProfile(root), skill, 'enable');
    if (!skillPlan.available) throw new Error('expected a plan');
    const said: string[] = [];
    expect(
      await service(refusing, { home }).perform!(managedProfile(root), skillPlan, {
        onOutput: (chunk) => said.push(chunk),
      }),
    ).toEqual({ ok: false, error: 'was refused by Codex' });
    expect(said.join('')).not.toContain('no answer');
  });
});
