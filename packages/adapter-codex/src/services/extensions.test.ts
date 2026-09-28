import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AgentProfileSchema,
  describeMcpDefinition,
  ExtensionActKindSchema,
  ExtensionActPlanSchema,
  ExtensionCatalogSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type CatalogPlugin,
  type ExtensionActPlan,
  type ExtensionCatalog,
  type ExtensionInventory,
  type ExtensionItem,
  type MarketplaceItem,
  type McpServerDefinition,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import type { Transport } from '../transport/app-server-client.js';
import { createCodexExtensionService, parseCodexConfig, type CodexExtensionOptions } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

// A service built without a home reads the process's: here, an empty one, never the machine's.
let processHome: string | undefined;
let emptyHome: string;
beforeAll(async () => {
  processHome = process.env.HOME;
  emptyHome = await realpath(await mkdtemp(join(tmpdir(), 'codex-extensions-home-')));
  process.env.HOME = emptyHome;
  expect(homedir()).toBe(emptyHome);
});
afterAll(async () => {
  if (processHome === undefined) delete process.env.HOME;
  else process.env.HOME = processHome;
  await rm(emptyHome, { recursive: true, force: true });
});

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

const definitionOf = (inventory: ExtensionInventory, id: string) => {
  const item = find(inventory, 'mcp-server', id);
  return item?.kind === 'mcp-server' ? item.definition : undefined;
};

describe('Codex extensions', () => {
  it('declares the kinds Codex has and which it reads', () => {
    const { provider } = service(fakeAppServer({}));
    expect(ExtensionProviderSchema.parse(provider).support).toEqual({
      // a plugin comes only from a marketplace, whose catalog a host reads; a marketplace from where Codex's add takes one
      plugins: { store: 'profile', changes: 'command', read: true, catalog: true },
      marketplaces: {
        store: 'mixed',
        changes: 'command',
        read: true,
        sources: 'A GitHub repository (owner/repo), a git address, or a folder',
      },
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

  it('gives a server that hides nothing, sends no header and runs in no folder of its own its definition', async () => {
    const { home, root } = await managedSetup();
    const listing = [
      ...(JSON.parse(LISTING) as unknown[]),
      {
        name: 'context7',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env: { CONTEXT7_API_KEY: 'ctx7-live-value' },
          env_vars: ['CONTEXT7_REGION'],
          cwd: null,
        },
        auth_status: 'unsupported',
      },
      {
        name: 'rooted',
        enabled: true,
        transport: {
          type: 'stdio',
          command: 'node',
          args: ['index.js'],
          env: null,
          env_vars: [],
          cwd: '/opt/mcp/rooted',
        },
        auth_status: 'unsupported',
      },
      {
        name: 'helper',
        enabled: true,
        transport: {
          type: 'streamable_http',
          url: 'https://mcp.helper.example/mcp',
          bearer_token_env_var: null,
          http_headers: null,
          env_http_headers: null,
          // `mcp list` prints only that one is set
          http_headers_helper: '<redacted>',
        },
        auth_status: 'unknown',
      },
    ];
    const inventory = ExtensionInventorySchema.parse(
      await service(fakeAppServer(answersFor(home, root)), {
        listServers: async () => JSON.stringify(listing),
      }).inventory(managedProfile(root)),
    );

    // every variable the server reads, by name: those Codex sets and those it forwards
    expect(definitionOf(inventory, 'context7')).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: ['CONTEXT7_API_KEY', 'CONTEXT7_REGION'],
    });
    expect(definitionOf(inventory, 'documents_mcp')).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: ['CODEX_HOME', 'PATH'],
    });
    expect(definitionOf(inventory, 'notion')).toEqual({ transport: 'http', url: 'https://mcp.notion.com/mcp' });
    expect(definitionOf(inventory, 'sentry')).toEqual({ transport: 'http', url: 'https://mcp.sentry.dev/mcp' });
    // a bearer variable, configured headers, a helper's, the account token Codex adds itself;
    // a masked argument; a folder of its own
    for (const id of ['linear', 'corp-search', 'helper', 'codex_apps', 'postgres', 'rooted']) {
      expect(find(inventory, 'mcp-server', id), id).toBeDefined();
      expect(definitionOf(inventory, id), id).toBeUndefined();
    }
    // what an item reports is as before: a helper's headers stay unnamed
    expect(find(inventory, 'mcp-server', 'helper')).not.toHaveProperty('headers');
    expect(JSON.stringify(inventory)).not.toContain('ctx7-live-value');
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
    const { home, root } = await managedSetup();
    const codex = service(fakeAppServer({}), { home });
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
    // taking it away would take it from every profile and agent that reads the folder, even with a place to keep it
    for (const options of [undefined, { keepIn: join(home, 'kept', 'release-notes') }]) {
      expect(codex.plan!(managedProfile(root), skill, 'remove', options)).toEqual({
        target: { kind: 'skill', id: 'release-notes' },
        act: 'remove',
        available: false,
        reason: 'no-command',
        message:
          "release-notes is in ~/.agents/skills, which every Codex profile and other agents read; Codex's switch turns it off here",
      });
    }
    expect(
      codex.plan!(managedProfile(root), { ...skill, id: 'system:skill-creator', origin: 'bundled' }, 'disable'),
    ).toMatchObject({ available: false, reason: 'not-own', message: 'It ships with Codex' });
    expect(
      codex.plan!(
        managedProfile(root),
        { ...skill, id: 'plugin:documents@openai-primary-runtime:documents', origin: 'plugin', plugin: 'documents' },
        'remove',
      ),
    ).toMatchObject({
      available: false,
      reason: 'not-own',
      message: 'It comes with the documents plugin and changes with it',
    });
  });

  /** A skill as the runtime hands it for an add: the host's folder as its link target, never read. */
  const placing = (name: string, folder?: string): SkillItem => ({
    kind: 'skill',
    id: name,
    name,
    origin: 'own',
    enabled: true,
    ...(folder === undefined ? {} : { linkTarget: folder }),
  });

  it('moves a skill the host keeps into ~/.agents/skills and leaves a link where it was, for every profile', async () => {
    const { home, root } = await managedSetup();
    const codex = service(fakeAppServer({}), { home });
    const kept = join(home, 'kept', 'work', 'standup');
    const placed = join(home, '.agents', 'skills', 'standup');
    await write(join(kept, 'SKILL.md'), '---\nname: standup\n---\n');
    const plan = ExtensionActPlanSchema.parse(codex.plan!(managedProfile(root), placing('standup', kept), 'add'));
    expect(plan).toEqual({
      target: { kind: 'skill', id: 'standup' },
      act: 'add',
      available: true,
      runs: {
        kind: 'files',
        steps: [
          { op: 'move', from: kept, to: placed },
          { op: 'link', path: kept, target: placed },
        ],
      },
      display:
        'move ~/kept/work/standup → ~/.agents/skills/standup\nlink ~/.agents/skills/standup → ~/kept/work/standup',
      // Grok, Kimi, OpenCode and Pi read the folder too
      reaches: ['shared-folder'],
    });
    // the native default reads the same folder, so it plans the same
    expect(codex.plan!(nativeProfile(join(home, '.codex')), placing('standup', kept), 'add')).toEqual(plan);
    // planning is pure: the host's folder has not moved, and nothing is made where it would go
    expect((await lstat(kept)).isDirectory()).toBe(true);
    await expect(lstat(placed)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('places no skill without a folder, under a name that is not one folder, or from inside ~/.agents/skills', async () => {
    const { home, root } = await managedSetup();
    const codex = service(fakeAppServer({}), { home });
    const work = managedProfile(root);
    const kept = (name: string) => join(home, 'kept', 'work', name);
    expect(codex.plan!(work, placing('standup'), 'add')).toEqual({
      target: { kind: 'skill', id: 'standup' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Codex takes a skill only as a folder, which it keeps in ~/.agents/skills',
    });
    for (const name of ['.standup', 'daily/standup', '..']) {
      expect(codex.plan!(work, placing(name, kept('standup')), 'add')).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: `Codex cannot keep a skill folder named ${name} in ~/.agents/skills`,
      });
    }
    // already where Codex reads it: nothing to move
    for (const folder of [join(home, '.agents', 'skills', 'standup'), join(home, '.agents', 'skills')]) {
      expect(codex.plan!(work, placing('standup', folder), 'add')).toEqual({
        target: { kind: 'skill', id: 'standup' },
        act: 'add',
        available: false,
        reason: 'unsupported',
        message: 'Codex already reads standup where it is, in ~/.agents/skills',
      });
    }
    // a sibling that only shares the prefix is not inside it
    const sibling = join(home, '.agents', 'skills-kept', 'standup');
    expect(codex.plan!(work, placing('standup', sibling), 'add')).toMatchObject({ available: true });
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

  /** A server as the runtime hands it for an add: as Codex would hold it once added, from its definition. */
  const adding = (name: string, definition: McpServerDefinition): McpServerItem => ({
    kind: 'mcp-server',
    id: name,
    name,
    origin: 'own',
    enabled: true,
    transport: definition.transport,
    target: describeMcpDefinition(definition),
    ...(definition.transport === 'stdio' && definition.env !== undefined ? { env: [...definition.env] } : {}),
    definition,
  });
  const context7: McpServerDefinition = {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: ['CONTEXT7_API_KEY'],
  };
  const paramsOf = (plan: ExtensionActPlan) =>
    plan.available && plan.runs.kind === 'protocol' ? plan.runs.params : undefined;

  it('adds a server by writing its whole table to the config, each variable named for Codex to forward', async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    expect(
      ExtensionActPlanSchema.parse(codex.plan!(managedProfile(root), adding('context7', context7), 'add')),
    ).toEqual({
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      available: true,
      runs: {
        kind: 'protocol',
        method: 'config/value/write',
        params: {
          keyPath: 'mcp_servers.context7',
          mergeStrategy: 'replace',
          // `env_vars` names a variable Codex forwards from its own environment; `env` would hold a value
          value: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], env_vars: ['CONTEXT7_API_KEY'] },
        },
      },
      display:
        'config/value/write mcp_servers.context7 = {"command":"npx","args":["-y","@upstash/context7-mcp"],"env_vars":["CONTEXT7_API_KEY"]}',
      reaches: [],
    });
    // a server that reads no variable names none
    expect(
      paramsOf(
        codex.plan!(
          managedProfile(root),
          adding('fetch', { transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }),
          'add',
        ),
      ),
    ).toEqual({
      keyPath: 'mcp_servers.fetch',
      mergeStrategy: 'replace',
      value: { command: 'uvx', args: ['mcp-server-fetch'] },
    });
    // a remote one is its address alone: its sign-in, if it asks for one, is a later act of its own
    expect(
      ExtensionActPlanSchema.parse(
        codex.plan!(
          managedProfile(root),
          adding('notion', { transport: 'http', url: 'https://mcp.notion.com/mcp' }),
          'add',
        ),
      ),
    ).toEqual({
      target: { kind: 'mcp-server', id: 'notion' },
      act: 'add',
      available: true,
      runs: {
        kind: 'protocol',
        method: 'config/value/write',
        params: {
          keyPath: 'mcp_servers.notion',
          mergeStrategy: 'replace',
          value: { url: 'https://mcp.notion.com/mcp' },
        },
      },
      display: 'config/value/write mcp_servers.notion = {"url":"https://mcp.notion.com/mcp"}',
      reaches: [],
    });
  });

  it('adds no SSE server, no name its commands would not take, and nothing without a definition', async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    expect(
      codex.plan!(
        managedProfile(root),
        adding('events', { transport: 'sse', url: 'https://mcp.example.com/sse' }),
        'add',
      ),
    ).toEqual({
      target: { kind: 'mcp-server', id: 'events' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Codex reaches a remote server only over streamable HTTP',
    });
    // a dot would split `mcp_servers.<name>` into a nested key
    expect(
      codex.plan!(
        managedProfile(root),
        adding('odd.name', { transport: 'http', url: 'https://mcp.notion.com/mcp' }),
        'add',
      ),
    ).toEqual({
      target: { kind: 'mcp-server', id: 'odd.name' },
      act: 'add',
      available: false,
      reason: 'no-command',
      message: "Codex's commands do not take this server's name",
    });
    const bare: McpServerItem = {
      kind: 'mcp-server',
      id: 'context7',
      name: 'context7',
      origin: 'own',
      enabled: true,
      transport: 'stdio',
      target: 'npx -y @upstash/context7-mcp',
    };
    expect(codex.plan!(managedProfile(root), bare, 'add')).toEqual({
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Codex adds a server only from its definition',
    });
    expect(codex.plan!(managedProfile(root), skill, 'add')).toMatchObject({
      target: { kind: 'skill', id: 'release-notes' },
      available: false,
      reason: 'unsupported',
    });
  });

  it("performs an add on a private app-server in the profile's root, sending exactly the table it planned", async () => {
    const { home, root } = await managedSetup();
    const server = fakeAppServer({
      initialize: () => ({ codexHome: root }),
      'config/value/write': () => ({ status: 'ok', version: 'sha256:next', filePath: join(root, 'config.toml') }),
    });
    const codex = service(server, { home });
    const plan = codex.plan!(managedProfile(root), adding('context7', context7), 'add');
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
      keyPath: 'mcp_servers.context7',
      mergeStrategy: 'replace',
      value: { command: 'npx', args: ['-y', '@upstash/context7-mcp'], env_vars: ['CONTEXT7_API_KEY'] },
    });
    expect(output.join('')).toBe(`${plan.display}\nCodex wrote it to its config.\n`);
    expect(server.closed()).toBe(true);
  });
});

