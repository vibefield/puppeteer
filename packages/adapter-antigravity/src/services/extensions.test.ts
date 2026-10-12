import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  describeMcpDefinition,
  ExtensionActKindSchema,
  ExtensionActPlanSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type ExtensionActItem,
  type ExtensionActKind,
  type ExtensionInventory,
  type ExtensionItem,
  type MarketplaceItem,
  type McpServerDefinition,
  type McpServerItem,
  type PluginItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
import { createAntigravityExtensionService } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'antigravity-extensions-')));
  made.push(dir);
  return dir;
}

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const managedProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'work-antigravity',
    provider: 'antigravity',
    label: 'Work',
    kind: 'managed',
    dataRoot: home,
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const nativeProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'antigravity:native-default',
    provider: 'antigravity',
    label: 'Default',
    kind: 'native-default',
    dataRoot: join(home, '.gemini', 'antigravity-cli'),
    createdAt: '1970-01-01T00:00:00.000Z',
  });

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);

/** A home as 1.2.11 lays it out, with a literal secret everywhere Antigravity lets one sit. */
async function populate(home: string): Promise<{ library: string }> {
  const config = join(home, '.gemini', 'config');
  await write(join(config, 'config.json'), {
    userSettings: { theme: 'dark' },
    plugins: { review: { enabled: false }, 'dropped-in': { enabled: true } },
  });
  await write(
    join(config, 'mcp_config.json'),
    [
      '{',
      '  // the person’s servers',
      '  "mcpServers": {',
      '    "github": {',
      '      "command": "docker",',
      '      "args": ["run", "-i", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_literalsecret", "ghcr.io/github/github-mcp-server"],',
      '      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_literalsecret", },',
      '    },',
      '    "linear": { "serverUrl": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_api_literal" } },',
      '    /* switched off, with a fixed OAuth client */',
      '    "sentry": {',
      '      "serverUrl": "https://mcp.sentry.dev/mcp",',
      '      "disabled": true,',
      '      "oauth": { "clientId": "sentry-client", "clientSecret": "oauth-client-secret" },',
      '    },',
      '    "stub": { "disabled": true },',
      '    "notes // not a comment": { "command": "echo", "args": ["//still-a-string", "/* also */"] },',
      '  },',
      '}',
    ].join('\n'),
  );

  const review = join(config, 'plugins', 'review');
  await write(join(review, 'plugin.json'), {
    name: 'review',
    version: '1.2.0',
    description: 'Reviews against the house style',
  });
  await write(
    join(review, 'mcp_config.json'),
    '{ "mcpServers": { "house": { "serverUrl": "https://mcp.northlight.studio/house?key=abc123", "headers": { "Authorization": "Bearer plugin-secret" } }, }, }',
  );
  await write(join(review, 'mcp.json'), { mcpServers: { ignored: { command: 'never-read' } } });
  await write(join(review, 'skills', 'house-style', 'SKILL.md'), skill('review:house-style', 'Northlight naming'));
  await write(join(config, 'plugins', 'quiet', 'plugin.json'), { name: 'quiet', disabled: true });
  await write(join(config, 'plugins', 'quiet', 'skills', 'hush', 'SKILL.md'), skill('hush', 'Stays off'));
  // Copied in by hand under another folder name: no import row, no name, still loaded.
  await write(join(config, 'plugins', 'dropped-in', 'plugin.json'), {});
  await write(join(config, 'plugins', 'not-a-plugin', 'README.md'), '# no manifest');
  await write(join(config, 'plugins', 'broken', 'plugin.json'), '{ nope');

  await write(
    join(config, 'skills', 'release-notes', 'SKILL.md'),
    skill('release-notes', 'Drafts release notes from merged pull requests'),
  );
  await write(join(config, 'skills', '.hidden', 'SKILL.md'), skill('hidden', 'never listed'));
  const library = join(home, 'library', 'changelog');
  await write(join(library, 'SKILL.md'), skill('changelog', 'Writes the changelog entry'));
  await symlink(library, join(config, 'skills', 'changelog'));

  const cli = join(home, '.gemini', 'antigravity-cli');
  await write(join(cli, 'builtin', 'skills', 'automation', 'SKILL.md'), skill('automation', 'Automates the desktop'));
  await write(join(cli, 'settings.json'), { trustedWorkspaces: ['/Users/test/billing'] });
  // Credential stores a read must never open: their contents would surface if it did.
  await write(join(cli, 'antigravity-oauth-token'), { token: { access_token: 'ya29.cli-access-token' } });
  await write(join(home, '.gemini', 'antigravity', 'mcp_oauth_tokens.json'), { sentry: 'mcp-oauth-access-token' });
  return { library };
}

