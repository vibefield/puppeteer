import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  describeMcpDefinition,
  ExtensionActKindSchema,
  ExtensionActPlanSchema,
  ExtensionCatalogSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type CatalogPlugin,
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionActPlanOptions,
  type ExtensionCatalog,
  type ExtensionInventory,
  type ExtensionItem,
  type MarketplaceItem,
  type McpServerDefinition,
  type McpServerItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
import { createGrokExtensionService, parseGrokConfig } from './extensions.js';

const shownArgument = (argument: string): string => (argument.includes('\\') ? JSON.stringify(argument) : argument);

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'grok-extensions-')));
  made.push(dir);
  return dir;
}

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string, description?: string) =>
  `---\nname: ${name}\n${description ? `description: ${description}\n` : ''}---\n\n# ${name}\n\nThe body's first paragraph.\n`;

const managedProfile = (root: string) =>
  AgentProfileSchema.parse({
    id: 'work-grok',
    provider: 'grok',
    label: 'Work',
    kind: 'managed',
    dataRoot: root,
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const nativeProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'grok:native-default',
    provider: 'grok',
    label: 'Default',
    kind: 'native-default',
    dataRoot: join(home, '.grok'),
    createdAt: '1970-01-01T00:00:00.000Z',
  });

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);

const CONFIG = `# Grok's own config, as \`grok mcp add\` and \`grok mcp disable\` leave it
disabled_mcp_servers = ["figma"]

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"

[skills]
disabled = ["release_notes"]
ignore = ["~/.agents/skills/hidden-one"]

[plugins]
disabled = ["review"]

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
headers = { Authorization = "Bearer lin_api_secret_value" }

[mcp_servers.postgres]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-postgres",
  'postgresql://app:hunter2@localhost/dev', # a literal string
]
enabled = false

[mcp_servers.postgres.env]
PGPASSWORD = "hunter2"

[mcp_servers."events.feed"]
type = "sse"
url = "https://events.example.com/sse"
`;

/** A home as the probe found it: Grok's root, the shared skills folder, and Claude's and Cursor's stores Grok borrows. */
async function populate(home: string, root: string): Promise<{ library: string }> {
  await write(join(root, 'config.toml'), CONFIG);
  await write(join(root, 'skills', 'release_notes', 'SKILL.md'), skill('Release Notes', 'Drafts release notes'));
  await write(join(root, 'bundled', 'skills', 'imagine', 'SKILL.md'), skill('imagine'));
  await mkdir(join(root, 'bundled', 'skills', 'no-skill-here'), { recursive: true });

  // Grok's own installs: one named by its manifest (and switched off), one by its folder.
  const review = join(root, 'installed-plugins', 'review-3f9c2a1b');
  await write(join(review, '.grok-plugin', 'plugin.json'), {
    name: 'review',
    version: '1.2.0',
    description: 'Reviews against the house style',
  });
  await write(join(review, '.mcp.json'), {
    mcpServers: { house: { type: 'http', url: 'https://mcp.northlight.studio/house?key=abc123' } },
  });
  await write(join(review, 'skills', 'house-style', 'SKILL.md'), skill('house-style', 'Northlight naming'));
  await write(join(root, 'installed-plugins', 'notes-1a2b3c4d', 'skills', 'notes', 'SKILL.md'), skill('notes'));
  await write(join(root, 'installed-plugins', 'registry.json'), '{}');
  await write(join(root, 'installed-plugins', 'registry.lock'), '');

  // A folder dropped into `plugins/`: listed, and nothing it holds is read.
  const dropped = join(root, 'plugins', 'local-tool');
  await write(join(dropped, '.mcp.json'), { mcpServers: { dropped: { command: 'dropped-server' } } });
  await write(join(dropped, 'skills', 'dropped', 'SKILL.md'), skill('dropped'));

  // The shared folder every profile reads.
  await write(join(home, '.agents', 'skills', 'browser-use', 'SKILL.md'), skill('browser-use', 'Drives a browser'));
  await write(join(home, '.agents', 'skills', 'hidden-one', 'SKILL.md'), skill('hidden-one'));

  // Claude's user skills, one of them linked, and its synced ones.
  await write(join(home, '.claude', 'skills', 'synced', 'brand', 'SKILL.md'), skill('brand', 'Northlight voice'));
  const library = join(home, 'library', 'changelog');
  await write(join(library, 'SKILL.md'), skill('changelog'));
  await symlink(library, join(home, '.claude', 'skills', 'changelog'));
  await write(join(home, '.claude.json'), {
    numStartups: 4,
    mcpServers: {
      sentry: {
        type: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        headers: { Authorization: 'Bearer sntrys_secret_value' },
      },
    },
  });

  // Claude's installs: one with a wrapped server, one with a bare map, one that holds nothing.
  const cache = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official');
  const figma = join(cache, 'figma', '2.2.120');
  const github = join(cache, 'github', '1.0.0');
  const lsp = join(cache, 'typescript-lsp', '1.0.0');
  await write(join(figma, '.claude-plugin', 'plugin.json'), { name: 'figma', description: 'Figma designs' });
  await write(join(figma, '.mcp.json'), { mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } } });
  await write(join(figma, 'skills', 'figma-design', 'SKILL.md'), skill('figma-design'));
  await write(join(github, '.mcp.json'), {
    github: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_PAT}' },
    },
  });
  await write(join(lsp, '.in_use', '4242'), '');
  await write(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'figma@claude-plugins-official': [{ scope: 'user', version: '2.2.120', installPath: figma }],
      'github@claude-plugins-official': [{ scope: 'user', version: '1.0.0', installPath: github }],
      'typescript-lsp@claude-plugins-official': [{ scope: 'user', version: '1.0.0', installPath: lsp }],
    },
  });
  await write(join(home, '.claude', 'settings.json'), {
    enabledPlugins: { 'figma@claude-plugins-official': false },
  });

  // Cursor's.
  await write(join(home, '.cursor', 'mcp.json'), {
    mcpServers: { docs: { url: 'https://docs.example.com/mcp?token=cursor-secret-value' } },
  });
  await write(join(home, '.cursor', 'skills', 'cursor-rules', 'SKILL.md'), skill('cursor-rules'));
  return { library };
}