describe('Codex plugin acts', () => {
  const review: PluginItem = {
    kind: 'plugin',
    id: 'review@personal',
    name: 'review',
    origin: 'own',
    enabled: true,
    version: 'local',
    marketplace: 'personal',
  };
  const target = { kind: 'plugin', id: 'review@personal' } as const;

  it("turns a plugin of the profile's own on and off through its config, and removes it with its own command", async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    for (const act of ['enable', 'disable'] as const) {
      const enabled = act === 'enable';
      expect(ExtensionActPlanSchema.parse(codex.plan!(managedProfile(root), review, act)), act).toEqual({
        target,
        act,
        available: true,
        runs: {
          kind: 'protocol',
          method: 'config/value/write',
          // the key `codex plugin add` writes, `[plugins."review@personal"] enabled = true`
          params: { keyPath: 'plugins.review@personal.enabled', mergeStrategy: 'replace', value: enabled },
        },
        display: `config/value/write plugins.review@personal.enabled = ${enabled}`,
        reaches: [],
      });
    }
    expect(ExtensionActPlanSchema.parse(codex.plan!(managedProfile(root), review, 'remove'))).toEqual({
      target,
      act: 'remove',
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/node/bin/codex', 'plugin', 'remove', 'review@personal'],
        env: { CODEX_HOME: root },
      },
      display: '/opt/node/bin/codex plugin remove review@personal',
      reaches: [],
    });
    // the native default binds nothing: Codex finds its own home
    expect(codex.plan!(nativeProfile(root), review, 'remove')).not.toHaveProperty('runs.env');
    // one uninstall, and no update of one plugin
    expect(codex.plan!(managedProfile(root), review, 'purge')).toEqual({
      target,
      act: 'purge',
      available: false,
      reason: 'unsupported',
      message: 'Codex removes a plugin one way, with `codex plugin remove`',
    });
    expect(codex.plan!(managedProfile(root), review, 'update')).toEqual({
      target,
      act: 'update',
      available: false,
      reason: 'no-command',
      message: 'Codex brings its plugins up to date when their marketplace is upgraded',
    });
  });

  it("performs a plugin's switch on a private app-server, as a server's", async () => {
    const { home, root } = await managedSetup();
    const server = fakeAppServer({
      initialize: () => ({ codexHome: root }),
      'config/value/write': () => ({ status: 'ok', version: 'sha256:next', filePath: join(root, 'config.toml') }),
    });
    const codex = service(server, { home });
    const plan = codex.plan!(managedProfile(root), review, 'disable');
    if (!plan.available) throw new Error('expected a plan');
    expect(await codex.perform!(managedProfile(root), plan, {})).toEqual({ ok: true });
    expect(server.requests.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'config/value/write']);
    expect(server.requests[2]?.params).toEqual({
      keyPath: 'plugins.review@personal.enabled',
      mergeStrategy: 'replace',
      value: false,
    });
    expect(server.closed()).toBe(true);
  });

  it("leaves a workspace's plugin to the workspace, and plans no key its config or commands cannot take", async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    const work = managedProfile(root);
    // a workspace-managed plugin keeps the workspace's state whatever a local `enabled = false` says
    const slack: PluginItem = { ...review, id: 'slack@openai-curated-remote', name: 'slack', origin: 'managed' };
    for (const act of ['enable', 'disable', 'remove', 'purge', 'update'] as const) {
      expect(codex.plan!(work, slack, act), act).toEqual({
        target: { kind: 'plugin', id: 'slack@openai-curated-remote' },
        act,
        available: false,
        reason: 'not-own',
        message: "Codex's app or your organization adds it, and changes it",
      });
    }
    // a dot would split `plugins.<id>.enabled` into another table; its own command takes the key whole
    const dotted: PluginItem = { ...review, id: 'review.v2@personal', name: 'review.v2' };
    for (const act of ['enable', 'disable'] as const) {
      expect(codex.plan!(work, dotted, act), act).toEqual({
        target: { kind: 'plugin', id: 'review.v2@personal' },
        act,
        available: false,
        reason: 'no-command',
        message: "Codex's config cannot name this plugin's key",
      });
    }
    expect(codex.plan!(work, dotted, 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['/opt/node/bin/codex', 'plugin', 'remove', 'review.v2@personal'] },
    });
    for (const id of ['--json', '../review@personal', 'review@per sonal']) {
      expect(codex.plan!(work, { ...review, id }, 'remove'), id).toEqual({
        target: { kind: 'plugin', id },
        act: 'remove',
        available: false,
        reason: 'no-command',
        message: "Codex's commands do not take this plugin's name",
      });
    }
    expect(codex.plan!(work, review, 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Codex installs a plugin from its marketplace',
    });
    for (const act of ['sign-in', 'sign-out'] as const) {
      expect(codex.plan!(work, review, act), act).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Codex has no sign-in for a plugin',
      });
    }
  });
});

