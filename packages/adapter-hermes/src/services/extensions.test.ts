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
} from '@vibecook/puppeteer-core';
import { createHermesExtensionService } from './extensions.js';

const now = () => new Date('2026-09-25T09:00:00.000Z');
const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hermes-extensions-')));
  made.push(dir);
  return dir;
}

async function write(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

const managedProfile = (root: string) =>
  AgentProfileSchema.parse({
    id: 'work-hermes',
    provider: 'hermes',
    label: 'Work',
    kind: 'managed',
    dataRoot: root,
    createdAt: '2026-09-23T00:00:00.000Z',
  });

const nativeProfile = (dataRoot: string) =>
  AgentProfileSchema.parse({
    id: 'hermes:native-default',
    provider: 'hermes',
    label: 'Default',
    kind: 'native-default',
    dataRoot,
    createdAt: '1970-01-01T00:00:00.000Z',
  });

const find = (inventory: ExtensionInventory, kind: ExtensionItem['kind'], id: string) =>
  inventory.items.find((item) => item.kind === kind && item.id === id);

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/** PyYAML `safe_dump` block style beside hand-written flow lists, quotes and comments. */
const CONFIG = `# written by hermes, then by hand
model:
  provider: nous
mcp_servers:
  github:
    command: npx
    args:
    - -y
    - '@modelcontextprotocol/server-github'
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: \${GITHUB_TOKEN}
      LOG_LEVEL: debug
  postgres:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://app:hunter2@localhost/dev"]
    enabled: false
  linear:
    url: https://mcp.linear.app/mcp
    auth: oauth
  notion:
    url: "https://mcp.notion.com/mcp"  # signed in elsewhere, not here
    auth: OAuth
  search:
    url: https://search.example.com/mcp?key=sk-live-123
    headers:
      Authorization: Bearer \${env:SEARCH_TOKEN}
      X-Static: s3cr3t-static-value
    enabled: 'no'
  legacy:
    url: https://legacy.example.com/sse
    transport: sse
  both:
    command: node
    url: https://both.example.com/mcp
  broken: just-a-string
plugins:
  enabled:
  - disk-cleanup
  - kanban
  - review-pack
  disabled: [image_gen/openai]
memory:
  provider: my-memory
skills:
  disabled:
    - sql-review
    - hermes-agent
  external_dirs:
    - ~/shared-skills
    - \${NOT_EXPANDED}/skills
  create_dir: made-by-agent
`;

async function populatedRoot() {
  const home = await tempHome();
  const root = join(home, 'profiles', 'hermes', 'h-7a10');
  await write(join(root, 'config.yaml'), CONFIG);
  await write(join(root, '.env'), 'GITHUB_TOKEN=ghp_envsecretvalue\nSEARCH_TOKEN=search-env-secret\n');
  await write(join(root, 'mcp-tokens', 'linear.json'), '{"access_token":"tok-secret"}');
  await write(join(root, 'auth.json'), '{"providers":{"nous":{"access_token":"auth-secret"}}}');

  const plugins = join(root, 'plugins');
  await write(
    join(plugins, 'disk-cleanup', 'plugin.yaml'),
    'name: disk-cleanup\nversion: 1.2.0\ndescription: Cleans temp files\n',
  );
  await write(join(plugins, 'web', 'firecrawl', 'plugin.yaml'), 'name: firecrawl\nkind: backend\n');
  await write(join(plugins, 'my-memory', 'plugin.yaml'), 'name: my-memory\n');
  await write(
    join(plugins, 'my-memory', '__init__.py'),
    'def register(ctx):\n    ctx.register_memory_provider(Provider())\n',
  );
  await write(join(plugins, 'broken', 'plugin.yaml'), 'name: [unclosed\n');
  await write(join(plugins, 'claude-only', '.claude-plugin', 'plugin.json'), { name: 'claude-only' });
  await write(join(plugins, '__pycache__', 'plugin.yaml'), 'name: cache\n');
  const pack = join(plugins, 'review-pack');
  await write(join(pack, 'plugin.json'), {
    $schema: PLUGIN_SCHEMA,
    name: 'review-pack',
    version: '0.3.0',
    description: 'Review helpers',
  });
  await write(join(pack, 'mcp.json'), {
    $schema: MCP_SCHEMA,
    mcpServers: {
      reviewer: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_ROOT}/server.js'],
        env: { REVIEW_KEY: 'package-secret' },
      },
      github: { type: 'stdio', command: 'other-github' },
      old: { type: 'sse', url: 'https://old.example.com/sse' },
    },
  });
  await write(join(pack, 'skills', 'checklist', 'SKILL.md'), skill('checklist', 'Walks the review checklist'));

  const skills = join(root, 'skills');
  await write(join(skills, '.bundled_manifest'), 'hermes-agent:4f2a\nplan:9c1d\n');
  await write(join(skills, '.hub', 'lock.json'), {
    version: 1,
    installed: { 'release-notes': { install_path: 'release-notes', source: 'skills.sh' } },
  });
  await write(join(skills, 'hermes-agent', 'SKILL.md'), skill('hermes-agent', 'How Hermes works'));
  await write(join(skills, 'software', 'plan', 'SKILL.md'), skill('plan', 'Plans a change'));
  await write(join(skills, 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
  await write(join(skills, 'sql-review', 'SKILL.md'), skill('sql-review', 'Reviews a migration'));
  await write(join(skills, 'sql-review', 'references', 'inner', 'SKILL.md'), skill('inner', 'A support file'));
  await write(join(skills, '.archive', 'old', 'SKILL.md'), skill('old', 'Archived'));
  await write(join(skills, '_org', '.active_org'), 'acme\n');
  await write(join(skills, '_org', 'acme', 'brand', 'SKILL.md'), skill('brand', 'The brand book'));
  await write(join(skills, '_org', 'other', 'secret-org', 'SKILL.md'), skill('secret-org', 'Not this org'));
  const library = join(home, 'library', 'linked');
  await write(join(library, 'SKILL.md'), skill('linked', 'Placed by a link'));
  await symlink(library, join(skills, 'linked'));
  await write(join(root, 'made-by-agent', 'drafted', 'SKILL.md'), skill('drafted', 'Drafted in create_dir'));
  // Managed roots run with HOME set to the root, so `~/shared-skills` is inside it.
  await write(join(root, 'shared-skills', 'browser-use', 'SKILL.md'), skill('browser-use', 'Drives a browser'));
  await write(join(root, 'shared-skills', 'release-notes', 'SKILL.md'), skill('release-notes', 'A shadowed copy'));
  return { home, root, library };
}

describe('Hermes extensions', () => {
  it('declares the kinds Hermes has: plugins, MCP servers and skills, with no marketplace', () => {
    const { provider } = createHermesExtensionService({ now });
    expect(ExtensionProviderSchema.parse(provider)).toEqual({
      id: 'hermes',
      label: 'Hermes',
      support: {
        plugins: { store: 'mixed', changes: 'command', read: true },
        mcpServers: { store: 'profile', changes: 'command', read: true },
        skills: { store: 'profile', changes: 'folder', read: true },
      },
    });
  });

  it('reads a managed root’s servers, plugins and skills as Hermes loads them, and no secret', async () => {
    const { home, root, library } = await populatedRoot();
    const inventory = ExtensionInventorySchema.parse(
      await createHermesExtensionService({ home, now }).inventory(managedProfile(root)),
    );

    const document = JSON.stringify(inventory);
    for (const secret of [
      'hunter2',
      'sk-live-123',
      's3cr3t-static-value',
      'ghp_envsecretvalue',
      'search-env-secret',
      'package-secret',
      'tok-secret',
      'auth-secret',
      'debug',
    ]) {
      expect(document).not.toContain(secret);
    }
    expect(inventory).toMatchObject({
      provider: 'hermes',
      profileId: 'work-hermes',
      fetchedAt: '2026-09-25T09:00:00.000Z',
      source: { kind: 'native-store', stability: 'experimental' },
    });
    expect(inventory.unread).toBeUndefined();

    const configFile = join(root, 'config.yaml');
    expect(find(inventory, 'mcp-server', 'github')).toEqual({
      kind: 'mcp-server',
      id: 'github',
      name: 'github',
      origin: 'own',
      enabled: true,
      location: configFile,
      transport: 'stdio',
      target: 'npx -y @modelcontextprotocol/server-github',
      env: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'LOG_LEVEL', 'GITHUB_TOKEN'],
      // The server reads its `env` keys; `${GITHUB_TOKEN}` is Hermes's to fill, and no value travels.
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'LOG_LEVEL'],
      },
    });
    expect(find(inventory, 'mcp-server', 'postgres')).toMatchObject({
      enabled: false,
      target: 'npx -y @modelcontextprotocol/server-postgres postgresql://•••@localhost/dev',
    });
    expect(find(inventory, 'mcp-server', 'linear')).toMatchObject({
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
      auth: 'signed-in',
    });
    expect(find(inventory, 'mcp-server', 'notion')).toMatchObject({ auth: 'needs-sign-in' });
    expect(find(inventory, 'mcp-server', 'search')).toMatchObject({
      enabled: false,
      target: 'https://search.example.com/mcp?•••',
      headers: ['Authorization', 'X-Static'],
      env: ['SEARCH_TOKEN'],
    });
    expect(find(inventory, 'mcp-server', 'search')).not.toHaveProperty('auth');
    expect(find(inventory, 'mcp-server', 'legacy')).toMatchObject({ transport: 'sse' });
    // `url` wins over `command`, as Hermes connects it.
    expect(find(inventory, 'mcp-server', 'both')).toMatchObject({
      transport: 'http',
      target: 'https://both.example.com/mcp',
    });
    expect(find(inventory, 'mcp-server', 'broken')).toBeUndefined();
    expect(find(inventory, 'mcp-server', 'plugin:review-pack:reviewer')).toMatchObject({
      name: 'reviewer',
      origin: 'plugin',
      plugin: 'review-pack',
      enabled: true,
      target: 'node ${PLUGIN_ROOT}/server.js',
      env: ['REVIEW_KEY'],
    });
    // config.yaml's own `github` wins; the package's SSE server is refused.
    expect(find(inventory, 'mcp-server', 'plugin:review-pack:github')).toBeUndefined();
    expect(find(inventory, 'mcp-server', 'plugin:review-pack:old')).toBeUndefined();
    // A definition travels only whole: never masked, with a header, or a package's.
    expect(find(inventory, 'mcp-server', 'linear')).toMatchObject({
      definition: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
    });
    expect(find(inventory, 'mcp-server', 'legacy')).toMatchObject({
      definition: { transport: 'sse', url: 'https://legacy.example.com/sse' },
    });
    expect(find(inventory, 'mcp-server', 'both')).toMatchObject({
      definition: { transport: 'http', url: 'https://both.example.com/mcp' },
    });
    for (const id of ['postgres', 'search', 'plugin:review-pack:reviewer']) {
      expect(find(inventory, 'mcp-server', id), id).not.toHaveProperty('definition');
    }

    expect(find(inventory, 'plugin', 'disk-cleanup')).toEqual({
      kind: 'plugin',
      id: 'disk-cleanup',
      name: 'disk-cleanup',
      origin: 'own',
      enabled: true,
      location: join(root, 'plugins', 'disk-cleanup'),
      version: '1.2.0',
      description: 'Cleans temp files',
    });
    // A user backend still needs the allow-list.
    expect(find(inventory, 'plugin', 'web/firecrawl')).toMatchObject({ name: 'firecrawl', enabled: false });
    // Undeclared, detected as a memory provider, and chosen by `memory.provider`.
    expect(find(inventory, 'plugin', 'my-memory')).toMatchObject({ enabled: true });
    expect(find(inventory, 'plugin', 'review-pack')).toMatchObject({ version: '0.3.0', enabled: true });
    expect(find(inventory, 'plugin', 'bundled:kanban')).toMatchObject({ origin: 'bundled', enabled: true });
    expect(find(inventory, 'plugin', 'bundled:image_gen/openai')).toMatchObject({
      origin: 'bundled',
      enabled: false,
    });
    // `broken` fails to parse, `claude-only` holds only another harness's manifest, `__pycache__` is skipped.
    expect(inventory.items.filter((item) => item.kind === 'plugin').map((item) => item.id)).toEqual([
      'disk-cleanup',
      'my-memory',
      'review-pack',
      'web/firecrawl',
      'bundled:kanban',
      'bundled:image_gen/openai',
    ]);

    expect(find(inventory, 'skill', 'hermes-agent')).toMatchObject({ origin: 'bundled', enabled: true });
    expect(find(inventory, 'skill', 'plan')).toMatchObject({
      origin: 'bundled',
      location: join(root, 'skills', 'software', 'plan'),
    });
    expect(find(inventory, 'skill', 'release-notes')).toMatchObject({
      origin: 'own',
      location: join(root, 'skills', 'release-notes'),
      description: 'Drafts release notes',
    });
    expect(find(inventory, 'skill', 'sql-review')).toMatchObject({ origin: 'agent', enabled: false });
    expect(find(inventory, 'skill', 'brand')).toMatchObject({ origin: 'managed' });
    expect(find(inventory, 'skill', 'linked')).toMatchObject({ origin: 'agent', linkTarget: library });
    expect(find(inventory, 'skill', 'drafted')).toMatchObject({ origin: 'own' });
    expect(find(inventory, 'skill', 'browser-use')).toMatchObject({
      origin: 'own',
      location: join(root, 'shared-skills', 'browser-use'),
    });
    expect(find(inventory, 'skill', 'plugin:review-pack:checklist')).toMatchObject({
      name: 'checklist',
      origin: 'plugin',
      plugin: 'review-pack',
      enabled: true,
    });
    const skillNames = inventory.items.filter((item) => item.kind === 'skill').map((item) => item.name);
    for (const absent of ['inner', 'old', 'secret-org']) expect(skillNames).not.toContain(absent);
    expect(skillNames.filter((name) => name === 'release-notes')).toHaveLength(1);
    expect(inventory.items.every((item) => item.kind !== 'skill' || !('switchable' in item))).toBe(true);
  });

  it('reads the native default from the given home, whatever path the profile carries, with `~` at that home', async () => {
    const home = await tempHome();
    await write(
      join(home, '.hermes', 'config.yaml'),
      'mcp_servers:\n  docs: {url: "https://docs.example.com/mcp"}\nskills:\n  external_dirs: ~/team-skills\n',
    );
    await write(join(home, 'team-skills', 'triage', 'SKILL.md'), skill('triage', 'Triages an issue'));
    const inventory = ExtensionInventorySchema.parse(
      await createHermesExtensionService({ home, now }).inventory(nativeProfile('/nowhere/.hermes')),
    );
    expect(inventory.profileId).toBe('hermes:native-default');
    expect(inventory.items.map((item) => `${item.kind} ${item.id}`)).toEqual(['mcp-server docs', 'skill triage']);
    expect(find(inventory, 'mcp-server', 'docs')).toMatchObject({ location: join(home, '.hermes', 'config.yaml') });
  });

  it('reads the YAML people write: block scalars, wrapped and quoted values, flow maps and comments', async () => {
    const home = await tempHome();
    const root = join(home, 'roots', 'h-1');
    await write(
      join(root, 'config.yaml'),
      [
        '---',
        'mcp_servers:',
        '  "quoted name":',
        '    command: >-',
        '      uvx',
        '    args:',
        '      - "--flag=with # hash"',
        "      - 'it''s'",
        '      -   spaced',
        '      - a long argument',
        '        that wraps',
        '  flowed: {command: node, args: [a, "b c"], env: {API_KEY: "${API_KEY}"}, enabled: off}',
        'skills:',
        '  disabled: \'["alpha", "beta"]\'',
        '...',
        '',
      ].join('\n'),
    );
    await write(join(root, 'skills', 'alpha', 'SKILL.md'), skill('alpha', 'First'));
    await write(join(root, 'skills', 'gamma', 'SKILL.md'), skill('gamma', 'Third'));
    const inventory = ExtensionInventorySchema.parse(
      await createHermesExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    expect(find(inventory, 'mcp-server', 'quoted name')).toMatchObject({
      target: `uvx "--flag=with # hash" "it's" spaced "a long argument that wraps"`,
    });
    expect(find(inventory, 'mcp-server', 'flowed')).toMatchObject({
      enabled: false,
      target: 'node a "b c"',
      env: ['API_KEY'],
    });
    expect(find(inventory, 'skill', 'alpha')).toMatchObject({ enabled: false });
    expect(find(inventory, 'skill', 'gamma')).toMatchObject({ enabled: true });
  });

  it("gives a server's definition only from config.yaml, whole: no folder of its own, no variable inside it", async () => {
    const home = await tempHome();
    const root = join(home, 'roots', 'h-2');
    await write(
      join(root, 'config.yaml'),
      [
        'mcp_servers:',
        '  fetch: {command: uvx, args: [mcp-server-fetch]}',
        '  templated: {command: node, args: ["${HOME}/server.js"]}',
        '  folder: {command: node, args: [server.js], cwd: /srv/mcp}',
        '  tenant: {url: "https://${TENANT}.example.com/mcp"}',
        'plugins:',
        '  enabled: [fetch-pack]',
        '',
      ].join('\n'),
    );
    const pack = join(root, 'plugins', 'fetch-pack');
    await write(join(pack, 'plugin.json'), { $schema: PLUGIN_SCHEMA, name: 'fetch-pack' });
    await write(join(pack, 'mcp.json'), {
      $schema: MCP_SCHEMA,
      mcpServers: { packaged: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] } },
    });
    const inventory = ExtensionInventorySchema.parse(
      await createHermesExtensionService({ home, now }).inventory(managedProfile(root)),
    );
    const definitionOf = (id: string) => {
      const item = find(inventory, 'mcp-server', id);
      expect(item, id).toBeDefined();
      return item?.kind === 'mcp-server' ? item.definition : undefined;
    };
    expect(definitionOf('fetch')).toEqual({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] });
    for (const id of ['templated', 'folder', 'tenant', 'plugin:fetch-pack:packaged']) {
      expect(definitionOf(id), id).toBeUndefined();
    }
  });

  it('says every kind is unread when config.yaml cannot be read, and never repeats what it holds', async () => {
    const home = await tempHome();
    for (const [index, config] of [
      'mcp_servers:\n  leak: {command: "hunter2-in-a-broken-file"\n',
      'mcp_servers:\n\tgithub: {}\n',
      'defaults: &base\n  command: x\nmcp_servers:\n  one: *base\n',
      '- just\n- a list\n',
    ].entries()) {
      const root = join(home, `root-${index}`);
      await write(join(root, 'config.yaml'), config);
      await write(join(root, 'skills', 'alpha', 'SKILL.md'), skill('alpha', 'First'));
      const inventory = ExtensionInventorySchema.parse(
        await createHermesExtensionService({ home, now }).inventory(managedProfile(root)),
      );
      expect(inventory.items).toEqual([]);
      expect(inventory.unread).toEqual([
        { kind: 'plugin', message: 'config.yaml could not be read' },
        { kind: 'mcp-server', message: 'config.yaml could not be read' },
        { kind: 'skill', message: 'config.yaml could not be read' },
      ]);
      expect(JSON.stringify(inventory)).not.toContain('hunter2');
    }
  });

  it('reads a root that does not exist, or has no config yet, as what Hermes starts from', async () => {
    const home = await tempHome();
    const missing = ExtensionInventorySchema.parse(
      await createHermesExtensionService({ home, now }).inventory(managedProfile(join(home, 'fresh'))),
    );
    expect(missing.items).toEqual([]);
    expect(missing.unread).toBeUndefined();

    const bare = join(home, 'bare');
    await write(join(bare, 'skills', 'hermes-agent', 'SKILL.md'), skill('hermes-agent', 'How Hermes works'));
    await write(join(bare, 'plugins', 'solo', 'plugin.yaml'), 'name: solo\n');
    const unconfigured = ExtensionInventorySchema.parse(
      await createHermesExtensionService({ home, now }).inventory(managedProfile(bare)),
    );
    // No allow-list: nothing opt-in loads, and a skill with no ledger reads as the agent's.
    expect(unconfigured.items).toEqual([
      expect.objectContaining({ kind: 'plugin', id: 'solo', enabled: false }),
      expect.objectContaining({ kind: 'skill', id: 'hermes-agent', origin: 'agent', enabled: true }),
    ]);
    expect(unconfigured.unread).toBeUndefined();
  });
});

