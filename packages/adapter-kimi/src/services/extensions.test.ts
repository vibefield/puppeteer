import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  ExtensionActPlanSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type ExtensionInventory,
  type ExtensionItem,
  type SkillItem,
} from '@vibecook/puppeteer-core';
import { createKimiExtensionService } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'kimi-extensions-')));
  made.push(dir);
  return dir;
}

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string, description: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

const managedProfile = (root: string) =>
  AgentProfileSchema.parse({
    id: 'work-kimi',
    provider: 'kimi',
    label: 'Work',
    kind: 'managed',
    dataRoot: root,
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const nativeProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'kimi:native-default',
    provider: 'kimi',
    label: 'Default',
    kind: 'native-default',
    dataRoot: join(home, '.kimi-code'),
    createdAt: '1970-01-01T00:00:00.000Z',
  });

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);

describe('Kimi Code extensions', () => {
  it('declares plugins, servers and skills, changed inside Kimi Code or in a folder, and no marketplaces', () => {
    const { provider } = createKimiExtensionService({ home: '/Users/test', env: {} });
    expect(ExtensionProviderSchema.parse(provider)).toEqual({
      id: 'kimi',
      label: 'Kimi',
      support: {
        plugins: { store: 'profile', changes: 'in-app', read: true },
        mcpServers: { store: 'profile', changes: 'in-app', read: true },
        skills: { store: 'mixed', changes: 'folder', read: true },
      },
    });
  });

  it('reads a managed root: its plugins with their servers and skills, its servers and skills, and no secret', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'kimi-4c1d');
    const managed = join(root, 'plugins', 'managed');
    await write(join(root, 'mcp.json'), {
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: 'LINEAR_TOKEN' },
        postgres: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://app:hunter2@localhost/dev'],
          env: { PGPASSWORD: 'hunter2' },
          enabled: false,
        },
        events: {
          transport: 'sse',
          url: 'https://events.example.com/sse?key=sk-live-123',
          headers: { 'X-Api-Key': 'events-secret' },
        },
        notion: { url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
        socket: { transport: 'ws', url: 'wss://socket.example.com' },
        // A file entry shadows the plugin server of the same runtime name.
        'plugin-kimi-datasource:data': { command: 'uvx', args: ['datasource-shadow'] },
      },
    });
    await write(join(root, 'plugins', 'installed.json'), {
      version: 1,
      plugins: [
        {
          id: 'kimi-datasource',
          root: join(managed, 'kimi-datasource'),
          source: 'local-path',
          enabled: true,
          installedAt: '2026-09-20T10:00:00.000Z',
          capabilities: { mcpServers: { data: { enabled: true } } },
        },
        {
          id: 'webbridge',
          root: join(managed, 'webbridge'),
          source: 'zip-url',
          originalSource: 'https://cdn.example.com/webbridge.zip?token=zip-secret',
          enabled: false,
        },
        {
          id: 'superpowers',
          root: join(managed, 'superpowers'),
          source: 'github',
          enabled: true,
          capabilities: { mcpServers: { search: { enabled: false } } },
        },
        { id: 'Not An Id', root: join(managed, 'bad'), enabled: true },
      ],
    });
    await write(join(managed, 'kimi-datasource', 'kimi.plugin.json'), {
      name: 'kimi-datasource',
      version: '3.4.0',
      interface: { displayName: 'Kimi Datasource', shortDescription: 'Query data vendors' },
      mcpServers: {
        data: { command: 'node', args: ['./bin/kimi-datasource.mjs'], env: { DATASOURCE_KEY: 'ds-secret' } },
        reports: { command: 'node', args: ['./bin/reports.mjs'] },
      },
    });
    // `kimi.plugin.json` wins over the legacy location when both exist.
    await write(join(managed, 'kimi-datasource', '.kimi-plugin', 'plugin.json'), { name: 'legacy-name' });
    await write(join(managed, 'webbridge', '.kimi-plugin', 'plugin.json'), {
      name: 'webbridge',
      description: 'Drives the browser',
      skills: ['./skills', './../outside', 'skills'],
    });
    await write(join(managed, 'webbridge', 'skills', 'browse', 'SKILL.md'), skill('browse', 'Opens and reads pages'));
    await write(join(managed, 'outside', 'escape', 'SKILL.md'), skill('escape', 'Never loaded'));
    await write(join(managed, 'superpowers', 'kimi.plugin.json'), {
      name: 'superpowers',
      mcpServers: {
        search: { url: 'https://search.example.com/mcp' },
        local: { command: '/usr/local/bin/escape-server' },
      },
    });
    await write(join(managed, 'superpowers', 'SKILL.md'), skill('superpowers', 'Plans before it builds'));

    await write(join(root, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
    await write(join(root, 'skills', 'commit.md'), '\n\nWrites a conventional commit message.\n\nMore detail.\n');
    await write(join(root, 'skills', 'review', 'SKILL.md'), skill('review', 'Reviews a pull request'));
    await write(join(root, 'skills', 'review.md'), 'A flat copy the folder beats.\n');
    await write(join(root, 'skills', 'undescribed', 'SKILL.md'), '---\nname: undescribed\n---\n');
    await write(join(root, 'skills', 'walkthrough', 'SKILL.md'), skill('walkthrough', 'Slash only', 'type: flow\n'));
    await write(join(root, 'skills', 'runner', 'SKILL.md'), skill('runner', 'Unknown type', 'type: script\n'));
    await write(join(root, 'skills', '.hidden', 'SKILL.md'), skill('hidden', 'Never listed'));
    await write(join(home, '.agents', 'skills', 'browser-use', 'SKILL.md'), skill('browser-use', 'Drives a browser'));
    const library = join(home, 'library', 'changelog');
    await write(join(library, 'SKILL.md'), skill('changelog', 'Writes the changelog entry'));
    await symlink(library, join(home, '.agents', 'skills', 'changelog'));

    const inventory = ExtensionInventorySchema.parse(
      await createKimiExtensionService({ home, env: {}, now }).inventory(managedProfile(root)),
    );
    const document = JSON.stringify(inventory);
    for (const secret of ['hunter2', 'sk-live-123', 'events-secret', 'ds-secret', 'zip-secret']) {
      expect(document).not.toContain(secret);
    }
    expect(inventory).toMatchObject({
      provider: 'kimi',
      profileId: 'work-kimi',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store' },
    });
    expect(inventory.unread).toBeUndefined();

    expect(find(inventory, 'plugin', 'kimi-datasource')).toEqual({
      kind: 'plugin',
      id: 'kimi-datasource',
      name: 'kimi-datasource',
      origin: 'own',
      enabled: true,
      location: join(managed, 'kimi-datasource'),
      version: '3.4.0',
      description: 'Query data vendors',
    });
    expect(find(inventory, 'plugin', 'webbridge')).toMatchObject({ enabled: false, description: 'Drives the browser' });
    expect(find(inventory, 'plugin', 'superpowers')).toMatchObject({ enabled: true });
    expect(inventory.items.filter((item) => item.kind === 'plugin')).toHaveLength(3);

    expect(find(inventory, 'mcp-server', 'linear')).toEqual({
      kind: 'mcp-server',
      id: 'linear',
      name: 'linear',
      origin: 'own',
      location: join(root, 'mcp.json'),
      enabled: true,
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      env: ['LINEAR_TOKEN'],
      headers: ['Authorization'],
    });
    expect(find(inventory, 'mcp-server', 'postgres')).toMatchObject({
      enabled: false,
      transport: 'stdio',
      target: 'npx -y @modelcontextprotocol/server-postgres postgresql://•••@localhost/dev',
      env: ['PGPASSWORD'],
    });
    expect(find(inventory, 'mcp-server', 'events')).toMatchObject({
      transport: 'sse',
      target: 'https://events.example.com/sse?•••',
      headers: ['X-Api-Key'],
    });
    // Signed in or not is the credential store's to say, which is never read.
    expect(find(inventory, 'mcp-server', 'notion')).not.toHaveProperty('auth');
    expect(find(inventory, 'mcp-server', 'socket')).toBeUndefined();
    expect(find(inventory, 'mcp-server', 'plugin-kimi-datasource:data')).toMatchObject({
      origin: 'own',
      target: 'uvx datasource-shadow',
    });
    expect(find(inventory, 'mcp-server', 'plugin-kimi-datasource:reports')).toMatchObject({
      name: 'reports',
      origin: 'plugin',
      plugin: 'kimi-datasource',
      enabled: true,
      target: 'node ./bin/reports.mjs',
      location: join(managed, 'kimi-datasource', 'kimi.plugin.json'),
    });
    expect(find(inventory, 'mcp-server', 'plugin-superpowers:search')).toMatchObject({ enabled: false });
    expect(find(inventory, 'mcp-server', 'plugin-superpowers:local')).toBeUndefined();

    expect(find(inventory, 'skill', 'release-notes')).toEqual({
      kind: 'skill',
      id: 'release-notes',
      name: 'release-notes',
      origin: 'own',
      enabled: true,
      location: join(root, 'skills', 'release-notes'),
      description: 'Drafts release notes',
    });
    expect(find(inventory, 'skill', 'commit')).toMatchObject({
      name: 'commit',
      location: join(root, 'skills', 'commit.md'),
      description: 'Writes a conventional commit message.',
    });
    expect(find(inventory, 'skill', 'review')).toMatchObject({ location: join(root, 'skills', 'review') });
    expect(find(inventory, 'skill', 'walkthrough')).toBeDefined();
    for (const skipped of ['undescribed', 'runner', 'hidden', '.hidden']) {
      expect(inventory.items.some((item) => item.kind === 'skill' && item.id === skipped)).toBe(false);
    }
    expect(find(inventory, 'skill', 'shared:browser-use')).toMatchObject({ origin: 'own', shared: true });
    expect(find(inventory, 'skill', 'shared:changelog')).toMatchObject({ linkTarget: library, shared: true });
    expect(find(inventory, 'skill', 'plugin:webbridge:browse')).toMatchObject({
      origin: 'plugin',
      plugin: 'webbridge',
      enabled: false,
    });
    expect(find(inventory, 'skill', 'plugin:superpowers:superpowers')).toMatchObject({
      location: join(managed, 'superpowers'),
      enabled: true,
    });
    expect(inventory.items.some((item) => item.name === 'escape')).toBe(false);
    expect(inventory.items.filter((item) => item.kind === 'skill').every((item) => !('switchable' in item))).toBe(true);
  });

  it('reads the native default where Kimi Code resolves it: KIMI_CODE_HOME, else ~/.kimi-code', async () => {
    const home = await tempHome();
    await write(join(home, '.kimi-code', 'mcp.json'), {
      mcpServers: { home: { url: 'https://home.example.com/mcp' } },
    });
    await write(join(home, 'elsewhere', 'mcp.json'), {
      mcpServers: { elsewhere: { url: 'https://elsewhere.example.com/mcp' } },
    });

    const plain = ExtensionInventorySchema.parse(
      await createKimiExtensionService({ home, env: {}, now }).inventory(nativeProfile(home)),
    );
    expect(plain.items.map((item) => item.id)).toEqual(['home']);
    const moved = ExtensionInventorySchema.parse(
      await createKimiExtensionService({
        home,
        env: { KIMI_CODE_HOME: join(home, 'elsewhere') },
        now,
      }).inventory(nativeProfile(home)),
    );
    expect(moved.items.map((item) => item.id)).toEqual(['elsewhere']);
  });

  it("gives a server's definition only from mcp.json, whole: no folder, masked part or header stays behind", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'kimi-4c1d');
    await write(join(root, 'mcp.json'), {
      mcpServers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env: { CONTEXT7_API_KEY: 'ctx-secret' },
        },
        docs: { url: 'https://docs.example.com/mcp' },
        events: { transport: 'sse', url: 'https://events.example.com/sse' },
        linear: { url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: 'LINEAR_TOKEN' },
        masked: { command: 'uvx', args: ['mcp-server', '--api-key', 'abc'] },
        folder: { command: 'node', args: ['server.js'], cwd: '/srv/mcp' },
      },
    });
    const plugin = join(root, 'plugins', 'managed', 'timekeeper');
    await write(join(root, 'plugins', 'installed.json'), {
      version: 1,
      plugins: [{ id: 'timekeeper', root: plugin, source: 'local-path', enabled: true }],
    });
    await write(join(plugin, 'kimi.plugin.json'), {
      name: 'timekeeper',
      mcpServers: { time: { command: 'uvx', args: ['mcp-server-time'] } },
    });
    const inventory = ExtensionInventorySchema.parse(
      await createKimiExtensionService({ home, env: {}, now }).inventory(managedProfile(root)),
    );
    expect(JSON.stringify(inventory)).not.toContain('ctx-secret');
    const definitionOf = (id: string) => {
      const item = find(inventory, 'mcp-server', id);
      expect(item, id).toBeDefined();
      return item?.kind === 'mcp-server' ? item.definition : undefined;
    };
    expect(definitionOf('context7')).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: ['CONTEXT7_API_KEY'],
    });
    expect(definitionOf('docs')).toEqual({ transport: 'http', url: 'https://docs.example.com/mcp' });
    expect(definitionOf('events')).toEqual({ transport: 'sse', url: 'https://events.example.com/sse' });
    // A bearer variable becomes an `Authorization` header, whose value would stay behind.
    for (const id of ['linear', 'masked', 'folder', 'plugin-timekeeper:time']) {
      expect(definitionOf(id), id).toBeUndefined();
    }
  });

  it('says which store it could not read and lists the rest', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'kimi-4c1d');
    await write(join(root, 'plugins', 'installed.json'), { version: 1, plugins: {} });
    await write(join(root, 'mcp.json'), '{ not json');
    await write(join(root, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));

    const inventory = ExtensionInventorySchema.parse(
      await createKimiExtensionService({ home, env: {}, now }).inventory(managedProfile(root)),
    );
    expect(inventory.unread).toEqual([
      { kind: 'plugin', message: 'plugins/installed.json could not be read' },
      { kind: 'mcp-server', message: 'mcp.json could not be read' },
    ]);
    expect(inventory.items.map((item) => item.id)).toEqual(['release-notes']);
  });

  it('reads an empty root as holding nothing', async () => {
    const home = await tempHome();
    const inventory = ExtensionInventorySchema.parse(
      await createKimiExtensionService({ home, env: {}, now }).inventory(managedProfile(join(home, 'fresh'))),
    );
    expect(inventory.items).toEqual([]);
    expect(inventory.unread).toBeUndefined();
  });

  it("reads a skill's type past a crafted run of spaces in one pass, and still drops a comment after it", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'kimi-4c1d');
    // no `#` after the run, where `\s+#.*$` would backtrack over it from every space
    await write(
      join(root, 'skills', 'crafted', 'SKILL.md'),
      skill('crafted', 'A crafted type line', `type: flow${' '.repeat(20_000)}x\n`),
    );
    await write(
      join(root, 'skills', 'commented', 'SKILL.md'),
      skill('commented', 'Slash only', 'type: flow  # a note\n'),
    );
    const started = performance.now();
    const inventory = ExtensionInventorySchema.parse(
      await createKimiExtensionService({ home, env: {}, now }).inventory(managedProfile(root)),
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    // a type Kimi does not load leaves the skill out; a comment after a loaded one does not
    expect(inventory.items.map((item) => item.id)).toEqual(['commented']);
  });
});