// ── catalogs, installs and marketplaces (RFC 006 C2) ──

const UPGRADED = new Date('2026-09-26T10:30:00.000Z');
const FETCHED = new Date('2026-09-26T09:15:00.000Z');
const SYNCED = new Date('2026-09-26T08:00:00.000Z');

const json = (path: string, value: unknown) => write(path, JSON.stringify(value, null, 2));

/**
 * A profile that knows every kind of marketplace Codex has — a git snapshot
 * (upgraded, fetched once, not fetched yet), local folders (one broken), one
 * Codex's app writes, the curated catalog and the personal one — with a
 * secret or an address wherever a catalog or a config could carry one.
 */
async function marketplaceSetup() {
  const { home, root } = await managedSetup();
  const snapshots = join(root, '.tmp', 'marketplaces');
  const northlight = join(snapshots, 'northlight');
  const fresh = join(snapshots, 'fresh');
  const workbench = join(home, 'work', 'workbench');
  const broken = join(home, 'work', 'broken');
  const bundled = join(root, '.tmp', 'bundled-marketplaces', 'openai-bundled');
  const curated = join(root, '.tmp', 'plugins');
  const personal = join(home, '.agents', 'plugins', 'marketplace.json');

  await write(
    join(root, 'config.toml'),
    [
      'plugins."slack@openai-curated".enabled = true',
      'model = "gpt-5.5"',
      '# a table header inside a string is text, never a marketplace',
      'developer_instructions = """',
      '[marketplaces.phantom]',
      'source_type = "git"',
      '"""',
      '',
      '[mcp_servers.postgres]',
      'command = "npx"',
      'env = { PGPASSWORD = "hunter2" }',
      '',
      '[marketplaces.northlight]',
      'source_type = "git"',
      'source = "https://x-access-token:ghp_northlightsecret@github.com/northlight/plugins.git"',
      'ref = "main"',
      '',
      '[marketplaces.fresh]',
      'source_type = "git"',
      'source = "https://github.com/owner/fresh.git"',
      '',
      '[marketplaces.pending]',
      'source_type = "git"',
      "source = 'git@github.com:owner/pending.git'",
      '',
      '[marketplaces.workbench]',
      'source_type = "local"',
      `source = ${JSON.stringify(workbench)}`,
      '',
      '[marketplaces]',
      `broken = { source_type = "local", source = ${JSON.stringify(broken)} }`,
      '',
      '[marketplaces.openai-bundled]',
      'source_type = "local"',
      `source = ${JSON.stringify(bundled)}`,
      '',
      '[marketplaces."bad.name"]',
      'source_type = "git"',
      'source = "https://example.com/bad.git"',
      '',
      '[plugins."review@northlight"]',
      'enabled = true',
      '',
      '[plugins."lint@northlight"]',
      'enabled = false',
      '',
      '# configured, but with no copy in the cache: not installed',
      '[plugins."deploy@northlight"]',
      'enabled = true',
      '',
      '[[skills.config]]',
      'path = "/Users/test/.agents/skills/changelog/SKILL.md"',
      'enabled = false',
    ].join('\n'),
  );

  // a git snapshot Codex upgraded: its install record is the time it keeps
  await json(join(northlight, '.agents', 'plugins', 'marketplace.json'), {
    name: 'northlight',
    interface: { displayName: 'Northlight' },
    plugins: [
      { name: 'review', source: './plugins/review', category: 'Coding' },
      { name: 'lint', source: { source: 'local', path: './plugins/lint' } },
      {
        name: 'deploy',
        source: { source: 'url', url: 'https://github.com/northlight/deploy.git' },
        version: '9.9.9',
        description: 'Deploys a branch',
        author: { name: 'Ops <ops@northlight.dev>', email: 'ops@northlight.dev' },
        homepage: 'https://northlight.dev/deploy?utm=catalog-secret',
      },
      { name: 'retired', source: './plugins/retired', policy: { installation: 'NOT_AVAILABLE' } },
      { name: 'chat-only', source: './plugins/chat-only', policy: { products: ['CHATGPT'] } },
      { name: 'escape', source: './plugins/escape', version: '6.6.6' },
      { name: '../evil', source: './plugins/review' },
      { name: 'outside', source: '../outside' },
      { name: 'unknown-source', source: { source: 'ftp', url: 'ftp://example.com/x' } },
      { name: 'review', source: './plugins/review-copy', category: 'Duplicate' },
    ],
  });
  const review = join(northlight, 'plugins', 'review');
  await json(join(review, '.codex-plugin', 'plugin.json'), {
    name: 'review',
    version: '1.3.0',
    description: 'Reviews a change',
    skills: './skills/',
    interface: {
      displayName: 'Review',
      shortDescription: 'Reviews pull requests',
      developerName: 'Northlight Labs <labs@northlight.dev>',
      category: 'Productivity',
      websiteUrl: 'https://northlight.dev/review?token=review-secret',
    },
  });
  await write(join(review, 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\n---\n');
  await write(join(review, 'skills', '.hidden', 'SKILL.md'), '---\nname: hidden\n---\n');
  await mkdir(join(review, 'skills', 'empty'), { recursive: true });
  await write(join(review, 'skills', 'notes.txt'), 'not a skill');
  await json(join(review, '.mcp.json'), {
    mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_mcpsecret' } } },
  });
  const lint = join(northlight, 'plugins', 'lint');
  await json(join(lint, 'plugin.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'lint',
    version: '2.0.0',
    description: 'Lints a change',
    author: { name: 'Lint Co', email: 'lint@example.com' },
    homepage: 'https://lint.example.com',
  });
  await json(join(lint, 'mcp.json'), { eslint: { command: 'npx', args: ['eslint-mcp'] } });
  await write(join(lint, 'skills', 'fix', 'SKILL.md'), '---\nname: fix\n---\n');
  await json(join(northlight, 'plugins', 'retired', '.codex-plugin', 'plugin.json'), {
    name: 'retired',
    version: '0.9.0',
  });
  // a plugin folder that is a link out of the marketplace is never read
  const elsewhere = join(home, 'elsewhere', 'escape');
  await json(join(elsewhere, '.codex-plugin', 'plugin.json'), {
    name: 'escape',
    version: '7.7.7',
    interface: { displayName: 'Escaped' },
  });
  await symlink(elsewhere, join(northlight, 'plugins', 'escape'));
  await json(join(northlight, '.codex-marketplace-install.json'), {
    source_type: 'git',
    source: 'https://github.com/northlight/plugins.git',
    ref_name: 'main',
    sparse_paths: [],
    revision: '0123456789abcdef0123456789abcdef01234567',
  });
  await utimes(join(northlight, '.codex-marketplace-install.json'), UPGRADED, UPGRADED);

  // a git snapshot Codex cloned once and never upgraded: the snapshot's own time
  await json(join(fresh, '.agents', 'plugins', 'marketplace.json'), { name: 'fresh', plugins: [] });
  await utimes(fresh, FETCHED, FETCHED);

  // a local folder in the Claude-compatible place: one plugin with a manifest, one the entry describes
  await json(join(workbench, '.claude-plugin', 'marketplace.json'), {
    name: 'workbench',
    plugins: [
      { name: 'notes', source: './notes', description: 'The entry, not the manifest', version: '0.2.0' },
      { name: 'scratch', source: './scratch', displayName: 'Scratch Pad', version: '0.0.1', category: 'Notes' },
    ],
  });
  await json(join(workbench, 'notes', '.claude-plugin', 'plugin.json'), { name: 'notes', version: '0.1.0' });
  await write(join(workbench, 'scratch', 'skills', 'jot', 'SKILL.md'), '---\nname: jot\n---\n');
  await write(join(broken, '.agents', 'plugins', 'marketplace.json'), '{ "name": "broken", "plugins": [');

  await json(join(bundled, '.agents', 'plugins', 'marketplace.json'), {
    name: 'openai-bundled',
    plugins: [{ name: 'browser', source: './plugins/browser' }],
  });
  await json(join(bundled, 'plugins', 'browser', '.codex-plugin', 'plugin.json'), {
    name: 'browser',
    version: '26.917.71314',
    interface: { displayName: 'Browser' },
  });

  await json(join(curated, '.agents', 'plugins', 'marketplace.json'), {
    name: 'openai-curated',
    interface: { displayName: 'OpenAI Curated' },
    plugins: [
      { name: 'slack', source: './plugins/slack' },
      { name: 'linear', source: './plugins/linear' },
    ],
  });
  await json(join(curated, 'plugins', 'slack', '.codex-plugin', 'plugin.json'), { name: 'slack', version: '1.0.39' });
  await write(join(root, '.tmp', 'plugins.sha'), '1dc19589aa0e4f7c9b1e2d3c4b5a69788796a5b4\n');
  await utimes(join(root, '.tmp', 'plugins.sha'), SYNCED, SYNCED);

  await json(personal, { name: 'personal', plugins: [{ name: 'draft', source: './plugins/draft' }] });
  await json(join(home, 'plugins', 'draft', '.codex-plugin', 'plugin.json'), {
    name: 'draft',
    version: '0.3.0',
    interface: { displayName: 'Draft' },
  });

  // what Codex holds: the highest version folder is its copy; a curated one is kept by commit
  const cache = join(root, 'plugins', 'cache');
  for (const folder of [
    join(cache, 'northlight', 'review', '1.1.0'),
    join(cache, 'northlight', 'review', '1.2.0'),
    join(cache, 'northlight', 'lint', '2.0.0'),
    join(cache, 'openai-curated', 'slack', '1dc19589'),
  ]) {
    await mkdir(folder, { recursive: true });
  }
  return { home, root, northlight, fresh, workbench, broken, bundled, curated, personal };
}

const SECRETS = [
  'ghp_northlightsecret',
  'x-access-token',
  'ops@northlight.dev',
  'labs@northlight.dev',
  'lint@example.com',
  'review-secret',
  'catalog-secret',
  'ghp_mcpsecret',
  'hunter2',
];

const catalogOf = async (codex: ReturnType<typeof service>, profile: ReturnType<typeof managedProfile>) =>
  ExtensionCatalogSchema.parse(await codex.catalog!(profile));

const listedIn = (catalog: ExtensionCatalog, id: string): CatalogPlugin | undefined =>
  catalog.plugins.find((plugin) => plugin.id === id);

describe('Codex marketplaces and catalogs', () => {
  it('lists every marketplace a profile knows from its files, beside what the app-server reads', async () => {
    const setup = await marketplaceSetup();
    const { home, root } = setup;
    const server = fakeAppServer(answersFor(home, root));
    const inventory = ExtensionInventorySchema.parse(await service(server, { home }).inventory(managedProfile(root)));
    expect(inventory.unread).toBeUndefined();
    const document = JSON.stringify(inventory);
    for (const secret of SECRETS) expect(document).not.toContain(secret);

    const marketplaces = inventory.items.filter((item): item is MarketplaceItem => item.kind === 'marketplace');
    // Codex's order: the personal catalog, then the rest by folder; a name Codex does not take is left out
    expect(marketplaces.map(({ id }) => id)).toEqual([
      'personal',
      'openai-bundled',
      'fresh',
      'northlight',
      'pending',
      'openai-curated',
      'broken',
      'workbench',
    ]);
    const find = (id: string) => marketplaces.find((item) => item.id === id);
    expect(find('personal')).toEqual({
      kind: 'marketplace',
      id: 'personal',
      name: 'personal',
      origin: 'own',
      enabled: true,
      // every Codex profile reads it from the home
      shared: true,
      location: setup.personal,
    });
    expect(find('northlight')).toEqual({
      kind: 'marketplace',
      id: 'northlight',
      name: 'Northlight',
      origin: 'own',
      enabled: true,
      // the address as recorded, less its sign-in
      source: 'https://•••@github.com/northlight/plugins.git',
      location: setup.northlight,
      // the upgrade's own record
      updatedAt: UPGRADED.toISOString(),
    });
    // cloned once and never upgraded: the snapshot's time; not fetched yet: none
    expect(find('fresh')).toMatchObject({
      updatedAt: FETCHED.toISOString(),
      source: 'https://github.com/owner/fresh.git',
    });
    expect(find('pending')).toEqual({
      kind: 'marketplace',
      id: 'pending',
      name: 'pending',
      origin: 'own',
      enabled: true,
      source: 'git@github.com:owner/pending.git',
      location: join(root, '.tmp', 'marketplaces', 'pending'),
    });
    // read where it is, so nothing keeps a time for it
    expect(find('workbench')).toEqual({
      kind: 'marketplace',
      id: 'workbench',
      name: 'workbench',
      origin: 'own',
      enabled: true,
      source: setup.workbench,
      location: setup.workbench,
    });
    expect(find('broken')).toMatchObject({ origin: 'own', location: setup.broken });
    expect(find('openai-bundled')).toMatchObject({ origin: 'managed', location: setup.bundled });
    expect(find('openai-curated')).toEqual({
      kind: 'marketplace',
      id: 'openai-curated',
      name: 'OpenAI Curated',
      origin: 'bundled',
      enabled: true,
      location: setup.curated,
      updatedAt: SYNCED.toISOString(),
    });
    // the app-server's reads are as before
    expect(server.requests.map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'skills/list',
      'plugin/installed',
      'config/read',
      'plugin/read',
    ]);
  });

  it('reads what each catalog lists from files alone, starting no process, and keeps no secret or address', async () => {
    const setup = await marketplaceSetup();
    const { home, root } = setup;
    const server = fakeAppServer(answersFor(home, root));
    const listServers = vi.fn(async () => LISTING);
    const catalog = await catalogOf(service(server, { home, listServers }), managedProfile(root));
    // every app-server start fetches and reinstalls: a catalog read starts none, and runs no command
    expect(server.spawns).toEqual([]);
    expect(server.requests).toEqual([]);
    expect(listServers).not.toHaveBeenCalled();

    const document = JSON.stringify(catalog);
    for (const secret of SECRETS) expect(document).not.toContain(secret);
    expect(catalog).toMatchObject({
      provider: 'codex',
      profileId: 'work-codex',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'experimental' },
    });
    // the curated catalog is here, so nothing is suggested
    expect(catalog.suggested).toBeUndefined();
    expect(catalog.marketplaces).toEqual([
      { id: 'personal', name: 'personal', origin: 'own', shared: true },
      { id: 'openai-bundled', name: 'openai-bundled', source: setup.bundled, origin: 'managed' },
      {
        id: 'fresh',
        name: 'fresh',
        source: 'https://github.com/owner/fresh.git',
        updatedAt: FETCHED.toISOString(),
        origin: 'own',
      },
      {
        id: 'northlight',
        name: 'Northlight',
        source: 'https://•••@github.com/northlight/plugins.git',
        updatedAt: UPGRADED.toISOString(),
        origin: 'own',
      },
      {
        id: 'pending',
        name: 'pending',
        source: 'git@github.com:owner/pending.git',
        origin: 'own',
        unread: 'Codex has no copy of its catalog in this profile',
      },
      { id: 'openai-curated', name: 'OpenAI Curated', updatedAt: SYNCED.toISOString(), origin: 'bundled' },
      { id: 'broken', name: 'broken', source: setup.broken, origin: 'own', unread: 'Its catalog could not be read' },
      { id: 'workbench', name: 'workbench', source: setup.workbench, origin: 'own' },
    ]);
    expect(catalog.plugins.map(({ id }) => id)).toEqual([
      'draft@personal',
      'browser@openai-bundled',
      'review@northlight',
      'lint@northlight',
      'deploy@northlight',
      'retired@northlight',
      'escape@northlight',
      'slack@openai-curated',
      'linear@openai-curated',
      'notes@workbench',
      'scratch@workbench',
    ]);

    // installed and older than the catalog's: Codex holds 1.2.0, the highest of its copies
    expect(listedIn(catalog, 'review@northlight')).toEqual({
      id: 'review@northlight',
      name: 'Review',
      marketplace: 'northlight',
      description: 'Reviews pull requests',
      author: 'Northlight Labs',
      // the marketplace's category wins over the plugin's own
      category: 'Coding',
      version: '1.3.0',
      homepage: 'https://northlight.dev/review?•••',
      // skill folders with a SKILL.md, never a dot folder; the servers of its `.mcp.json`
      brings: { skills: ['house-style'], servers: ['github'] },
      held: 'review@northlight',
      newer: true,
    });
    // an Agent Plugins manifest: its own fields make the face, skills in `skills/`, servers in `mcp.json`
    expect(listedIn(catalog, 'lint@northlight')).toEqual({
      id: 'lint@northlight',
      name: 'lint',
      marketplace: 'northlight',
      description: 'Lints a change',
      author: 'Lint Co',
      category: 'Other',
      version: '2.0.0',
      homepage: 'https://lint.example.com',
      brings: { skills: ['fix'], servers: ['eslint'] },
      held: 'lint@northlight',
    });
    // fetched from git when installed: the entry's words, no version, and no copy in the cache
    expect(listedIn(catalog, 'deploy@northlight')).toEqual({
      id: 'deploy@northlight',
      name: 'deploy',
      marketplace: 'northlight',
      description: 'Deploys a branch',
      author: 'Ops',
      homepage: 'https://northlight.dev/deploy?•••',
    });
    expect(listedIn(catalog, 'retired@northlight')).toMatchObject({
      version: '0.9.0',
      blocked: 'Codex does not offer it for install',
    });
    // a folder that links out of the marketplace: neither its manifest nor the entry's version
    expect(listedIn(catalog, 'escape@northlight')).toEqual({
      id: 'escape@northlight',
      name: 'escape',
      marketplace: 'northlight',
    });
    // kept by the curated sync's commit: Codex brings it up to date itself
    expect(listedIn(catalog, 'slack@openai-curated')).toEqual({
      id: 'slack@openai-curated',
      name: 'slack',
      marketplace: 'openai-curated',
      version: '1.0.39',
      held: 'slack@openai-curated',
    });
    expect(listedIn(catalog, 'draft@personal')).toEqual({
      id: 'draft@personal',
      name: 'Draft',
      marketplace: 'personal',
      version: '0.3.0',
    });
    expect(listedIn(catalog, 'browser@openai-bundled')).toMatchObject({ name: 'Browser', version: '26.917.71314' });
    // a manifest in its folder wins over the entry; with none, the entry is the manifest, paths and all
    expect(listedIn(catalog, 'notes@workbench')).toEqual({
      id: 'notes@workbench',
      name: 'notes',
      marketplace: 'workbench',
      version: '0.1.0',
    });
    expect(listedIn(catalog, 'scratch@workbench')).toEqual({
      id: 'scratch@workbench',
      name: 'Scratch Pad',
      marketplace: 'workbench',
      category: 'Notes',
      version: '0.0.1',
      brings: { skills: ['jot'] },
    });
    for (const id of ['chat-only@northlight', 'outside@northlight', 'unknown-source@northlight']) {
      expect(listedIn(catalog, id), id).toBeUndefined();
    }
  });

  it('suggests the curated catalog to a profile Codex has not started in, and answers for a root not made yet', async () => {
    const { home, root } = await managedSetup();
    const server = fakeAppServer({});
    const codex = service(server, { home });
    expect(await catalogOf(codex, managedProfile(root))).toEqual({
      provider: 'codex',
      profileId: 'work-codex',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      marketplaces: [],
      plugins: [],
      // a reserved name no add may take: only Codex clones it
      suggested: [
        {
          name: 'openai-curated',
          message: 'Codex fetches its curated catalog the first time it starts in this profile',
        },
      ],
      source: { kind: 'native-store', stability: 'experimental' },
    });
    expect(await codex.catalog!(managedProfile(join(home, 'missing')))).toEqual({
      status: 'not-found',
      provider: 'codex',
      message: 'this profile has no Codex root on disk yet',
      retryable: false,
    });
    expect(server.spawns).toEqual([]);
  });

  it('says so when the config or the personal catalog cannot be read, and lists the rest', async () => {
    const setup = await marketplaceSetup();
    const { home, root } = setup;
    await write(join(root, 'config.toml'), '[marketplaces.northlight\nsource_type = "git"\n');
    await write(setup.personal, '{ "plugins": [] }');
    const codex = service(fakeAppServer(answersFor(home, root)), { home });
    expect(await codex.catalog!(managedProfile(root))).toEqual({
      status: 'unavailable',
      provider: 'codex',
      message: "this profile's config.toml could not be read, so its marketplaces are not known",
      retryable: true,
    });
    const inventory = ExtensionInventorySchema.parse(await codex.inventory(managedProfile(root)));
    expect(inventory.unread).toEqual([
      {
        kind: 'marketplace',
        message: 'config.toml could not be read; ~/.agents/plugins/marketplace.json could not be read',
      },
    ]);
    // the curated catalog is no entry of the config
    expect(inventory.items.filter((item) => item.kind === 'marketplace').map(({ id }) => id)).toEqual([
      'openai-curated',
    ]);
  });
});

