import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  describeMcpDefinition,
  ExtensionActKindSchema,
  ExtensionActPlanSchema,
  ExtensionCatalogSchema,
  ExtensionFailureSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  McpServerDefinitionSchema,
  type CatalogPlugin,
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionActPlanOptions,
  type ExtensionInventory,
  type ExtensionItem,
  type ExtensionReach,
  type MarketplaceItem,
  type McpServerDefinition,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
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

/** A root that knows one marketplace, `northlight`, cloned with `catalog` as its marketplace.json; answers the clone. */
async function knowing(root: string, catalog: unknown): Promise<string> {
  const clone = join(root, 'plugins', 'marketplaces', 'northlight');
  await write(join(root, 'plugins', 'known_marketplaces.json'), {
    northlight: {
      source: { source: 'github', repo: 'northlight-studio/plugins' },
      installLocation: clone,
      lastUpdated: '2026-09-26T08:00:00.000Z',
    },
  });
  await write(join(clone, '.claude-plugin', 'marketplace.json'), catalog);
  return clone;
}

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
      origin: 'own',
      source: 'northlight-studio/plugins',
      updatedAt: '2026-09-20T10:00:00.000Z',
    });
    // Claude Code's own, from Anthropic's repository
    expect(find(inventory, 'marketplace', 'claude-plugins-official')).toMatchObject({ origin: 'bundled' });
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

  it('offers a server another agent could take only when nothing of it would stay behind', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'claude-0b7e2c4d');
    await write(join(root, '.claude.json'), {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_northlightvalue0123456789' },
        },
        docs: { type: 'http', url: 'https://mcp.northlight.studio/docs' },
        weather: { command: 'npx', args: ['-y', 'weather-mcp', 'sk-ant-api03-weathervalue0123456789'] },
        linear: {
          type: 'http',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer lin_api_secret_value' },
        },
        // Claude Code keeps args as strings: this one is not the server a definition would give
        numbered: { command: 'node', args: ['server.js', '--port', 8080] },
      },
    });

    const inventory = ExtensionInventorySchema.parse(
      await createClaudeExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    const document = JSON.stringify(inventory);
    for (const secret of ['ghp_northlightvalue', 'weathervalue', 'lin_api_secret_value']) {
      expect(document).not.toContain(secret);
    }

    expect(find(inventory, 'mcp-server', 'github')).toHaveProperty('definition', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: ['GITHUB_TOKEN'],
    });
    expect(find(inventory, 'mcp-server', 'docs')).toHaveProperty('definition', {
      transport: 'http',
      url: 'https://mcp.northlight.studio/docs',
    });
    // a key in its command line is masked, so the target is not the whole of it
    expect(find(inventory, 'mcp-server', 'weather')).toMatchObject({ target: 'npx -y weather-mcp •••' });
    // a header's value never travels
    expect(find(inventory, 'mcp-server', 'linear')).toMatchObject({ headers: ['Authorization'] });
    for (const id of ['weather', 'linear', 'numbered']) {
      const server = find(inventory, 'mcp-server', id);
      expect(server).toBeDefined();
      expect(server).not.toHaveProperty('definition');
    }
  });

  it('says who made a plugin, where it lives and what it brings, read from inside its folder alone', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'claude');
    const cache = join(root, 'plugins', 'cache');
    const review = join(cache, 'northlight', 'review', '1.2.0');
    const figma = join(cache, 'official', 'figma', '1.1.0');
    const linked = join(cache, 'northlight', 'linked', '0.1.0');
    const outside = join(home, 'elsewhere');
    await write(join(root, 'settings.json'), { enabledPlugins: { 'review@northlight': true } });
    await write(join(root, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'review@northlight': [{ scope: 'user', version: '1.2.0', installPath: review }],
        'figma@claude-plugins-official': [{ scope: 'user', version: '1.1.0', installPath: figma }],
        'linked@northlight': [{ scope: 'user', version: '0.1.0', installPath: linked }],
        'gone@northlight': [{ scope: 'user', version: '0.0.1', installPath: join(cache, 'northlight', 'gone') }],
      },
    });
    // an author with an email, a homepage with a key in it, and every part
    await write(join(review, '.claude-plugin', 'plugin.json'), {
      name: 'review',
      author: { name: 'Northlight Studio', email: 'plugins@northlight.studio', url: 'https://northlight.studio' },
      homepage: 'https://user:pw@github.com/x/y?token=1',
      repository: 'https://github.com/northlight/review',
    });
    await write(join(review, 'commands', 'review.md'), '# review');
    await write(join(review, 'commands', 'lint.md'), '# lint');
    await write(join(review, 'commands', '.draft.md'), '# hidden');
    await write(join(review, 'commands', 'notes.txt'), 'not a command');
    await write(join(review, 'commands', 'nested', 'deep.md'), '# nested');
    await write(join(outside, 'stolen.md'), '# a link among the files');
    await symlink(join(outside, 'stolen.md'), join(review, 'commands', 'stolen.md'));
    // a part linked to a folder inside the plugin is its own
    await write(join(review, 'parts', 'agents', 'reviewer.md'), '# reviewer');
    await symlink(join(review, 'parts', 'agents'), join(review, 'agents'));
    await write(join(review, 'hooks', 'hooks.json'), {
      description: 'Checks each edit',
      hooks: { PreToolUse: [], PostToolUse: [], 'not an event': [], '9Lives': [] },
    });
    // npm's person form, a repository object behind a homepage that is no address, events at the top level
    await write(join(figma, '.claude-plugin', 'plugin.json'), {
      name: 'figma',
      author: 'Figma Design <plugins@figma.example> (https://figma.example)',
      homepage: 'not an address',
      repository: { type: 'git', url: 'https://github.com/figma/claude-plugin.git' },
    });
    await write(join(figma, 'hooks', 'hooks.json'), { SessionStart: [] });
    // parts that are links out of the plugin, and addresses that are not http(s)
    await write(join(linked, '.claude-plugin', 'plugin.json'), {
      name: 'linked',
      homepage: 'ftp://files.northlight.example/linked',
      repository: 'github:northlight/linked',
    });
    await write(join(outside, 'commands', 'escape.md'), '# escape');
    await write(join(outside, 'hooks.json'), { hooks: { Stop: [] } });
    await symlink(join(outside, 'commands'), join(linked, 'commands'));
    await mkdir(join(linked, 'hooks'), { recursive: true });
    await symlink(join(outside, 'hooks.json'), join(linked, 'hooks', 'hooks.json'));
    const toolkit = join(root, 'plugins', 'synced', 'toolkit');
    await write(join(toolkit, '.claude-plugin', 'plugin.json'), { name: 'toolkit', author: 'Northlight' });
    await write(join(toolkit, 'agents', 'planner.md'), '# planner');

    const inventory = ExtensionInventorySchema.parse(
      await createClaudeExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    const document = JSON.stringify(inventory);
    for (const secret of ['plugins@northlight.studio', 'user:pw', 'token=1', 'plugins@figma.example']) {
      expect(document).not.toContain(secret);
    }
    expect(find(inventory, 'plugin', 'review@northlight')).toEqual({
      kind: 'plugin',
      id: 'review@northlight',
      name: 'review',
      origin: 'own',
      enabled: true,
      version: '1.2.0',
      marketplace: 'northlight',
      location: review,
      author: 'Northlight Studio',
      homepage: 'https://•••@github.com/x/y?•••',
      brings: { commands: ['lint', 'review'], agents: ['reviewer'], hooks: ['PostToolUse', 'PreToolUse'] },
    });
    expect(find(inventory, 'plugin', 'figma@claude-plugins-official')).toMatchObject({
      author: 'Figma Design',
      homepage: 'https://github.com/figma/claude-plugin.git',
    });
    expect(find(inventory, 'plugin', 'figma@claude-plugins-official')).toHaveProperty('brings', {
      hooks: ['SessionStart'],
    });
    expect(find(inventory, 'plugin', 'toolkit@synced')).toMatchObject({ origin: 'managed', author: 'Northlight' });
    expect(find(inventory, 'plugin', 'toolkit@synced')).toHaveProperty('brings', { agents: ['planner'] });
    // nothing followed out of its folder, and a folder that is not there says nothing
    for (const id of ['linked@northlight', 'gone@northlight']) {
      const plugin = find(inventory, 'plugin', id);
      expect(plugin, id).toBeDefined();
      for (const field of ['author', 'homepage', 'brings']) expect(plugin, id).not.toHaveProperty(field);
    }
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
/** The server an add plans from, as the runtime synthesizes it: never read, always the profile's own. */
const addedServer = (name: string, definition: McpServerDefinition): McpServerItem => ({
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

  it('signs a remote server in with its own login in a terminal, and out with its own command', () => {
    const work = actProfile('managed', '/profiles/work/claude');
    expect(claude.plan!(work, actServer(), 'sign-in')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'sign-in',
      available: true,
      runs: {
        kind: 'terminal',
        argv: ['claude', 'mcp', 'login', 'linear'],
        env: { CLAUDE_CONFIG_DIR: '/profiles/work/claude' },
      },
      display: 'claude mcp login linear',
      // the profile's own keychain item: it reaches no other profile
      reaches: [],
    });
    expect(claude.plan!(work, actServer(), 'sign-out')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['claude', 'mcp', 'logout', 'linear'] },
    });
    expect(claude.plan!(work, actServer({ transport: 'stdio', target: 'npx x' }), 'sign-in')).toMatchObject({
      available: false,
      reason: 'no-sign-in',
    });
    expect(claude.plan!(work, actServer({ headers: ['Authorization'] }), 'sign-in')).toMatchObject({
      available: false,
      reason: 'no-sign-in',
      message: 'linear sends its own key, so Claude Code has no sign-in for it',
    });
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

  it("adds a stdio server at user scope, each variable named in Claude Code's own syntax and never its value", () => {
    // values the host's environment holds: an add names the variables and never carries one
    const values = { GITHUB_TOKEN: 'ghp_northlightvalue0123456789', GITHUB_HOST: 'github.northlight.example' };
    const hosted = createClaudeExtensionService({ executable: 'claude', env: values, home: '/Users/test' });
    const github = addedServer(
      'github',
      McpServerDefinitionSchema.parse({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: ['GITHUB_TOKEN', 'GITHUB_HOST'],
      }),
    );
    // the name before `-e`, which takes every word after it; `--` ends Claude Code's own options
    const argv = [
      'claude',
      'mcp',
      'add',
      'github',
      '--scope',
      'user',
      '-e',
      'GITHUB_TOKEN=${GITHUB_TOKEN:-}',
      '-e',
      'GITHUB_HOST=${GITHUB_HOST:-}',
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ];
    const plan = {
      target: { kind: 'mcp-server', id: 'github' },
      act: 'add',
      available: true,
      display:
        'claude mcp add github --scope user -e GITHUB_TOKEN=${GITHUB_TOKEN:-} -e GITHUB_HOST=${GITHUB_HOST:-} -- npx -y @modelcontextprotocol/server-github',
      reaches: [],
    };
    const work = ExtensionActPlanSchema.parse(
      hosted.plan!(actProfile('managed', '/profiles/work/claude'), github, 'add'),
    );
    expect(work).toEqual({
      ...plan,
      runs: { kind: 'command', argv, env: { CLAUDE_CONFIG_DIR: '/profiles/work/claude' } },
    });
    // the native default is the root Claude Code finds with no variable at all
    const native = ExtensionActPlanSchema.parse(
      hosted.plan!(actProfile('native-default', '/Users/test/.claude'), github, 'add'),
    );
    expect(native).toEqual({ ...plan, runs: { kind: 'command', argv } });
    for (const answer of [work, native]) {
      const document = JSON.stringify(answer);
      for (const value of Object.values(values)) expect(document).not.toContain(value);
    }
  });

  it('adds a remote server at its address, over HTTP or SSE', () => {
    const work = actProfile('managed', '/profiles/work/claude');
    const docs = addedServer('docs', { transport: 'http', url: 'https://mcp.northlight.studio/docs' });
    expect(ExtensionActPlanSchema.parse(claude.plan!(work, docs, 'add'))).toEqual({
      target: { kind: 'mcp-server', id: 'docs' },
      act: 'add',
      available: true,
      runs: {
        kind: 'command',
        argv: [
          'claude',
          'mcp',
          'add',
          'docs',
          'https://mcp.northlight.studio/docs',
          '--scope',
          'user',
          '--transport',
          'http',
        ],
        env: { CLAUDE_CONFIG_DIR: '/profiles/work/claude' },
      },
      display: 'claude mcp add docs https://mcp.northlight.studio/docs --scope user --transport http',
      reaches: [],
    });
    const events = addedServer('events', { transport: 'sse', url: 'https://mcp.northlight.studio/sse' });
    expect(ExtensionActPlanSchema.parse(claude.plan!(work, events, 'add'))).toMatchObject({
      available: true,
      runs: {
        kind: 'command',
        argv: [
          'claude',
          'mcp',
          'add',
          'events',
          'https://mcp.northlight.studio/sse',
          '--scope',
          'user',
          '--transport',
          'sse',
        ],
      },
      display: 'claude mcp add events https://mcp.northlight.studio/sse --scope user --transport sse',
      reaches: [],
    });
  });

  it("answers an add Claude Code's command cannot take: a name or address it would misread, no definition, no folder", () => {
    const work = actProfile('managed', '/profiles/work/claude');
    const docs = { transport: 'http', url: 'https://mcp.northlight.studio/docs' } as const;
    for (const name of ['--scope', 'north light']) {
      expect(claude.plan!(work, addedServer(name, docs), 'add')).toEqual({
        target: { kind: 'mcp-server', id: name },
        act: 'add',
        available: false,
        reason: 'no-command',
        message: "Claude Code's commands do not take this server's name",
      });
    }
    expect(claude.plan!(work, addedServer('docs', { ...docs, url: '--scope=project' }), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
    });
    // an own server as a read found it carries no definition to add from
    expect(claude.plan!(work, actServer(), 'add')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: 'Claude Code adds a server only from its command line or address',
    });
    // a skill comes only as a folder to link
    expect(claude.plan!(work, actSkill(), 'add')).toMatchObject({
      target: { kind: 'skill', id: 'release-notes' },
      available: false,
      reason: 'unsupported',
    });
  });
});