describe('Antigravity extensions', () => {
  it('declares the kinds Antigravity has and which it reads', () => {
    const { provider } = createAntigravityExtensionService({ home: '/nonexistent' });
    expect(ExtensionProviderSchema.parse(provider)).toEqual({
      id: 'antigravity',
      label: 'Antigravity',
      support: {
        plugins: {
          store: 'profile',
          changes: 'command',
          read: true,
          sources: 'A folder on this Mac, or a GitHub repository',
        },
        // Its marketplaces are the app's, behind a flag its account is served: no command reaches them.
        marketplaces: { store: 'profile', changes: 'in-app', read: false },
        mcpServers: { store: 'profile', changes: 'command', read: true },
        skills: { store: 'profile', changes: 'folder', read: true },
      },
    });
  });

  it('reads a managed home: plugins with what they bring, the person’s servers and skills, the builtins, and no secret', async () => {
    const home = await tempHome();
    const { library } = await populate(home);
    const inventory = ExtensionInventorySchema.parse(
      await createAntigravityExtensionService({ home: '/nonexistent', now }).inventory(managedProfile(home)),
    );

    const document = JSON.stringify(inventory);
    for (const secret of [
      'ghp_literalsecret',
      'lin_api_literal',
      'oauth-client-secret',
      'sentry-client',
      'abc123',
      'plugin-secret',
      'ya29.cli-access-token',
      'mcp-oauth-access-token',
    ]) {
      expect(document).not.toContain(secret);
    }
    expect(inventory).toMatchObject({
      provider: 'antigravity',
      profileId: 'work-antigravity',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'experimental' },
    });
    expect(inventory.unread).toBeUndefined();

    const config = join(home, '.gemini', 'config');
    expect(find(inventory, 'plugin', 'review')).toEqual({
      kind: 'plugin',
      id: 'review',
      name: 'review',
      origin: 'own',
      enabled: false,
      location: join(config, 'plugins', 'review'),
      version: '1.2.0',
      description: 'Reviews against the house style',
    });
    expect(find(inventory, 'plugin', 'quiet')).toMatchObject({ enabled: false });
    expect(find(inventory, 'plugin', 'dropped-in')).toMatchObject({ name: 'dropped-in', enabled: true });
    expect(inventory.items.filter((item) => item.kind === 'plugin').map((item) => item.id)).toEqual([
      'dropped-in',
      'quiet',
      'review',
    ]);

    expect(find(inventory, 'mcp-server', 'github')).toEqual({
      kind: 'mcp-server',
      id: 'github',
      name: 'github',
      origin: 'own',
      enabled: true,
      location: join(config, 'mcp_config.json'),
      transport: 'stdio',
      target: 'docker run -i -e GITHUB_PERSONAL_ACCESS_TOKEN=••• ghcr.io/github/github-mcp-server',
      env: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    });
    expect(find(inventory, 'mcp-server', 'linear')).toMatchObject({
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      headers: ['Authorization'],
    });
    expect(find(inventory, 'mcp-server', 'sentry')).toMatchObject({ enabled: false, transport: 'http' });
    expect(find(inventory, 'mcp-server', 'stub')).toBeUndefined();
    expect(find(inventory, 'mcp-server', 'notes // not a comment')).toMatchObject({
      target: 'echo //still-a-string "/* also */"',
    });
    expect(find(inventory, 'mcp-server', 'plugin:review:house')).toMatchObject({
      name: 'house',
      origin: 'plugin',
      plugin: 'review',
      enabled: false,
      target: 'https://mcp.northlight.studio/house?•••',
      headers: ['Authorization'],
      location: join(config, 'plugins', 'review', 'mcp_config.json'),
    });
    expect(inventory.items.some((item) => item.name === 'ignored')).toBe(false);

    expect(find(inventory, 'skill', 'release-notes')).toEqual({
      kind: 'skill',
      id: 'release-notes',
      name: 'release-notes',
      origin: 'own',
      enabled: true,
      location: join(config, 'skills', 'release-notes'),
      description: 'Drafts release notes from merged pull requests',
    });
    expect(find(inventory, 'skill', 'changelog')).toMatchObject({ linkTarget: library });
    expect(find(inventory, 'skill', 'plugin:review:house-style')).toMatchObject({
      name: 'house-style',
      origin: 'plugin',
      plugin: 'review',
      enabled: false,
    });
    expect(find(inventory, 'skill', 'plugin:quiet:hush')).toMatchObject({ enabled: false });
    expect(find(inventory, 'skill', 'builtin:automation')).toMatchObject({ origin: 'bundled', enabled: true });
    expect(inventory.items.some((item) => item.name === 'hidden')).toBe(false);
  });

  it('reads the native default from the home it was given, and a managed home only from its own', async () => {
    const home = await tempHome();
    await populate(home);
    const service = createAntigravityExtensionService({ home, now });
    const native = ExtensionInventorySchema.parse(await service.inventory(nativeProfile(home)));
    expect(native.profileId).toBe('antigravity:native-default');
    expect(find(native, 'mcp-server', 'github')).toBeDefined();

    const work = join(home, 'profiles', 'work', 'antigravity-3c1f');
    await write(join(work, '.gemini', 'config', 'mcp_config.json'), {
      mcpServers: { 'work-only': { serverUrl: 'https://work.example.com/sse', type: 'sse' } },
    });
    const managed = ExtensionInventorySchema.parse(await service.inventory(managedProfile(work)));
    expect(managed.items.map((item) => item.id)).toEqual(['work-only']);
    expect(managed.items[0]).toMatchObject({ transport: 'sse', target: 'https://work.example.com/sse' });
  });

  it('says which store it could not read and lists the rest', async () => {
    const home = await tempHome();
    const config = join(home, '.gemini', 'config');
    await write(join(config, 'config.json'), 'not json');
    await write(join(config, 'mcp_config.json'), '{ "mcpServers": { "db": { "env": { "PGPASSWORD": "hunter2" ');
    await write(join(config, 'plugins', 'quiet', 'plugin.json'), { name: 'quiet', disabled: true });
    await write(join(config, 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
    await write(join(config, 'skills.json'), { entries: [{ path: '~/personal-skills' }] });

    const inventory = ExtensionInventorySchema.parse(
      await createAntigravityExtensionService({ home: '/nonexistent', now }).inventory(managedProfile(home)),
    );
    expect(JSON.stringify(inventory)).not.toContain('hunter2');
    expect(inventory.unread).toEqual([
      { kind: 'plugin', message: 'config.json could not be read' },
      { kind: 'mcp-server', message: 'mcp_config.json could not be read' },
      { kind: 'skill', message: 'skills.json names more skill folders, which are not read' },
    ]);
    // Without the switches, a plugin falls back to its manifest.
    expect(find(inventory, 'plugin', 'quiet')).toMatchObject({ enabled: false });
    expect(inventory.items.map((item) => item.id)).toEqual(['quiet', 'release-notes']);
  });

  it('reads an empty home as holding nothing', async () => {
    const home = await tempHome();
    const inventory = ExtensionInventorySchema.parse(
      await createAntigravityExtensionService({ home: '/nonexistent', now }).inventory(
        managedProfile(join(home, 'fresh')),
      ),
    );
    expect(inventory.items).toEqual([]);
    expect(inventory.unread).toBeUndefined();
  });

  it('gives a server of the person’s own its definition when nothing in it was hidden, and a plugin’s server none', async () => {
    const home = await tempHome();
    const config = join(home, '.gemini', 'config');
    await write(join(config, 'mcp_config.json'), {
      mcpServers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env: { CONTEXT7_API_KEY: 'ctx7sk-literal-secret' },
        },
        deepwiki: { serverUrl: 'https://mcp.deepwiki.com/mcp' },
        events: { serverUrl: 'https://events.example.com/sse', type: 'sse' },
        linear: { serverUrl: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_api_literal' } },
        sentry: {
          serverUrl: 'https://mcp.sentry.dev/mcp',
          oauth: { clientId: 'sentry-client', clientSecret: 'oauth-client-secret' },
        },
        bigquery: { serverUrl: 'https://bigquery.googleapis.com/mcp', authProviderType: 'google_credentials' },
        notes: { command: 'node', args: ['server.js'], cwd: '/Users/test/notes-server' },
        github: {
          command: 'docker',
          args: [
            'run',
            '-i',
            '-e',
            'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_literalsecret',
            'ghcr.io/github/github-mcp-server',
          ],
        },
      },
    });
    await write(join(config, 'plugins', 'review', 'plugin.json'), { name: 'review' });
    await write(join(config, 'plugins', 'review', 'mcp_config.json'), {
      mcpServers: { house: { serverUrl: 'https://mcp.northlight.studio/house' } },
    });

    const inventory = ExtensionInventorySchema.parse(
      await createAntigravityExtensionService({ home: '/nonexistent', now }).inventory(managedProfile(home)),
    );
    const document = JSON.stringify(inventory);
    for (const secret of ['ctx7sk-literal-secret', 'lin_api_literal', 'oauth-client-secret', 'ghp_literalsecret']) {
      expect(document).not.toContain(secret);
    }
    const definition = (id: string) => {
      const server = find(inventory, 'mcp-server', id);
      expect(server, id).toBeDefined();
      return (server as McpServerItem).definition;
    };
    // The names the server reads travel; their literal values stay in Antigravity's file.
    expect(definition('context7')).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: ['CONTEXT7_API_KEY'],
    });
    expect(definition('deepwiki')).toEqual({ transport: 'http', url: 'https://mcp.deepwiki.com/mcp' });
    expect(definition('events')).toEqual({ transport: 'sse', url: 'https://events.example.com/sse' });
    // A header, an OAuth client, Google credentials, a working folder, anything masked, and a plugin's server stay behind.
    for (const id of ['linear', 'sentry', 'bigquery', 'notes', 'github', 'plugin:review:house']) {
      expect(definition(id), id).toBeUndefined();
    }
  });
});