// ── acts (RFC 006 C2) ──

const actProfile = (kind: 'managed' | 'native-default', dataRoot: string) =>
  ({
    id: kind === 'managed' ? 'work-kimi' : 'kimi:native-default',
    provider: 'kimi',
    label: kind === 'managed' ? 'Work' : 'Default',
    kind,
    dataRoot,
    createdAt: '2026-09-23T00:00:00.000Z',
  }) as const;
const actServer = (fields: Record<string, unknown> = {}) =>
  ({
    kind: 'mcp-server',
    id: 'linear',
    name: 'linear',
    origin: 'own',
    enabled: true,
    transport: 'http',
    target: 'https://mcp.linear.app/mcp',
    ...fields,
  }) as never;
const actSkill = (fields: Record<string, unknown> = {}) =>
  ({ kind: 'skill', id: 'release-notes', name: 'release-notes', origin: 'own', enabled: true, ...fields }) as never;
const actPlugin = (fields: Record<string, unknown> = {}) =>
  ({
    kind: 'plugin',
    id: 'kimi-datasource',
    name: 'kimi-datasource',
    origin: 'own',
    enabled: true,
    ...fields,
  }) as never;

describe('Kimi extension acts', () => {
  it('changes nothing from outside the app', () => {
    const kimi = createKimiExtensionService({ home: '/Users/test' });
    expect(kimi.plan!(actProfile('managed', '/p'), actServer(), 'disable')).toMatchObject({
      available: false,
      reason: 'in-app',
      message: 'Kimi changes its servers only inside the app, with /mcp-config',
    });
    expect(kimi.plan!(actProfile('managed', '/p'), actSkill(), 'disable')).toMatchObject({ reason: 'no-command' });
    expect(kimi.plan!(actProfile('managed', '/p'), actServer(), 'sign-in')).toMatchObject({
      available: false,
      reason: 'in-app',
      message: 'Kimi signs in to a server only inside the app, with /mcp-config',
    });
  });

  it('adds a server only inside the app, in the words of every server act', () => {
    const kimi = createKimiExtensionService({ home: '/Users/test' });
    const context7 = actServer({
      id: 'context7',
      name: 'context7',
      transport: 'stdio',
      target: 'npx -y @upstash/context7-mcp',
      env: ['CONTEXT7_API_KEY'],
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: ['CONTEXT7_API_KEY'],
      },
    });
    expect(ExtensionActPlanSchema.parse(kimi.plan!(actProfile('managed', '/p'), context7, 'add'))).toEqual({
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      available: false,
      reason: 'in-app',
      message: 'Kimi changes its servers only inside the app, with /mcp-config',
    });
  });

  it('changes a plugin only inside the app, whatever the act, and what a plugin brings with it', () => {
    const kimi = createKimiExtensionService({ home: '/Users/test' });
    const work = actProfile('managed', '/p');
    // The runtime answers a plugin's add and sign-ins itself; asked anyway, Kimi says the same.
    for (const act of ['enable', 'disable', 'remove', 'purge', 'update', 'add', 'sign-in', 'sign-out'] as const) {
      expect(ExtensionActPlanSchema.parse(kimi.plan!(work, actPlugin(), act)), act).toEqual({
        target: { kind: 'plugin', id: 'kimi-datasource' },
        act,
        available: false,
        reason: 'in-app',
        message:
          'Kimi changes plugins only inside the app: `/plugins`, where Space turns one on or off and D removes it',
      });
    }
    const brought = { origin: 'plugin', plugin: 'kimi-datasource' };
    for (const [item, act] of [
      [actServer({ id: 'plugin-kimi-datasource:data', name: 'data', ...brought }), 'disable'],
      [actSkill({ id: 'plugin:kimi-datasource:query', name: 'query', ...brought }), 'remove'],
    ] as const) {
      expect(kimi.plan!(work, item, act), act).toMatchObject({
        available: false,
        reason: 'not-own',
        message: 'It comes with the kimi-datasource plugin and changes with it',
      });
    }
  });
});