describe('Claude Code skills placed', () => {
  /** A skill as the runtime hands it for an add: the host's folder as its link, never read. */
  const placing = (name: string, folder: string): SkillItem => ({
    kind: 'skill',
    id: name,
    name,
    origin: 'own',
    enabled: true,
    linkTarget: folder,
  });

  it("links a skill the host keeps into the root's skills folder; the native default's reaches the agents that borrow it", async () => {
    const home = await tempHome();
    const kept = join(home, 'kept', 'release-notes');
    const claude = createClaudeExtensionService({ executable: 'claude', env: {}, home });
    const work = managedProfile(join(home, 'profiles', 'work', 'claude'));
    expect(ExtensionActPlanSchema.parse(claude.plan!(work, placing('release-notes', kept), 'add'))).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: true,
      runs: {
        kind: 'files',
        steps: [
          { op: 'link', path: join(home, 'profiles', 'work', 'claude', 'skills', 'release-notes'), target: kept },
        ],
      },
      display: 'link ~/kept/release-notes → ~/profiles/work/claude/skills/release-notes',
      reaches: [],
    });
    // Grok and OpenCode read the home's ~/.claude/skills whatever their profile
    expect(
      ExtensionActPlanSchema.parse(claude.plan!(nativeProfile(home), placing('release-notes', kept), 'add')),
    ).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'link', path: join(home, '.claude', 'skills', 'release-notes') }] },
      display: 'link ~/kept/release-notes → ~/.claude/skills/release-notes',
      reaches: ['shared-folder'],
    });
  });

  it('takes away only its own: a link goes, a folder moves to where the host keeps it, or else stays', async () => {
    const home = await tempHome();
    const claude = createClaudeExtensionService({ executable: 'claude', env: {}, home });
    const work = managedProfile(join(home, 'profiles', 'work', 'claude'));
    const location = join(work.dataRoot, 'skills', 'release-notes');
    const keepIn = join(home, 'kept', 'release-notes');
    expect(claude.plan!(work, actSkill({ location, linkTarget: keepIn }), 'remove')).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: location }] },
      display: 'unlink ~/profiles/work/claude/skills/release-notes',
      reaches: [],
    });
    expect(claude.plan!(work, actSkill({ location }), 'remove', { keepIn })).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'move', from: location, to: keepIn }] },
      display: 'move ~/profiles/work/claude/skills/release-notes → ~/kept/release-notes',
    });
    expect(claude.plan!(work, actSkill({ location }), 'remove')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
    // the switch stays a settings key
    expect(claude.plan!(work, actSkill({ location }), 'disable', { keepIn })).toMatchObject({
      available: false,
      reason: 'no-command',
      message: 'Claude Code turns a skill off only in its settings',
    });
  });

  it("leaves the account's synced skills and a plugin's where they come from, and places none named synced", async () => {
    const home = await tempHome();
    const claude = createClaudeExtensionService({ executable: 'claude', env: {}, home });
    const work = managedProfile(join(home, 'profiles', 'work', 'claude'));
    const keepIn = join(home, 'kept', 'brand');
    const synced = actSkill({
      id: 'synced:brand',
      name: 'brand',
      origin: 'managed',
      location: join(work.dataRoot, 'skills', 'synced', 'brand'),
    });
    expect(claude.plan!(work, synced, 'remove', { keepIn })).toMatchObject({ available: false, reason: 'not-own' });
    const plugin = actSkill({
      id: 'plugin:review@northlight:house-style',
      name: 'house-style',
      origin: 'plugin',
      plugin: 'review@northlight',
      location: join(work.dataRoot, 'plugins', 'cache', 'northlight', 'review', 'skills', 'house-style'),
    });
    expect(claude.plan!(work, plugin, 'remove', { keepIn })).toEqual({
      target: { kind: 'skill', id: 'plugin:review@northlight:house-style' },
      act: 'remove',
      available: false,
      reason: 'not-own',
      message: 'It comes with the review@northlight plugin and changes with it',
    });
    // a case-folding disk would take `Synced` for the account's folder too
    for (const name of ['synced', 'Synced']) {
      expect(claude.plan!(work, placing(name, join(home, 'kept', name)), 'add')).toEqual({
        target: { kind: 'skill', id: name },
        act: 'add',
        available: false,
        reason: 'unsupported',
        message: "Claude Code keeps your account's synced skills in skills/synced",
      });
    }
  });

  it('plans from what its own read found, and a link placed where the plan says reads back as its own', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'claude');
    const kept = join(home, 'kept');
    await write(join(root, 'skills', 'changelog', 'SKILL.md'), skill('changelog', 'Writes the changelog entry'));
    await write(join(kept, 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
    const claude = createClaudeExtensionService({ executable: 'claude', env: {}, home, now });
    const work = managedProfile(root);
    const skillIn = async (id: string): Promise<SkillItem> => {
      const item = find(ExtensionInventorySchema.parse(await claude.inventory(work)), 'skill', id);
      if (item?.kind !== 'skill') throw new Error(`the read found no skill ${id}`);
      return item;
    };

    const changelog = await skillIn('changelog');
    expect(claude.plan!(work, changelog, 'remove', { keepIn: join(kept, 'changelog') })).toMatchObject({
      available: true,
      runs: {
        kind: 'files',
        steps: [{ op: 'move', from: join(root, 'skills', 'changelog'), to: join(kept, 'changelog') }],
      },
    });
    const add = claude.plan!(work, placing('release-notes', join(kept, 'release-notes')), 'add');
    const step = add.available && add.runs.kind === 'files' ? add.runs.steps[0] : undefined;
    if (step?.op !== 'link') throw new Error('expected a link step');
    // the runtime's step, by hand: the second read is the receipt, and the link is the root's own
    await symlink(step.target, step.path);
    const placed = await skillIn('release-notes');
    expect(placed).toMatchObject({
      origin: 'own',
      location: step.path,
      linkTarget: join(kept, 'release-notes'),
      description: 'Drafts release notes',
    });
    expect(claude.plan!(work, placed, 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: step.path }] },
    });
  });
});