describe('Grok extensions', () => {
  it('declares every kind Grok has, its catalogs, what it installs a plugin from, and where it adds a marketplace from', () => {
    const { provider } = createGrokExtensionService({ home: '/nowhere', now });
    expect(ExtensionProviderSchema.parse(provider)).toEqual({
      id: 'grok',
      label: 'Grok',
      support: {
        plugins: { store: 'mixed', changes: 'command', read: true, sources: 'A folder on this Mac', catalog: true },
        marketplaces: {
          store: 'mixed',
          changes: 'command',
          read: true,
          sources: 'A git address, or a folder on this Mac',
        },
        mcpServers: { store: 'mixed', changes: 'command', read: true },
        skills: { store: 'mixed', changes: 'folder', read: true },
      },
    });
  });

  it('reads a managed root and what it borrows from the home, with no secret', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'grok-5c1e');
    const { library } = await populate(home, root);

    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    const document = JSON.stringify(inventory);
    for (const secret of ['lin_api_secret_value', 'hunter2', 'abc123', 'sntrys_secret_value', 'cursor-secret-value']) {
      expect(document).not.toContain(secret);
    }
    expect(inventory).toMatchObject({
      provider: 'grok',
      profileId: 'work-grok',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'experimental' },
    });
    expect(inventory.unread).toBeUndefined();

    // The root's own servers, from config.toml.
    expect(find(inventory, 'mcp-server', 'linear')).toEqual({
      kind: 'mcp-server',
      id: 'linear',
      name: 'linear',
      origin: 'own',
      enabled: true,
      location: join(root, 'config.toml'),
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      headers: ['Authorization'],
    });
    expect(find(inventory, 'mcp-server', 'postgres')).toMatchObject({
      enabled: false,
      transport: 'stdio',
      target: 'npx -y @modelcontextprotocol/server-postgres postgresql://•••@localhost/dev',
      env: ['PGPASSWORD'],
    });
    expect(find(inventory, 'mcp-server', 'events.feed')).toMatchObject({ transport: 'sse', enabled: true });

    // Borrowed servers: Claude's user servers and Cursor's.
    expect(find(inventory, 'mcp-server', 'claude:sentry')).toMatchObject({
      name: 'sentry',
      origin: 'borrowed',
      lender: 'claude',
      shared: true,
      enabled: true,
      location: join(home, '.claude.json'),
      headers: ['Authorization'],
    });
    expect(find(inventory, 'mcp-server', 'cursor:docs')).toMatchObject({
      origin: 'borrowed',
      lender: 'cursor',
      target: 'https://docs.example.com/mcp?•••',
    });

    // Plugins: Grok's own installs, the dropped folder, and Claude's installs Grok loads.
    expect(find(inventory, 'plugin', 'review')).toMatchObject({
      origin: 'own',
      enabled: false,
      version: '1.2.0',
      description: 'Reviews against the house style',
    });
    expect(find(inventory, 'plugin', 'notes-1a2b3c4d')).toMatchObject({ origin: 'own', enabled: true });
    expect(find(inventory, 'plugin', 'plugins:local-tool')).toMatchObject({ name: 'local-tool', enabled: true });
    // Grok loads Claude's install whatever Claude's own switch says.
    expect(find(inventory, 'plugin', 'figma@claude-plugins-official')).toMatchObject({
      name: 'figma',
      origin: 'borrowed',
      lender: 'claude',
      shared: true,
      enabled: true,
      version: '2.2.120',
      marketplace: 'claude-plugins-official',
    });
    expect(find(inventory, 'plugin', 'github@claude-plugins-official')).toMatchObject({ enabled: true });
    expect(find(inventory, 'plugin', 'typescript-lsp@claude-plugins-official')).toBeUndefined();

    // Plugins' servers: the wrapper only, switched off with a disabled plugin or by name.
    expect(find(inventory, 'mcp-server', 'plugin:review:house')).toMatchObject({
      origin: 'plugin',
      plugin: 'review',
      enabled: false,
      target: 'https://mcp.northlight.studio/house?•••',
    });
    expect(find(inventory, 'mcp-server', 'plugin:figma@claude-plugins-official:figma')).toMatchObject({
      origin: 'plugin',
      plugin: 'figma@claude-plugins-official',
      enabled: false,
    });
    const servers = inventory.items.filter((item) => item.kind === 'mcp-server').map((item) => item.name);
    expect(servers).not.toContain('github');
    expect(servers).not.toContain('dropped');

    // Skills, each where it lives.
    expect(find(inventory, 'skill', 'release_notes')).toMatchObject({
      name: 'release-notes',
      origin: 'own',
      enabled: false,
      description: 'Drafts release notes',
    });
    expect(find(inventory, 'skill', 'bundled:imagine')).toMatchObject({
      origin: 'bundled',
      description: "The body's first paragraph.",
    });
    expect(find(inventory, 'skill', 'agents:browser-use')).toMatchObject({ origin: 'own', shared: true });
    expect(find(inventory, 'skill', 'agents:hidden-one')).toBeUndefined();
    expect(find(inventory, 'skill', 'claude:synced:brand')).toMatchObject({
      name: 'brand',
      origin: 'borrowed',
      lender: 'claude',
      shared: true,
      enabled: true,
    });
    expect(find(inventory, 'skill', 'claude:changelog')).toMatchObject({ linkTarget: library });
    expect(find(inventory, 'skill', 'cursor:cursor-rules')).toMatchObject({ lender: 'cursor' });
    expect(find(inventory, 'skill', 'plugin:review:house-style')).toMatchObject({ plugin: 'review', enabled: false });
    expect(find(inventory, 'skill', 'plugin:notes-1a2b3c4d:notes')).toMatchObject({ enabled: true });
    expect(find(inventory, 'skill', 'plugin:figma@claude-plugins-official:figma-design')).toMatchObject({
      origin: 'plugin',
      enabled: true,
    });
    expect(inventory.items.some((item) => item.kind === 'skill' && item.name === 'dropped')).toBe(false);
    expect(inventory.items.some((item) => item.kind === 'skill' && item.name === 'no-skill-here')).toBe(false);
    expect(inventory.items.every((item) => item.kind !== 'skill' || !('switchable' in item))).toBe(true);
  });

  it('keeps borrowed items listed and out of use when a compat cell is off; plugins’ servers stay', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    await populate(home, root);
    await write(
      join(root, 'config.toml'),
      '[compat.claude]\nskills = false\nmcps = false\n\n[compat.cursor]\nmcps = false\n',
    );

    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(nativeProfile(home)),
    );
    expect(find(inventory, 'skill', 'claude:synced:brand')).toMatchObject({ enabled: false });
    expect(find(inventory, 'skill', 'plugin:figma@claude-plugins-official:figma-design')).toMatchObject({
      enabled: false,
    });
    expect(find(inventory, 'skill', 'plugin:notes-1a2b3c4d:notes')).toMatchObject({ enabled: true });
    expect(find(inventory, 'skill', 'agents:browser-use')).toMatchObject({ enabled: true });
    expect(find(inventory, 'skill', 'cursor:cursor-rules')).toMatchObject({ enabled: true });
    expect(find(inventory, 'mcp-server', 'claude:sentry')).toMatchObject({ enabled: false });
    expect(find(inventory, 'mcp-server', 'cursor:docs')).toMatchObject({ enabled: false });
    expect(find(inventory, 'mcp-server', 'plugin:figma@claude-plugins-official:figma')).toMatchObject({
      enabled: true,
    });
  });

  it('says which store it could not read and lists the rest', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    await write(join(root, 'config.toml'), '[mcp_servers.broken\ncommand = "x"\n');
    await write(join(root, 'skills', 'kept', 'SKILL.md'), skill('kept'));
    await write(join(home, '.claude.json'), '{ not json');
    await write(join(home, '.claude', 'plugins', 'installed_plugins.json'), '[]');
    await write(join(home, '.cursor', 'mcp.json'), {
      mcpServers: { docs: { url: 'https://docs.example.com/mcp' } },
    });

    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(nativeProfile(home)),
    );
    expect(inventory.unread).toEqual([
      { kind: 'mcp-server', message: 'config.toml could not be read' },
      { kind: 'plugin', message: 'config.toml could not be read' },
      { kind: 'skill', message: 'config.toml could not be read' },
      { kind: 'marketplace', message: 'config.toml could not be read' },
    ]);
    expect(inventory.items.map((item) => `${item.kind} ${item.id}`)).toEqual(['mcp-server cursor:docs', 'skill kept']);
  });

  it('reads an empty root in an empty home as holding nothing', async () => {
    const home = await tempHome();
    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(managedProfile(join(home, 'fresh'))),
    );
    expect(inventory.items).toEqual([]);
    expect(inventory.unread).toBeUndefined();
  });

  it('gives an own or borrowed server its definition when nothing in it was hidden, and a plugin’s server none', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    await write(
      join(root, 'config.toml'),
      [
        '[mcp_servers.context7]',
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        'env = { CONTEXT7_API_KEY = "ctx7sk-live-secret" }',
        '',
        '[mcp_servers.events]',
        'type = "sse"',
        'url = "https://events.example.com/sse"',
        '',
        '[mcp_servers.linear]',
        'url = "https://mcp.linear.app/mcp"',
        'headers = { Authorization = "Bearer lin_api_secret_value" }',
        '',
        '[mcp_servers.notes]',
        'command = "node"',
        'args = ["${HOME}/servers/notes.js"]',
        '',
        '[mcp_servers.postgres]',
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-postgres", "postgresql://app:hunter2@localhost/dev"]',
      ].join('\n'),
    );
    await write(join(home, '.claude.json'), {
      mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
    });
    await write(join(home, '.cursor', 'mcp.json'), {
      mcpServers: { docs: { url: 'https://docs.example.com/mcp?token=cursor-secret-value' } },
    });
    const review = join(root, 'installed-plugins', 'review-3f9c2a1b');
    await write(join(review, '.grok-plugin', 'plugin.json'), { name: 'review' });
    await write(join(review, '.mcp.json'), {
      mcpServers: { house: { type: 'http', url: 'https://mcp.northlight.studio/house' } },
    });

    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(nativeProfile(home)),
    );
    const document = JSON.stringify(inventory);
    for (const secret of ['ctx7sk-live-secret', 'lin_api_secret_value', 'hunter2', 'cursor-secret-value']) {
      expect(document).not.toContain(secret);
    }
    const definition = (id: string) => {
      const server = find(inventory, 'mcp-server', id);
      expect(server, id).toBeDefined();
      return (server as McpServerItem).definition;
    };
    // The names the server reads travel; their values stay in Grok's config.
    expect(definition('context7')).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: ['CONTEXT7_API_KEY'],
    });
    expect(definition('events')).toEqual({ transport: 'sse', url: 'https://events.example.com/sse' });
    expect(definition('claude:deepwiki')).toEqual({ transport: 'http', url: 'https://mcp.deepwiki.com/mcp' });
    // A header, a variable inside the command line, anything masked, and a plugin's server stay behind.
    for (const id of ['linear', 'notes', 'postgres', 'cursor:docs', 'plugin:review:house']) {
      expect(definition(id), id).toBeUndefined();
    }
  });
});

describe('parseGrokConfig', () => {
  it('reads the TOML Grok writes: tables, dotted and quoted keys, inline tables, arrays, strings and scalars', () => {
    const config = parseGrokConfig(
      [
        'title = "a \\"quoted\\" \\u00e9"',
        "path = 'C:\\raw'",
        'multi = """',
        'one \\',
        '   two"""',
        "lit = '''",
        "line'''",
        'count = 1_000',
        'ratio = -0.5',
        'on = true',
        'when = 2026-09-25T09:00:00Z',
        'privacy.privacy_banner_acked = true',
        '',
        '[mcp_servers."my.server"]',
        'env = {',
        '  A = "1", # first',
        '  B = { C = "2" },',
        '}',
        '',
        '[[marketplace.sources]]',
        'name = "one"',
        '[[marketplace.sources]]',
        'name = "two"',
        '[marketplace.sources.meta]',
        'kind = "git"',
      ].join('\n'),
    );
    expect(config.title).toBe('a "quoted" é');
    expect(config.path).toBe('C:\\raw');
    expect(config.multi).toBe('one two');
    expect(config.lit).toBe('line');
    expect(config.count).toBe(1000);
    expect(config.ratio).toBe(-0.5);
    expect(config.on).toBe(true);
    expect(config.when).toBe('2026-09-25T09:00:00Z');
    expect(JSON.parse(JSON.stringify(config.privacy))).toEqual({ privacy_banner_acked: true });
    expect(JSON.parse(JSON.stringify(config.mcp_servers))).toEqual({
      'my.server': { env: { A: '1', B: { C: '2' } } },
    });
    expect(JSON.parse(JSON.stringify(config.marketplace))).toEqual({
      sources: [{ name: 'one' }, { name: 'two', meta: { kind: 'git' } }],
    });
  });

  it('keeps `__proto__` a key and refuses what it does not know', () => {
    const config = parseGrokConfig('[__proto__]\npolluted = true\n');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(config)).toEqual(['__proto__']);
    expect((config['__proto__'] as Record<string, unknown>).polluted).toBe(true);
    expect(() => parseGrokConfig('key = "unterminated\n')).toThrow();
    expect(() => parseGrokConfig('key = value\n')).toThrow();
    expect(() => parseGrokConfig('[table\n')).toThrow();
    expect(() => parseGrokConfig('a = 1 b = 2\n')).toThrow();
  });
});

// ── acts (RFC 006 C2) ──

const actProfile = (kind: 'managed' | 'native-default', dataRoot: string) =>
  ({
    id: kind === 'managed' ? 'work-grok' : 'grok:native-default',
    provider: 'grok',
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
    id: 'review',
    name: 'review',
    origin: 'own',
    enabled: true,
    version: '1.2.0',
    ...fields,
  }) as never;