// ── acts (RFC 006 C2) ──

const actProfile = (kind: 'managed' | 'native-default', dataRoot: string) =>
  ({
    id: kind === 'managed' ? 'work-antigravity' : 'antigravity:native-default',
    provider: 'antigravity',
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
    location: '/profiles/work/antigravity/.gemini/config/plugins/review',
    ...fields,
  }) as never;
/** A server to add, as the runtime gives it: the server as Antigravity would hold it once added. */
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

describe('Antigravity extension acts', () => {
  const agy = createAntigravityExtensionService({ executable: 'agy', env: {}, home: '/Users/test' });
  it("switches a server of the home's own under the profile's HOME, and offers no removal it has not probed", () => {
    expect(agy.plan!(actProfile('managed', '/profiles/work/antigravity'), actServer(), 'enable')).toMatchObject({
      available: true,
      runs: {
        kind: 'command',
        argv: ['agy', 'mcp', 'enable', 'linear'],
        env: { HOME: '/profiles/work/antigravity', PUPPETEER_ANTIGRAVITY_HOME: '/profiles/work/antigravity' },
      },
      reaches: [],
    });
    const native = agy.plan!(actProfile('native-default', '/Users/test'), actServer(), 'disable');
    expect(native).toMatchObject({ available: true, runs: { argv: ['agy', 'mcp', 'disable', 'linear'] } });
    expect((native as { runs: { env?: unknown } }).runs.env).toBeUndefined();
    expect(agy.plan!(actProfile('managed', '/p'), actServer(), 'remove')).toMatchObject({ available: false });
    expect(agy.plan!(actProfile('managed', '/p'), actSkill(), 'disable')).toMatchObject({
      available: false,
      reason: 'in-app',
    });
    expect(agy.plan!(actProfile('managed', '/p'), actServer(), 'sign-in')).toMatchObject({
      available: false,
      reason: 'in-app',
      message: 'Antigravity signs in to a server only in its /mcp panel',
    });
  });

  it("adds a server with its own add under the profile's HOME, the command line after `--`", () => {
    const plan = agy.plan!(
      actProfile('managed', '/profiles/work/antigravity'),
      added({ transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp', '--transport', 'stdio'] }),
      'add',
    );
    expect(ExtensionActPlanSchema.parse(plan)).toEqual({
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      available: true,
      runs: {
        kind: 'command',
        argv: ['agy', 'mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp', '--transport', 'stdio'],
        env: { HOME: '/profiles/work/antigravity', PUPPETEER_ANTIGRAVITY_HOME: '/profiles/work/antigravity' },
      },
      display: 'agy mcp add context7 -- npx -y @upstash/context7-mcp --transport stdio',
      reaches: [],
    });
    const http = agy.plan!(
      actProfile('native-default', '/Users/test'),
      added({ transport: 'http', url: 'https://mcp.linear.app/mcp' }, 'linear'),
      'add',
    );
    expect(http).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['agy', 'mcp', 'add', 'linear', 'https://mcp.linear.app/mcp'] },
      display: 'agy mcp add linear https://mcp.linear.app/mcp',
      reaches: [],
    });
    expect((http as { runs: { env?: unknown } }).runs.env).toBeUndefined();
  });

  it('adds no server that reads a variable, since Antigravity keeps only literal values, and none over SSE', () => {
    const work = actProfile('managed', '/profiles/work/antigravity');
    expect(
      agy.plan!(
        work,
        added({
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env: ['CONTEXT7_API_KEY'],
        }),
        'add',
      ),
    ).toEqual({
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      available: false,
      reason: 'unsupported',
      message: "Antigravity reads a server's values only from its own file, never from a variable",
    });
    expect(
      agy.plan!(work, added({ transport: 'sse', url: 'https://events.example.com/sse' }, 'events'), 'add'),
    ).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Antigravity adds a remote server by its command only as Streamable HTTP',
    });
    // Antigravity's add would take any other address for a command.
    expect(agy.plan!(work, added({ transport: 'http', url: 'mcp.example.com/mcp' }, 'bare'), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
    });
  });

  it('adds only a server with a definition, under a name its command takes', () => {
    const work = actProfile('managed', '/profiles/work/antigravity');
    const linear: McpServerDefinition = { transport: 'http', url: 'https://mcp.linear.app/mcp' };
    for (const name of ['--version', 'my server']) {
      expect(agy.plan!(work, added(linear, name), 'add'), name).toMatchObject({
        available: false,
        reason: 'no-command',
        message: "Antigravity's commands do not take this server's name",
      });
    }
    expect(agy.plan!(work, actServer(), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Antigravity adds only a server, from its definition',
    });
    expect(agy.plan!(work, actSkill(), 'add')).toMatchObject({ available: false, reason: 'unsupported' });
  });

  it("switches and uninstalls a plugin of the home's own under the profile's HOME, by the name the read found", () => {
    const work = actProfile('managed', '/profiles/work/antigravity');
    const commands: Array<[ExtensionActKind, string[]]> = [
      ['enable', ['agy', 'plugin', 'enable', 'review']],
      ['disable', ['agy', 'plugin', 'disable', 'review']],
      ['remove', ['agy', 'plugin', 'uninstall', 'review']],
    ];
    for (const [act, argv] of commands) {
      expect(ExtensionActPlanSchema.parse(agy.plan!(work, actPlugin(), act)), act).toEqual({
        target: { kind: 'plugin', id: 'review' },
        act,
        available: true,
        runs: {
          kind: 'command',
          argv,
          env: { HOME: '/profiles/work/antigravity', PUPPETEER_ANTIGRAVITY_HOME: '/profiles/work/antigravity' },
        },
        display: argv.join(' '),
        reaches: [],
      });
    }
    const native = agy.plan!(
      actProfile('native-default', '/Users/test'),
      actPlugin({ location: '/Users/test/.gemini/config/plugins/review' }),
      'remove',
    );
    expect(native).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['agy', 'plugin', 'uninstall', 'review'] },
    });
    expect((native as { runs: { env?: unknown } }).runs.env).toBeUndefined();
  });

  it('offers no purge or update, which Antigravity has no command for, and no name its commands cannot take', () => {
    const work = actProfile('managed', '/profiles/work/antigravity');
    expect(agy.plan!(work, actPlugin(), 'purge')).toEqual({
      target: { kind: 'plugin', id: 'review' },
      act: 'purge',
      available: false,
      reason: 'unsupported',
      message: 'Antigravity keeps a plugin in one folder, which its uninstall takes whole',
    });
    expect(agy.plan!(work, actPlugin(), 'update')).toEqual({
      target: { kind: 'plugin', id: 'review' },
      act: 'update',
      available: false,
      reason: 'no-command',
      message: 'Antigravity has no command that updates a plugin: install it again from its source',
    });
    // A name `agy plugin validate` accepts can still read as a flag.
    for (const id of ['--help', '-v']) {
      const flagged = actPlugin({ id, name: id, location: `/profiles/work/antigravity/.gemini/config/plugins/${id}` });
      expect(agy.plan!(work, flagged, 'disable'), id).toMatchObject({
        available: false,
        reason: 'no-command',
        message: "Antigravity's commands do not take this plugin's name",
      });
    }
    expect(agy.plan!(work, actPlugin(), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Antigravity installs a plugin from its source',
    });
    for (const act of ['sign-in', 'sign-out'] as const) {
      expect(agy.plan!(work, actPlugin(), act), act).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Antigravity has no sign-in for a plugin',
      });
    }
    expect(agy.plan!(work, actPlugin({ origin: 'managed' }), 'disable')).toMatchObject({
      available: false,
      reason: 'not-own',
      message: "Antigravity's app or your organization adds it, and changes it",
    });
    // Never `agy mcp update`: an update, and a removal that takes the data, are a plugin's alone.
    expect(agy.plan!(work, actServer(), 'update')).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'update',
      available: false,
      reason: 'unsupported',
      message: 'Only a plugin is updated',
    });
    expect(agy.plan!(work, actSkill(), 'purge')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Only a plugin is removed with its data',
    });
  });

  it('uninstalls only a plugin whose folder has its name, since the uninstall takes the folder by that name', () => {
    const work = actProfile('managed', '/profiles/work/antigravity');
    const copied = actPlugin({
      id: 'other',
      name: 'other',
      location: '/profiles/work/antigravity/.gemini/config/plugins/dropped-in',
    });
    expect(agy.plan!(work, copied, 'remove')).toEqual({
      target: { kind: 'plugin', id: 'other' },
      act: 'remove',
      available: false,
      reason: 'no-command',
      message: "Antigravity uninstalls a plugin by its folder's name, and this plugin's folder is named otherwise",
    });
    // Its switch is keyed by its name, as the read finds it on or off.
    expect(agy.plan!(work, copied, 'disable')).toMatchObject({
      available: true,
      runs: { argv: ['agy', 'plugin', 'disable', 'other'] },
    });
  });
});