describe('Claude Code plugin acts', () => {
  const claude = createClaudeExtensionService({ executable: 'claude', env: {}, home: '/Users/test' });
  const actPlugin = (fields: Record<string, unknown> = {}) =>
    ({
      kind: 'plugin',
      id: 'review@northlight',
      name: 'review',
      origin: 'own',
      enabled: true,
      version: '1.2.0',
      marketplace: 'northlight',
      ...fields,
    }) as never;

  it("turns a plugin on and off, updates it and uninstalls it with Claude Code's own commands, at user scope", () => {
    const work = actProfile('managed', '/profiles/work/claude');
    const forms: Record<string, string[]> = {
      enable: ['claude', 'plugin', 'enable', 'review@northlight', '--scope', 'user'],
      disable: ['claude', 'plugin', 'disable', 'review@northlight', '--scope', 'user'],
      // a remove keeps what the plugin stored in plugins/data; a purge takes that too
      remove: ['claude', 'plugin', 'uninstall', 'review@northlight', '--scope', 'user', '--keep-data'],
      purge: ['claude', 'plugin', 'uninstall', 'review@northlight', '--scope', 'user'],
      // an update refuses to run without `-y` where no one answers it
      update: ['claude', 'plugin', 'update', 'review@northlight', '--scope', 'user', '-y'],
    };
    for (const [act, argv] of Object.entries(forms)) {
      expect(ExtensionActPlanSchema.parse(claude.plan!(work, actPlugin(), act as ExtensionActKind)), act).toEqual({
        target: { kind: 'plugin', id: 'review@northlight' },
        act,
        available: true,
        runs: { kind: 'command', argv, env: { CLAUDE_CONFIG_DIR: '/profiles/work/claude' } },
        display: argv.join(' '),
        // a managed root's plugins are its own
        reaches: [],
      });
    }
  });

  it('says an uninstall or an update in the native default reaches Grok, which loads every plugin installed there', () => {
    const native = actProfile('native-default', '/Users/test/.claude');
    for (const act of ['remove', 'purge', 'update'] as const) {
      const plan = ExtensionActPlanSchema.parse(claude.plan!(native, actPlugin(), act));
      expect(plan, act).toMatchObject({ available: true, runs: { kind: 'command' }, reaches: ['shared-folder'] });
      // the root Claude Code finds with no variable at all
      expect(plan, act).not.toHaveProperty('runs.env');
    }
    // Grok never reads enabledPlugins: a switch stays with Claude Code
    for (const act of ['enable', 'disable'] as const) {
      expect(claude.plan!(native, actPlugin(), act), act).toMatchObject({ available: true, reaches: [] });
    }
  });

  it("leaves the account's synced plugins to claude.ai, and plans nothing Claude Code's commands cannot take", () => {
    const work = actProfile('managed', '/profiles/work/claude');
    const synced = actPlugin({
      id: 'toolkit@synced',
      name: 'toolkit',
      origin: 'managed',
      location: '/profiles/work/claude/plugins/synced/toolkit',
    });
    for (const act of ['enable', 'disable', 'remove', 'purge', 'update'] as const) {
      expect(claude.plan!(work, synced, act)).toEqual({
        target: { kind: 'plugin', id: 'toolkit@synced' },
        act,
        available: false,
        reason: 'not-own',
        message: 'It comes with your Claude account, from claude.ai, and changes there',
      });
    }
    // a flag, a path, a space: never an argument of Claude Code's own
    for (const id of ['--scope', '../review@northlight', '.review@northlight', 'review@north light']) {
      expect(claude.plan!(work, actPlugin({ id }), 'remove')).toEqual({
        target: { kind: 'plugin', id },
        act: 'remove',
        available: false,
        reason: 'no-command',
        message: "Claude Code's commands do not take this plugin's name",
      });
    }
    expect(claude.plan!(work, actPlugin(), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Claude Code installs a plugin from its marketplace',
    });
    for (const act of ['sign-in', 'sign-out'] as const) {
      expect(claude.plan!(work, actPlugin(), act)).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Claude Code has no sign-in for a plugin',
      });
    }
  });
});

// ── catalogs, installs and marketplaces (RFC 006 C2) ──