describe('Codex installs and marketplace acts', () => {
  const listedPlugin = (listed: CatalogPlugin): PluginItem => ({
    kind: 'plugin',
    id: listed.id,
    name: listed.name,
    origin: 'own',
    enabled: true,
    marketplace: listed.marketplace,
    ...(listed.version === undefined ? {} : { version: listed.version }),
  });

  it("installs a plugin its catalog lists with `codex plugin add`, bound to the profile's root", async () => {
    const setup = await marketplaceSetup();
    const { home, root } = setup;
    const codex = service(fakeAppServer({}), { home });
    const catalog = await catalogOf(codex, managedProfile(root));
    const deploy = listedIn(catalog, 'deploy@northlight')!;
    expect(
      ExtensionActPlanSchema.parse(
        codex.plan!(managedProfile(root), listedPlugin(deploy), 'install', { listed: deploy }),
      ),
    ).toEqual({
      target: { kind: 'plugin', id: 'deploy@northlight' },
      act: 'install',
      available: true,
      // the CLI, which never prompts; never the app-server's install, which opens a browser per sign-in
      runs: {
        kind: 'command',
        argv: ['/opt/node/bin/codex', 'plugin', 'add', 'deploy@northlight', '--json'],
        env: { CODEX_HOME: root },
      },
      display: '/opt/node/bin/codex plugin add deploy@northlight --json',
      reaches: [],
    });
    // the native default binds nothing
    expect(codex.plan!(nativeProfile(root), listedPlugin(deploy), 'install', { listed: deploy })).not.toHaveProperty(
      'runs.env',
    );
    const retired = listedIn(catalog, 'retired@northlight')!;
    expect(codex.plan!(managedProfile(root), listedPlugin(retired), 'install', { listed: retired })).toEqual({
      target: { kind: 'plugin', id: 'retired@northlight' },
      act: 'install',
      available: false,
      reason: 'blocked',
      message: 'Codex does not offer it for install',
    });
  });

  it('installs from no source a person gives, and no key its command would not take', async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    const work = managedProfile(root);
    const source = 'https://github.com/northlight/review';
    const fromSource: PluginItem = { kind: 'plugin', id: source, name: source, origin: 'own', enabled: true };
    expect(codex.plan!(work, fromSource, 'install', { source, holds: ['review@northlight'] })).toEqual({
      target: { kind: 'plugin', id: source },
      act: 'install',
      available: false,
      reason: 'unsupported',
      message: 'Codex installs a plugin only from a marketplace; add the marketplace first',
    });
    for (const id of ['-x@northlight', 'review', 'review@north light', '../review@northlight']) {
      const item: PluginItem = { kind: 'plugin', id, name: id, origin: 'own', enabled: true };
      expect(codex.plan!(work, item, 'install', { listed: { id, name: id, marketplace: 'northlight' } }), id).toEqual({
        target: { kind: 'plugin', id },
        act: 'install',
        available: false,
        reason: 'unsupported',
        message: "Codex's commands do not take this plugin's name",
      });
    }
    // only a plugin installs
    const server: McpServerItem = {
      kind: 'mcp-server',
      id: 'linear',
      name: 'linear',
      origin: 'own',
      enabled: true,
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
    };
    expect(codex.plan!(work, server, 'install')).toMatchObject({ available: false, reason: 'unsupported' });
  });

  it('adds a marketplace from its source with its own add', async () => {
    const { root } = await managedSetup();
    const codex = service(fakeAppServer({}));
    const adding = (source: string): MarketplaceItem => ({
      kind: 'marketplace',
      id: source,
      name: source,
      origin: 'own',
      enabled: true,
      source,
    });
    expect(
      ExtensionActPlanSchema.parse(codex.plan!(managedProfile(root), adding('northlight/plugins'), 'add')),
    ).toEqual({
      target: { kind: 'marketplace', id: 'northlight/plugins' },
      act: 'add',
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/node/bin/codex', 'plugin', 'marketplace', 'add', 'northlight/plugins', '--json'],
        env: { CODEX_HOME: root },
      },
      display: '/opt/node/bin/codex plugin marketplace add northlight/plugins --json',
      reaches: [],
    });
    for (const source of ['git@github.com:northlight/plugins.git', '/Users/test/work/workbench']) {
      expect(codex.plan!(nativeProfile(root), adding(source), 'add'), source).toMatchObject({
        available: true,
        runs: { kind: 'command', argv: ['/opt/node/bin/codex', 'plugin', 'marketplace', 'add', source, '--json'] },
      });
    }
    // never a flag, nor an address carrying a sign-in
    for (const source of ['--ref', 'https://me:secret@github.com/northlight/plugins.git']) {
      expect(codex.plan!(managedProfile(root), adding(source), 'add'), source).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Codex adds a marketplace from a GitHub repository, a git address or a folder',
      });
    }
  });

  it("fetches a git marketplace again and removes one of the profile's own; the rest change where they are", async () => {
    const setup = await marketplaceSetup();
    const { home, root } = setup;
    const codex = service(fakeAppServer(answersFor(home, root)), { home });
    const work = managedProfile(root);
    const inventory = ExtensionInventorySchema.parse(await codex.inventory(work));
    const held = (id: string) => {
      const item = inventory.items.find((candidate) => candidate.kind === 'marketplace' && candidate.id === id);
      expect(item, id).toBeDefined();
      return item as MarketplaceItem;
    };

    // Codex reinstalls every plugin installed from it from the new snapshot
    expect(ExtensionActPlanSchema.parse(codex.plan!(work, held('northlight'), 'update'))).toEqual({
      target: { kind: 'marketplace', id: 'northlight' },
      act: 'update',
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/node/bin/codex', 'plugin', 'marketplace', 'upgrade', 'northlight', '--json'],
        env: { CODEX_HOME: root },
      },
      display: '/opt/node/bin/codex plugin marketplace upgrade northlight --json',
      reaches: ['plugins'],
    });
    // the plugins installed from it stay installed
    expect(ExtensionActPlanSchema.parse(codex.plan!(work, held('northlight'), 'remove'))).toEqual({
      target: { kind: 'marketplace', id: 'northlight' },
      act: 'remove',
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/node/bin/codex', 'plugin', 'marketplace', 'remove', 'northlight', '--json'],
        env: { CODEX_HOME: root },
      },
      display: '/opt/node/bin/codex plugin marketplace remove northlight --json',
      reaches: [],
    });
    expect(codex.plan!(work, held('pending'), 'update')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['/opt/node/bin/codex', 'plugin', 'marketplace', 'upgrade', 'pending', '--json'] },
    });

    const unavailable = (id: string, act: 'update' | 'remove') => codex.plan!(work, held(id), act);
    expect(unavailable('workbench', 'update')).toEqual({
      target: { kind: 'marketplace', id: 'workbench' },
      act: 'update',
      available: false,
      reason: 'unsupported',
      message: 'Codex reads a local marketplace where it is',
    });
    expect(unavailable('workbench', 'remove')).toMatchObject({
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/node/bin/codex', 'plugin', 'marketplace', 'remove', 'workbench', '--json'],
      },
    });
    for (const id of ['openai-curated', 'openai-bundled']) {
      expect(unavailable(id, 'update'), id).toMatchObject({
        available: false,
        reason: 'not-own',
        message: 'Codex keeps it current itself',
      });
      expect(unavailable(id, 'remove'), id).toMatchObject({
        available: false,
        reason: 'not-own',
        message: 'It ships with Codex',
      });
    }
    expect(unavailable('personal', 'update')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Codex reads a local marketplace where it is',
    });
    expect(unavailable('personal', 'remove')).toEqual({
      target: { kind: 'marketplace', id: 'personal' },
      act: 'remove',
      available: false,
      reason: 'not-own',
      message: 'It is `~/.agents/plugins/marketplace.json`, which every Codex profile reads; it changes there',
    });
    for (const act of ['enable', 'disable', 'purge', 'sign-in', 'sign-out', 'install'] as const) {
      expect(codex.plan!(work, held('northlight'), act), act).toEqual({
        target: { kind: 'marketplace', id: 'northlight' },
        act,
        available: false,
        reason: 'unsupported',
        message: 'Codex adds, upgrades or removes a marketplace',
      });
    }
    // a name its commands would read as a flag
    expect(codex.plan!(work, { ...held('northlight'), id: '-northlight' }, 'remove')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: "Codex's commands do not take this marketplace's name",
    });
  });

  it('answers every act on every kind with a plan the schema takes, and never throws', async () => {
    const setup = await marketplaceSetup();
    const { home, root } = setup;
    const codex = service(fakeAppServer(answersFor(home, root)), { home });
    const inventory = ExtensionInventorySchema.parse(await codex.inventory(managedProfile(root)));
    const catalog = await catalogOf(codex, managedProfile(root));
    const items = inventory.items.filter((item) => item.kind !== 'mcp-server' || item.origin === 'own');
    const options = [
      undefined,
      { source: 'northlight/plugins', holds: [] },
      { listed: listedIn(catalog, 'review@northlight')! },
      { keepIn: join(home, 'kept', 'elsewhere') },
    ];
    for (const profile of [managedProfile(root), nativeProfile(root)]) {
      for (const item of items) {
        for (const act of ExtensionActKindSchema.options) {
          for (const option of options) {
            const plan = ExtensionActPlanSchema.parse(codex.plan!(profile, item as never, act, option));
            expect(plan, `${item.kind} ${item.id} ${act}`).toMatchObject({
              target: { kind: item.kind, id: item.id },
              act,
            });
          }
        }
      }
    }
  });
});