describe('Antigravity plugins described', () => {
  it('says who made a plugin, its homepage and what it brings, by name only, with no key or email', async () => {
    const home = await tempHome();
    const config = join(home, '.gemini', 'config');
    const review = join(config, 'plugins', 'review');
    await write(join(review, 'plugin.json'), {
      name: 'review',
      author: { name: 'Northlight', email: 'dev@northlight.studio' },
      homepage: 'https://northlight.studio/review?utm_source=agy&key=abc123',
    });
    await write(join(review, 'commands', 'review.md'), '# Review');
    await write(join(review, 'commands', 'review.toml'), 'prompt = "Review"');
    await write(join(review, 'commands', 'triage.md'), '# Triage');
    await write(join(review, 'commands', '.DS_Store'), '');
    await write(join(review, 'commands', 'nested', 'deep.md'), '# one folder down');
    await write(join(review, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\n');
    // Antigravity keys a hook by its name, with the events it runs on inside.
    await write(join(review, 'hooks.json'), {
      'house-rules': {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'check --token ${SECRET_TOKEN}' }] }],
        Stop: [{ type: 'command', command: 'notify' }],
        enabled: true,
      },
      PostToolUse: [{ type: 'command', command: 'log' }],
      description: 'House checks',
    });
    await write(join(config, 'plugins', 'quiet', 'plugin.json'), {
      name: 'quiet',
      author: 'ops@example.com',
      repository: 'https://github.com/northlight/quiet',
    });
    // Copied in by hand under a folder of another name: described alike, and not uninstalled by its name.
    await write(join(config, 'plugins', 'dropped-in', 'plugin.json'), { name: 'other' });
    await write(join(config, 'plugins', 'dropped-in', 'agents', 'helper.md'), '# Helper');

    const service = createAntigravityExtensionService({ executable: 'agy', env: {}, home: '/nonexistent', now });
    const work = managedProfile(home);
    const inventory = ExtensionInventorySchema.parse(await service.inventory(work));
    const document = JSON.stringify(inventory);
    for (const hidden of ['dev@northlight.studio', 'utm_source', 'abc123', 'ops@example.com', 'SECRET_TOKEN']) {
      expect(document).not.toContain(hidden);
    }
    const plugin = (id: string): PluginItem => {
      const item = find(inventory, 'plugin', id);
      expect(item, id).toMatchObject({ kind: 'plugin' });
      return item as PluginItem;
    };
    expect(plugin('review')).toMatchObject({
      author: 'Northlight',
      homepage: 'https://northlight.studio/review?•••',
      brings: { commands: ['review', 'triage'], agents: ['reviewer'], hooks: ['PostToolUse', 'PreToolUse', 'Stop'] },
    });
    expect(plugin('quiet')).toMatchObject({ homepage: 'https://github.com/northlight/quiet' });
    for (const field of ['author', 'brings']) expect(plugin('quiet')).not.toHaveProperty(field);
    expect(plugin('other')).toMatchObject({
      location: join(config, 'plugins', 'dropped-in'),
      brings: { agents: ['helper'] },
    });

    // An act plans from the item as the read found it.
    expect(service.plan!(work, plugin('review'), 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['agy', 'plugin', 'uninstall', 'review'], env: { HOME: home } },
    });
    expect(service.plan!(work, plugin('other'), 'remove')).toMatchObject({ available: false, reason: 'no-command' });
    expect(service.plan!(work, plugin('other'), 'enable')).toMatchObject({
      available: true,
      runs: { argv: ['agy', 'plugin', 'enable', 'other'] },
    });
  });
});