/** A server to add, as the runtime gives it: the server as Grok would hold it once added. */
const added = (definition: McpServerDefinition, name = 'context7'): McpServerItem => ({
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

describe('Grok extension acts', () => {
  const grok = createGrokExtensionService({ executable: '/opt/grok/bin/grok', env: {}, home: resolve('/Users/test') });
  it("turns a server of the profile's own config on and off, and removes it, with Grok's own commands", () => {
    expect(grok.plan!(actProfile('managed', resolve('/profiles/work/grok')), actServer(), 'disable')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'disable',
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/grok/bin/grok', 'mcp', 'disable', 'linear'],
        env: { GROK_HOME: resolve('/profiles/work/grok') },
      },
      display: '/opt/grok/bin/grok mcp disable linear',
      reaches: [],
    });
    expect(grok.plan!(actProfile('native-default', resolve('/Users/test/.grok')), actServer(), 'remove')).toMatchObject(
      {
        runs: { kind: 'command', argv: ['/opt/grok/bin/grok', 'mcp', 'remove', 'linear', '--scope', 'user'] },
        reaches: ['definition'],
      },
    );
  });

  it('leaves what it borrows to its lender, a skill to its config, and never passes a flag as a name', () => {
    const work = actProfile('managed', resolve('/profiles/work/grok'));
    expect(
      grok.plan!(
        work,
        actServer({ id: 'claude:linear', origin: 'borrowed', lender: 'claude', shared: true }),
        'disable',
      ),
    ).toMatchObject({
      available: false,
      reason: 'not-own',
      message: 'Grok loads it from Claude Code on This Mac, and it changes there',
    });
    expect(grok.plan!(work, actSkill(), 'disable')).toMatchObject({ available: false, reason: 'no-command' });
    expect(grok.plan!(work, actServer({ id: '--scope', name: '--scope' }), 'remove')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
  });

  it('signs in to a server only inside the app, or when a session first uses it', () => {
    const work = actProfile('managed', resolve('/profiles/work/grok'));
    expect(grok.plan!(work, actServer(), 'sign-in')).toMatchObject({
      available: false,
      reason: 'in-app',
      message: 'Grok signs in to a server inside the app, in /mcps, or the first time a session uses it',
    });
    expect(grok.plan!(work, actServer({ transport: 'stdio', target: 'npx x' }), 'sign-out')).toMatchObject({
      reason: 'no-sign-in',
    });
  });

  it('adds a server with its own add, each variable named for Grok to expand and never given a value', () => {
    const plan = grok.plan!(
      actProfile('managed', resolve('/profiles/work/grok')),
      added({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp', '--transport', 'stdio'],
        env: ['CONTEXT7_API_KEY', 'CONTEXT7_REGION'],
      }),
      'add',
    );
    expect(ExtensionActPlanSchema.parse(plan)).toEqual({
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      available: true,
      runs: {
        kind: 'command',
        argv: [
          '/opt/grok/bin/grok',
          'mcp',
          'add',
          '--scope',
          'user',
          '--env',
          'CONTEXT7_API_KEY=${CONTEXT7_API_KEY:-}',
          '--env',
          'CONTEXT7_REGION=${CONTEXT7_REGION:-}',
          'context7',
          '--',
          'npx',
          '-y',
          '@upstash/context7-mcp',
          '--transport',
          'stdio',
        ],
        env: { GROK_HOME: resolve('/profiles/work/grok') },
      },
      display:
        '/opt/grok/bin/grok mcp add --scope user --env CONTEXT7_API_KEY=${CONTEXT7_API_KEY:-} --env CONTEXT7_REGION=${CONTEXT7_REGION:-} context7 -- npx -y @upstash/context7-mcp --transport stdio',
      reaches: [],
    });
  });

  it('adds a remote server over HTTP at its address, and none over SSE, which its add cannot say', () => {
    const native = actProfile('native-default', resolve('/Users/test/.grok'));
    const http = grok.plan!(native, added({ transport: 'http', url: 'https://mcp.linear.app/mcp' }, 'linear'), 'add');
    expect(http).toMatchObject({
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/grok/bin/grok', 'mcp', 'add', '--scope', 'user', 'linear', 'https://mcp.linear.app/mcp'],
      },
      display: '/opt/grok/bin/grok mcp add --scope user linear https://mcp.linear.app/mcp',
      reaches: [],
    });
    expect((http as { runs: { env?: unknown } }).runs.env).toBeUndefined();
    expect(
      grok.plan!(native, added({ transport: 'sse', url: 'https://events.example.com/sse' }, 'events'), 'add'),
    ).toEqual({
      target: { kind: 'mcp-server', id: 'events' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Grok adds a remote server by its command only over HTTP',
    });
    // Grok's add would take any other address for a command.
    expect(grok.plan!(native, added({ transport: 'http', url: 'mcp.example.com/mcp' }, 'bare'), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
    });
  });

  it('adds only a server with a definition, under a name its command takes and its catalog loads', () => {
    const work = actProfile('managed', resolve('/profiles/work/grok'));
    const linear: McpServerDefinition = { transport: 'http', url: 'https://mcp.linear.app/mcp' };
    for (const name of ['--scope', 'my server']) {
      expect(grok.plan!(work, added(linear, name), 'add'), name).toMatchObject({
        available: false,
        reason: 'no-command',
        message: "Grok's commands do not take this server's name",
      });
    }
    for (const name of ['1password', 'my__server', 'linear_']) {
      expect(grok.plan!(work, added(linear, name), 'add'), name).toMatchObject({
        available: false,
        reason: 'unsupported',
      });
    }
    expect(grok.plan!(work, actServer(), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Grok adds only a server, from its definition',
    });
    expect(grok.plan!(work, actSkill(), 'add')).toMatchObject({ available: false, reason: 'unsupported' });
  });

  it('turns a plugin Grok installed on and off, uninstalls it with its data kept or gone, and updates it, by name', () => {
    const work = actProfile('managed', resolve('/profiles/work/grok'));
    const commands: Array<[ExtensionActKind, string[]]> = [
      ['enable', ['plugin', 'enable', 'review']],
      ['disable', ['plugin', 'disable', 'review']],
      ['remove', ['plugin', 'uninstall', 'review', '--confirm', '--keep-data']],
      ['purge', ['plugin', 'uninstall', 'review', '--confirm']],
      ['update', ['plugin', 'update', 'review']],
    ];
    for (const [act, command] of commands) {
      const argv = ['/opt/grok/bin/grok', ...command];
      expect(ExtensionActPlanSchema.parse(grok.plan!(work, actPlugin(), act)), act).toEqual({
        target: { kind: 'plugin', id: 'review' },
        act,
        available: true,
        runs: { kind: 'command', argv, env: { GROK_HOME: resolve('/profiles/work/grok') } },
        display: argv.join(' '),
        reaches: [],
      });
    }
    // An install without a manifest name goes by the name Grok gave its folder; the native default needs no root.
    const native = grok.plan!(
      actProfile('native-default', resolve('/Users/test/.grok')),
      actPlugin({ id: 'notes-1a2b3c4d', name: 'notes-1a2b3c4d' }),
      'purge',
    );
    expect(native).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['/opt/grok/bin/grok', 'plugin', 'uninstall', 'notes-1a2b3c4d', '--confirm'] },
    });
    expect((native as { runs: { env?: unknown } }).runs.env).toBeUndefined();
  });

  it("leaves Claude Code's plugins to it and a folder in plugins/ where it is, and never passes a flag as a name", () => {
    const work = actProfile('managed', resolve('/profiles/work/grok'));
    const figma = actPlugin({
      id: 'figma@claude-plugins-official',
      name: 'figma',
      origin: 'borrowed',
      lender: 'claude',
      shared: true,
    });
    for (const act of ['enable', 'disable', 'remove', 'purge', 'update'] as const) {
      expect(grok.plan!(work, figma, act), act).toEqual({
        target: { kind: 'plugin', id: 'figma@claude-plugins-official' },
        act,
        available: false,
        reason: 'not-own',
        message: 'Grok loads it from Claude Code on This Mac, and it changes there',
      });
    }
    expect(grok.plan!(work, actPlugin({ id: 'plugins:local-tool', name: 'local-tool' }), 'remove')).toEqual({
      target: { kind: 'plugin', id: 'plugins:local-tool' },
      act: 'remove',
      available: false,
      reason: 'no-command',
      message: "It is a folder in Grok's plugins folder, and changes there",
    });
    for (const id of ['--confirm', '.hidden', '../escape', 'review@', 'my plugin']) {
      expect(grok.plan!(work, actPlugin({ id, name: id }), 'update'), id).toMatchObject({
        available: false,
        reason: 'no-command',
        message: "Grok's commands do not take this plugin's name",
      });
    }
  });

  it('answers an add or a sign-in on a plugin, and an update or a purge of anything else, with no command', () => {
    const work = actProfile('managed', resolve('/profiles/work/grok'));
    expect(grok.plan!(work, actPlugin(), 'add')).toEqual({
      target: { kind: 'plugin', id: 'review' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Grok installs a plugin from its marketplace',
    });
    for (const act of ['sign-in', 'sign-out'] as const) {
      expect(grok.plan!(work, actPlugin(), act), act).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Grok has no sign-in for a plugin',
      });
    }
    // Never `grok mcp update`: an update, and a removal that takes the data, are a plugin's alone.
    expect(grok.plan!(work, actServer(), 'update')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'update',
      available: false,
      reason: 'unsupported',
      message: 'Only a plugin is updated',
    });
    expect(grok.plan!(work, actSkill(), 'purge')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Only a plugin is removed with its data',
    });
  });
});

// ── plugins described ──

