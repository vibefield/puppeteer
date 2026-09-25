import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  ExtensionInventorySchema,
  type ExtensionInventory,
  type ExtensionItem,
} from '@vibecook/puppeteer-core';
import { createClaudeExtensionService } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-extensions-'));
  made.push(dir);
  return dir;
}

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const nativeProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'claude:native-default',
    provider: 'claude',
    label: 'Default',
    kind: 'native-default',
    dataRoot: join(home, '.claude'),
    createdAt: '1970-01-01T00:00:00.000Z',
  });

const managedProfile = (root: string) =>
  AgentProfileSchema.parse({
    id: 'work-claude',
    provider: 'claude',
    label: 'Work',
    kind: 'managed',
    dataRoot: root,
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);

describe('Claude Code extensions', () => {
  it('reads a native default root: its servers beside it, its plugins, marketplaces and skills, and no secret', async () => {
    const home = await tempHome();
    const root = join(home, '.claude');
    const review = join(root, 'plugins', 'cache', 'northlight', 'review', '3f9c2a1b7d04');
    await write(join(home, '.claude.json'), {
      numStartups: 12,
      mcpServers: {
        linear: {
          type: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer lin_api_secret_value' },
        },
        postgres: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://app:hunter2@localhost/dev'],
          env: { PGPASSWORD: 'hunter2' },
        },
        skipped: { url: 'https://no-type.example.com/mcp' },
      },
      projects: {
        '/Users/test/billing': {
          mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } },
          disabledMcpServers: ['sentry'],
        },
      },
    });
    await write(join(root, 'settings.json'), {
      enabledPlugins: { 'review@northlight': true, 'figma@claude-plugins-official': false },
      skillOverrides: { 'sql-review': 'off' },
    });
    await write(join(root, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'review@northlight': [
          { scope: 'user', version: '3f9c2a1b7d04', installPath: review, installedAt: '2026-09-20T10:00:00.000Z' },
        ],
        'figma@claude-plugins-official': [
          {
            scope: 'user',
            version: '1.1.0',
            installPath: join(root, 'plugins', 'cache', 'official', 'figma', '1.1.0'),
          },
        ],
        'repo-only@northlight': [{ scope: 'project', projectPath: '/Users/test/billing', version: '1.0.0' }],
      },
    });
    await write(join(review, '.claude-plugin', 'plugin.json'), {
      name: 'review',
      version: '3f9c2a1b7d04',
      description: 'Reviews against the house style',
    });
    await write(join(review, '.mcp.json'), {
      mcpServers: { house: { type: 'http', url: 'https://mcp.northlight.studio/house?key=abc123' } },
    });
    await write(
      join(review, 'skills', 'house-style', 'SKILL.md'),
      skill('house-style', 'Northlight naming and formatting'),
    );
    await write(join(root, 'plugins', 'synced', 'northlight-toolkit', '.claude-plugin', 'plugin.json'), {
      name: 'northlight-toolkit',
    });
    await write(join(root, 'plugins', 'known_marketplaces.json'), {
      northlight: {
        source: { source: 'github', repo: 'northlight-studio/plugins' },
        installLocation: join(root, 'plugins', 'marketplaces', 'northlight'),
        lastUpdated: '2026-09-20T10:00:00.000Z',
      },
      'claude-plugins-official': {
        source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
        lastUpdated: 'yesterday',
      },
    });
    await write(
      join(root, 'skills', 'release-notes', 'SKILL.md'),
      skill('release-notes', 'Drafts release notes from merged pull requests'),
    );
    await write(
      join(root, 'skills', 'sql-review', 'SKILL.md'),
      skill('sql-review', 'Reviews a migration before it ships'),
    );
    await write(join(root, 'skills', 'synced', 'brand', 'SKILL.md'), skill('brand', 'Northlight voice'));
    await write(join(root, 'skills', 'notes-without-skill', 'README.md'), '# not a skill');
    await write(join(root, 'skills', '.hidden', 'SKILL.md'), skill('hidden', 'never listed'));
    const library = join(home, 'library', 'changelog');
    await write(join(library, 'SKILL.md'), skill('changelog', 'Writes the changelog entry'));
    await symlink(library, join(root, 'skills', 'changelog'));

    const result = await createClaudeExtensionService({ home, now }).inventory(nativeProfile(home));
    const inventory = ExtensionInventorySchema.parse(result);
    const document = JSON.stringify(inventory);
    for (const secret of ['lin_api_secret_value', 'hunter2', 'abc123']) expect(document).not.toContain(secret);

    expect(inventory).toMatchObject({
      provider: 'claude',
      profileId: 'claude:native-default',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store' },
    });
    expect(inventory.unread).toBeUndefined();

    expect(find(inventory, 'mcp-server', 'linear')).toMatchObject({
      origin: 'own',
      enabled: true,
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      headers: ['Authorization'],
    });
    expect(find(inventory, 'mcp-server', 'postgres')).toMatchObject({
      transport: 'stdio',
      target: 'npx -y @modelcontextprotocol/server-postgres postgresql://•••@localhost/dev',
      env: ['PGPASSWORD'],
      location: join(home, '.claude.json'),
    });
    expect(find(inventory, 'mcp-server', 'skipped')).toBeUndefined();
    expect(find(inventory, 'mcp-server', 'project:/Users/test/billing:sentry')).toMatchObject({
      origin: 'project',
      project: '/Users/test/billing',
      enabled: false,
    });
    expect(find(inventory, 'mcp-server', 'plugin:review@northlight:house')).toMatchObject({
      origin: 'plugin',
      plugin: 'review@northlight',
      enabled: true,
      target: 'https://mcp.northlight.studio/house?•••',
    });

    expect(find(inventory, 'plugin', 'review@northlight')).toMatchObject({
      name: 'review',
      origin: 'own',
      enabled: true,
      version: '3f9c2a1b7d04',
      marketplace: 'northlight',
      description: 'Reviews against the house style',
    });
    expect(find(inventory, 'plugin', 'figma@claude-plugins-official')).toMatchObject({
      enabled: false,
      version: '1.1.0',
    });
    expect(find(inventory, 'plugin', 'repo-only@northlight')).toBeUndefined();
    expect(find(inventory, 'plugin', 'northlight-toolkit@synced')).toMatchObject({ origin: 'managed', enabled: true });

    expect(find(inventory, 'marketplace', 'northlight')).toMatchObject({
      source: 'northlight-studio/plugins',
      updatedAt: '2026-09-20T10:00:00.000Z',
    });
    expect(find(inventory, 'marketplace', 'claude-plugins-official')).not.toHaveProperty('updatedAt');

    expect(find(inventory, 'skill', 'release-notes')).toMatchObject({
      origin: 'own',
      enabled: true,
      description: 'Drafts release notes from merged pull requests',
    });
    expect(find(inventory, 'skill', 'sql-review')).toMatchObject({ enabled: false });
    expect(find(inventory, 'skill', 'changelog')).toMatchObject({
      origin: 'own',
      linkTarget: library,
      description: 'Writes the changelog entry',
    });
    expect(find(inventory, 'skill', 'synced:brand')).toMatchObject({ name: 'brand', origin: 'managed' });
    expect(find(inventory, 'skill', 'plugin:review@northlight:house-style')).toMatchObject({
      origin: 'plugin',
      plugin: 'review@northlight',
    });
    expect(inventory.items.filter((item) => item.kind === 'skill').map((item) => item.name)).not.toContain(
      'notes-without-skill',
    );
    expect(inventory.items.filter((item) => item.kind === 'skill').map((item) => item.name)).not.toContain('.hidden');
  });

  it('reads a managed root’s own app state, never the native one beside the home', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'claude-0b7e2c4d');
    await write(join(home, '.claude.json'), {
      mcpServers: { 'home-only': { type: 'http', url: 'https://home.example.com/mcp' } },
    });
    await write(join(root, '.claude.json'), {
      mcpServers: { 'work-only': { type: 'sse', url: 'https://work.example.com/sse' } },
    });

    const inventory = ExtensionInventorySchema.parse(
      await createClaudeExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    expect(inventory.items.map((item) => item.id)).toEqual(['work-only']);
    expect(inventory.items[0]).toMatchObject({ transport: 'sse', location: join(root, '.claude.json') });
    expect(inventory.profileId).toBe('work-claude');
  });

  it('says which store it could not read and lists the rest', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'claude-0b7e2c4d');
    await write(join(root, '.claude.json'), '{ not json');
    await write(join(root, 'plugins', 'installed_plugins.json'), '[]');
    await write(join(root, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));

    const inventory = ExtensionInventorySchema.parse(
      await createClaudeExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    expect(inventory.unread).toEqual([
      { kind: 'plugin', message: 'installed_plugins.json could not be read' },
      { kind: 'mcp-server', message: '.claude.json could not be read' },
    ]);
    expect(inventory.items.map((item) => item.id)).toEqual(['release-notes']);
  });

  it('reads an empty root as holding nothing', async () => {
    const home = await tempHome();
    const inventory = ExtensionInventorySchema.parse(
      await createClaudeExtensionService({ home, now }).inventory(managedProfile(join(home, 'fresh'))),
    );
    expect(inventory.items).toEqual([]);
    expect(inventory.unread).toBeUndefined();
  });
});