describe('Antigravity skills placed', () => {
  it("links a kept skill into the bound home's .gemini/config/skills, and refuses one it cannot place", async () => {
    const home = await tempHome();
    const work = join(home, 'profiles', 'work', 'antigravity-3c1f');
    const kept = join(home, 'kept', 'release-notes');
    const service = createAntigravityExtensionService({ executable: 'agy', env: {}, home, now });
    expect(
      ExtensionActPlanSchema.parse(service.plan!(managedProfile(work), actSkill({ linkTarget: kept }), 'add')),
    ).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: true,
      runs: {
        kind: 'files',
        steps: [{ op: 'link', path: join(work, '.gemini', 'config', 'skills', 'release-notes'), target: kept }],
      },
      display: 'link ~/kept/release-notes → ~/profiles/work/antigravity-3c1f/.gemini/config/skills/release-notes',
      reaches: [],
    });
    // The native default's is the process home's, whatever root the profile carries.
    expect(service.plan!(nativeProfile(home), actSkill({ linkTarget: kept }), 'add')).toMatchObject({
      available: true,
      runs: { steps: [{ op: 'link', path: join(home, '.gemini', 'config', 'skills', 'release-notes'), target: kept }] },
      display: 'link ~/kept/release-notes → ~/.gemini/config/skills/release-notes',
    });
    // No folder to link, or a name that is not one folder Antigravity lists.
    for (const fields of [{}, { id: '../escape', linkTarget: kept }, { id: '.hidden', linkTarget: kept }]) {
      expect(service.plan!(managedProfile(work), actSkill(fields), 'add'), JSON.stringify(fields)).toMatchObject({
        available: false,
        reason: 'unsupported',
      });
    }
  });

  it("takes away a link, or moves the person's own folder to where the host keeps it, and never a builtin or a plugin's", async () => {
    const home = await tempHome();
    const { library } = await populate(home);
    const service = createAntigravityExtensionService({ executable: 'agy', env: {}, home, now });
    const work = managedProfile(home);
    const inventory = ExtensionInventorySchema.parse(await service.inventory(work));
    const held = (id: string): SkillItem => {
      const item = find(inventory, 'skill', id);
      expect(item, id).toBeDefined();
      return item as SkillItem;
    };
    const skills = join(home, '.gemini', 'config', 'skills');
    const kept = join(home, 'kept', 'release-notes');
    expect(held('changelog')).toMatchObject({ origin: 'own', linkTarget: library });

    // A link goes, even with somewhere to keep it: the folder it points to stays where it is.
    expect(
      ExtensionActPlanSchema.parse(
        service.plan!(work, held('changelog'), 'remove', { keepIn: join(home, 'kept', 'changelog') }),
      ),
    ).toEqual({
      target: { kind: 'skill', id: 'changelog' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: join(skills, 'changelog') }] },
      display: 'unlink ~/.gemini/config/skills/changelog',
      reaches: [],
    });
    // The person's own folder moves to where the host keeps it; with nowhere to keep it, it stays.
    expect(
      ExtensionActPlanSchema.parse(service.plan!(work, held('release-notes'), 'remove', { keepIn: kept })),
    ).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'move', from: join(skills, 'release-notes'), to: kept }] },
      display: 'move ~/.gemini/config/skills/release-notes → ~/kept/release-notes',
      reaches: [],
    });
    expect(service.plan!(work, held('release-notes'), 'remove')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
    // What ships with Antigravity or comes with a plugin changes there.
    expect(service.plan!(work, held('builtin:automation'), 'remove', { keepIn: kept })).toMatchObject({
      available: false,
      reason: 'not-own',
      message: 'It ships with Antigravity',
    });
    expect(service.plan!(work, held('plugin:review:house-style'), 'remove', { keepIn: kept })).toMatchObject({
      available: false,
      reason: 'not-own',
      message: 'It comes with the review plugin and changes with it',
    });
    // Placed or not, a skill switches only inside the app.
    expect(service.plan!(work, held('changelog'), 'disable')).toMatchObject({ available: false, reason: 'in-app' });
  });
});