describe('Grok plugins described', () => {
  it('says who made an install, its homepage and what it brings, by name only, with no key or email', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'grok-5c1e');
    const review = join(root, 'installed-plugins', 'review-3f9c2a1b');
    await write(join(review, '.grok-plugin', 'plugin.json'), {
      name: 'review',
      author: { name: 'Northlight', email: 'dev@northlight.studio' },
      homepage: 'https://ci-bot:hunter2@northlight.studio/review?token=abc123#readme-anchor',
    });
    await write(join(review, 'commands', 'triage.md'), '# Triage');
    await write(join(review, 'commands', 'review.md'), '# Review');
    await write(join(review, 'commands', 'notes.txt'), 'not a command');
    await write(join(review, 'commands', '.draft.md'), '# hidden');
    await write(join(review, 'commands', 'nested', 'deep.md'), '# one folder down');
    // Only a regular file is a command: a link to one elsewhere is not.
    await write(join(home, 'elsewhere', 'linked.md'), '# linked');
    await symlink(join(home, 'elsewhere', 'linked.md'), join(review, 'commands', 'linked.md'));
    await write(join(review, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
    await write(join(review, 'hooks', 'hooks.json'), {
      description: 'House checks',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify --token ${SECRET_TOKEN}' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check' }] }],
        'not-an-event': [],
        Notes: 'not a list of handlers',
      },
    });
    // A person string and a repository address; then a manifest with nothing a person may see.
    await write(join(root, 'installed-plugins', 'notes-1a2b3c4d', '.grok-plugin', 'plugin.json'), {
      name: 'notes',
      author: 'Jane Doe <jane@example.com> (https://jane.example.com)',
      repository: { type: 'git', url: 'https://github.com/jane/notes' },
    });
    await write(join(root, 'installed-plugins', 'bare-9f8e7d6c', 'plugin.json'), {
      name: 'bare',
      author: 'ops@example.com',
      homepage: 'mailto:ops@example.com',
      repository: 'git@github.com:ops/bare.git',
    });
    // Claude Code's install is described from its own folder; a folder in `plugins/` is not described.
    const figma = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'figma', '2.2.120');
    await write(join(figma, '.claude-plugin', 'plugin.json'), {
      name: 'figma',
      author: { name: 'Figma' },
      homepage: 'https://www.figma.com/',
    });
    await write(join(figma, 'commands', 'implement-design.md'), '# Implement');
    await write(join(figma, 'hooks', 'hooks.json'), { SessionStart: [{ hooks: [] }] });
    await write(join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'figma@claude-plugins-official': [{ scope: 'user', version: '2.2.120', installPath: figma }] },
    });
    await write(join(root, 'plugins', 'local-tool', 'commands', 'tool.md'), '# Tool');

    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    const document = JSON.stringify(inventory);
    for (const hidden of [
      'ci-bot',
      'hunter2',
      'abc123',
      'readme-anchor',
      'dev@northlight.studio',
      'jane@example.com',
      'jane.example.com',
      'ops@example.com',
      'SECRET_TOKEN',
    ]) {
      expect(document).not.toContain(hidden);
    }
    expect(find(inventory, 'plugin', 'review')).toMatchObject({
      author: 'Northlight',
      homepage: 'https://•••@northlight.studio/review?•••',
      brings: { commands: ['review', 'triage'], agents: ['reviewer'], hooks: ['PreToolUse', 'Stop'] },
    });
    expect(find(inventory, 'plugin', 'notes')).toMatchObject({
      author: 'Jane Doe',
      homepage: 'https://github.com/jane/notes',
    });
    expect(find(inventory, 'plugin', 'notes')).not.toHaveProperty('brings');
    const bare = find(inventory, 'plugin', 'bare');
    expect(bare).toMatchObject({ origin: 'own' });
    for (const field of ['author', 'homepage', 'brings']) expect(bare).not.toHaveProperty(field);
    expect(find(inventory, 'plugin', 'figma@claude-plugins-official')).toMatchObject({
      origin: 'borrowed',
      author: 'Figma',
      homepage: 'https://www.figma.com/',
      brings: { commands: ['implement-design'], hooks: ['SessionStart'] },
    });
    expect(find(inventory, 'plugin', 'plugins:local-tool')).not.toHaveProperty('brings');
  });

  it('says at most 256 commands and 64 hook events, in name order', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    const crowded = join(root, 'installed-plugins', 'crowded-0a1b2c3d');
    await write(join(crowded, '.grok-plugin', 'plugin.json'), { name: 'crowded' });
    const numbered = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, '0')}`);
    for (const name of numbered('c', 260)) await write(join(crowded, 'commands', `${name}.md`), '');
    await write(join(crowded, 'hooks', 'hooks.json'), {
      hooks: Object.fromEntries(numbered('Event', 70).map((event) => [event, []])),
    });

    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(nativeProfile(home)),
    );
    const brings = (find(inventory, 'plugin', 'crowded') as { brings?: { commands?: string[]; hooks?: string[] } })
      .brings;
    expect(brings?.commands).toEqual(numbered('c', 256));
    expect(brings?.hooks).toEqual(numbered('Event', 64));
  });
});

// ── skills placed (RFC 006 C2) ──

/** A skill to place, as the runtime gives it: the skill as Grok would hold it once linked. */
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

describe('Grok skills placed', () => {
  it("links a kept skill into the root's own skills folder, and the read finds the link as the root's own", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'grok-5c1e');
    const kept = join(home, 'kept', 'release-notes');
    await write(join(kept, 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
    const grok = createGrokExtensionService({ executable: '/opt/grok/bin/grok', env: {}, home, now });
    const work = managedProfile(root);

    expect(ExtensionActPlanSchema.parse(grok.plan!(work, placed('release-notes', kept), 'add'))).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'link', path: join(root, 'skills', 'release-notes'), target: kept }] },
      display: 'link ~/kept/release-notes → ~/profiles/work/grok-5c1e/skills/release-notes'.replaceAll('/', sep),
      reaches: [],
    });

    // The runtime's step, taken here by hand: the second read follows the link.
    await mkdir(join(root, 'skills'), { recursive: true });
    await symlink(kept, join(root, 'skills', 'release-notes'));
    const linked = held(ExtensionInventorySchema.parse(await grok.inventory(work)), 'release-notes');
    expect(linked).toMatchObject({ origin: 'own', linkTarget: kept, description: 'Drafts release notes' });
    // Taking it away takes the link, never the host's folder, even with somewhere to keep one.
    expect(grok.plan!(work, linked, 'remove', { keepIn: join(home, 'kept', 'elsewhere') })).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: join(root, 'skills', 'release-notes') }] },
      display: 'unlink ~/profiles/work/grok-5c1e/skills/release-notes'.replaceAll('/', sep),
      reaches: [],
    });
  });

  it("places into the native default's root under the name it is given, and only a folder by a name a folder takes", () => {
    const grok = createGrokExtensionService({
      executable: '/opt/grok/bin/grok',
      env: {},
      home: resolve('/Users/test'),
    });
    const native = actProfile('native-default', resolve('/Users/test/.grok'));
    // The key, as given: Grok's own lowercase name for it is its reading, not the folder's.
    expect(grok.plan!(native, placed('Release_Notes', resolve('/Users/test/kept/Release_Notes')), 'add')).toMatchObject(
      {
        available: true,
        runs: {
          kind: 'files',
          steps: [
            {
              op: 'link',
              path: resolve('/Users/test/.grok/skills/Release_Notes'),
              target: resolve('/Users/test/kept/Release_Notes'),
            },
          ],
        },
        display: 'link ~/kept/Release_Notes → ~/.grok/skills/Release_Notes'.replaceAll('/', sep),
      },
    );
    expect(grok.plan!(native, placed('release-notes'), 'add')).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Grok takes a skill as a folder to link',
    });
    for (const name of ['../escape', '.hidden', 'team/notes']) {
      expect(grok.plan!(native, placed(name, resolve('/Users/test/kept/x')), 'add'), name).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: `Grok cannot take a skill folder named ${name}`,
      });
    }
  });

  it("moves a real folder of the root's own to where the host keeps it, and with nowhere to keep it leaves it", async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    await write(join(root, 'skills', 'release_notes', 'SKILL.md'), skill('Release Notes', 'Drafts release notes'));
    const grok = createGrokExtensionService({ executable: '/opt/grok/bin/grok', env: {}, home, now });
    const native = nativeProfile(home);
    const own = held(ExtensionInventorySchema.parse(await grok.inventory(native)), 'release_notes');
    expect(own).toMatchObject({ name: 'release-notes', origin: 'own' });

    const keepIn = join(home, 'kept', 'release-notes');
    expect(grok.plan!(native, own, 'remove', { keepIn })).toEqual({
      target: { kind: 'skill', id: 'release_notes' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'move', from: join(root, 'skills', 'release_notes'), to: keepIn }] },
      display: 'move ~/.grok/skills/release_notes → ~/kept/release-notes'.replaceAll('/', sep),
      reaches: [],
    });
    expect(grok.plan!(native, own, 'remove')).toEqual({
      target: { kind: 'skill', id: 'release_notes' },
      act: 'remove',
      available: false,
      reason: 'no-command',
      message: "release-notes is a folder of Grok's own, and nothing keeps it if it goes",
    });
    // Its switch stays config.toml's.
    expect(grok.plan!(native, own, 'disable')).toMatchObject({
      available: false,
      reason: 'no-command',
      message: 'Grok switches a skill only in its config.toml, with no command',
    });
  });

  it('leaves a skill of the shared folder, and one Grok borrows, ships or a plugin brings, where it is', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    await populate(home, root);
    const grok = createGrokExtensionService({ executable: '/opt/grok/bin/grok', env: {}, home, now });
    const native = nativeProfile(home);
    const inventory = ExtensionInventorySchema.parse(await grok.inventory(native));
    const remove = (id: string) =>
      grok.plan!(native, held(inventory, id), 'remove', { keepIn: join(home, 'kept', 'elsewhere') });

    expect(remove('agents:browser-use')).toEqual({
      target: { kind: 'skill', id: 'agents:browser-use' },
      act: 'remove',
      available: false,
      reason: 'not-own',
      message: "browser-use is not in Grok's own skills folder, and changes where it is",
    });
    // A borrowed one is its lender's, linked or not, named as a person knows the lender.
    for (const id of ['claude:changelog', 'claude:synced:brand']) {
      expect(remove(id), id).toMatchObject({
        available: false,
        reason: 'not-own',
        message: 'Grok loads it from Claude Code on This Mac, and it changes there',
      });
    }
    expect(remove('cursor:cursor-rules')).toMatchObject({
      reason: 'not-own',
      message: 'Grok loads it from Cursor on This Mac, and it changes there',
    });
    expect(remove('bundled:imagine')).toMatchObject({ reason: 'not-own', message: 'It ships with Grok' });
    expect(remove('plugin:review:house-style')).toMatchObject({
      reason: 'not-own',
      message: 'It comes with the review plugin and changes with it',
    });
  });
});

// ── marketplaces and catalogs (RFC 006 C2) ──

const OFFICIAL_GIT = 'https://github.com/xai-org/plugin-marketplace.git';

/**
 * A clone as Grok keeps one in `marketplace-cache/`: git's own config naming
 * where it came from, its files, and — where it fetched since it was made —
 * the `FETCH_HEAD` each fetch rewrites. `made` sets the clone folder's own time.
 */
async function clone(
  root: string,
  hex: string,
  url: string,
  files: Record<string, unknown>,
  times: { fetched?: Date; made?: Date } = {},
): Promise<string> {
  const folder = join(root, 'marketplace-cache', hex);
  await write(
    join(folder, '.git', 'config'),
    [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tbare = false',
      '[remote "origin"]',
      `\turl = ${url}`,
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[branch "main"]',
      '\tremote = origin',
      '\tmerge = refs/heads/main',
      '',
    ].join('\n'),
  );
  for (const [path, content] of Object.entries(files)) await write(join(folder, path), content);
  if (times.fetched !== undefined) {
    await write(join(folder, '.git', 'FETCH_HEAD'), `${'0'.repeat(40)}\t\tbranch 'main' of ${url}\n`);
    await utimes(join(folder, '.git', 'FETCH_HEAD'), times.fetched, times.fetched);
  }
  if (times.made !== undefined) await utimes(folder, times.made, times.made);
  return folder;
}

/**
 * A profile's marketplaces as Grok keeps them: its own sources (xAI Official,
 * a folder, a git source it never fetched, a folder that is gone), its clones
 * — xAI's with Grok's own index, Claude Code's with Claude's — the Claude Code
 * marketplaces and installs it borrows, and its registry of what it installed.
 */
async function populateMarketplaces(
  home: string,
  root: string,
): Promise<{ xai: string; claudeCode: string; broken: string }> {
  await write(
    join(root, 'config.toml'),
    [
      '[marketplace]',
      'official_marketplace_auto_installed = true',
      'default_skills_installs_purged = true',
      '',
      '[[marketplace.sources]]',
      'name = "xAI Official"',
      `git = "${OFFICIAL_GIT}"`,
      '',
      '[[marketplace.sources]]',
      'name = "northlight"',
      'path = "~/markets/northlight"',
      '',
      '[[marketplace.sources]]',
      'name = "team"',
      'git = "https://ci-bot:hunter2@git.example.com/team/plugins.git?token=abc123"',
      '',
      '[[marketplace.sources]]',
      'name = "gone"',
      `path = ${JSON.stringify(join(home, 'markets', 'gone'))}`,
      '',
    ].join('\n'),
  );

  const remote = (repo: string) => ({
    source: 'url',
    url: `https://github.com/xai-org/${repo}.git`,
    sha: 'f'.repeat(40),
  });
  const xai = await clone(
    root,
    '0a1b2c3d4e5f6a7b',
    OFFICIAL_GIT,
    {
      '.grok-plugin/marketplace.json': {
        name: 'xai-official',
        owner: { name: 'xAI', email: 'plugins@x.ai' },
        plugins: [
          { name: 'x-search', description: 'Searches X', version: '1.2.0', source: remote('x-search') },
          {
            name: 'review',
            source: './plugins/review',
            version: '2.0.0',
            category: 'development',
            author: { name: 'xAI', email: 'review@x.ai' },
            homepage: 'https://x.ai/review?utm_source=token-abc123',
          },
          { name: 'frontend-design', source: './plugins/frontend-design', description: "Grok's frontend design" },
          // Folders outside the catalog: one up the tree, one through a link.
          { name: 'escape', source: '../../outside' },
          { name: 'linked', source: './plugins/linked' },
          { name: 'ghost', version: '1.0.0', source: remote('ghost') },
          // A second entry by a name the catalog already lists, and one with no name.
          { name: 'review', source: './plugins/review-again', version: '9.9.9' },
          { description: 'An entry with no name' },
        ],
      },
      'plugins/review/.grok-plugin/plugin.json': {
        name: 'review',
        version: '2.0.0',
        description: 'Reviews against the house style',
      },
      'plugins/review/commands/review.md': '# Review',
      'plugins/review/agents/reviewer.md': '---\nname: reviewer\n---\n',
      'plugins/review/hooks/hooks.json': {
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check --token abc123' }] }] },
      },
      'plugins/review/.mcp.json': {
        mcpServers: { house: { type: 'http', url: 'https://mcp.northlight.studio/house?key=abc123' } },
      },
      'plugins/review/skills/house_style/SKILL.md': skill('House Style', 'Northlight naming'),
      // A bare server map is never admitted, so it brings no server.
      'plugins/frontend-design/.mcp.json': { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
      'plugins/frontend-design/skills/frontend-design/SKILL.md': skill('frontend-design'),
    },
    { fetched: new Date('2026-09-20T08:00:00.000Z') },
  );
  await write(join(root, 'outside', 'commands', 'leak.md'), '# outside the catalog');
  await write(join(home, 'elsewhere', 'linked-plugin', 'commands', 'leak.md'), '# linked from outside the catalog');
  await symlink(join(home, 'elsewhere', 'linked-plugin'), join(xai, 'plugins', 'linked'));

  // Claude Code's public marketplace, in Grok's own clone of it: never fetched since it was made.
  const claudeCode = await clone(
    root,
    '11f3bbe6ef2f799d',
    'https://github.com/anthropics/claude-code.git',
    {
      '.claude-plugin/marketplace.json': {
        $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
        name: 'claude-code-plugins',
        owner: { name: 'Anthropic', email: 'support@anthropic.com' },
        metadata: { pluginRoot: './plugins' },
        plugins: [
          {
            name: 'frontend-design',
            source: 'frontend-design',
            version: '1.1.0',
            category: 'development',
            author: 'Anthropic <support@anthropic.com>',
          },
          { name: 'agent-sdk-dev', source: './plugins/agent-sdk-dev' },
        ],
      },
      'plugins/frontend-design/.claude-plugin/plugin.json': { name: 'frontend-design', version: '1.1.0' },
      'plugins/frontend-design/skills/frontend-design/SKILL.md': skill('frontend-design'),
      'plugins/agent-sdk-dev/.claude-plugin/plugin.json': {
        name: 'agent-sdk-dev',
        version: '1.0.0',
        description: 'Agent SDK tools',
      },
      'plugins/agent-sdk-dev/commands/new-sdk-app.md': '# New SDK app',
    },
    { made: new Date('2026-09-18T12:00:00.000Z') },
  );
  const broken = await clone(
    root,
    '22aa33bb44cc55dd',
    'git@gitlab.com:team/broken.git',
    { '.claude-plugin/marketplace.json': '{ "plugins": [' },
    { made: new Date('2026-09-10T00:00:00.000Z') },
  );
  // A clone with no origin, and the locks Grok keeps beside its clones.
  await write(join(root, 'marketplace-cache', '33cc44dd55ee66ff', '.git', 'config'), '[core]\n\tbare = false\n');
  await write(join(root, 'marketplace-cache', '0a1b2c3d4e5f6a7b.lock'), '');

  await write(join(home, 'markets', 'northlight', '.claude-plugin', 'marketplace.json'), {
    name: 'northlight',
    plugins: [
      {
        name: 'deploy',
        source: { source: 'github', repo: 'northlight/deploy' },
        version: '0.3.0',
        homepage: 'https://github.com/northlight/deploy',
      },
    ],
  });

  const claudePlugins = join(home, '.claude', 'plugins');
  await write(join(claudePlugins, 'known_marketplaces.json'), {
    'claude-code-plugins': {
      source: { source: 'github', repo: 'anthropics/claude-code' },
      installLocation: join(claudePlugins, 'marketplaces', 'claude-code-plugins'),
      lastUpdated: '2026-09-01T00:00:00.000Z',
    },
    'claude-plugins-official': {
      source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
      installLocation: join(claudePlugins, 'marketplaces', 'claude-plugins-official'),
      lastUpdated: '2026-09-01T00:00:00.000Z',
    },
    // A folder source, which Grok leaves out.
    'vercel-vercel-plugin': {
      source: { source: 'directory', path: join(home, 'vercel-plugin') },
      installLocation: join(home, 'vercel-plugin'),
    },
    'broken-market': { source: { source: 'git', url: 'git@gitlab.com:team/broken.git' } },
    // xAI's own address again, without `.git`: Grok lists one source once.
    'xai-copy': { source: { source: 'git', url: 'https://github.com/xai-org/plugin-marketplace' } },
  });
  const lent = join(claudePlugins, 'cache', 'claude-code-plugins', 'frontend-design', '1.0.0');
  await write(join(lent, '.claude-plugin', 'plugin.json'), { name: 'frontend-design', version: '1.0.0' });
  await write(join(claudePlugins, 'installed_plugins.json'), {
    version: 2,
    plugins: { 'frontend-design@claude-code-plugins': [{ scope: 'user', version: '1.0.0', installPath: lent }] },
  });

  const installed = join(root, 'installed-plugins');
  await write(join(installed, 'review-3f9c2a1b', '.grok-plugin', 'plugin.json'), { name: 'review', version: '1.9.0' });
  await write(join(installed, 'x-search-0badc0de', '.grok-plugin', 'plugin.json'), {
    name: 'x-search',
    version: '1.2.0',
  });
  await write(join(installed, 'frontend-design-12345678', '.grok-plugin', 'plugin.json'), {
    name: 'frontend-design',
    version: '0.9.0',
  });
  await write(join(installed, 'registry.json'), {
    version: 1,
    plugins: [
      {
        status: 'installed',
        name: 'review',
        repo_key: 'xai-org/plugin-marketplace',
        version: '1.9.0',
        path: join(installed, 'review-3f9c2a1b'),
        source: './plugins/review',
        marketplace: 'xAI Official',
      },
      {
        status: 'installed',
        name: 'x-search',
        version: '1.2.0',
        path: join(installed, 'x-search-0badc0de'),
        marketplace: 'xAI Official',
      },
      {
        status: 'installed',
        name: 'frontend-design',
        version: '0.9.0',
        path: join(installed, 'frontend-design-12345678'),
        marketplace: 'somewhere-else',
      },
      // Recorded, and its folder gone: Grok holds nothing by it.
      { status: 'installed', name: 'ghost', version: '1.0.0', marketplace: 'xAI Official' },
    ],
  });
  return { xai, claudeCode, broken };
}