// ── acts (RFC 006 C2) ──

const actProfile = (kind: 'managed' | 'native-default', dataRoot: string) =>
  ({
    id: kind === 'managed' ? 'work-claude' : 'claude:native-default',
    provider: 'claude',
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

describe('Claude Code extension acts', () => {
  const claude = createClaudeExtensionService({ executable: 'claude', env: {}, home: '/Users/test' });
  it('removes a user server with its own command, saying a remote one takes its sign-in with it', () => {
    expect(claude.plan!(actProfile('managed', '/profiles/work/claude'), actServer(), 'remove')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'remove',
      available: true,
      runs: {
        kind: 'command',
        argv: ['claude', 'mcp', 'remove', '--scope', 'user', 'linear'],
        env: { CLAUDE_CONFIG_DIR: '/profiles/work/claude' },
      },
      display: 'claude mcp remove --scope user linear',
      reaches: ['definition', 'sign-in'],
    });
    expect(
      claude.plan!(
        actProfile('native-default', '/Users/test/.claude'),
        actServer({ transport: 'stdio', target: 'npx x' }),
        'remove',
      ),
    ).toMatchObject({ reaches: ['definition'] });
  });

  it("has no switch for a whole profile, and leaves a project's server and a skill alone", () => {
    const work = actProfile('managed', '/profiles/work/claude');
    expect(claude.plan!(work, actServer(), 'disable')).toMatchObject({
      available: false,
      reason: 'no-command',
      message: 'Claude Code has no switch for a whole profile: /mcp turns a server off one project at a time',
    });
    expect(
      claude.plan!(
        work,
        actServer({ id: 'project:/Users/test/billing:sentry', origin: 'project', project: '~/billing' }),
        'remove',
      ),
    ).toMatchObject({ available: false, reason: 'not-own' });
    expect(claude.plan!(work, actSkill(), 'disable')).toMatchObject({ available: false, reason: 'no-command' });
  });
});