// ── installs and marketplaces (RFC 006 C2) ──

const EVERY_ACT = ['enable', 'disable', 'remove', 'sign-in', 'sign-out', 'add', 'update', 'purge', 'install'] as const;
const actMarketplace = (fields: Record<string, unknown> = {}) =>
  ({
    kind: 'marketplace',
    id: 'owner/kimi-plugins',
    name: 'owner/kimi-plugins',
    origin: 'own',
    enabled: true,
    source: 'owner/kimi-plugins',
    ...fields,
  }) as never;

describe('Kimi installs and marketplaces', () => {
  it('installs a plugin only inside the app, from its catalog tabs or from a source there', () => {
    const kimi = createKimiExtensionService({ home: '/Users/test', env: {} });
    const work = actProfile('managed', '/p');
    // as the runtime hands a catalog entry: the plugin as Kimi would hold it once installed
    const listed = { id: 'kimi-webbridge', name: 'Kimi WebBridge', marketplace: 'kimi' };
    expect(
      ExtensionActPlanSchema.parse(
        kimi.plan!(work, actPlugin({ id: 'kimi-webbridge', name: 'Kimi WebBridge' }), 'install', { listed }),
      ),
    ).toEqual({
      target: { kind: 'plugin', id: 'kimi-webbridge' },
      act: 'install',
      available: false,
      reason: 'in-app',
      message: 'Kimi Code installs plugins only inside the app: `/plugins`, from its Official and Curated tabs',
    });
    const source = 'https://github.com/obra/superpowers';
    expect(
      ExtensionActPlanSchema.parse(
        kimi.plan!(work, actPlugin({ id: source, name: source }), 'install', { source, holds: ['kimi-datasource'] }),
      ),
    ).toEqual({
      target: { kind: 'plugin', id: source },
      act: 'install',
      available: false,
      reason: 'in-app',
      message: 'Kimi Code installs one from a folder or an address inside the app: `/plugins install <path-or-url>`',
    });
  });

  it('has no marketplace to add, fetch again or remove: its one catalog is inside the app', () => {
    const kimi = createKimiExtensionService({ home: '/Users/test', env: {} });
    for (const act of EVERY_ACT) {
      expect(ExtensionActPlanSchema.parse(kimi.plan!(actProfile('managed', '/p'), actMarketplace(), act)), act).toEqual(
        {
          target: { kind: 'marketplace', id: 'owner/kimi-plugins' },
          act,
          available: false,
          reason: 'unsupported',
          message: 'Kimi Code has one catalog, inside the app',
        },
      );
    }
    // nothing to read without the network, so no catalog; and still no marketplaces kind
    expect(kimi.catalog).toBeUndefined();
    expect(kimi.provider.support).not.toHaveProperty('marketplaces');
  });

  it('answers every act on every kind with a plan the schema takes, and never throws', () => {
    const kimi = createKimiExtensionService({ home: '/Users/test', env: {} });
    const items = [
      actPlugin(),
      actMarketplace(),
      actServer(),
      actSkill({ linkTarget: '/Users/test/kept/release-notes' }),
    ];
    const options = [
      undefined,
      { source: 'https://github.com/obra/superpowers', holds: [] },
      { listed: { id: 'kimi-datasource', name: 'kimi-datasource', marketplace: 'kimi' } },
      { keepIn: '/Users/test/kept/elsewhere' },
    ];
    for (const profile of [actProfile('managed', '/p'), actProfile('native-default', '/Users/test/.kimi-code')]) {
      for (const item of items) {
        for (const act of EVERY_ACT) {
          for (const option of options) {
            const { kind, id } = item as { kind: string; id: string };
            const plan = ExtensionActPlanSchema.parse(kimi.plan!(profile, item, act, option));
            expect(plan, `${kind} ${act}`).toMatchObject({ target: { kind, id }, act });
          }
        }
      }
    }
  });
});