const CATALOG_SECRETS = [
  'hunter2',
  'abc123',
  'ci-bot',
  'plugins@x.ai',
  'review@x.ai',
  'support@anthropic.com',
  'leak',
  'mcp.northlight.studio',
];

describe('Grok marketplaces', () => {
  it("lists the profile's own sources and the git sources it reads from Claude Code, with when Grok last fetched each", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'grok-5c1e');
    const { xai, claudeCode, broken } = await populateMarketplaces(home, root);
    const grok = createGrokExtensionService({ executable: '/opt/grok/bin/grok', env: {}, home, now });
    const work = managedProfile(root);

    const inventory = ExtensionInventorySchema.parse(await grok.inventory(work));
    const document = JSON.stringify(inventory);
    for (const secret of ['hunter2', 'abc123', 'ci-bot']) expect(document).not.toContain(secret);
    expect(inventory.unread).toBeUndefined();
    const lent = { origin: 'borrowed', lender: 'claude', shared: true, enabled: true } as const;
    expect(inventory.items.filter((item) => item.kind === 'marketplace')).toEqual([
      {
        kind: 'marketplace',
        id: 'xAI Official',
        name: 'xAI Official',
        origin: 'bundled',
        enabled: true,
        source: OFFICIAL_GIT,
        updatedAt: '2026-09-20T08:00:00.000Z',
        location: xai,
      },
      {
        kind: 'marketplace',
        id: 'northlight',
        name: 'northlight',
        origin: 'own',
        enabled: true,
        source: '~/markets/northlight',
        location: join(home, 'markets', 'northlight'),
      },
      {
        kind: 'marketplace',
        id: 'team',
        name: 'team',
        origin: 'own',
        enabled: true,
        source: 'https://•••@git.example.com/team/plugins.git?•••',
      },
      {
        kind: 'marketplace',
        id: 'gone',
        name: 'gone',
        origin: 'own',
        enabled: true,
        source: join(home, 'markets', 'gone'),
        location: join(home, 'markets', 'gone'),
      },
      {
        kind: 'marketplace',
        id: 'claude:claude-code-plugins',
        name: 'claude-code-plugins',
        ...lent,
        source: 'https://github.com/anthropics/claude-code.git',
        updatedAt: '2026-09-18T12:00:00.000Z',
        location: claudeCode,
      },
      {
        kind: 'marketplace',
        id: 'claude:claude-plugins-official',
        name: 'claude-plugins-official',
        ...lent,
        source: 'https://github.com/anthropics/claude-plugins-official.git',
      },
      {
        kind: 'marketplace',
        id: 'claude:broken-market',
        name: 'broken-market',
        ...lent,
        source: 'git@gitlab.com:team/broken.git',
        updatedAt: '2026-09-10T00:00:00.000Z',
        location: broken,
      },
    ]);

    // Grok's registry says which marketplace its own installs came from.
    expect(find(inventory, 'plugin', 'review')).toMatchObject({
      origin: 'own',
      version: '1.9.0',
      marketplace: 'xAI Official',
    });
    expect(find(inventory, 'plugin', 'x-search')).toMatchObject({ marketplace: 'xAI Official' });
    expect(find(inventory, 'plugin', 'frontend-design')).not.toHaveProperty('marketplace');
    expect(find(inventory, 'plugin', 'frontend-design@claude-code-plugins')).toMatchObject({
      origin: 'borrowed',
      marketplace: 'claude-code-plugins',
    });

    // An act plans from the item as the read found it: xAI Official by its name, with its space.
    expect(grok.plan!(work, find(inventory, 'marketplace', 'xAI Official') as MarketplaceItem, 'update')).toMatchObject(
      {
        available: true,
        runs: { kind: 'command', argv: ['/opt/grok/bin/grok', 'plugin', 'marketplace', 'update', 'xAI Official'] },
      },
    );
  });

  it('reads every catalog Grok fetched from its files: what each entry brings, and whether Grok holds it', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'grok-5c1e');
    await populateMarketplaces(home, root);
    const grok = createGrokExtensionService({ home, now });
    const work = managedProfile(root);

    const catalog = ExtensionCatalogSchema.parse(await grok.catalog!(work));
    const document = JSON.stringify(catalog);
    for (const secret of CATALOG_SECRETS) expect(document, secret).not.toContain(secret);
    expect(catalog).toMatchObject({
      provider: 'grok',
      profileId: 'work-grok',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'experimental' },
    });
    // Grok added xAI Official to this profile itself, and says so in its config.
    expect(catalog.suggested).toBeUndefined();

    const lent = { origin: 'borrowed', lender: 'claude', shared: true } as const;
    expect(catalog.marketplaces).toEqual([
      {
        id: 'xAI Official',
        name: 'xAI Official',
        source: OFFICIAL_GIT,
        updatedAt: '2026-09-20T08:00:00.000Z',
        origin: 'bundled',
      },
      { id: 'northlight', name: 'northlight', source: '~/markets/northlight', origin: 'own' },
      {
        id: 'team',
        name: 'team',
        source: 'https://•••@git.example.com/team/plugins.git?•••',
        origin: 'own',
        unread: 'Grok has not fetched it yet',
      },
      {
        id: 'gone',
        name: 'gone',
        source: join(home, 'markets', 'gone'),
        origin: 'own',
        unread: 'Its folder is not there',
      },
      {
        id: 'claude:claude-code-plugins',
        name: 'claude-code-plugins',
        source: 'https://github.com/anthropics/claude-code.git',
        updatedAt: '2026-09-18T12:00:00.000Z',
        ...lent,
      },
      {
        id: 'claude:claude-plugins-official',
        name: 'claude-plugins-official',
        source: 'https://github.com/anthropics/claude-plugins-official.git',
        ...lent,
        unread: 'Grok has not fetched it yet',
      },
      {
        id: 'claude:broken-market',
        name: 'broken-market',
        source: 'git@gitlab.com:team/broken.git',
        updatedAt: '2026-09-10T00:00:00.000Z',
        ...lent,
        unread: 'Its marketplace.json could not be read',
      },
    ]);

    // One entry per name in a catalog, and names that repeat across catalogs stay apart.
    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual([
      'x-search@xAI Official',
      'review@xAI Official',
      'frontend-design@xAI Official',
      'escape@xAI Official',
      'linked@xAI Official',
      'ghost@xAI Official',
      'deploy@northlight',
      'frontend-design@claude:claude-code-plugins',
      'agent-sdk-dev@claude:claude-code-plugins',
    ]);
    const listed = (id: string) => catalog.plugins.find((plugin) => plugin.id === id);
    // A remote entry says only what its catalog says; Grok holds it at the catalog's version.
    expect(listed('x-search@xAI Official')).toEqual({
      id: 'x-search@xAI Official',
      name: 'x-search',
      marketplace: 'xAI Official',
      description: 'Searches X',
      version: '1.2.0',
      held: 'x-search',
    });
    // One in the catalog's own folder brings what the folder holds; Grok's copy is older.
    expect(listed('review@xAI Official')).toEqual({
      id: 'review@xAI Official',
      name: 'review',
      marketplace: 'xAI Official',
      description: 'Reviews against the house style',
      author: 'xAI',
      category: 'development',
      version: '2.0.0',
      homepage: 'https://x.ai/review?•••',
      brings: {
        commands: ['review'],
        agents: ['reviewer'],
        hooks: ['PreToolUse'],
        servers: ['house'],
        skills: ['house-style'],
      },
      held: 'review',
      newer: true,
    });
    // Grok's own install of that name came from another marketplace: it is not this entry's.
    expect(listed('frontend-design@xAI Official')).toEqual({
      id: 'frontend-design@xAI Official',
      name: 'frontend-design',
      marketplace: 'xAI Official',
      description: "Grok's frontend design",
      brings: { skills: ['frontend-design'] },
    });
    for (const id of ['escape@xAI Official', 'linked@xAI Official'])
      expect(listed(id), id).not.toHaveProperty('brings');
    expect(listed('ghost@xAI Official')).not.toHaveProperty('held');
    expect(listed('deploy@northlight')).toEqual({
      id: 'deploy@northlight',
      name: 'deploy',
      marketplace: 'northlight',
      version: '0.3.0',
      homepage: 'https://github.com/northlight/deploy',
    });
    // In a marketplace Grok lists from Claude Code, Claude Code's install is the one Grok holds.
    expect(listed('frontend-design@claude:claude-code-plugins')).toEqual({
      id: 'frontend-design@claude:claude-code-plugins',
      name: 'frontend-design',
      marketplace: 'claude:claude-code-plugins',
      author: 'Anthropic',
      category: 'development',
      version: '1.1.0',
      brings: { skills: ['frontend-design'] },
      held: 'frontend-design@claude-code-plugins',
      newer: true,
    });
    expect(listed('agent-sdk-dev@claude:claude-code-plugins')).toEqual({
      id: 'agent-sdk-dev@claude:claude-code-plugins',
      name: 'agent-sdk-dev',
      marketplace: 'claude:claude-code-plugins',
      description: 'Agent SDK tools',
      version: '1.0.0',
      brings: { commands: ['new-sdk-app'] },
    });

    // What a held entry names is a plugin the inventory holds.
    const inventory = ExtensionInventorySchema.parse(await grok.inventory(work));
    for (const { held } of catalog.plugins.filter((plugin) => plugin.held !== undefined)) {
      expect(find(inventory, 'plugin', held!), held).toBeDefined();
    }
  });

  it('says Grok adds xAI Official itself to a profile with neither it nor Grok’s record of adding it', async () => {
    const home = await tempHome();
    const grok = createGrokExtensionService({ home, now });
    const fresh = managedProfile(join(home, 'fresh'));
    expect(ExtensionCatalogSchema.parse(await grok.catalog!(fresh))).toEqual({
      provider: 'grok',
      profileId: 'work-grok',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      marketplaces: [],
      plugins: [],
      suggested: [
        { name: 'xAI Official', message: 'Grok adds xAI Official itself the first time it starts in this profile' },
      ],
      source: { kind: 'native-store', stability: 'experimental' },
    });

    // Removed after Grok added it: Grok's record keeps it from coming back, so nothing is said.
    await write(join(home, 'fresh', 'config.toml'), '[marketplace]\nofficial_marketplace_auto_installed = true\n');
    expect(((await grok.catalog!(fresh)) as ExtensionCatalog).suggested).toBeUndefined();
    // Added under another name before Grok's first start: it is there.
    await write(
      join(home, 'fresh', 'config.toml'),
      '[[marketplace.sources]]\nname = "xai"\ngit = "https://github.com/xai-org/plugin-marketplace"\n',
    );
    const added = ExtensionCatalogSchema.parse(await grok.catalog!(fresh));
    expect(added.suggested).toBeUndefined();
    expect(added.marketplaces).toEqual([
      {
        id: 'xai',
        name: 'xai',
        source: 'https://github.com/xai-org/plugin-marketplace',
        origin: 'own',
        unread: 'Grok has not fetched it yet',
      },
    ]);
  });

  it("fails when Grok's config.toml cannot be read, and says which catalog it could not read and why", async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    const grok = createGrokExtensionService({ home, now });
    await write(join(root, 'config.toml'), '[[marketplace.sources]\nname = "broken"\n');
    expect(await grok.catalog!(nativeProfile(home))).toEqual({
      status: 'unavailable',
      provider: 'grok',
      message: "Grok's config.toml could not be read",
      retryable: false,
    });

    await write(
      join(root, 'config.toml'),
      [
        '[marketplace]',
        'official_marketplace_auto_installed = true',
        '[[marketplace.sources]]',
        'name = "huge"',
        'git = "https://git.example.com/huge.git"',
        '[[marketplace.sources]]',
        'name = "empty"',
        'git = "https://git.example.com/empty.git"',
        '[[marketplace.sources]]',
        'name = "listless"',
        `path = ${JSON.stringify(join(home, 'markets', 'listless'))}`,
        '[[marketplace.sources]]',
        'name = "relative"',
        'path = "markets/relative"',
        '',
      ].join('\n'),
    );
    await clone(root, 'aa00aa00aa00aa00', 'https://git.example.com/huge.git', {
      '.grok-plugin/marketplace.json': 'x'.repeat(4 * 1024 * 1024 + 1),
    });
    await clone(root, 'bb00bb00bb00bb00', 'https://git.example.com/empty.git', { 'README.md': '# nothing listed' });
    await write(join(home, 'markets', 'listless', '.grok-plugin', 'marketplace.json'), { plugins: { not: 'a list' } });
    // Claude Code's list of marketplaces does not parse: only what Grok lists from it drops out.
    await write(join(home, '.claude', 'plugins', 'known_marketplaces.json'), '{ not json');

    const catalog = ExtensionCatalogSchema.parse(await grok.catalog!(nativeProfile(home)));
    expect(catalog.marketplaces.map(({ name, unread }) => [name, unread])).toEqual([
      ['huge', 'Its marketplace.json is too large to read'],
      ['empty', 'It has no marketplace.json'],
      ['listless', 'Its marketplace.json could not be read'],
      ['relative', "Grok's config names its folder without a full path"],
    ]);
    expect(catalog.plugins).toEqual([]);
    const inventory = ExtensionInventorySchema.parse(await grok.inventory(nativeProfile(home)));
    expect(inventory.unread).toEqual([
      {
        kind: 'marketplace',
        message: '~/.claude/plugins/known_marketplaces.json could not be read',
      },
    ]);
  });

  it('shows a git address with nothing that could sign in to it', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    await write(
      join(root, 'config.toml'),
      [
        ['scp', 'git@github.com:northlight/plugins.git'],
        ['deploy-user', 'deploy@git.example.com:team/tools.git'],
        ['ssh', 'ssh://deploy:hunter2@git.example.com/team/x.git'],
        ['local', resolve('/Users/test/repos/market.git')],
        ['windows-drive', 'C:\\repos\\market.git'],
        ['windows-forward-slashes', 'C:/repos/market.git'],
        ['windows-share', '\\\\server\\share\\market.git'],
      ]
        .map(([name, git]) => `[[marketplace.sources]]\nname = "${name}"\ngit = ${JSON.stringify(git)}\n`)
        .join('\n'),
    );
    const inventory = ExtensionInventorySchema.parse(
      await createGrokExtensionService({ home, now }).inventory(nativeProfile(home)),
    );
    expect(
      inventory.items.filter((item): item is MarketplaceItem => item.kind === 'marketplace').map((item) => item.source),
    ).toEqual([
      'git@github.com:northlight/plugins.git',
      '•••@git.example.com:team/tools.git',
      'ssh://•••@git.example.com/team/x.git',
      resolve('/Users/test/repos/market.git'),
      'C:\\repos\\market.git',
      'C:/repos/market.git',
      '\\\\server\\share\\market.git',
    ]);
  });

  it('never lists two marketplaces under one key', async () => {
    const home = await tempHome();
    await write(
      join(home, '.grok', 'config.toml'),
      '[[marketplace.sources]]\nname = "claude:northlight"\ngit = "https://git.example.com/mine.git"\n',
    );
    await write(join(home, '.claude', 'plugins', 'known_marketplaces.json'), {
      northlight: { source: { source: 'github', repo: 'northlight/plugins' } },
    });
    const grok = createGrokExtensionService({ home, now });
    const catalog = ExtensionCatalogSchema.parse(await grok.catalog!(nativeProfile(home)));
    expect(catalog.marketplaces.map(({ id, origin }) => [id, origin])).toEqual([['claude:northlight', 'own']]);
    const inventory = ExtensionInventorySchema.parse(await grok.inventory(nativeProfile(home)));
    expect(inventory.items.filter((item) => item.kind === 'marketplace')).toHaveLength(1);
  });

  it('leaves out a source or a folder too long to show, and reads everything else', async () => {
    const home = await tempHome();
    const market = join(home, 'market');
    const long = 'a'.repeat(9_000);
    await write(
      join(home, '.grok', 'config.toml'),
      [
        ['long-git', 'git', `https://git.example.com/${long}.git`],
        ['long-path', 'path', `/${long}`],
        ['northlight', 'path', market],
      ]
        .map(([name, key, value]) => `[[marketplace.sources]]\nname = "${name}"\n${key} = ${JSON.stringify(value)}\n`)
        .join('\n'),
    );
    await write(join(market, '.grok-plugin', 'marketplace.json'), {
      plugins: [
        {
          name: 'review',
          version: '1.0.0',
          homepage: `https://northlight.example/${long}`,
          source: { source: 'url', url: 'https://github.com/northlight/review.git', sha: 'a'.repeat(40) },
        },
      ],
    });
    await write(join(home, '.claude', 'plugins', 'known_marketplaces.json'), {
      'long-lent': { source: { source: 'git', url: `https://git.example.com/lent/${long}` } },
    });
    const grok = createGrokExtensionService({ home, now });

    const inventory = ExtensionInventorySchema.parse(await grok.inventory(nativeProfile(home)));
    expect(inventory.unread).toBeUndefined();
    expect(inventory.items.filter((item) => item.kind === 'marketplace')).toEqual([
      { kind: 'marketplace', id: 'long-git', name: 'long-git', origin: 'own', enabled: true },
      { kind: 'marketplace', id: 'long-path', name: 'long-path', origin: 'own', enabled: true },
      {
        kind: 'marketplace',
        id: 'northlight',
        name: 'northlight',
        origin: 'own',
        enabled: true,
        source: market,
        location: market,
      },
      {
        kind: 'marketplace',
        id: 'claude:long-lent',
        name: 'long-lent',
        origin: 'borrowed',
        lender: 'claude',
        shared: true,
        enabled: true,
      },
    ]);
    const catalog = ExtensionCatalogSchema.parse(await grok.catalog!(nativeProfile(home)));
    expect(catalog.marketplaces).toEqual([
      { id: 'long-git', name: 'long-git', origin: 'own', unread: 'Grok has not fetched it yet' },
      { id: 'long-path', name: 'long-path', origin: 'own', unread: 'Its folder is not there' },
      { id: 'northlight', name: 'northlight', source: market, origin: 'own' },
      {
        id: 'claude:long-lent',
        name: 'long-lent',
        origin: 'borrowed',
        lender: 'claude',
        shared: true,
        unread: 'Grok has not fetched it yet',
      },
    ]);
    // A homepage past the limit goes as well; its entry stays.
    expect(catalog.plugins).toEqual([
      { id: 'review@northlight', name: 'review', marketplace: 'northlight', version: '1.0.0' },
    ]);
  });

  it('reads text crafted to make a pattern backtrack in one pass', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    const market = join(home, 'market');
    // A run of slashes, a query that crosses a line (the TOML escape), and a clone whose url a run of spaces pads.
    await write(
      join(root, 'config.toml'),
      [
        '[[marketplace.sources]]',
        'name = "slashes"',
        `git = "https://git.example.com/team${'/'.repeat(20_000)}x"`,
        '[[marketplace.sources]]',
        'name = "crossing"',
        `git = "https://git.example.com/team${'?'.repeat(20_000)}\\nx"`,
        '[[marketplace.sources]]',
        'name = "northlight"',
        `path = ${JSON.stringify(market)}`,
        '',
      ].join('\n'),
    );
    await clone(root, 'cc00cc00cc00cc00', `https://git.example.com/padded.git${' '.repeat(20_000)}x`, {});
    // Brackets that never close around an `@`, and a homepage that crosses a line.
    await write(join(market, '.grok-plugin', 'marketplace.json'), {
      plugins: [
        {
          name: 'crafted',
          author: '(@'.repeat(2_048),
          homepage: `https://northlight.example/${'a'.repeat(8_000)}#\nx`,
        },
        { name: 'plain', author: 'Northlight <dev@northlight.studio>', homepage: 'https://northlight.example/plain' },
      ],
    });
    const grok = createGrokExtensionService({ home, now });

    const started = performance.now();
    const inventory = ExtensionInventorySchema.parse(await grok.inventory(nativeProfile(home)));
    const catalog = ExtensionCatalogSchema.parse(await grok.catalog!(nativeProfile(home)));
    // Matched by patterns that backtrack, these took from seconds to minutes; read in one pass, the reads are quick.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(
      inventory.items
        .filter((item): item is MarketplaceItem => item.kind === 'marketplace')
        .map(({ id, source }) => [id, source]),
    ).toEqual([
      ['slashes', undefined],
      ['crossing', undefined],
      ['northlight', market],
    ]);
    expect(catalog.plugins).toEqual([
      { id: 'crafted@northlight', name: 'crafted', marketplace: 'northlight' },
      {
        id: 'plain@northlight',
        name: 'plain',
        marketplace: 'northlight',
        author: 'Northlight',
        homepage: 'https://northlight.example/plain',
      },
    ]);
  });

  it('reads what Grok installed from its registry as a list, bare or under `plugins`, or as a map by name', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    const market = join(home, 'market');
    await write(
      join(root, 'config.toml'),
      `[[marketplace.sources]]\nname = "northlight"\npath = ${JSON.stringify(market)}\n`,
    );
    await write(join(market, '.grok-plugin', 'marketplace.json'), {
      plugins: [
        {
          name: 'review',
          version: '1.0.0',
          source: { source: 'url', url: 'https://github.com/northlight/review.git', sha: 'a'.repeat(40) },
        },
      ],
    });
    await write(join(root, 'installed-plugins', 'review-3f9c2a1b', '.grok-plugin', 'plugin.json'), {
      name: 'review',
      version: '1.0.0',
    });
    const grok = createGrokExtensionService({ home, now });
    const held = async () => ExtensionCatalogSchema.parse(await grok.catalog!(nativeProfile(home))).plugins[0]?.held;
    const row = { status: 'installed', name: 'review', version: '1.0.0', marketplace: 'northlight' };
    const unnamed = { status: 'installed', version: '1.0.0', marketplace: 'northlight' };
    for (const registry of [[row], { version: 1, plugins: [row] }, { review: unnamed }, { plugins: { review: row } }]) {
      await write(join(root, 'installed-plugins', 'registry.json'), registry);
      expect(await held(), JSON.stringify(registry)).toBe('review');
    }
    // Anything else reads as no record at all, never as an error.
    for (const registry of ['{ not json', '[1, "two", null]', '{ "version": 2 }', '"text"']) {
      await write(join(root, 'installed-plugins', 'registry.json'), registry);
      expect(await held(), registry).toBeUndefined();
    }
  });

  it('says what at most 400 entries bring, and lists the rest without', async () => {
    const home = await tempHome();
    const root = join(home, '.grok');
    const market = join(home, 'market');
    await write(
      join(root, 'config.toml'),
      `[[marketplace.sources]]\nname = "crowded"\npath = ${JSON.stringify(market)}\n`,
    );
    const names = Array.from({ length: 405 }, (_, index) => `p${String(index).padStart(3, '0')}`);
    await write(join(market, '.grok-plugin', 'marketplace.json'), {
      plugins: names.map((name) => ({ name, source: `./plugins/${name}` })),
    });
    await Promise.all(names.map((name) => write(join(market, 'plugins', name, 'commands', 'run.md'), '# Run')));

    const catalog = ExtensionCatalogSchema.parse(
      await createGrokExtensionService({ home, now }).catalog!(nativeProfile(home)),
    );
    expect(catalog.plugins).toHaveLength(405);
    expect(catalog.plugins.filter((plugin) => plugin.brings !== undefined)).toHaveLength(400);
    expect(catalog.plugins[404]).toEqual({ id: 'p404@crowded', name: 'p404', marketplace: 'crowded' });
  });
});