// ── installs and marketplaces (RFC 006 C2) ──

/** A plugin as the runtime hands an install from a source to the adapter: named by the source a person gave. */
const sourced = (source: string): PluginItem => ({
  kind: 'plugin',
  id: source,
  name: source,
  origin: 'own',
  enabled: true,
});

describe('Antigravity plugin installs', () => {
  const agy = createAntigravityExtensionService({ executable: 'agy', env: {}, home: '/Users/test' });
  const work = actProfile('managed', '/profiles/work/antigravity');
  const native = actProfile('native-default', '/Users/test/.gemini/antigravity-cli');
  const install = (source: string, holds: readonly string[] = [], profile = work) =>
    ExtensionActPlanSchema.parse(agy.plan!(profile, sourced(source), 'install', { source, holds }));
  const marketplace: MarketplaceItem = {
    kind: 'marketplace',
    id: 'agent-marketplace',
    name: 'Agent Marketplace',
    origin: 'managed',
    enabled: true,
  };

  it("installs from a folder or a GitHub repository with its own install, under the profile's HOME", () => {
    expect(install('/Users/test/code/review')).toEqual({
      target: { kind: 'plugin', id: '/Users/test/code/review' },
      act: 'install',
      available: true,
      runs: {
        kind: 'command',
        argv: ['agy', 'plugin', 'install', '/Users/test/code/review'],
        env: { HOME: '/profiles/work/antigravity', PUPPETEER_ANTIGRAVITY_HOME: '/profiles/work/antigravity' },
      },
      display: 'agy plugin install /Users/test/code/review',
      reaches: [],
    });
    // `~/` is the person's home, never the profile's HOME: the command is given the whole path.
    expect(install('~/code/review')).toMatchObject({
      target: { kind: 'plugin', id: '~/code/review' },
      available: true,
      runs: { kind: 'command', argv: ['agy', 'plugin', 'install', '/Users/test/code/review'] },
      display: 'agy plugin install /Users/test/code/review',
    });
    for (const source of [
      'https://github.com/northlight/review',
      'https://github.com/northlight/review.git',
      'https://github.com/northlight/review/',
      'https://github.com/northlight/agy-plugins/tree/main/plugins/review',
      'https://github.com/north-light/review.plugin/tree/v1.2.0',
      // A Gemini CLI extension, and another profile's copy of a plugin, are folders like any other.
      '/Users/test/.gemini/extensions/review',
      '/Users/test/.gemini/config/plugins/review',
    ]) {
      expect(install(source), source).toMatchObject({
        target: { kind: 'plugin', id: source },
        available: true,
        runs: { kind: 'command', argv: ['agy', 'plugin', 'install', source] },
        reaches: [],
      });
    }
    // The native default runs under the process's own home.
    const nativePlan = install('https://github.com/northlight/review', [], native);
    expect(nativePlan).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['agy', 'plugin', 'install', 'https://github.com/northlight/review'] },
    });
    expect((nativePlan as { runs: { env?: unknown } }).runs.env).toBeUndefined();
  });

  it('refuses a source Antigravity would not take as given', () => {
    const generic = 'Antigravity installs a plugin from a folder on this Mac or a GitHub repository';
    const whole = "Give the folder's whole path, with no `.` or `..` in it and no `/` at its end";
    const at = "Antigravity reads `@` in a source as a marketplace's plugin: give a folder whose path has none";
    const own = "This is Antigravity's own folder: give the folder the plugin came from";
    const refusals: Array<[source: string, message: string, profile?: typeof work]> = [
      ['review', generic],
      ['./code/review', generic],
      ['code/review', generic],
      ['~', generic],
      ['~other/review', generic],
      ['northlight/review', generic],
      ['github:northlight/review', generic],
      ['git@github.com:northlight/review.git', generic],
      ['http://github.com/northlight/review', generic],
      ['https://www.github.com/northlight/review', generic],
      ['https://gitlab.com/northlight/review', generic],
      ['https://github.com:443/northlight/review', generic],
      ['https://github.com/northlight', generic],
      ['https://github.com/northlight/review/blob/main/plugin.json', generic],
      ['https://github.com/northlight/..', generic],
      ['https://github.com/northlight/review/tree/main/../secrets', generic],
      ['https://github.com/northlight/review/tree/main//plugins', generic],
      // What the runtime already refuses stays refused here: a flag, a sign-in, a query.
      ['--help', generic],
      ['https://me:token@github.com/northlight/review', generic],
      ['https://github.com/northlight/review?ref=main', generic],
      ['/Users/test/code/review/', whole],
      ['/Users/test/code/../review', whole],
      ['~/code/../review', whole],
      ['~/', whole],
      ['/Users/test/code/review@2', at],
      ['~/code/@northlight/review', at],
      // Its own plugins folder, anything in it, and the `.gemini` above it, in the home the profile binds.
      ['/profiles/work/antigravity/.gemini/config/plugins/review', own],
      ['/profiles/work/antigravity/.gemini/config/plugins', own],
      ['/profiles/work/antigravity/.gemini', own],
      ['/Users/test/.gemini/config/plugins/review', own, native],
      ['~/.gemini', own, native],
    ];
    for (const [source, message, profile] of refusals) {
      expect(install(source, [], profile), source).toEqual({
        target: { kind: 'plugin', id: source },
        act: 'install',
        available: false,
        reason: 'unsupported',
        message,
      });
    }
  });

  it('answers held for a plugin it has by the name the source would most likely give it', () => {
    const holds = ['review', 'data-tools'];
    for (const source of [
      '/Users/test/code/review',
      '~/code/review',
      'https://github.com/northlight/review',
      'https://github.com/northlight/review.git/',
      'https://github.com/northlight/review/tree/main',
      'https://github.com/northlight/agy-plugins/tree/main/plugins/review',
    ]) {
      expect(install(source, holds), source).toEqual({
        target: { kind: 'plugin', id: source },
        act: 'install',
        available: false,
        reason: 'held',
        message: 'Antigravity already has review; its install would replace it',
      });
    }
    for (const source of [
      'https://github.com/northlight/agy-plugins',
      'https://github.com/northlight/review/tree/main/plugins/lint',
      '/Users/test/code/review-2',
    ]) {
      expect(install(source, holds), source).toMatchObject({ available: true });
    }
  });

  it('installs from its Agent Marketplace only inside the app, and has no command for a marketplace', () => {
    const inApp = 'Antigravity installs from its Agent Marketplace only inside the app (`/plugin`)';
    const listed = { id: 'data-tools', name: 'data-tools', marketplace: 'agent-marketplace' };
    expect(
      ExtensionActPlanSchema.parse(
        agy.plan!(
          work,
          actPlugin({ id: 'data-tools', name: 'data-tools', marketplace: 'agent-marketplace' }),
          'install',
          {
            listed,
          },
        ),
      ),
    ).toEqual({
      target: { kind: 'plugin', id: 'data-tools' },
      act: 'install',
      available: false,
      reason: 'in-app',
      message: inApp,
    });
    // A `<name>@<marketplace>` given as a source is that install too.
    expect(install('data-tools@agent-marketplace')).toMatchObject({
      available: false,
      reason: 'in-app',
      message: inApp,
    });
    for (const act of ['add', 'update', 'remove'] as const) {
      expect(ExtensionActPlanSchema.parse(agy.plan!(work, marketplace, act)), act).toEqual({
        target: { kind: 'marketplace', id: 'agent-marketplace' },
        act,
        available: false,
        reason: 'in-app',
        message: "Antigravity's marketplaces come with the app: it has no command that adds, fetches or removes one",
      });
    }
  });

  it('answers every act on every kind, with a source or without, and never throws', () => {
    const items: ExtensionActItem[] = [actServer(), actSkill(), actPlugin(), marketplace];
    for (const item of items) {
      for (const act of ExtensionActKindSchema.options) {
        for (const options of [{}, { source: '/Users/test/code/review', holds: [] }, { source: '-rf' }]) {
          const plan = ExtensionActPlanSchema.parse(agy.plan!(work, item, act, options));
          expect(plan.target, `${item.kind} ${act}`).toEqual({ kind: item.kind, id: item.id });
          expect(plan.act).toBe(act);
        }
      }
    }
    // Never `agy mcp install`: only a plugin is installed.
    for (const item of [actServer(), actSkill(), marketplace]) {
      expect(agy.plan!(work, item, 'install', { source: '/Users/test/code/review' })).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Only a plugin is installed',
      });
    }
  });

  it('reads back what its install copies in, under the name its manifest gives it', async () => {
    const home = await tempHome();
    const service = createAntigravityExtensionService({ executable: 'agy', env: {}, home, now });
    const profile = managedProfile(join(home, 'profiles', 'work', 'antigravity-3c1f'));
    const source = join(home, 'code', 'review-src');
    await write(join(source, 'plugin.json'), { name: 'review', version: '1.0.0' });
    expect(service.plan!(profile, sourced(source), 'install', { source, holds: [] })).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['agy', 'plugin', 'install', source] },
    });
    // What the install does: a copy into plugins/<manifest name>/, and no switch in config.json.
    await write(join(profile.dataRoot, '.gemini', 'config', 'plugins', 'review', 'plugin.json'), {
      name: 'review',
      version: '1.0.0',
    });
    const inventory = ExtensionInventorySchema.parse(await service.inventory(profile));
    // The folder's name guessed review-src; the manifest named it review, and the second read finds that one.
    expect(inventory.items.filter((item) => item.kind === 'plugin')).toEqual([
      {
        kind: 'plugin',
        id: 'review',
        name: 'review',
        origin: 'own',
        enabled: true,
        location: join(profile.dataRoot, '.gemini', 'config', 'plugins', 'review'),
        version: '1.0.0',
      },
    ]);
  });
});