describe('Codex catalog keys, bounds and addresses', () => {
  /** Every listed plugin is keyed by the marketplace it names, one the catalog lists. */
  const expectOneKey = (catalog: ExtensionCatalog) => {
    const ids = new Set(catalog.marketplaces.map(({ id }) => id));
    for (const plugin of catalog.plugins) {
      expect(plugin.id, plugin.id).toBe(`${plugin.id.split('@')[0]}@${plugin.marketplace}`);
      expect(ids.has(plugin.marketplace), plugin.id).toBe(true);
    }
  };

  it('keys every plugin by the name Codex installs it by, and lists no catalog that names itself otherwise', async () => {
    const setup = await marketplaceSetup();
    const { home, root } = setup;
    // two forks whose catalogs both call themselves northlight, configured under keys of their own
    const myFork = join(home, 'work', 'my-fork');
    const otherFork = join(home, 'work', 'other-fork');
    await json(join(myFork, '.agents', 'plugins', 'marketplace.json'), {
      name: 'northlight',
      interface: { displayName: 'Northlight (fork)' },
      plugins: [
        { name: 'review', source: './plugins/review' },
        { name: 'fork-only', source: './plugins/fork-only' },
      ],
    });
    await json(join(myFork, 'plugins', 'fork-only', '.codex-plugin', 'plugin.json'), {
      name: 'fork-only',
      version: '1.0.0',
    });
    await json(join(otherFork, '.agents', 'plugins', 'marketplace.json'), {
      name: 'northlight',
      plugins: [{ name: 'other', source: './other' }],
    });
    await writeFile(
      join(root, 'config.toml'),
      [
        '',
        '[marketplaces.my-fork]',
        'source_type = "local"',
        `source = ${JSON.stringify(myFork)}`,
        '',
        '[marketplaces.other-fork]',
        'source_type = "local"',
        `source = ${JSON.stringify(otherFork)}`,
        '',
        '# what Codex writes when it installs from the fork: the key its catalog names',
        '[plugins."fork-only@northlight"]',
        'enabled = true',
      ].join('\n'),
      { flag: 'a' },
    );
    const codex = service(fakeAppServer(answersFor(home, root)), { home });
    // parses whole, where plugins under a name no marketplace has would have failed it
    const catalog = await catalogOf(codex, managedProfile(root));
    expectOneKey(catalog);

    for (const id of ['my-fork', 'other-fork']) {
      expect(
        catalog.marketplaces.find((marketplace) => marketplace.id === id),
        id,
      ).toEqual({
        id,
        name: id,
        source: id === 'my-fork' ? myFork : otherFork,
        origin: 'own',
        // said, never dropped quietly: Codex keys these plugins `@northlight`, and refuses an install
        // that two catalogs of that name both list
        unread: 'Its catalog calls itself northlight, the name Codex lists and installs its plugins by',
      });
      expect(catalog.plugins.some((plugin) => plugin.marketplace === id)).toBe(false);
    }
    // the marketplace configured under its own name keeps its plugins, held and newer as before
    expect(listedIn(catalog, 'review@northlight')).toMatchObject({
      marketplace: 'northlight',
      version: '1.3.0',
      held: 'review@northlight',
      newer: true,
    });
    expect(listedIn(catalog, 'fork-only@northlight')).toBeUndefined();
    const review = listedIn(catalog, 'review@northlight')!;
    const install = codex.plan!(
      managedProfile(root),
      {
        kind: 'plugin',
        id: review.id,
        name: review.name,
        origin: 'own',
        enabled: true,
        marketplace: review.marketplace,
      },
      'install',
      { listed: review },
    );
    expect(install).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['/opt/node/bin/codex', 'plugin', 'add', 'review@northlight', '--json'] },
    });
    // the forks stay in the inventory under their keys, which `codex plugin marketplace remove` takes
    const inventory = ExtensionInventorySchema.parse(await codex.inventory(managedProfile(root)));
    expect(inventory.items.filter((item) => item.kind === 'marketplace').map(({ id }) => id)).toEqual(
      expect.arrayContaining(['my-fork', 'other-fork', 'northlight']),
    );
    expect(inventory.unread).toBeUndefined();

    // a personal catalog that calls itself as a configured marketplace is keyed: the first is listed, and it is said
    await json(setup.personal, { name: 'workbench', plugins: [] });
    const collided = ExtensionInventorySchema.parse(await codex.inventory(managedProfile(root)));
    expect(collided.unread).toEqual([
      { kind: 'marketplace', message: 'two marketplaces are named workbench, and only the first is listed' },
    ]);
    expect(collided.items.find((item) => item.kind === 'marketplace' && item.id === 'workbench')).toMatchObject({
      shared: true,
    });
    expectOneKey(await catalogOf(codex, managedProfile(root)));
  });

  it('lists the curated clone by the name Codex gives it, and nothing of one whose catalog names itself otherwise', async () => {
    const { home, root } = await managedSetup();
    const curated = join(root, '.tmp', 'plugins');
    // openai/plugins as Codex's own tests lay it out: its catalog and its API catalog side by side
    await json(join(curated, '.agents', 'plugins', 'marketplace.json'), {
      name: 'openai-curated',
      interface: { displayName: 'OpenAI Curated' },
      plugins: [{ name: 'siwc-plugin', source: { source: 'local', path: './plugins/siwc-plugin' } }],
    });
    await json(join(curated, '.agents', 'plugins', 'api_marketplace.json'), {
      name: 'openai-api-curated',
      plugins: [{ name: 'api-plugin', source: { source: 'local', path: './plugins/api-plugin' } }],
    });
    const codex = service(fakeAppServer({}), { home });
    const both = await catalogOf(codex, managedProfile(root));
    expect(both.marketplaces).toEqual([{ id: 'openai-curated', name: 'OpenAI Curated', origin: 'bundled' }]);
    expect(both.plugins.map(({ id }) => id)).toEqual(['siwc-plugin@openai-curated']);
    expect(both.suggested).toBeUndefined();

    // the API catalog alone: Codex names the clone by it
    await rm(join(curated, '.agents', 'plugins', 'marketplace.json'));
    const apiOnly = await catalogOf(codex, managedProfile(root));
    expect(apiOnly.marketplaces).toEqual([{ id: 'openai-api-curated', name: 'openai-api-curated', origin: 'bundled' }]);
    expect(apiOnly.plugins.map(({ id }) => id)).toEqual(['api-plugin@openai-api-curated']);
    expect(apiOnly.suggested).toBeUndefined();

    // a clone whose catalog names itself otherwise is one Codex leaves out (`validate_expected_marketplace_name`)
    await json(join(curated, '.agents', 'plugins', 'marketplace.json'), {
      name: 'plugins',
      plugins: [{ name: 'stray', source: './stray' }],
    });
    const renamed = await catalogOf(codex, managedProfile(root));
    expect(renamed.marketplaces).toEqual([
      {
        id: 'openai-curated',
        name: 'openai-curated',
        origin: 'bundled',
        unread: 'Its catalog calls itself plugins, and Codex takes it only as openai-curated',
      },
    ]);
    expect(renamed.plugins).toEqual([]);
  });

  it("reads the folders of a catalog's first entries and of every plugin Codex holds, a few at a time, in order", async () => {
    const { home, root } = await managedSetup();
    const big = join(home, 'work', 'big');
    const count = 405;
    const name = (index: number) => `p${String(index).padStart(3, '0')}`;
    await json(join(big, '.agents', 'plugins', 'marketplace.json'), {
      name: 'big',
      plugins: Array.from({ length: count }, (_, index) => ({
        name: name(index),
        source: `./plugins/${name(index)}`,
        displayName: `Entry ${index}`,
        version: `0.0.${index}`,
      })),
    });
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        json(join(big, 'plugins', name(index), '.codex-plugin', 'plugin.json'), {
          name: name(index),
          version: `1.0.${index}`,
          interface: { displayName: `Folder ${index}` },
        }),
      ),
    );
    await write(
      join(root, 'config.toml'),
      [
        '[marketplaces.big]',
        'source_type = "local"',
        `source = ${JSON.stringify(big)}`,
        '',
        '[plugins."p402@big"]',
        'enabled = true',
      ].join('\n'),
    );
    await mkdir(join(root, 'plugins', 'cache', 'big', 'p402', '1.0.0'), { recursive: true });

    const catalog = await catalogOf(service(fakeAppServer({}), { home }), managedProfile(root));
    expect(catalog.plugins.map(({ id }) => id)).toEqual(
      Array.from({ length: count }, (_, index) => `${name(index)}@big`),
    );
    // within the cap: what the folder says
    for (const index of [0, 1, 250, 399]) {
      expect(catalog.plugins[index], name(index)).toEqual({
        id: `${name(index)}@big`,
        name: `Folder ${index}`,
        marketplace: 'big',
        version: `1.0.${index}`,
      });
    }
    // past it: what the entry says, with no version, since the folder's is not read
    for (const index of [400, 401, 403, 404]) {
      expect(catalog.plugins[index], name(index)).toEqual({
        id: `${name(index)}@big`,
        name: `Entry ${index}`,
        marketplace: 'big',
      });
    }
    // held past it: its folder is read, so its version says it is newer
    expect(catalog.plugins[402]).toEqual({
      id: 'p402@big',
      name: 'Folder 402',
      marketplace: 'big',
      version: '1.0.402',
      held: 'p402@big',
      newer: true,
    });
  });

  it('shows an author given as text by its name alone', async () => {
    const { home, root } = await managedSetup();
    const solo = join(home, 'work', 'solo');
    await json(join(solo, '.agents', 'plugins', 'marketplace.json'), {
      name: 'solo',
      plugins: [
        {
          name: 'jane',
          source: { source: 'npm', package: '@jane/solo' },
          author: 'Jane Doe <jane@example.com> (https://jane.example.com)',
        },
        { name: 'agent', source: './agent' },
      ],
    });
    await json(join(solo, 'agent', 'plugin.json'), {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'agent',
      author: 'Ada Lovelace (mailto:ada@example.com)',
    });
    await write(
      join(root, 'config.toml'),
      ['[marketplaces.solo]', 'source_type = "local"', `source = ${JSON.stringify(solo)}`].join('\n'),
    );
    const catalog = await catalogOf(service(fakeAppServer({}), { home }), managedProfile(root));
    expect(listedIn(catalog, 'jane@solo')).toMatchObject({ author: 'Jane Doe' });
    expect(listedIn(catalog, 'agent@solo')).toMatchObject({ author: 'Ada Lovelace' });
    const document = JSON.stringify(catalog);
    for (const address of ['jane@example.com', 'jane.example.com', 'ada@example.com']) {
      expect(document).not.toContain(address);
    }
  });

  it('shows an scp-like source with its user only when that user is `git`', async () => {
    const { home, root } = await managedSetup();
    await write(
      join(root, 'config.toml'),
      [
        '[marketplaces.team]',
        'source_type = "git"',
        'source = "deploy-bot@git.example.com:team/plugins.git"',
        '',
        '[marketplaces.public]',
        'source_type = "git"',
        'source = "git@github.com:owner/public.git"',
        '',
        '[marketplaces.hostonly]',
        'source_type = "git"',
        'source = "git.example.com:team/hostonly.git"',
        '',
        '[marketplaces.bare]',
        'source_type = "git"',
        'source = "not an address"',
      ].join('\n'),
    );
    const inventory = ExtensionInventorySchema.parse(
      await service(fakeAppServer(answersFor(home, root)), { home }).inventory(managedProfile(root)),
    );
    const sourceOf = (id: string) =>
      inventory.items.find((item): item is MarketplaceItem => item.kind === 'marketplace' && item.id === id)?.source;
    expect(sourceOf('team')).toBe('•••@git.example.com:team/plugins.git');
    expect(sourceOf('public')).toBe('git@github.com:owner/public.git');
    expect(sourceOf('hostonly')).toBe('git.example.com:team/hostonly.git');
    // what parses as no address is masked whole
    expect(sourceOf('bare')).toBe('•••');
    expect(JSON.stringify(inventory)).not.toContain('deploy-bot');
  });
});