/** A marketplace an act is about, as a read found it: xAI Official unless told otherwise. */
const actMarketplace = (fields: Record<string, unknown> = {}): MarketplaceItem =>
  ({
    kind: 'marketplace',
    id: 'xAI Official',
    name: 'xAI Official',
    origin: 'bundled',
    enabled: true,
    source: OFFICIAL_GIT,
    ...fields,
  }) as MarketplaceItem;
/** A marketplace to add, as the runtime gives it: named by its source until Grok reads the name it keeps. */
const toAdd = (source: string): MarketplaceItem => ({
  kind: 'marketplace',
  id: source,
  name: source,
  origin: 'own',
  enabled: true,
  source,
});
/** A plugin to install from a source a person gave, as the runtime gives it. */
const fromSource = (source: string): ExtensionActItem => ({
  kind: 'plugin',
  id: source,
  name: source,
  origin: 'own',
  enabled: true,
});

describe('Grok installs and marketplace acts', () => {
  const grok = createGrokExtensionService({ executable: '/opt/grok/bin/grok', env: {}, home: resolve('/Users/test') });
  const work = actProfile('managed', resolve('/profiles/work/grok'));
  const native = actProfile('native-default', resolve('/Users/test/.grok'));

  it('installs a plugin from a folder on this Mac with its own install, trusted by the person the host asked', () => {
    const source = resolve('/Users/test/plugins/review');
    expect(
      ExtensionActPlanSchema.parse(grok.plan!(work, fromSource(source), 'install', { source, holds: ['notes'] })),
    ).toEqual({
      target: { kind: 'plugin', id: source },
      act: 'install',
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/grok/bin/grok', 'plugin', 'install', source, '--trust'],
        env: { GROK_HOME: resolve('/profiles/work/grok') },
      },
      display: `/opt/grok/bin/grok plugin install ${shownArgument(source)} --trust`,
      reaches: [],
    });
    // From `~`, and whole however it was written; the native default needs no root.
    for (const given of ['~/plugins/review', '/Users/test/plugins/./review/', '/Users/test/other/../plugins/review']) {
      const plan = grok.plan!(native, fromSource(given), 'install', { source: given, holds: [] });
      expect(plan, given).toMatchObject({
        available: true,
        target: { kind: 'plugin', id: given },
        runs: { kind: 'command', argv: ['/opt/grok/bin/grok', 'plugin', 'install', source, '--trust'] },
      });
      expect((plan as { runs: { env?: unknown } }).runs.env).toBeUndefined();
    }
  });

  it('installs from nothing but a folder, and not one named like a plugin Grok holds', () => {
    for (const source of [
      'review',
      './review',
      'https://github.com/northlight/review.git',
      'git@github.com:northlight/review.git',
      'northlight/review',
      '~',
      '--trust',
      '/',
    ]) {
      expect(grok.plan!(work, fromSource(source), 'install', { source, holds: [] }), source).toEqual({
        target: { kind: 'plugin', id: source },
        act: 'install',
        available: false,
        reason: 'unsupported',
        message: 'Grok installs a plugin from a folder on this Mac',
      });
    }
    const source = resolve('/Users/test/plugins/review');
    expect(grok.plan!(work, fromSource(source), 'install', { source, holds: ['notes', 'review'] })).toEqual({
      target: { kind: 'plugin', id: source },
      act: 'install',
      available: false,
      reason: 'held',
      message: 'Grok already has review; its install would stand beside it',
    });
  });

  it('leaves a catalog entry’s install to Grok itself, and installs only a plugin', () => {
    const listed: CatalogPlugin = {
      id: 'x-search@xAI Official',
      name: 'x-search',
      marketplace: 'xAI Official',
      version: '1.2.0',
    };
    const item = actPlugin({ id: listed.id, name: 'x-search', marketplace: 'xAI Official' });
    expect(grok.plan!(work, item, 'install', { listed })).toEqual({
      target: { kind: 'plugin', id: 'x-search@xAI Official' },
      act: 'install',
      available: false,
      reason: 'unsupported',
      message: "Grok's install of a marketplace plugin isn't confirmed yet: run `grok plugin install` in a terminal",
    });
    for (const other of [actServer(), actSkill()]) {
      expect(
        grok.plan!(work, other, 'install', { source: resolve('/Users/test/plugins/review'), holds: [] }),
      ).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Only a plugin is installed',
      });
    }
  });

  it('adds a marketplace from a git address or a folder on this Mac with its own add', () => {
    for (const source of [
      'https://github.com/northlight/plugins.git',
      'ssh://github.com/northlight/plugins.git',
      'git@github.com:northlight/plugins.git',
      resolve('/Users/test/markets/northlight'),
    ]) {
      expect(ExtensionActPlanSchema.parse(grok.plan!(work, toAdd(source), 'add')), source).toEqual({
        target: { kind: 'marketplace', id: source },
        act: 'add',
        available: true,
        runs: {
          kind: 'command',
          argv: ['/opt/grok/bin/grok', 'plugin', 'marketplace', 'add', source],
          env: { GROK_HOME: resolve('/profiles/work/grok') },
        },
        display: `/opt/grok/bin/grok plugin marketplace add ${shownArgument(source)}`,
        reaches: [],
      });
    }
    // A folder from `~`, given whole.
    const home = grok.plan!(native, toAdd('~/markets/northlight/'), 'add');
    expect(home).toMatchObject({
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/grok/bin/grok', 'plugin', 'marketplace', 'add', resolve('/Users/test/markets/northlight')],
      },
    });
    expect((home as { runs: { env?: unknown } }).runs.env).toBeUndefined();
    for (const source of [
      'northlight/plugins',
      'http://git.example.com/plugins.git',
      'markets/northlight',
      'https://ci-bot:hunter2@git.example.com/plugins.git',
      'https://git.example.com/plugins.git?token=abc123',
      '--help',
    ]) {
      expect(grok.plan!(work, toAdd(source), 'add'), source).toEqual({
        target: { kind: 'marketplace', id: source },
        act: 'add',
        available: false,
        reason: 'unsupported',
        message: 'Grok adds a marketplace from a git address or a folder on this Mac',
      });
    }
    expect(grok.plan!(work, actMarketplace({ source: undefined }), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
    });
  });

  it("fetches a marketplace again and removes it by Grok's own name for it, given as one argument", () => {
    for (const act of ['update', 'remove'] as const) {
      expect(ExtensionActPlanSchema.parse(grok.plan!(work, actMarketplace(), act)), act).toEqual({
        target: { kind: 'marketplace', id: 'xAI Official' },
        act,
        available: true,
        runs: {
          kind: 'command',
          argv: ['/opt/grok/bin/grok', 'plugin', 'marketplace', act, 'xAI Official'],
          env: { GROK_HOME: resolve('/profiles/work/grok') },
        },
        display: `/opt/grok/bin/grok plugin marketplace ${act} "xAI Official"`,
        reaches: [],
      });
    }
    const own = actMarketplace({
      id: 'northlight',
      name: 'northlight',
      origin: 'own',
      source: resolve('/Users/test/markets'),
    });
    expect(grok.plan!(native, own, 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['/opt/grok/bin/grok', 'plugin', 'marketplace', 'remove', 'northlight'] },
      reaches: [],
    });
    // One Grok lists from Claude Code: Grok's own clone is fetched again under Claude Code's name, and it goes there.
    const lent = actMarketplace({
      id: 'claude:claude-plugins-official',
      name: 'claude-plugins-official',
      origin: 'borrowed',
      lender: 'claude',
      shared: true,
      source: 'https://github.com/anthropics/claude-plugins-official.git',
    });
    expect(grok.plan!(work, lent, 'update')).toEqual({
      target: { kind: 'marketplace', id: 'claude:claude-plugins-official' },
      act: 'update',
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/grok/bin/grok', 'plugin', 'marketplace', 'update', 'claude-plugins-official'],
        env: { GROK_HOME: resolve('/profiles/work/grok') },
      },
      display: '/opt/grok/bin/grok plugin marketplace update claude-plugins-official',
      reaches: [],
    });
    expect(grok.plan!(work, lent, 'remove')).toEqual({
      target: { kind: 'marketplace', id: 'claude:claude-plugins-official' },
      act: 'remove',
      available: false,
      reason: 'not-own',
      message: 'Grok reads it from Claude Code on This Mac, and it changes there',
    });
  });

  it('only adds, fetches again or removes a marketplace, and never passes a flag or a line break as its name', () => {
    for (const act of ExtensionActKindSchema.options.filter((kind) => !['add', 'update', 'remove'].includes(kind))) {
      expect(grok.plan!(work, actMarketplace(), act), act).toEqual({
        target: { kind: 'marketplace', id: 'xAI Official' },
        act,
        available: false,
        reason: 'unsupported',
        message: 'Grok only adds a marketplace, fetches it again or removes it',
      });
    }
    for (const name of ['--all', 'team\nplugins', 'x'.repeat(257)]) {
      expect(grok.plan!(work, actMarketplace({ id: 'odd', name, origin: 'own' }), 'update'), name).toMatchObject({
        available: false,
        reason: 'no-command',
        message: "Grok's commands do not take this marketplace's name",
      });
    }
    expect(grok.plan!(work, actMarketplace({ origin: 'managed' }), 'remove')).toMatchObject({
      available: false,
      reason: 'not-own',
      message: "Grok's app or your organization adds it, and changes it",
    });
  });

  it('answers every act on every kind without throwing, each plan about the item it was asked about', () => {
    const items: ExtensionActItem[] = [
      actServer(),
      actServer({ id: 'claude:linear', origin: 'borrowed', lender: 'claude', shared: true }),
      actServer({ transport: 'stdio', target: 'npx x' }),
      actSkill(),
      actSkill({ id: 'bundled:imagine', origin: 'bundled' }),
      actPlugin(),
      actPlugin({ id: 'figma@claude-plugins-official', origin: 'borrowed', lender: 'claude', shared: true }),
      actPlugin({ id: 'plugins:local-tool' }),
      actMarketplace(),
      actMarketplace({ id: 'northlight', name: 'northlight', origin: 'own' }),
      actMarketplace({ id: 'claude:x', name: 'x', origin: 'borrowed', lender: 'claude', shared: true }),
      actMarketplace({ origin: 'managed' }),
      actMarketplace({ id: '-x', name: '-x', origin: 'own', source: undefined }),
      toAdd(resolve('/Users/test/markets/northlight')),
    ];
    const options: ExtensionActPlanOptions[] = [
      {},
      { source: resolve('/Users/test/plugins/review'), holds: ['review'] },
      { source: 'review', holds: [] },
      { listed: { id: 'review@xAI Official', name: 'review', marketplace: 'xAI Official' } },
      { keepIn: resolve('/Users/test/kept/review') },
    ];
    for (const profile of [work, native]) {
      for (const item of items) {
        for (const act of ExtensionActKindSchema.options) {
          for (const option of options) {
            const plan = ExtensionActPlanSchema.parse(grok.plan!(profile, item, act, option));
            expect(plan.act).toBe(act);
            expect(plan.target).toEqual({ kind: item.kind, id: item.id });
          }
        }
      }
    }
  });
});