// ── skills placed (RFC 006 C2) ──

/** A skill to place, as the runtime gives it: the skill as Kimi would hold it once linked. */
const placed = (name: string, linkTarget?: string): SkillItem => ({
  kind: 'skill',
  id: name,
  name,
  origin: 'own',
  enabled: true,
  ...(linkTarget === undefined ? {} : { linkTarget }),
});
const held = (inventory: ExtensionInventory, id: string): SkillItem => {
  const item = find(inventory, 'skill', id);
  expect(item, id).toMatchObject({ kind: 'skill' });
  return item as SkillItem;
};

describe('Kimi skills placed', () => {
  it("links a kept skill into the root's skills folder, and the read finds the link as the root's own", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'kimi-4c1d');
    const kept = join(home, 'kept', 'release-notes');
    await write(join(kept, 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
    const kimi = createKimiExtensionService({ home, env: {}, now });
    const work = managedProfile(root);

    expect(ExtensionActPlanSchema.parse(kimi.plan!(work, placed('release-notes', kept), 'add'))).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'link', path: join(root, 'skills', 'release-notes'), target: kept }] },
      display: 'link ~/kept/release-notes → ~/profiles/work/kimi-4c1d/skills/release-notes',
      reaches: [],
    });

    // The runtime's step, taken here by hand: the second read follows the link.
    await mkdir(join(root, 'skills'), { recursive: true });
    await symlink(kept, join(root, 'skills', 'release-notes'));
    const linked = held(ExtensionInventorySchema.parse(await kimi.inventory(work)), 'release-notes');
    expect(linked).toMatchObject({ origin: 'own', linkTarget: kept, description: 'Drafts release notes' });
    // Taking it away takes the link, never the host's folder, even with somewhere to keep one.
    expect(kimi.plan!(work, linked, 'remove', { keepIn: join(home, 'kept', 'elsewhere') })).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: join(root, 'skills', 'release-notes') }] },
      display: 'unlink ~/profiles/work/kimi-4c1d/skills/release-notes',
      reaches: [],
    });
  });

  it('places into the native default where Kimi Code resolves it, and only a folder by a name a folder takes', () => {
    const kept = '/Users/test/kept/release-notes';
    const native = actProfile('native-default', '/Users/test/.kimi-code');
    const plain = createKimiExtensionService({ home: '/Users/test', env: {} });
    expect(plain.plan!(native, placed('release-notes', kept), 'add')).toMatchObject({
      available: true,
      runs: {
        kind: 'files',
        steps: [{ op: 'link', path: '/Users/test/.kimi-code/skills/release-notes', target: kept }],
      },
      display: 'link ~/kept/release-notes → ~/.kimi-code/skills/release-notes',
    });
    const moved = createKimiExtensionService({ home: '/Users/test', env: { KIMI_CODE_HOME: '/Volumes/work/kimi' } });
    expect(moved.plan!(native, placed('release-notes', kept), 'add')).toMatchObject({
      runs: { kind: 'files', steps: [{ op: 'link', path: '/Volumes/work/kimi/skills/release-notes', target: kept }] },
      display: 'link ~/kept/release-notes → /Volumes/work/kimi/skills/release-notes',
    });

    expect(plain.plan!(native, placed('release-notes'), 'add')).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Kimi takes a skill as a folder to link',
    });
    for (const name of ['../escape', '.hidden', 'team/notes']) {
      expect(plain.plan!(native, placed(name, '/Users/test/kept/x'), 'add'), name).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: `Kimi cannot take a skill folder named ${name}`,
      });
    }
  });

  it("moves a folder skill of the root's own to where the host keeps it; one with nowhere to go, and a flat one, stay", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'kimi-4c1d');
    await write(join(root, 'skills', 'review', 'SKILL.md'), skill('review', 'Reviews a pull request'));
    await write(join(root, 'skills', 'commit.md'), '\n\nWrites a conventional commit message.\n');
    // A folder named like a flat file is still a folder.
    await write(join(root, 'skills', 'notes.md', 'SKILL.md'), skill('notes', 'Takes notes'));
    const kimi = createKimiExtensionService({ home, env: {}, now });
    const work = managedProfile(root);
    const inventory = ExtensionInventorySchema.parse(await kimi.inventory(work));
    const review = held(inventory, 'review');

    const keepIn = join(home, 'kept', 'review');
    expect(kimi.plan!(work, review, 'remove', { keepIn })).toEqual({
      target: { kind: 'skill', id: 'review' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'move', from: join(root, 'skills', 'review'), to: keepIn }] },
      display: 'move ~/profiles/work/kimi-4c1d/skills/review → ~/kept/review',
      reaches: [],
    });
    expect(kimi.plan!(work, review, 'remove')).toEqual({
      target: { kind: 'skill', id: 'review' },
      act: 'remove',
      available: false,
      reason: 'no-command',
      message: "review is a folder of Kimi's own, and nothing keeps it if it goes",
    });
    expect(kimi.plan!(work, held(inventory, 'commit'), 'remove', { keepIn: join(home, 'kept', 'commit') })).toEqual({
      target: { kind: 'skill', id: 'commit' },
      act: 'remove',
      available: false,
      reason: 'no-command',
      message: "commit is a flat skill, one file in Kimi's skills folder, and only a skill's folder is taken away",
    });
    expect(
      kimi.plan!(work, held(inventory, 'notes.md'), 'remove', { keepIn: join(home, 'kept', 'notes') }),
    ).toMatchObject({
      available: true,
      runs: {
        kind: 'files',
        steps: [{ op: 'move', from: join(root, 'skills', 'notes.md'), to: join(home, 'kept', 'notes') }],
      },
    });
    // One skill still has no switch.
    expect(kimi.plan!(work, review, 'disable')).toMatchObject({
      available: false,
      reason: 'no-command',
      message: 'Kimi has no switch for one skill',
    });
  });

  it('leaves a skill of the shared folder, and one a plugin brings or Kimi ships, where it is', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'kimi-4c1d');
    await write(join(home, '.agents', 'skills', 'browser-use', 'SKILL.md'), skill('browser-use', 'Drives a browser'));
    await write(join(home, '.agents', 'skills', 'tips.md'), 'Short tips.\n');
    const plugin = join(root, 'plugins', 'managed', 'webbridge');
    await write(join(root, 'plugins', 'installed.json'), {
      version: 1,
      plugins: [{ id: 'webbridge', root: plugin, source: 'local-path', enabled: true }],
    });
    await write(join(plugin, 'kimi.plugin.json'), { name: 'webbridge', skills: ['./skills'] });
    await write(join(plugin, 'skills', 'browse', 'SKILL.md'), skill('browse', 'Opens and reads pages'));
    const kimi = createKimiExtensionService({ home, env: {}, now });
    const work = managedProfile(root);
    const inventory = ExtensionInventorySchema.parse(await kimi.inventory(work));
    const remove = (item: SkillItem) => kimi.plan!(work, item, 'remove', { keepIn: join(home, 'kept', 'elsewhere') });

    expect(remove(held(inventory, 'shared:browser-use'))).toEqual({
      target: { kind: 'skill', id: 'shared:browser-use' },
      act: 'remove',
      available: false,
      reason: 'not-own',
      message: "browser-use is not in Kimi's own skills folder, and changes where it is",
    });
    // A flat skill of the shared folder is that folder's, not a flat one of the root's.
    expect(remove(held(inventory, 'shared:tips'))).toMatchObject({
      reason: 'not-own',
      message: "tips is not in Kimi's own skills folder, and changes where it is",
    });
    expect(remove(held(inventory, 'plugin:webbridge:browse'))).toMatchObject({
      reason: 'not-own',
      message: 'It comes with the webbridge plugin and changes with it',
    });
    // What Kimi ships is never read; one given answers as what it is.
    expect(remove(actSkill({ id: 'mcp-config', name: 'mcp-config', origin: 'bundled' }))).toMatchObject({
      reason: 'not-own',
      message: 'It ships with Kimi',
    });
  });
});
