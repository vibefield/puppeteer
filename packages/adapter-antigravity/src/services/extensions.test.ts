import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  describeMcpDefinition,
  ExtensionActPlanSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type ExtensionInventory,
  type ExtensionItem,
  type McpServerDefinition,
  type McpServerItem,
} from '@vibecook/puppeteer-core';
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
        plugins: { store: 'profile', changes: 'command', read: true },
        marketplaces: { store: 'profile', changes: 'command', read: false },
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
});