describe('Antigravity files anyone may write', () => {
  it('reads plugins and servers crafted to make a pattern backtrack in one pass, and shows no address', async () => {
    const home = await tempHome();
    const config = join(home, '.gemini', 'config');
    // About 20k characters each, in the shapes that backtracked: `(@` ran cubic in `\([^)]*(?::\/\/|@)[^)]*\)`,
    // a run of `<` quadratic in `<[^>]*>`, and a long word with no `@` quadratic in `\S+@\S+`.
    const authors: Record<string, string> = {
      'paren-at': '(@'.repeat(10_000),
      angle: `Jo ${'<'.repeat(20_000)}`,
      word: `Jo ${'a'.repeat(20_000)}`,
      parens: `Jo ${'('.repeat(20_000)}`,
      mixed: 'Jo <(@ a@b (http://x.io '.repeat(800),
      ats: `Jo ${'@'.repeat(20_000)}`,
    };
    for (const [name, author] of Object.entries(authors)) {
      await write(join(config, 'plugins', name, 'plugin.json'), {
        name,
        author,
        homepage: `https://northlight.studio/${'a'.repeat(20_000)}`,
        repository: { url: `https://${'@'.repeat(20_000)}` },
        description: 'x '.repeat(10_000),
      });
      await write(join(config, 'plugins', name, 'hooks.json'), {
        ['P'.repeat(20_000)]: [],
        [name]: { ['S'.repeat(20_000)]: [] },
      });
      await write(join(config, 'plugins', name, 'commands', `${'c'.repeat(200)}.md`), '# a long name');
    }
    const servers = JSON.stringify({
      mcpServers: {
        crafted: { command: 'node', args: [`--${'a.'.repeat(10_000)}!`, `API_KEY=${'x'.repeat(20_000)}`] },
        keyed: {
          command: 'node',
          args: ['server.js'],
          env: { ['E'.repeat(20_000)]: 'value', GOOD: 'value' },
          headers: { ['H'.repeat(20_000)]: 'value' },
        },
      },
    });
    // JSONC, as Antigravity allows it: a long comment of comment openers, a long block, a trailing comma.
    await write(
      join(config, 'mcp_config.json'),
      `// ${'/*'.repeat(10_000)}\n/* ${'*'.repeat(20_000)} */\n${servers.slice(0, -1)},}`,
    );
    await write(
      join(config, 'skills', 'long', 'SKILL.md'),
      `---\nname: long\ndescription: ${'d'.repeat(20_000)}\n---\n`,
    );

    const started = performance.now();
    const inventory = ExtensionInventorySchema.parse(
      await createAntigravityExtensionService({ home: '/nonexistent', now }).inventory(managedProfile(home)),
    );
    expect(performance.now() - started).toBeLessThan(2_000);

    expect(JSON.stringify(inventory)).not.toContain('a@b');
    const plugins = inventory.items.filter((item): item is PluginItem => item.kind === 'plugin');
    expect(plugins.map((plugin) => plugin.id)).toEqual(['angle', 'ats', 'mixed', 'paren-at', 'parens', 'word']);
    // Too long to be a name once the addresses go, and every address gone: only `Jo` is left of one.
    expect(plugins.map((plugin) => plugin.author)).toEqual([
      undefined,
      'Jo',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    for (const plugin of plugins) {
      expect(plugin, plugin.id).not.toHaveProperty('homepage');
      expect(plugin.brings, plugin.id).toEqual({ commands: ['c'.repeat(200)] });
      expect(plugin.description!.length, plugin.id).toBeLessThanOrEqual(2_048);
    }
    // A command line too long to show is no server to list; a name too long to be a variable's is left out.
    expect(find(inventory, 'mcp-server', 'crafted')).toBeUndefined();
    expect(find(inventory, 'mcp-server', 'keyed')).toEqual({
      kind: 'mcp-server',
      id: 'keyed',
      name: 'keyed',
      origin: 'own',
      enabled: true,
      location: join(config, 'mcp_config.json'),
      transport: 'stdio',
      target: 'node server.js',
      env: ['GOOD'],
    });
    expect(find(inventory, 'skill', 'long')).toMatchObject({ description: 'd'.repeat(2_048) });
  });
});
