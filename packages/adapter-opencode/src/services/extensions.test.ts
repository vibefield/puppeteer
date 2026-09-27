import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { createOpenCodeExtensionService } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'opencode-extensions-')));
  made.push(dir);
  return dir;
}

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string, description?: string) =>
  `---\nname: ${name}\n${description ? `description: ${description}\n` : ''}---\n\n# ${name}\n`;

const managedProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'work-opencode',
    provider: 'opencode',
    label: 'Work',
    kind: 'managed',
    dataRoot: join(home, 'profiles', 'work', 'opencode-3c1d'),
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const nativeProfile = (home: string) =>
  AgentProfileSchema.parse({
    id: 'opencode:native-default',
    provider: 'opencode',
    label: 'Default',
    kind: 'native-default',
    dataRoot: join(home, '.local', 'share', 'opencode'),
    createdAt: '1970-01-01T00:00:00.000Z',
  });

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);

async function read(home: string, env: NodeJS.ProcessEnv = {}, profile = managedProfile(home)) {
  return ExtensionInventorySchema.parse(await createOpenCodeExtensionService({ home, env, now }).inventory(profile));
}

describe('OpenCode extensions', () => {
  it('declares the kinds OpenCode has, every one kept once for all profiles', () => {
    const { provider } = createOpenCodeExtensionService({ home: '/nowhere' });
    expect(ExtensionProviderSchema.parse(provider)).toEqual({
      id: 'opencode',
      label: 'OpenCode',
      support: {
        plugins: { store: 'shared', changes: 'command', read: true },
        mcpServers: { store: 'shared', changes: 'in-app', read: true },
        skills: { store: 'shared', changes: 'folder', read: true },
      },
    });
  });

  it('merges the config documents in OpenCode’s order, lists plugins and skills, and keeps no secret', async () => {
    const home = await tempHome();
    const config = join(home, '.config', 'opencode');
    await write(join(config, 'config.json'), {
      mcp: { legacy: { type: 'local', command: ['legacy-mcp'] } },
    });
    await write(join(config, 'opencode.json'), {
      $schema: 'https://opencode.ai/config.json',
      plugin: [
        'opencode-wakatime@1.2.3',
        ['@acme/opencode-review@latest', { strict: true }],
        './plugins-local/notify.ts',
        'opencode-copilot-auth',
      ],
      mcp: {
        linear: {
          type: 'remote',
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer {env:LINEAR_TOKEN}' },
          oauth: false,
        },
        postgres: {
          type: 'local',
          command: ['npx', '-y', '@modelcontextprotocol/server-postgres', 'postgresql://app:hunter2@localhost/dev'],
          environment: { PGPASSWORD: 'hunter2' },
        },
        sentry: { type: 'remote', url: 'https://mcp.sentry.dev/mcp?token=sk-live-abc' },
        halfway: { enabled: true },
      },
      skills: { paths: ['~/team-skills', 'relative/skills'] },
    });
    // JSONC: comments and trailing commas, as OpenCode reads them.
    await write(
      join(config, 'opencode.jsonc'),
      [
        '{',
        '  // switch sentry off without restating it',
        '  "mcp": { "sentry": { "enabled": false, }, },',
        '  /* the later declaration of a package wins */',
        '  "plugin": ["opencode-wakatime@2.0.0",],',
        '}',
      ].join('\n'),
    );
    await write(join(home, '.opencode', 'opencode.json'), {
      mcp: { 'remote-env': { type: 'remote', url: '{env:REMOTE_MCP_URL}' } },
    });
    await write(join(config, 'plugins-local', 'notify.ts'), 'export default async () => ({})');
    await write(join(config, 'plugins', 'notify-hook.ts'), 'export default async () => ({})');
    await write(join(config, 'plugin', 'legacy.js'), 'export default async () => ({})');
    await write(join(config, 'plugins', 'theme.tsx'), 'export default {}');
    await write(join(config, 'plugins', 'nested', 'deep.ts'), 'export default async () => ({})');

    await write(join(home, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'Claude’s review'));
    await write(join(home, '.claude', 'skills', 'house', 'SKILL.md'), skill('house', 'Northlight naming'));
    await write(join(home, '.agents', 'skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts notes'));
    await write(
      join(home, '.agents', 'skills', 'nested', 'deeper', 'changelog', 'SKILL.md'),
      skill('changelog', 'Writes the entry'),
    );
    await write(join(home, '.agents', 'skills', 'broken', 'SKILL.md'), '# no frontmatter');
    await write(join(config, 'skills', 'review', 'SKILL.md'), skill('review', 'OpenCode’s own review'));
    await write(join(config, 'skill', 'undescribed', 'SKILL.md'), skill('undescribed'));
    await write(join(home, 'team-skills', 'sql', 'SKILL.md'), skill('sql', 'Reviews a migration'));
    const library = join(home, 'library', 'linked-skill');
    await write(join(library, 'SKILL.md'), skill('linked', 'Kept in the library'));
    await symlink(library, join(home, '.agents', 'skills', 'linked'));

    const inventory = await read(home);
    const document = JSON.stringify(inventory);
    for (const secret of ['hunter2', 'sk-live-abc']) expect(document).not.toContain(secret);
    expect(inventory).toMatchObject({
      provider: 'opencode',
      profileId: 'work-opencode',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'documented' },
    });
    expect(inventory.unread).toBeUndefined();
    expect(inventory.items.every((item) => item.shared === true)).toBe(true);

    expect(find(inventory, 'mcp-server', 'legacy')).toMatchObject({
      origin: 'own',
      transport: 'stdio',
      target: 'legacy-mcp',
      location: join(config, 'config.json'),
    });
    expect(find(inventory, 'mcp-server', 'linear')).toEqual({
      kind: 'mcp-server',
      id: 'linear',
      name: 'linear',
      origin: 'own',
      shared: true,
      enabled: true,
      location: join(config, 'opencode.json'),
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      env: ['LINEAR_TOKEN'],
      headers: ['Authorization'],
    });
    expect(find(inventory, 'mcp-server', 'postgres')).toMatchObject({
      target: 'npx -y @modelcontextprotocol/server-postgres postgresql://•••@localhost/dev',
      env: ['PGPASSWORD'],
    });
    // Switched off by the later document; defined, and so kept, in the earlier one.
    expect(find(inventory, 'mcp-server', 'sentry')).toMatchObject({
      enabled: false,
      target: 'https://mcp.sentry.dev/mcp?•••',
      location: join(config, 'opencode.json'),
    });
    expect(find(inventory, 'mcp-server', 'remote-env')).toMatchObject({
      target: '{env:REMOTE_MCP_URL}',
      env: ['REMOTE_MCP_URL'],
      location: join(home, '.opencode', 'opencode.json'),
    });
    expect(find(inventory, 'mcp-server', 'halfway')).toBeUndefined();

    const notify = pathToFileURL(join(config, 'plugins-local', 'notify.ts')).href;
    expect(inventory.items.filter((item) => item.kind === 'plugin').map((item) => item.id)).toEqual([
      'opencode-wakatime',
      '@acme/opencode-review',
      notify,
      pathToFileURL(join(config, 'plugin', 'legacy.js')).href,
      pathToFileURL(join(config, 'plugins', 'notify-hook.ts')).href,
    ]);
    expect(find(inventory, 'plugin', 'opencode-wakatime')).toMatchObject({
      name: 'opencode-wakatime',
      version: '2.0.0',
      location: join(config, 'opencode.jsonc'),
    });
    expect(find(inventory, 'plugin', '@acme/opencode-review')).not.toHaveProperty('version');
    expect(find(inventory, 'plugin', notify)).toMatchObject({
      name: 'notify',
      location: join(config, 'plugins-local', 'notify.ts'),
    });

    expect(find(inventory, 'skill', 'review')).toMatchObject({
      origin: 'own',
      description: 'OpenCode’s own review',
      location: join(config, 'skills', 'review'),
    });
    expect(find(inventory, 'skill', 'house')).toMatchObject({ origin: 'borrowed', lender: 'claude', enabled: true });
    expect(find(inventory, 'skill', 'release-notes')).toMatchObject({ origin: 'own', enabled: true });
    expect(find(inventory, 'skill', 'changelog')).toMatchObject({
      location: join(home, '.agents', 'skills', 'nested', 'deeper', 'changelog'),
    });
    expect(find(inventory, 'skill', 'undescribed')).toMatchObject({ enabled: false });
    expect(find(inventory, 'skill', 'sql')).toMatchObject({ location: join(home, 'team-skills', 'sql') });
    expect(find(inventory, 'skill', 'linked')).toMatchObject({
      location: join(home, '.agents', 'skills', 'linked'),
      linkTarget: library,
    });
    expect(inventory.items.some((item) => item.kind === 'skill' && item.location?.endsWith('broken'))).toBe(false);

    // Every profile reads the same documents and folders.
    const native = await read(home, {}, nativeProfile(home));
    expect(native.profileId).toBe('opencode:native-default');
    expect(native.items).toEqual(inventory.items);
  });

  it('keeps `{env:NAME}` in a target as written and lists the name, where a literal secret is masked', async () => {
    const home = await tempHome();
    await write(join(home, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        github: {
          type: 'local',
          command: ['github-mcp', '--token', '{env:GITHUB_TOKEN}', 'API_KEY={env:API_KEY}', '--secret', 'hunter2'],
          environment: { GITHUB_HOST: '{env:GH_HOST}' },
        },
        tenant: {
          type: 'remote',
          url: 'https://{env:TENANT_HOST}/mcp',
          headers: { 'X-Api-Key': '{env:TENANT_KEY}', 'X-Static': 'static-secret-value' },
          oauth: { clientId: 'opencode', clientSecret: '{env:TENANT_CLIENT_SECRET}' },
        },
      },
    });
    const inventory = await read(home);
    expect(JSON.stringify(inventory)).not.toContain('hunter2');
    expect(JSON.stringify(inventory)).not.toContain('static-secret-value');
    expect(find(inventory, 'mcp-server', 'github')).toMatchObject({
      target: 'github-mcp --token {env:GITHUB_TOKEN} API_KEY={env:API_KEY} --secret •••',
      env: ['GITHUB_HOST', 'GITHUB_TOKEN', 'API_KEY', 'GH_HOST'],
    });
    expect(find(inventory, 'mcp-server', 'tenant')).toMatchObject({
      target: 'https://{env:TENANT_HOST}/mcp',
      env: ['TENANT_HOST', 'TENANT_KEY', 'TENANT_CLIENT_SECRET'],
      headers: ['X-Api-Key', 'X-Static'],
    });
  });

  it("gives a server's definition only when no OpenCode reference, folder, masked part or header stays behind", async () => {
    const home = await tempHome();
    await write(join(home, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        github: {
          type: 'local',
          command: ['npx', '-y', '@modelcontextprotocol/server-github'],
          environment: { GITHUB_TOKEN: 'ghp_literalsecretvalue', GITHUB_HOST: '{env:GH_HOST}' },
        },
        docs: { type: 'remote', url: 'https://docs.example.com/mcp' },
        'from-env': { type: 'local', command: ['node', '{env:SERVER_JS}'] },
        'from-file': { type: 'local', command: ['uvx', 'mcp-server', '{file:~/.mcp-arg}'] },
        tenant: { type: 'remote', url: 'https://{env:TENANT_HOST}/mcp' },
        keyed: { type: 'remote', url: 'https://keyed.example.com/mcp', headers: { 'X-Api-Key': '{env:KEYED_KEY}' } },
        masked: { type: 'local', command: ['uvx', 'mcp-server', '--api-key', 'abc'] },
        folder: { type: 'local', command: ['node', 'server.js'], cwd: 'tools/mcp' },
      },
    });
    const inventory = await read(home);
    expect(JSON.stringify(inventory)).not.toContain('ghp_literalsecretvalue');
    // The server reads what `environment` sets; GH_HOST is OpenCode's own to read.
    expect(find(inventory, 'mcp-server', 'github')).toMatchObject({
      env: ['GITHUB_TOKEN', 'GITHUB_HOST', 'GH_HOST'],
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: ['GITHUB_TOKEN', 'GITHUB_HOST'],
      },
    });
    expect(find(inventory, 'mcp-server', 'docs')).toMatchObject({
      definition: { transport: 'http', url: 'https://docs.example.com/mcp' },
    });
    for (const id of ['from-env', 'from-file', 'tenant', 'keyed', 'masked', 'folder']) {
      expect(find(inventory, 'mcp-server', id), id).toBeDefined();
      expect(find(inventory, 'mcp-server', id), id).not.toHaveProperty('definition');
    }
  });

  it('says which document it could not read and lists what the others hold', async () => {
    const home = await tempHome();
    const config = join(home, '.config', 'opencode');
    await write(join(config, 'opencode.json'), '{ "mcp": { "linear": { "type": "remote", "url": "https://x" ');
    await write(join(config, 'opencode.jsonc'), {
      mcp: { docs: { type: 'remote', url: 'https://docs.example.com/mcp' } },
    });
    const inventory = await read(home);
    expect(inventory.unread).toEqual([
      { kind: 'plugin', message: '~/.config/opencode/opencode.json could not be read' },
      { kind: 'mcp-server', message: '~/.config/opencode/opencode.json could not be read' },
      { kind: 'skill', message: '~/.config/opencode/opencode.json could not be read' },
    ]);
    expect(inventory.items.map((item) => item.id)).toEqual(['docs']);
  });

  it('marks skills unread when some come from `skills.urls`, which OpenCode downloads at start', async () => {
    const home = await tempHome();
    await write(join(home, '.config', 'opencode', 'opencode.json'), {
      skills: { urls: ['https://skills.example.com/'] },
    });
    expect((await read(home)).unread).toEqual([
      {
        kind: 'skill',
        message: 'skills from `skills.urls` are downloaded when OpenCode starts and are not read here',
      },
    ]);
  });

  it('follows the variables OpenCode starts with, and only the ones it is given', async () => {
    const home = await tempHome();
    const moved = join(home, 'xdg');
    await write(join(moved, 'opencode', 'opencode.json'), { mcp: { moved: { type: 'local', command: ['moved'] } } });
    await write(join(home, 'extra', 'opencode.jsonc'), { mcp: { extra: { type: 'local', command: ['extra'] } } });
    await write(join(home, 'one.json'), { mcp: { named: { type: 'local', command: ['named'] } } });
    await write(join(home, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'Claude’s review'));
    await write(join(home, '.agents', 'skills', 'notes', 'SKILL.md'), skill('notes', 'Takes notes'));

    const inventory = await read(home, {
      XDG_CONFIG_HOME: moved,
      OPENCODE_CONFIG_DIR: join(home, 'extra'),
      OPENCODE_CONFIG: join(home, 'one.json'),
      OPENCODE_CONFIG_CONTENT: '{ "mcp": { "inline": { "type": "local", "command": ["inline"] } } }',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    });
    expect(inventory.items.map((item) => `${item.kind} ${item.id}`)).toEqual([
      'mcp-server moved',
      'mcp-server named',
      'mcp-server extra',
      'mcp-server inline',
      'skill notes',
    ]);
    expect(find(inventory, 'mcp-server', 'inline')).not.toHaveProperty('location');
    expect((await read(home, { OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true' })).items).toEqual([]);

    // An injected home with no env never follows this process's variables.
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = moved;
    try {
      const isolated = ExtensionInventorySchema.parse(
        await createOpenCodeExtensionService({ home, now }).inventory(managedProfile(home)),
      );
      expect(isolated.items.some((item) => item.id === 'moved')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  it('reads an empty home as holding nothing', async () => {
    const home = await tempHome();
    const inventory = await read(home);
    expect(inventory.items).toEqual([]);
    expect(inventory.unread).toBeUndefined();
  });
});

// ── acts (RFC 006 C2) ──

const actProfile = (kind: 'managed' | 'native-default', dataRoot: string) =>
  ({
    id: kind === 'managed' ? 'work-opencode' : 'opencode:native-default',
    provider: 'opencode',
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
/** A server as the runtime hands an add to the adapter: as the agent would hold it once added. */
const added = (name: string, definition: McpServerDefinition): McpServerItem => ({
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

describe('OpenCode extension acts', () => {
  it('has no command for a server or a skill', () => {
    const opencode = createOpenCodeExtensionService({ home: '/Users/test', env: {} });
    expect(opencode.plan!(actProfile('managed', '/p'), actServer({ shared: true }), 'disable')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
    expect(
      opencode.plan!(
        actProfile('managed', '/p'),
        actSkill({ origin: 'borrowed', lender: 'claude', shared: true }),
        'disable',
      ),
    ).toMatchObject({ available: false, reason: 'not-own' });
  });

  it("signs a remote server in and out in the profile's own data home, though the definition is every profile's", () => {
    const opencode = createOpenCodeExtensionService({ home: '/Users/test', env: {}, executable: 'opencode' });
    expect(
      opencode.plan!(actProfile('managed', '/profiles/work/opencode'), actServer({ shared: true }), 'sign-in'),
    ).toEqual({
      target: { kind: 'mcp-server', id: 'linear' },
      act: 'sign-in',
      available: true,
      runs: {
        kind: 'terminal',
        argv: ['opencode', 'mcp', 'auth', 'linear'],
        env: { XDG_DATA_HOME: '/profiles/work/opencode/data' },
      },
      display: 'opencode mcp auth linear',
      reaches: [],
    });
    const native = opencode.plan!(actProfile('native-default', '/Users/test'), actServer({ shared: true }), 'sign-out');
    expect(native).toMatchObject({
      available: true,
      runs: { kind: 'command', argv: ['opencode', 'mcp', 'logout', 'linear'] },
    });
    expect((native as { runs: { env?: unknown } }).runs.env).toBeUndefined();
    expect(
      opencode.plan!(actProfile('managed', '/p'), actServer({ transport: 'stdio', target: 'npx x' }), 'sign-in'),
    ).toMatchObject({ available: false, reason: 'no-sign-in' });
  });

  it('adds a server with its own non-interactive add, into the one config every profile reads', () => {
    const opencode = createOpenCodeExtensionService({ home: '/Users/test', env: {}, executable: 'opencode' });
    const github: McpServerDefinition = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: ['GITHUB_TOKEN', 'GITHUB_HOST'],
    };
    // A managed profile binds only the data home; the config it writes is every profile's, so no variable.
    expect(opencode.plan!(actProfile('managed', '/profiles/work/opencode'), added('github', github), 'add')).toEqual({
      target: { kind: 'mcp-server', id: 'github' },
      act: 'add',
      available: true,
      runs: {
        kind: 'command',
        argv: [
          'opencode',
          'mcp',
          'add',
          'github',
          '--env',
          'GITHUB_TOKEN={env:GITHUB_TOKEN}',
          '--env',
          'GITHUB_HOST={env:GITHUB_HOST}',
          '--',
          'npx',
          '-y',
          '@modelcontextprotocol/server-github',
        ],
      },
      display:
        'opencode mcp add github --env GITHUB_TOKEN={env:GITHUB_TOKEN} --env GITHUB_HOST={env:GITHUB_HOST} -- npx -y @modelcontextprotocol/server-github',
      reaches: ['every-profile'],
    });
    for (const transport of ['http', 'sse'] as const) {
      expect(
        opencode.plan!(
          actProfile('native-default', '/Users/test'),
          added('linear', { transport, url: 'https://mcp.linear.app/mcp' }),
          'add',
        ),
      ).toEqual({
        target: { kind: 'mcp-server', id: 'linear' },
        act: 'add',
        available: true,
        runs: { kind: 'command', argv: ['opencode', 'mcp', 'add', 'linear', '--url', 'https://mcp.linear.app/mcp'] },
        display: 'opencode mcp add linear --url https://mcp.linear.app/mcp',
        reaches: ['every-profile'],
      });
    }
  });

  it('adds only a server that carries a definition, under a name its commands take', () => {
    const opencode = createOpenCodeExtensionService({ home: '/Users/test', env: {}, executable: 'opencode' });
    const work = actProfile('managed', '/p');
    expect(opencode.plan!(work, actServer(), 'add')).toMatchObject({ available: false, reason: 'unsupported' });
    expect(opencode.plan!(work, actSkill(), 'add')).toMatchObject({ available: false, reason: 'unsupported' });
    expect(
      opencode.plan!(work, added('-rf', { transport: 'http', url: 'https://mcp.linear.app/mcp' }), 'add'),
    ).toMatchObject({ available: false, reason: 'no-command' });
  });

  it('adds what a read found by its names alone: a value stays in the config it came from', async () => {
    const home = await tempHome();
    await write(join(home, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        github: {
          type: 'local',
          command: ['npx', '-y', 'server-github'],
          environment: { GITHUB_TOKEN: 'ghp_literalsecretvalue' },
        },
      },
    });
    const opencode = createOpenCodeExtensionService({ home, env: {}, now, executable: 'opencode' });
    const server = find(
      ExtensionInventorySchema.parse(await opencode.inventory(managedProfile(home))),
      'mcp-server',
      'github',
    );
    const definition = server?.kind === 'mcp-server' ? server.definition : undefined;
    expect(definition).toBeDefined();
    const plan = ExtensionActPlanSchema.parse(
      opencode.plan!(managedProfile(home), added('github-work', definition!), 'add'),
    );
    expect(JSON.stringify(plan)).not.toContain('ghp_literalsecretvalue');
    expect(plan).toMatchObject({
      available: true,
      runs: {
        argv: [
          'opencode',
          'mcp',
          'add',
          'github-work',
          '--env',
          'GITHUB_TOKEN={env:GITHUB_TOKEN}',
          '--',
          'npx',
          '-y',
          'server-github',
        ],
      },
    });
  });
});
