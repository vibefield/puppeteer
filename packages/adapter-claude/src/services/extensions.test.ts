import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  describeMcpDefinition,
  ExtensionActPlanSchema,
  ExtensionInventorySchema,
  McpServerDefinitionSchema,
  type ExtensionActKind,
  type ExtensionInventory,
  type ExtensionItem,
  type McpServerDefinition,
  type McpServerItem,
  type SkillItem,
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
      update: ['claude', 'plugin', 'update', 'review@northlight', '--scope', 'user'],
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