describe('Codex catalog text anyone may write', () => {
  it('reads crafted authors, homepages and sources of some 20k characters in one pass, and shows none of them', async () => {
    const { home, root } = await managedSetup();
    const crafted = join(home, 'work', 'crafted');
    const long = 20_000;
    // each is a run a backtracking pattern never finds the end of
    const authors = [
      '(@'.repeat(long / 2),
      '<'.repeat(long),
      'a'.repeat(long),
      `(${'a@'.repeat(long / 2)}`,
      `Jane ${'<('.repeat(long / 2)}`,
    ];
    const homepages = [
      `https://${'a'.repeat(long)}`,
      `https://${'@'.repeat(long)}`,
      `https://example.com/${'/'.repeat(long)}?`,
    ];
    await json(join(crafted, '.agents', 'plugins', 'marketplace.json'), {
      name: 'crafted',
      plugins: [
        ...authors.map((author, index) => ({
          name: `author-${index}`,
          source: { source: 'npm', package: `@crafted/author-${index}` },
          author,
        })),
        ...homepages.map((homepage, index) => ({
          name: `homepage-${index}`,
          source: { source: 'npm', package: `@crafted/homepage-${index}` },
          homepage,
        })),
        { name: 'manifest', source: './manifest' },
      ],
    });
    await json(join(crafted, 'manifest', '.codex-plugin', 'plugin.json'), {
      name: 'manifest',
      interface: { developerName: '(@'.repeat(long / 2), websiteUrl: `https://${'a:'.repeat(long / 2)}` },
    });
    const sources = [
      `${'u'.repeat(long)}@git.example.com:team/plugins.git`,
      'a@'.repeat(long / 2),
      `${'h'.repeat(long)}:${'p'.repeat(64)}`,
      `https://${'a'.repeat(long)}`,
      `ssh://${'u@'.repeat(long / 2)}host/path`,
    ];
    await write(
      join(root, 'config.toml'),
      [
        '[marketplaces.crafted]',
        'source_type = "local"',
        `source = ${JSON.stringify(crafted)}`,
        ...sources.flatMap((source, index) => [
          '',
          `[marketplaces.source-${index}]`,
          'source_type = "git"',
          `source = ${JSON.stringify(source)}`,
        ]),
      ].join('\n'),
    );

    const codex = service(fakeAppServer({}), { home });
    const started = performance.now();
    const catalog = await catalogOf(codex, managedProfile(root));
    expect(performance.now() - started).toBeLessThan(2_000);

    for (const index of authors.keys()) {
      expect(listedIn(catalog, `author-${index}@crafted`), `author-${index}`).not.toHaveProperty('author');
    }
    expect(listedIn(catalog, 'manifest@crafted')).not.toHaveProperty('author');
    // an address past a listing's length is masked whole, so it is none to show
    for (const index of [0, 1, 2]) {
      expect(listedIn(catalog, `homepage-${index}@crafted`)?.homepage ?? '', `homepage-${index}`).not.toContain(
        'a'.repeat(1_000),
      );
    }
    const shown = new Map(catalog.marketplaces.map(({ id, source }) => [id, source]));
    // a user other than `git` is masked, however long; what does not parse as an address is masked whole
    expect(shown.get('source-0')).toBe('•••@git.example.com:team/plugins.git');
    expect(shown.get('source-3')).toBe('•••');
    expect(JSON.stringify(catalog)).not.toContain('u'.repeat(1_000));
  });
});