// ── acts (RFC 006 C2) ──

const actProfile = (kind: 'managed' | 'native-default', dataRoot: string) =>
  ({
    id: kind === 'managed' ? 'work-hermes' : 'hermes:native-default',
    provider: 'hermes',
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

describe('Hermes extension acts', () => {
  const hermes = createHermesExtensionService({ executable: '/opt/hermes/bin/hermes', home: '/Users/test' });
  it('removes a server of its own config with its own command, and turns none off by command', () => {
    expect(hermes.plan!(actProfile('managed', '/profiles/work/hermes'), actServer(), 'remove')).toMatchObject({
      available: true,
      runs: {
        kind: 'command',
        argv: ['/opt/hermes/bin/hermes', 'mcp', 'remove', 'linear'],
        env: { HERMES_HOME: '/profiles/work/hermes' },
      },
      reaches: ['definition'],
    });
    expect(hermes.plan!(actProfile('managed', '/p'), actServer(), 'disable')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
  });

  it('signs in to a server its config marks auth: oauth in a terminal, and has no command that signs out', () => {
    const work = actProfile('managed', '/profiles/work/hermes');
    expect(hermes.plan!(work, actServer({ auth: 'needs-sign-in' }), 'sign-in')).toMatchObject({
      available: true,
      runs: {
        kind: 'terminal',
        argv: ['/opt/hermes/bin/hermes', 'mcp', 'login', 'linear'],
        env: { HERMES_HOME: '/profiles/work/hermes' },
      },
      reaches: [],
    });
    expect(hermes.plan!(work, actServer({ auth: 'signed-in' }), 'sign-out')).toMatchObject({
      available: false,
      reason: 'no-command',
    });
    expect(hermes.plan!(work, actServer(), 'sign-in')).toMatchObject({ available: false, reason: 'no-sign-in' });
  });

  it('adds no server for a host: its own add asks which of the tools to use before it saves', () => {
    const work = actProfile('managed', '/profiles/work/hermes');
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
    expect(ExtensionActPlanSchema.parse(hermes.plan!(work, context7, 'add'))).toEqual({
      target: { kind: 'mcp-server', id: 'context7' },
      act: 'add',
      available: false,
      reason: 'in-app',
      message:
        'Hermes adds a server only in its own terminal: `hermes mcp add` connects to it and asks which of its tools to use',
    });
    const linear = actServer({ definition: { transport: 'http', url: 'https://mcp.linear.app/mcp' } });
    expect(hermes.plan!(actProfile('native-default', '/Users/test'), linear, 'add')).toMatchObject({
      available: false,
      reason: 'in-app',
    });
  });
});