describe('Claude Code catalogs', () => {
  it('reads each catalog Claude Code fetched: what its plugins bring and ask, which it holds and which are newer, and no secret', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'work', 'claude');
    const plugins = join(root, 'plugins');
    const northlight = join(plugins, 'marketplaces', 'northlight');
    const official = join(plugins, 'marketplaces', 'claude-plugins-official');
    const local = join(home, 'work', 'local-market');
    const hosted = join(plugins, 'marketplaces', 'acme-org.json');
    const outside = join(home, 'elsewhere');
    await write(join(plugins, 'known_marketplaces.json'), {
      northlight: {
        source: { source: 'github', repo: 'northlight-studio/plugins' },
        installLocation: northlight,
        lastUpdated: '2026-09-26T08:00:00.000Z',
      },
      'claude-plugins-official': {
        source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
        installLocation: official,
        lastUpdated: '2026-09-27T08:00:00.000Z',
        autoUpdate: true,
      },
      // a folder is read in place
      local: {
        source: { source: 'directory', path: local },
        installLocation: local,
        lastUpdated: '2026-09-25T08:00:00.000Z',
      },
      broken: {
        source: { source: 'git', url: 'https://deploy:hunter2@git.northlight.example/broken.git' },
        installLocation: join(plugins, 'marketplaces', 'broken'),
      },
      missing: {
        source: { source: 'github', repo: 'northlight-studio/missing' },
        installLocation: join(plugins, 'marketplaces', 'missing'),
      },
    });
    await write(join(plugins, 'known_marketplaces_claudeai.json'), {
      'acme-org': {
        source: { source: 'url', url: 'https://claude.ai/api/marketplaces/acme?sig=abc123' },
        installLocation: hosted,
        lastUpdated: '2026-09-27T07:00:00.000Z',
      },
    });

    const pluginRoot = join(northlight, 'plugins');
    await write(join(northlight, '.claude-plugin', 'marketplace.json'), {
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'northlight',
      owner: { name: 'Northlight Studio', email: 'owner@northlight.studio' },
      metadata: { pluginRoot: './plugins' },
      plugins: [
        {
          name: 'review',
          source: './review',
          description: 'Reviews against the house style',
          version: '1.0.0',
          author: { name: 'Northlight Studio', email: 'plugins@northlight.studio' },
          category: 'productivity',
          homepage: 'https://user:pw@northlight.studio/review?key=abc123',
          tags: ['review'],
        },
        { name: 'lint', source: './lint', version: '2.0.0', repository: 'https://github.com/northlight-studio/lint' },
        {
          name: 'deploy',
          source: { source: 'github', repo: 'northlight-studio/deploy', ref: 'v2', sha: 'A'.repeat(40) },
          version: '2.1.0',
          commands: ['./commands/ship.md', './commands/'],
          agents: './agents/deployer.md',
          hooks: { hooks: { PostToolUse: [] } },
          mcpServers: { deploy: { type: 'http', url: 'https://mcp.northlight.studio/deploy?token=abc123' } },
        },
        {
          name: 'types',
          source: {
            source: 'npm',
            package: '@northlight/claude-types',
            version: '^2.0.0',
            registry: 'https://npm:tok3n@registry.northlight.example',
          },
        },
        {
          name: 'bootstrap',
          source: {
            source: 'command',
            command: 'curl',
            args: ['-fsSL', 'https://get.northlight.example/plugin.sh', '--token', 'sk-ant-api03-bootstrapsecret'],
          },
        },
        { name: 'setup', source: { source: 'command', command: 'npx @northlight/setup --out plugin' } },
        { name: 'telemetry', source: './telemetry' },
        // a path out of the marketplace's folder, and a link out of it
        { name: 'escape', source: relative(pluginRoot, join(outside, 'escape')) },
        { name: 'linked', source: './linked' },
        { name: 'nosource' },
        { source: './anonymous' },
        'not an entry',
        { name: 'review', source: './review-again', description: 'A second entry by one name' },
      ],
    });
    const review = join(pluginRoot, 'review');
    await write(join(review, '.claude-plugin', 'plugin.json'), {
      name: 'review',
      version: '1.3.0',
      description: 'From its manifest',
    });
    await write(join(review, 'commands', 'review.md'), '# review');
    await write(join(review, 'commands', 'lint.md'), '# lint');
    await write(join(review, 'agents', 'reviewer.md'), '# reviewer');
    await write(join(review, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [], Stop: [] } });
    await write(join(review, '.mcp.json'), {
      mcpServers: { house: { type: 'http', url: 'https://mcp.northlight.studio/house?key=abc123' } },
    });
    await write(join(review, 'skills', 'house-style', 'SKILL.md'), skill('house-style', 'Northlight naming'));
    await write(join(review, 'skills', 'notes', 'README.md'), '# not a skill');
    await write(join(outside, 'stolen', 'SKILL.md'), skill('stolen', 'A skill outside the plugin'));
    await symlink(join(outside, 'stolen'), join(review, 'skills', 'stolen'));
    await write(join(pluginRoot, 'lint', '.claude-plugin', 'plugin.json'), { name: 'lint' });
    await write(join(pluginRoot, 'telemetry', '.claude-plugin', 'plugin.json'), {
      name: 'telemetry',
      version: '0.4.0',
    });
    for (const name of ['escape', 'linked']) {
      await write(join(outside, name, '.claude-plugin', 'plugin.json'), { name, version: '9.9.9' });
      await write(join(outside, name, 'commands', 'wander.md'), '# wander');
    }
    await symlink(join(outside, 'linked'), join(pluginRoot, 'linked'));

    await write(join(official, '.claude-plugin', 'marketplace.json'), {
      name: 'claude-plugins-official',
      owner: { name: 'Anthropic' },
      plugins: [
        {
          name: 'figma',
          source: './external_plugins/figma',
          description: 'Figma designs in Claude Code',
          category: 'design',
        },
      ],
    });
    const figma = join(official, 'external_plugins', 'figma');
    await write(join(figma, '.claude-plugin', 'plugin.json'), { name: 'figma', version: '1.1.0' });
    await write(join(figma, '.mcp.json'), { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } });
    await write(join(local, '.claude-plugin', 'marketplace.json'), {
      name: 'local',
      plugins: [{ name: 'notes', source: './notes' }],
    });
    await write(join(local, 'notes', 'skills', 'journal', 'SKILL.md'), skill('journal', 'Keeps a work journal'));
    await write(join(plugins, 'marketplaces', 'broken', '.claude-plugin', 'marketplace.json'), '{ not json');
    await write(hosted, {
      name: 'acme-org',
      owner: { name: 'Acme' },
      plugins: [
        {
          name: 'handbook',
          source: { source: 'github', repo: 'acme/handbook' },
          description: 'The Acme handbook',
          // commands mapped by name
          commands: { onboard: { source: './commands/onboard.md', description: 'Onboards a new hire' } },
        },
      ],
    });

    await write(join(plugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'review@northlight': [
          { scope: 'user', version: '1.3.0', installPath: join(plugins, 'cache', 'northlight', 'review', '1.3.0') },
        ],
        'lint@northlight': [{ scope: 'user', version: '1.9.0' }],
        'deploy@northlight': [{ scope: 'user', version: '2.1.0', gitCommitSha: 'b'.repeat(40) }],
        'types@northlight': [{ scope: 'project', projectPath: '/Users/test/app', version: '2.0.0' }],
        'handbook@acme-org': [{ scope: 'user', version: '5d2e8f0a1b3c' }],
      },
    });
    await write(join(plugins, 'flagged-plugins.json'), [{ plugin: 'telemetry@northlight', reason: 'delisted' }]);
    await write(join(root, 'settings.json'), {
      enabledPlugins: { 'review@northlight': true },
      extraKnownMarketplaces: {
        northlight: { source: { source: 'github', repo: 'northlight-studio/plugins' } },
        'team-tools': { source: { source: 'github', repo: 'northlight-studio/team-tools', ref: 'stable' } },
        private: { source: { source: 'git', url: 'https://deploy:hunter2@git.northlight.example/private.git' } },
      },
    });

    const catalog = ExtensionCatalogSchema.parse(
      await createClaudeExtensionService({ home, now }).catalog!(managedProfile(root)),
    );
    const document = JSON.stringify(catalog);
    for (const secret of [
      'hunter2',
      'abc123',
      'user:pw',
      'tok3n',
      'bootstrapsecret',
      'plugins@northlight.studio',
      'owner@northlight.studio',
      '9.9.9',
      'wander',
      'stolen',
    ]) {
      expect(document).not.toContain(secret);
    }

    expect(catalog).toMatchObject({
      provider: 'claude',
      profileId: 'work-claude',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'documented' },
    });
    expect(catalog.marketplaces).toEqual([
      {
        id: 'northlight',
        name: 'northlight',
        source: 'northlight-studio/plugins',
        updatedAt: '2026-09-26T08:00:00.000Z',
        origin: 'own',
      },
      {
        id: 'claude-plugins-official',
        name: 'claude-plugins-official',
        source: 'anthropics/claude-plugins-official',
        updatedAt: '2026-09-27T08:00:00.000Z',
        origin: 'bundled',
      },
      { id: 'local', name: 'local', source: local, updatedAt: '2026-09-25T08:00:00.000Z', origin: 'own' },
      {
        id: 'broken',
        name: 'broken',
        source: 'https://•••@git.northlight.example/broken.git',
        origin: 'own',
        unread: 'Its catalog is not valid JSON',
      },
      {
        id: 'missing',
        name: 'missing',
        source: 'northlight-studio/missing',
        origin: 'own',
        unread: 'Claude Code has not fetched its catalog',
      },
      {
        id: 'acme-org',
        name: 'acme-org',
        source: 'https://claude.ai/api/marketplaces/acme?•••',
        updatedAt: '2026-09-27T07:00:00.000Z',
        origin: 'managed',
      },
    ]);
    // an entry needs a name and a source, and a second by one name is not another plugin
    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual([
      'review@northlight',
      'lint@northlight',
      'deploy@northlight',
      'types@northlight',
      'bootstrap@northlight',
      'setup@northlight',
      'telemetry@northlight',
      'escape@northlight',
      'linked@northlight',
      'figma@claude-plugins-official',
      'notes@local',
      'handbook@acme-org',
    ]);
    const listed = (id: string) => catalog.plugins.find((plugin) => plugin.id === id);
    expect(listed('review@northlight')).toEqual({
      id: 'review@northlight',
      name: 'review',
      marketplace: 'northlight',
      description: 'Reviews against the house style',
      author: 'Northlight Studio',
      category: 'productivity',
      // the manifest's version, before the entry's
      version: '1.3.0',
      homepage: 'https://•••@northlight.studio/review?•••',
      brings: {
        commands: ['lint', 'review'],
        agents: ['reviewer'],
        hooks: ['PreToolUse', 'Stop'],
        servers: ['house'],
        skills: ['house-style'],
      },
      held: 'review@northlight',
    });
    expect(listed('lint@northlight')).toEqual({
      id: 'lint@northlight',
      name: 'lint',
      marketplace: 'northlight',
      version: '2.0.0',
      homepage: 'https://github.com/northlight-studio/lint',
      held: 'lint@northlight',
      newer: true,
    });
    // a remote entry: what it names itself, and the commit it pins against the one installed
    expect(listed('deploy@northlight')).toEqual({
      id: 'deploy@northlight',
      name: 'deploy',
      marketplace: 'northlight',
      version: '2.1.0',
      brings: { commands: ['ship'], agents: ['deployer'], hooks: ['PostToolUse'], servers: ['deploy'] },
      held: 'deploy@northlight',
      newer: true,
    });
    // npm fetches it with its install scripts; a project's install is not the profile's
    expect(listed('types@northlight')).toEqual({
      id: 'types@northlight',
      name: 'types',
      marketplace: 'northlight',
      asks: [{ kind: 'fetch', command: 'npm install @northlight/claude-types@^2.0.0' }],
    });
    // the command Claude Code shows before it runs one, said ahead and masked
    expect(listed('bootstrap@northlight')).toMatchObject({
      asks: [{ kind: 'command', command: 'curl -fsSL https://get.northlight.example/plugin.sh --token •••' }],
    });
    expect(listed('setup@northlight')).toMatchObject({
      asks: [{ kind: 'command', command: 'npx @northlight/setup --out plugin' }],
    });
    expect(listed('telemetry@northlight')).toMatchObject({
      version: '0.4.0',
      blocked: 'Claude Code flagged it and took it out',
    });
    // nothing read outside the marketplace's folder
    for (const name of ['escape', 'linked']) {
      expect(listed(`${name}@northlight`)).toEqual({ id: `${name}@northlight`, name, marketplace: 'northlight' });
    }
    expect(listed('figma@claude-plugins-official')).toEqual({
      id: 'figma@claude-plugins-official',
      name: 'figma',
      marketplace: 'claude-plugins-official',
      description: 'Figma designs in Claude Code',
      category: 'design',
      version: '1.1.0',
      brings: { servers: ['figma'] },
    });
    expect(listed('notes@local')).toEqual({
      id: 'notes@local',
      name: 'notes',
      marketplace: 'local',
      brings: { skills: ['journal'] },
    });
    // a digest installed, and no version listed: nothing to compare
    expect(listed('handbook@acme-org')).toEqual({
      id: 'handbook@acme-org',
      name: 'handbook',
      marketplace: 'acme-org',
      description: 'The Acme handbook',
      brings: { commands: ['onboard'] },
      held: 'handbook@acme-org',
    });
    expect(catalog.suggested).toEqual([
      {
        name: 'team-tools',
        source: 'northlight-studio/team-tools#stable',
        message: 'Claude Code fetches it the next time it starts',
      },
      // an address a listing would mask is no source to add
      { name: 'private', message: 'Claude Code fetches it the next time it starts' },
    ]);
  });

  it("suggests Claude Code's own marketplace to a root without it, and at most four", async () => {
    const home = await tempHome();
    const claude = createClaudeExtensionService({ home, now });
    const official = {
      name: 'claude-plugins-official',
      source: 'anthropics/claude-plugins-official',
      message: 'Claude Code adds claude-plugins-official the first time it starts in this profile',
    };
    for (const profile of [nativeProfile(home), managedProfile(join(home, 'fresh'))]) {
      const fresh = ExtensionCatalogSchema.parse(await claude.catalog!(profile));
      expect(fresh, profile.id).toMatchObject({ profileId: profile.id, marketplaces: [], plugins: [] });
      expect(fresh.suggested, profile.id).toEqual([official]);
    }

    const declared = join(home, 'declared');
    await write(join(declared, 'settings.json'), {
      extraKnownMarketplaces: Object.fromEntries(
        ['one', 'two', 'three', 'four', 'five'].map((name) => [
          name,
          { source: { source: 'github', repo: `northlight-studio/${name}` } },
        ]),
      ),
    });
    const many = ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(declared)));
    expect(many.suggested?.map((suggestion) => suggestion.name)).toEqual([
      'claude-plugins-official',
      'one',
      'two',
      'three',
    ]);

    // a marketplace by that name from another repository is the person's own
    const spoof = join(home, 'spoof');
    await write(join(spoof, 'plugins', 'known_marketplaces.json'), {
      'claude-plugins-official': {
        source: { source: 'github', repo: 'someone/claude-plugins-official' },
        installLocation: join(spoof, 'plugins', 'marketplaces', 'claude-plugins-official'),
      },
    });
    const spoofed = ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(spoof)));
    expect(spoofed.marketplaces).toMatchObject([{ id: 'claude-plugins-official', origin: 'own' }]);
    expect(spoofed.suggested).toBeUndefined();
    const inventory = ExtensionInventorySchema.parse(await claude.inventory(managedProfile(spoof)));
    expect(find(inventory, 'marketplace', 'claude-plugins-official')).toMatchObject({ origin: 'own' });
  });

  it('says a held plugin is newer only where Claude Code compares: two versions of one kind, or the commit an entry pins', async () => {
    const home = await tempHome();
    const root = join(home, 'work');
    const commit = (digit: string) => digit.repeat(40);
    // name, what its entry says, and the root's install record of it
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['semver', { version: '1.1.0' }, { version: '1.0.0' }],
      ['current', { version: '1.0.0' }, { version: '1.0.0' }],
      ['digests', { version: '4e5d6c7b8a90' }, { version: '3f9c2a1b7d04' }],
      ['digest-held', { version: '1.0.0' }, { version: '3f9c2a1b7d04' }],
      ['unknown-held', { version: '1.0.0' }, { version: 'unknown' }],
      ['no-version', {}, { version: '1.0.0' }],
      // the pinned commit decides, whatever the versions say
      [
        'pinned',
        { source: { source: 'github', repo: 'northlight-studio/pinned', sha: commit('a') }, version: '2.0.0' },
        { version: '1.0.0', gitCommitSha: commit('a') },
      ],
      [
        'moved',
        { source: { source: 'url', url: 'https://git.northlight.example/moved.git', sha: commit('c') } },
        { version: '0123456789ab', gitCommitSha: commit('d') },
      ],
      [
        'uninstalled-commit',
        { source: { source: 'github', repo: 'northlight-studio/x', sha: commit('e') }, version: '1.0.0' },
        { version: '1.0.0' },
      ],
    ];
    await knowing(root, {
      name: 'northlight',
      plugins: cases.map(([name, fields]) => ({ name, source: `./${name}`, ...fields })),
    });
    await write(join(root, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: Object.fromEntries(
        cases.map(([name, , record]) => [`${name}@northlight`, [{ scope: 'user', ...record }]]),
      ),
    });
    const catalog = ExtensionCatalogSchema.parse(
      await createClaudeExtensionService({ home, now }).catalog!(managedProfile(root)),
    );
    expect(catalog.plugins.every((plugin) => plugin.held === plugin.id)).toBe(true);
    expect(catalog.plugins.filter((plugin) => plugin.newer === true).map((plugin) => plugin.name)).toEqual([
      'semver',
      'digests',
      'moved',
    ]);
  });

  it('reads the plugins Claude Code flagged in any shape its file may take', async () => {
    const home = await tempHome();
    const claude = createClaudeExtensionService({ home, now });
    const shapes: unknown[] = [
      ['telemetry@northlight'],
      [{ plugin: 'telemetry@northlight', reason: 'delisted' }],
      { 'telemetry@northlight': { flaggedAt: '2026-09-20T10:00:00.000Z' } },
      { plugins: [{ plugin: 'telemetry@northlight' }] },
    ];
    for (const [index, shape] of shapes.entries()) {
      const root = join(home, `root-${index}`);
      await knowing(root, {
        name: 'northlight',
        plugins: [
          { name: 'telemetry', source: './telemetry' },
          { name: 'lint', source: './lint' },
        ],
      });
      await write(join(root, 'plugins', 'flagged-plugins.json'), shape);
      const catalog = ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(root)));
      expect(catalog.plugins, JSON.stringify(shape)).toEqual([
        {
          id: 'telemetry@northlight',
          name: 'telemetry',
          marketplace: 'northlight',
          blocked: 'Claude Code flagged it and took it out',
        },
        { id: 'lint@northlight', name: 'lint', marketplace: 'northlight' },
      ]);
    }
  });

  it('bounds what it reads: a catalog too large or not one is said, and past 400 entries only what an entry says', async () => {
    const home = await tempHome();
    const claude = createClaudeExtensionService({ home, now });
    const large = join(home, 'large');
    await knowing(large, `{"name":"northlight","plugins":[]}${' '.repeat(4 * 1024 * 1024)}`);
    expect(ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(large))).marketplaces).toMatchObject([
      { id: 'northlight', unread: 'Its catalog is larger than 4 MiB' },
    ]);
    const shapeless = join(home, 'shapeless');
    await knowing(shapeless, { name: 'northlight', owner: { name: 'Northlight' } });
    expect(ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(shapeless))).marketplaces).toMatchObject([
      { id: 'northlight', unread: 'Its catalog has no list of plugins' },
    ]);

    const many = join(home, 'many');
    const clone = await knowing(many, {
      name: 'northlight',
      plugins: Array.from({ length: 402 }, (_, index) => ({ name: `p${index}`, source: `./p${index}` })),
    });
    for (const index of [0, 400, 401]) {
      await write(join(clone, `p${index}`, '.claude-plugin', 'plugin.json'), {
        name: `p${index}`,
        version: `1.0.${index}`,
      });
      await write(join(clone, `p${index}`, 'commands', 'run.md'), '# run');
    }
    // one past the bound that the root holds is read: its version decides whether it is newer
    await write(join(many, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'p401@northlight': [{ scope: 'user', version: '1.0.0' }] },
    });
    const catalog = ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(many)));
    expect(catalog.plugins).toHaveLength(402);
    const listed = (id: string) => catalog.plugins.find((plugin) => plugin.id === id);
    expect(listed('p0@northlight')).toMatchObject({ version: '1.0.0', brings: { commands: ['run'] } });
    expect(listed('p400@northlight')).toEqual({ id: 'p400@northlight', name: 'p400', marketplace: 'northlight' });
    expect(listed('p401@northlight')).toMatchObject({
      version: '1.0.401',
      brings: { commands: ['run'] },
      held: 'p401@northlight',
      newer: true,
    });
  });

  it('fails a read whose list of marketplaces cannot be read, since what the root knows is that list', async () => {
    const home = await tempHome();
    const root = join(home, 'work');
    await write(join(root, 'plugins', 'known_marketplaces.json'), '{ not json');
    const result = await createClaudeExtensionService({ home, now }).catalog!(managedProfile(root));
    expect(ExtensionFailureSchema.parse(result)).toEqual({
      status: 'unavailable',
      provider: 'claude',
      message: 'known_marketplaces.json could not be read',
      retryable: true,
    });
  });

  it("leaves out a field past Core's bound, never the read: a source, a location, a plugin's key, a command line", async () => {
    const home = await tempHome();
    const root = join(home, 'work');
    const plugins = join(root, 'plugins');
    const northlight = join(plugins, 'marketplaces', 'northlight');
    const long = (fill: string) => fill.repeat(9_000);
    await write(join(plugins, 'known_marketplaces.json'), {
      northlight: {
        source: { source: 'github', repo: 'northlight-studio/plugins' },
        installLocation: northlight,
        lastUpdated: '2026-09-26T08:00:00.000Z',
      },
      'long-repo': {
        source: { source: 'github', repo: `northlight-studio/${long('r')}` },
        installLocation: join(plugins, 'marketplaces', 'long-repo'),
      },
      'long-url': { source: { source: 'url', url: `https://northlight.example/${long('u')}/marketplace.json` } },
      'long-path': { source: { source: 'directory', path: `/${long('p')}` } },
      'long-location': {
        source: { source: 'github', repo: 'northlight-studio/far' },
        installLocation: `/${long('l')}`,
      },
    });
    await write(join(northlight, '.claude-plugin', 'marketplace.json'), {
      name: 'northlight',
      plugins: [
        { name: 'lint', source: './lint' },
        { name: 'types', source: { source: 'npm', package: `@northlight/${long('n')}` } },
      ],
    });
    await write(join(plugins, 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'lint@northlight': [{ scope: 'user', version: '1.0.0', installPath: `/${long('i')}` }],
        [`${long('k')}@northlight`]: [{ scope: 'user', version: '1.0.0' }],
      },
    });
    const claude = createClaudeExtensionService({ home, now });

    const inventory = ExtensionInventorySchema.parse(await claude.inventory(managedProfile(root)));
    expect(inventory.items.filter((item) => item.kind === 'marketplace').map((item) => item.id)).toEqual([
      'northlight',
      'long-repo',
      'long-url',
      'long-path',
      'long-location',
    ]);
    expect(find(inventory, 'marketplace', 'northlight')).toMatchObject({
      source: 'northlight-studio/plugins',
      location: northlight,
    });
    for (const id of ['long-repo', 'long-path']) {
      expect(find(inventory, 'marketplace', id), id).not.toHaveProperty('source');
    }
    // Core masks an address past its bound whole
    expect(find(inventory, 'marketplace', 'long-url')).toMatchObject({ source: '•••' });
    expect(find(inventory, 'marketplace', 'long-location')).toMatchObject({ source: 'northlight-studio/far' });
    expect(find(inventory, 'marketplace', 'long-location')).not.toHaveProperty('location');
    // a plugin keeps its place without a location no disk takes; a key no install gives is left out
    expect(inventory.items.filter((item) => item.kind === 'plugin').map((item) => item.id)).toEqual([
      'lint@northlight',
    ]);
    expect(find(inventory, 'plugin', 'lint@northlight')).not.toHaveProperty('location');

    const catalog = ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(root)));
    expect(
      catalog.marketplaces.map((marketplace) => [
        marketplace.id,
        marketplace.source ?? null,
        marketplace.unread ?? null,
      ]),
    ).toEqual([
      ['northlight', 'northlight-studio/plugins', null],
      ['long-repo', null, 'Claude Code has not fetched its catalog'],
      ['long-url', '•••', 'Claude Code has not fetched its catalog'],
      // read in place, at a path no disk takes
      ['long-path', null, 'Its catalog could not be read'],
      ['long-location', 'northlight-studio/far', 'Claude Code has not fetched its catalog'],
    ]);
    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual(['lint@northlight', 'types@northlight']);
    const [ask] = catalog.plugins[1]?.asks ?? [];
    expect(ask).toMatchObject({ kind: 'fetch' });
    expect(ask?.kind === 'fetch' && ask.command.startsWith('npm install @northlight/nnn')).toBe(true);
    expect(ask?.kind === 'fetch' ? ask.command.length : 0).toBe(8_192);
  });

  it('lists a catalog only while it fits beside the others, up to the plugins Core takes', async () => {
    const home = await tempHome();
    const root = join(home, 'work');
    const plugins = join(root, 'plugins');
    // `over` has one plugin, and no room is left for it once `northlight` and `fits` are listed
    const counts: Array<[string, number]> = [
      ['northlight', 8_190],
      ['fits', 2],
      ['over', 1],
      ['empty', 0],
    ];
    const known: Record<string, unknown> = {};
    for (const [name, count] of counts) {
      const clone = join(plugins, 'marketplaces', name);
      known[name] = { source: { source: 'github', repo: `northlight-studio/${name}` }, installLocation: clone };
      await write(join(clone, '.claude-plugin', 'marketplace.json'), {
        name,
        plugins: [
          ...Array.from({ length: count }, (_, index) => ({ name: `p${index}`, source: `./p${index}` })),
          // no plugin, or a second by one name: neither takes room
          ...(count > 0 ? [{ name: 'p0', source: './again' }] : []),
          { name: 'nosource' },
        ],
      });
    }
    await write(join(plugins, 'known_marketplaces.json'), known);
    const catalog = ExtensionCatalogSchema.parse(
      await createClaudeExtensionService({ home, now }).catalog!(managedProfile(root)),
    );
    expect(catalog.plugins).toHaveLength(8_192);
    expect(catalog.marketplaces.map((marketplace) => [marketplace.id, marketplace.unread ?? null])).toEqual([
      ['northlight', null],
      ['fits', null],
      ['over', 'It lists more plugins than can be shown beside the others'],
      ['empty', null],
    ]);
    expect(catalog.plugins.filter((plugin) => plugin.marketplace === 'fits').map((plugin) => plugin.id)).toEqual([
      'p0@fits',
      'p1@fits',
    ]);
  });

  it('reads crafted text of some 20k characters in one pass: an author, a homepage, a source', async () => {
    const home = await tempHome();
    const root = join(home, 'work');
    const plugins = join(root, 'plugins');
    const northlight = join(plugins, 'marketplaces', 'northlight');
    const review = join(plugins, 'cache', 'northlight', 'review', '1.0.0');
    // shapes that once made a pattern backtrack: `(` never closed before `://` (cubic), `(@` groups, `<`
    // with no `>`, and a long word
    const unclosedAddresses = '(://'.repeat(5_000);
    const atGroups = '(@'.repeat(10_000);
    const openAngles = '<'.repeat(20_000);
    const word = 'a'.repeat(20_000);
    await write(join(plugins, 'known_marketplaces.json'), {
      northlight: { source: { source: 'github', repo: 'northlight-studio/plugins' }, installLocation: northlight },
      'crafted-url': { source: { source: 'url', url: `https://northlight.example/${unclosedAddresses}` } },
      'crafted-repo': { source: { source: 'github', repo: unclosedAddresses } },
    });
    await write(join(northlight, '.claude-plugin', 'marketplace.json'), {
      name: 'northlight',
      plugins: [
        {
          name: 'review',
          source: './review',
          author: { name: `Northlight Studio ${atGroups}` },
          homepage: `https://northlight.example/${unclosedAddresses}`,
          repository: 'https://github.com/northlight-studio/review',
        },
        {
          name: 'angles',
          source: './angles',
          author: `Figma Design ${openAngles}`,
          homepage: `https://${'a@'.repeat(10_000)}`,
        },
        { name: 'word', source: './word', author: `Jane Doe ${word}@northlight.example` },
        { name: 'addresses', source: './addresses', author: `Northlight Studio ${unclosedAddresses}` },
        { name: 'bootstrap', source: { source: 'command', command: `curl ${unclosedAddresses}` } },
      ],
    });
    await write(join(plugins, 'installed_plugins.json'), {
      version: 2,
      plugins: { 'review@northlight': [{ scope: 'user', version: '1.0.0', installPath: review }] },
    });
    await write(join(review, '.claude-plugin', 'plugin.json'), {
      name: 'review',
      author: `Northlight Studio ${atGroups}`,
      homepage: `https://${word}`,
    });
    const claude = createClaudeExtensionService({ home, now });

    const started = performance.now();
    const inventory = ExtensionInventorySchema.parse(await claude.inventory(managedProfile(root)));
    const catalog = ExtensionCatalogSchema.parse(await claude.catalog!(managedProfile(root)));
    expect(performance.now() - started).toBeLessThan(2_000);

    // a name beside the crafted text survives it; an address in it never shows
    expect(find(inventory, 'plugin', 'review@northlight')).toMatchObject({ author: 'Northlight Studio' });
    expect(find(inventory, 'plugin', 'review@northlight')).not.toHaveProperty('homepage');
    const listed = (id: string) => catalog.plugins.find((plugin) => plugin.id === id);
    expect(listed('review@northlight')).toMatchObject({
      author: 'Northlight Studio',
      // a homepage past Core's bound is masked, so the repository speaks for it
      homepage: 'https://github.com/northlight-studio/review',
      held: 'review@northlight',
    });
    expect(listed('word@northlight')).toMatchObject({ author: 'Jane Doe' });
    for (const [id, name] of [
      ['angles@northlight', 'Figma Design <'],
      ['addresses@northlight', 'Northlight Studio (://'],
    ] as const) {
      const author = listed(id)?.author ?? '';
      expect(author.startsWith(name), id).toBe(true);
      expect(author.length, id).toBeLessThanOrEqual(256);
    }
    expect(listed('angles@northlight')).not.toHaveProperty('homepage');
    const [ask] = listed('bootstrap@northlight')?.asks ?? [];
    expect(ask?.kind).toBe('command');
    expect(ask?.kind === 'command' && ask.command.startsWith('curl (://') && ask.command.length <= 8_192).toBe(true);
    // Core masks an address past its bound whole; a repository that long is left out
    expect(catalog.marketplaces.map((marketplace) => [marketplace.id, marketplace.source ?? null])).toEqual([
      ['northlight', 'northlight-studio/plugins'],
      ['crafted-url', '•••'],
      ['crafted-repo', null],
    ]);
    expect(JSON.stringify({ inventory, catalog })).not.toContain('@northlight.example');
  });
});