describe('parseCodexConfig', () => {
  it('reads tables, dotted and quoted keys, inline tables, arrays of tables, and strings of every kind', () => {
    const config = parseCodexConfig(
      [
        'plugins."a@b".enabled = true',
        'notes = """',
        '[marketplaces.phantom]',
        '"""',
        "path = 'C:\\raw'",
        '',
        '[marketplaces]',
        'inline = { source_type = "local", source = "/work/inline" }',
        '',
        '[marketplaces."quoted-name"]',
        'source_type = "git" # a comment',
        'sparse_paths = [',
        '  "plugins/a",',
        '  "plugins/b",',
        ']',
        '',
        '[[skills.config]]',
        'path = "/x/SKILL.md"',
        'enabled = false',
      ].join('\n'),
    );
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      plugins: { 'a@b': { enabled: true } },
      notes: '[marketplaces.phantom]\n',
      path: 'C:\\raw',
      marketplaces: {
        inline: { source_type: 'local', source: '/work/inline' },
        'quoted-name': { source_type: 'git', sparse_paths: ['plugins/a', 'plugins/b'] },
      },
      skills: { config: [{ path: '/x/SKILL.md', enabled: false }] },
    });
  });

  it('keeps `__proto__` a key and refuses what it does not know', () => {
    const config = parseCodexConfig('[__proto__]\npolluted = true\n');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(config)).toEqual(['__proto__']);
    expect(() => parseCodexConfig('key = "unterminated\n')).toThrow();
    expect(() => parseCodexConfig('[table\n')).toThrow();
    expect(() => parseCodexConfig('a = 1 b = 2\n')).toThrow();
  });
});
