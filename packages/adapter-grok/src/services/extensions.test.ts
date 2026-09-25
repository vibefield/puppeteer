import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type ExtensionInventory,
  type ExtensionItem,
} from '@vibecook/puppeteer-core';
import { createGrokExtensionService, parseGrokConfig } from './extensions.js';

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
  it('declares every kind Grok has, and the marketplaces as not read yet', () => {
    const { provider } = createGrokExtensionService({ home: '/nowhere', now });
    expect(ExtensionProviderSchema.parse(provider)).toEqual({
      id: 'grok',
      label: 'Grok',
      support: {
        plugins: { store: 'mixed', changes: 'command', read: true },
        marketplaces: { store: 'mixed', changes: 'command', read: false },
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