describe('Claude Code installs and marketplaces', () => {
  const claude = createClaudeExtensionService({ executable: 'claude', env: {}, home: '/Users/test' });
  const work = actProfile('managed', '/profiles/work/claude');
  const native = actProfile('native-default', '/Users/test/.claude');
  /** A plugin as the runtime hands it for an install: from its catalog entry, always the root's own. */
  const installing = (id = 'lint@northlight'): PluginItem => ({
    kind: 'plugin',
    id,
    name: id.split('@')[0]!,
    origin: 'own',
    enabled: true,
    marketplace: 'northlight',
    version: '2.0.0',
  });
  const listing = (fields: Partial<CatalogPlugin> = {}): CatalogPlugin => ({
    id: 'lint@northlight',
    name: 'lint',
    marketplace: 'northlight',
    version: '2.0.0',
    ...fields,
  });
  const marketplace = (fields: Partial<MarketplaceItem> = {}): MarketplaceItem => ({
    kind: 'marketplace',
    id: 'northlight',
    name: 'northlight',
    origin: 'own',
    enabled: true,
    source: 'northlight-studio/plugins',
    ...fields,
  });

  it('declares where it adds a marketplace from, and lists plugins in catalogs but takes no source for one', () => {
    expect(claude.provider.support.marketplaces).toEqual({
      store: 'profile',
      changes: 'command',
      read: true,
      sources: 'A GitHub repository (owner/repo), a git address, a folder, or the address of a marketplace.json',
    });
    expect(claude.provider.support.plugins).toEqual({
      store: 'profile',
      changes: 'command',
      read: true,
      catalog: true,
    });
    expect(ExtensionProviderSchema.parse(claude.provider)).toEqual(claude.provider);
  });

  it("installs a plugin its catalog lists with Claude Code's own command at user scope, `-y` since no one answers it", () => {
    const argv = ['claude', 'plugin', 'install', 'lint@northlight', '--scope', 'user', '-y'];
    const plan = {
      target: { kind: 'plugin', id: 'lint@northlight' },
      act: 'install',
      available: true,
      display: 'claude plugin install lint@northlight --scope user -y',
    };
    expect(ExtensionActPlanSchema.parse(claude.plan!(work, installing(), 'install', { listed: listing() }))).toEqual({
      ...plan,
      runs: { kind: 'command', argv, env: { CLAUDE_CONFIG_DIR: '/profiles/work/claude' } },
      // a managed root's plugins are its own
      reaches: [],
    });
    // Grok loads every plugin the native default installs, in each of its profiles
    expect(ExtensionActPlanSchema.parse(claude.plan!(native, installing(), 'install', { listed: listing() }))).toEqual({
      ...plan,
      runs: { kind: 'command', argv },
      reaches: ['shared-folder'],
    });
    // a package npm fetches asks nothing at Claude Code's prompt
    const fetched = listing({ asks: [{ kind: 'fetch', command: 'npm install @northlight/lint' }] });
    expect(claude.plan!(work, installing(), 'install', { listed: fetched })).toMatchObject({
      available: true,
      runs: { kind: 'command', argv },
    });
    // planned without its entry, it still installs by the catalog's key
    expect(claude.plan!(work, installing(), 'install')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv },
    });
  });

  it('installs a plugin its marketplace fetches with a command in a terminal, where the person accepts that command', () => {
    const listed = listing({
      asks: [{ kind: 'command', command: 'curl -fsSL https://get.northlight.example/lint.sh' }],
    });
    // no `-y`: it would accept the command unseen
    const argv = ['claude', 'plugin', 'install', 'lint@northlight', '--scope', 'user'];
    expect(ExtensionActPlanSchema.parse(claude.plan!(work, installing(), 'install', { listed }))).toEqual({
      target: { kind: 'plugin', id: 'lint@northlight' },
      act: 'install',
      available: true,
      runs: { kind: 'terminal', argv, env: { CLAUDE_CONFIG_DIR: '/profiles/work/claude' } },
      display: 'claude plugin install lint@northlight --scope user',
      reaches: [],
    });
    expect(ExtensionActPlanSchema.parse(claude.plan!(native, installing(), 'install', { listed }))).toEqual({
      target: { kind: 'plugin', id: 'lint@northlight' },
      act: 'install',
      available: true,
      runs: { kind: 'terminal', argv },
      display: 'claude plugin install lint@northlight --scope user',
      reaches: ['shared-folder'],
    });
  });

  it('installs nothing from a source, and nothing its command would misread', () => {
    const source = './plugins/lint';
    const fromSource: PluginItem = { kind: 'plugin', id: source, name: source, origin: 'own', enabled: true };
    expect(claude.plan!(work, fromSource, 'install', { source, holds: ['review@northlight'] })).toEqual({
      target: { kind: 'plugin', id: source },
      act: 'install',
      available: false,
      reason: 'unsupported',
      message: 'Claude Code installs a plugin from a marketplace; `--plugin-dir` loads a folder for one session only',
    });
    for (const id of ['--scope', 'lint@north light', '.lint@northlight', '../lint@northlight']) {
      expect(claude.plan!(work, installing(id), 'install', { listed: listing({ id }) })).toEqual({
        target: { kind: 'plugin', id },
        act: 'install',
        available: false,
        reason: 'unsupported',
        message: "Claude Code's commands do not take this plugin's name",
      });
    }
  });

  it("adds, fetches and removes a marketplace with Claude Code's own commands, a removal taking its plugins", () => {
    const env = { CLAUDE_CONFIG_DIR: '/profiles/work/claude' };
    // an add is handed the marketplace named by its source, until Claude Code names it from its catalog
    const adding = (source: string) => marketplace({ id: source, name: source, source });
    const forms: Array<[ExtensionActKind, MarketplaceItem, string[], ExtensionReach[]]> = [
      [
        'add',
        adding('northlight-studio/extra'),
        ['claude', 'plugin', 'marketplace', 'add', 'northlight-studio/extra'],
        [],
      ],
      ['update', marketplace(), ['claude', 'plugin', 'marketplace', 'update', 'northlight'], []],
      ['remove', marketplace(), ['claude', 'plugin', 'marketplace', 'remove', 'northlight'], ['plugins']],
    ];
    for (const [act, item, argv, reaches] of forms) {
      expect(ExtensionActPlanSchema.parse(claude.plan!(work, item, act)), act).toEqual({
        target: { kind: 'marketplace', id: item.id },
        act,
        available: true,
        runs: { kind: 'command', argv, env },
        display: argv.join(' '),
        reaches,
      });
      // Grok lists the native default's marketplaces in every profile of its own
      const home = ExtensionActPlanSchema.parse(claude.plan!(native, item, act));
      expect(home, act).toMatchObject({
        available: true,
        runs: { kind: 'command', argv },
        reaches: [...reaches, 'shared-folder'],
      });
      expect(home, act).not.toHaveProperty('runs.env');
    }
    // a git address, a folder, the address of a marketplace.json: each one argument, as given
    for (const source of [
      'https://git.northlight.example/plugins.git#stable',
      '/Users/test/work/local-market',
      'https://northlight.example/marketplace.json',
    ]) {
      expect(claude.plan!(work, adding(source), 'add')).toMatchObject({
        available: true,
        runs: { kind: 'command', argv: ['claude', 'plugin', 'marketplace', 'add', source] },
      });
    }
    // Claude Code's own marketplace is the person's to fetch again or remove
    const official = marketplace({ id: 'claude-plugins-official', name: 'claude-plugins-official', origin: 'bundled' });
    expect(claude.plan!(work, official, 'update')).toMatchObject({
      available: true,
      display: 'claude plugin marketplace update claude-plugins-official',
    });
    expect(claude.plan!(work, official, 'remove')).toMatchObject({
      available: true,
      display: 'claude plugin marketplace remove claude-plugins-official',
      reaches: ['plugins'],
    });
  });

  it("leaves claude.ai's marketplaces to claude.ai, has no switch for one, and takes no name or source its command would misread", () => {
    const claudeai = marketplace({ id: 'acme-org', name: 'acme-org', origin: 'managed' });
    for (const act of ['update', 'remove'] as const) {
      expect(claude.plan!(work, claudeai, act)).toEqual({
        target: { kind: 'marketplace', id: 'acme-org' },
        act,
        available: false,
        reason: 'not-own',
        message: 'It comes with your Claude account, from claude.ai, and changes there',
      });
    }
    for (const act of ['enable', 'disable', 'purge', 'sign-in', 'sign-out', 'install'] as const) {
      expect(claude.plan!(work, marketplace(), act)).toEqual({
        target: { kind: 'marketplace', id: 'northlight' },
        act,
        available: false,
        reason: 'unsupported',
        message: 'Claude Code adds, fetches and removes a marketplace; it has no switch for one',
      });
    }
    for (const id of ['--all', 'north light', 'north\u0007light']) {
      expect(claude.plan!(work, marketplace({ id, name: id }), 'update')).toEqual({
        target: { kind: 'marketplace', id },
        act: 'update',
        available: false,
        reason: 'unsupported',
        message: "Claude Code's commands do not take this marketplace's name",
      });
    }
    const sourceless: MarketplaceItem = {
      kind: 'marketplace',
      id: 'extra',
      name: 'extra',
      origin: 'own',
      enabled: true,
    };
    for (const item of [
      sourceless,
      marketplace({ id: '--scope=project', name: '--scope=project', source: '--scope=project' }),
      marketplace({ id: 'x', name: 'x', source: 'https://me:secret@git.northlight.example/plugins.git' }),
      marketplace({ id: 'y', name: 'y', source: 'https://northlight.example/marketplace.json?token=x' }),
    ]) {
      expect(claude.plan!(work, item, 'add'), item.id).toEqual({
        target: { kind: 'marketplace', id: item.id },
        act: 'add',
        available: false,
        reason: 'unsupported',
        message: 'Claude Code adds a marketplace from a repository, a git address, a folder or an address',
      });
    }
  });

  it('installs, updates and purges nothing but a plugin', () => {
    const answers = (['install', 'update', 'purge'] as const).map((act) => claude.plan!(work, actServer(), act));
    expect(answers).toEqual([
      expect.objectContaining({
        available: false,
        reason: 'unsupported',
        message: 'Claude Code installs only plugins',
      }),
      expect.objectContaining({ available: false, reason: 'unsupported', message: 'Claude Code updates only plugins' }),
      expect.objectContaining({
        available: false,
        reason: 'unsupported',
        message: 'Claude Code removes only a plugin with its data',
      }),
    ]);
    expect(claude.plan!(work, actSkill(), 'install')).toMatchObject({ available: false, reason: 'unsupported' });
  });

  it('answers every act on every kind it may be handed, and never throws', () => {
    const items: ExtensionActItem[] = [
      installing(),
      { ...installing('toolkit@synced'), origin: 'managed' },
      marketplace(),
      marketplace({ id: 'claude-plugins-official', name: 'claude-plugins-official', origin: 'bundled' }),
      marketplace({ id: 'acme-org', name: 'acme-org', origin: 'managed' }),
      actServer(),
      actServer({ transport: 'stdio', target: 'npx x' }),
      actSkill({ location: '/profiles/work/claude/skills/release-notes' }),
    ];
    const options: ExtensionActPlanOptions[] = [
      {},
      { source: 'northlight-studio/lint', holds: [] },
      { listed: listing({ asks: [{ kind: 'command', command: 'curl -fsSL https://get.northlight.example/x.sh' }] }) },
      { keepIn: '/Users/test/kept/release-notes' },
    ];
    for (const profile of [work, native]) {
      for (const item of items) {
        for (const act of ExtensionActKindSchema.options) {
          for (const option of options) {
            const answer = ExtensionActPlanSchema.parse(claude.plan!(profile, item, act, option));
            expect(answer.target, `${item.kind} ${item.id} ${act}`).toEqual({ kind: item.kind, id: item.id });
            expect(answer.act).toBe(act);
          }
        }
      }
    }
  });

  it('plans an install from the entry its own catalog read found', async () => {
    const home = await tempHome();
    const root = join(home, 'work');
    await knowing(root, {
      name: 'northlight',
      plugins: [
        { name: 'lint', source: './lint' },
        {
          name: 'bootstrap',
          source: { source: 'command', command: ['curl', '-fsSL', 'https://get.northlight.example/plugin.sh'] },
        },
      ],
    });
    const service = createClaudeExtensionService({ executable: 'claude', env: {}, home, now });
    const profile = managedProfile(root);
    const catalog = ExtensionCatalogSchema.parse(await service.catalog!(profile));
    expect(catalog.plugins[1]).toMatchObject({
      asks: [{ kind: 'command', command: 'curl -fsSL https://get.northlight.example/plugin.sh' }],
    });
    const runs = catalog.plugins.map((listed) => {
      const item: PluginItem = {
        kind: 'plugin',
        id: listed.id,
        name: listed.name,
        origin: 'own',
        enabled: true,
        marketplace: listed.marketplace,
      };
      const plan = service.plan!(profile, item, 'install', { listed });
      return plan.available ? `${plan.runs.kind}: ${plan.display}` : plan.reason;
    });
    expect(runs).toEqual([
      'command: claude plugin install lint@northlight --scope user -y',
      'terminal: claude plugin install bootstrap@northlight --scope user',
    ]);
  });
});
