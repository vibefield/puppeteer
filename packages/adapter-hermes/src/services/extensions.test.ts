import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileSchema,
  ExtensionActKindSchema,
  ExtensionActPlanSchema,
  ExtensionCatalogSchema,
  ExtensionInventorySchema,
  ExtensionProviderSchema,
  type CatalogPlugin,
  type ExtensionActItem,
  type ExtensionInventory,
  type ExtensionItem,
  type PluginItem,
  type SkillItem,
} from '@vibefield/puppeteer-core';
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
        plugins: {
          store: 'mixed',
          changes: 'command',
          read: true,
          sources: 'A GitHub repository (owner/repo) or a git address',
          catalog: true,
        },
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
    // A link is the person's: Hermes writes only real folders, and its curator never follows one.
    expect(find(inventory, 'skill', 'linked')).toMatchObject({ origin: 'own', linkTarget: library });
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

describe('Hermes skills placed', () => {
  it("links a kept skill directly into the root's skills/, and refuses one it cannot place", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'hermes', 'h-7a10');
    const kept = join(home, 'kept', 'release-notes');
    const hermes = createHermesExtensionService({ home, now });
    expect(
      ExtensionActPlanSchema.parse(hermes.plan!(managedProfile(root), actSkill({ linkTarget: kept }), 'add')),
    ).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'link', path: join(root, 'skills', 'release-notes'), target: kept }] },
      display: 'link ~/kept/release-notes → ~/profiles/hermes/h-7a10/skills/release-notes',
      reaches: [],
    });
    // The native default's is the given home's `.hermes`, whatever path the profile carries.
    expect(hermes.plan!(nativeProfile('/nowhere/.hermes'), actSkill({ linkTarget: kept }), 'add')).toMatchObject({
      available: true,
      runs: { steps: [{ op: 'link', path: join(home, '.hermes', 'skills', 'release-notes'), target: kept }] },
      display: 'link ~/kept/release-notes → ~/.hermes/skills/release-notes',
    });
    // No folder to link, a name that is not one folder, or one Hermes's walk passes over.
    for (const fields of [
      {},
      { id: '../escape', linkTarget: kept },
      { id: '.hidden', linkTarget: kept },
      { id: 'node_modules', linkTarget: kept },
      { id: '_org', linkTarget: kept },
    ]) {
      expect(hermes.plan!(managedProfile(root), actSkill(fields), 'add'), JSON.stringify(fields)).toMatchObject({
        available: false,
        reason: 'unsupported',
      });
    }
  });

  it("reads a link in the root's skills/ as the person's own, and takes away only such a link", async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'hermes', 'h-7a10');
    const skills = join(root, 'skills');
    await write(join(skills, '.bundled_manifest'), 'hermes-agent:4f2a\n');
    await write(join(skills, '.hub', 'lock.json'), {
      version: 1,
      installed: { 'release-notes': { install_path: 'release-notes', source: 'skills.sh' } },
    });
    await write(join(skills, 'hermes-agent', 'SKILL.md'), skill('hermes-agent', 'How Hermes works'));
    await write(join(skills, 'release-notes', 'SKILL.md'), skill('release-notes', 'Drafts release notes'));
    await write(join(skills, 'notes', 'SKILL.md'), skill('notes', 'Written by the agent'));
    const library = join(home, 'library');
    await write(join(library, 'changelog', 'SKILL.md'), skill('changelog', 'Kept by the host'));
    await write(join(library, 'arxiv', 'SKILL.md'), skill('arxiv', 'Linked into a category'));
    await symlink(join(library, 'changelog'), join(skills, 'changelog'));
    await mkdir(join(skills, 'research'));
    await symlink(join(library, 'arxiv'), join(skills, 'research', 'arxiv'));

    const hermes = createHermesExtensionService({ home, now });
    const work = managedProfile(root);
    const inventory = ExtensionInventorySchema.parse(await hermes.inventory(work));
    const held = (id: string): SkillItem => {
      const item = find(inventory, 'skill', id);
      expect(item, id).toBeDefined();
      return item as SkillItem;
    };
    expect(held('changelog')).toMatchObject({
      origin: 'own',
      location: join(skills, 'changelog'),
      linkTarget: join(library, 'changelog'),
    });
    expect(held('arxiv')).toMatchObject({ origin: 'own', location: join(skills, 'research', 'arxiv') });
    expect(held('release-notes')).toMatchObject({ origin: 'own', location: join(skills, 'release-notes') });
    expect(held('release-notes')).not.toHaveProperty('linkTarget');
    expect(held('notes')).toMatchObject({ origin: 'agent' });
    expect(held('hermes-agent')).toMatchObject({ origin: 'bundled' });

    const remove = (id: string) =>
      ExtensionActPlanSchema.parse(hermes.plan!(work, held(id), 'remove', { keepIn: join(home, 'kept', id) }));
    // A link goes, even with somewhere to keep it: the folder it points to is the host's.
    expect(remove('changelog')).toEqual({
      target: { kind: 'skill', id: 'changelog' },
      act: 'remove',
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: join(skills, 'changelog') }] },
      display: 'unlink ~/profiles/hermes/h-7a10/skills/changelog',
      reaches: [],
    });
    // The hub's folder never moves, whatever keep the host offers.
    expect(remove('release-notes')).toEqual({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'remove',
      available: false,
      reason: 'no-command',
      message:
        "Hermes's skills hub installed release-notes and keeps track of it, so its folder stays where Hermes put it",
    });
    // A link in a category folder, the curator's and the bundled ones are not the host's to take.
    expect(remove('arxiv')).toMatchObject({ available: false, reason: 'not-own' });
    expect(remove('notes')).toMatchObject({
      available: false,
      reason: 'not-own',
      message: 'Hermes wrote it itself, and changes it itself',
    });
    expect(remove('hermes-agent')).toMatchObject({
      available: false,
      reason: 'not-own',
      message: 'It ships with Hermes',
    });
    // A placed skill still has no switch a host can drive.
    expect(hermes.plan!(work, held('changelog'), 'disable')).toMatchObject({ available: false, reason: 'no-command' });
  });
});

describe('Hermes plugin acts', () => {
  const HERMES = '/opt/hermes/bin/hermes';

  /** The populated root, read, with a service whose acts run HERMES. */
  async function readRoot() {
    const { home, root } = await populatedRoot();
    const hermes = createHermesExtensionService({ executable: HERMES, home, now });
    const work = managedProfile(root);
    const inventory = ExtensionInventorySchema.parse(await hermes.inventory(work));
    const held = (id: string): PluginItem => {
      const item = find(inventory, 'plugin', id);
      if (item?.kind !== 'plugin') throw new Error(`no plugin ${id}`);
      return item;
    };
    return { root, hermes, work, held };
  }

  it("turns a bundled plugin on and off in the root's own config, and leaves the rest of it to the install", async () => {
    const { root, hermes, work, held } = await readRoot();
    for (const act of ['enable', 'disable'] as const) {
      expect(ExtensionActPlanSchema.parse(hermes.plan!(work, held('bundled:kanban'), act))).toEqual({
        target: { kind: 'plugin', id: 'bundled:kanban' },
        act,
        available: true,
        runs: { kind: 'command', argv: [HERMES, 'plugins', act, 'kanban'], env: { HERMES_HOME: root } },
        display: `${HERMES} plugins ${act} kanban`,
        reaches: [],
      });
    }
    // Its code is the install's, which every root on it shares.
    for (const act of ['remove', 'purge', 'update'] as const) {
      expect(hermes.plan!(work, held('bundled:kanban'), act)).toEqual({
        target: { kind: 'plugin', id: 'bundled:kanban' },
        act,
        available: false,
        reason: 'not-own',
        message: 'It ships with Hermes',
      });
    }
    // A bundled plugin in a category folder is keyed by its path.
    expect(hermes.plan!(work, held('bundled:image_gen/openai'), 'disable')).toMatchObject({
      available: false,
      reason: 'no-command',
      message: "Hermes's commands do not take this plugin's name",
    });
  });

  it("turns off and removes one of the root's own by command, and turns one on or updates it in a terminal", async () => {
    const { root, hermes, work, held } = await readRoot();
    for (const act of ['disable', 'remove'] as const) {
      expect(ExtensionActPlanSchema.parse(hermes.plan!(work, held('disk-cleanup'), act)), act).toEqual({
        target: { kind: 'plugin', id: 'disk-cleanup' },
        act,
        available: true,
        runs: { kind: 'command', argv: [HERMES, 'plugins', act, 'disk-cleanup'], env: { HERMES_HOME: root } },
        display: `${HERMES} plugins ${act} disk-cleanup`,
        reaches: [],
      });
    }
    // Turning it on asks what it may do, and an update that widens it asks first: with no one to answer,
    // Hermes grants nothing and applies no such update.
    for (const act of ['enable', 'update'] as const) {
      for (const id of ['disk-cleanup', 'review-pack']) {
        expect(ExtensionActPlanSchema.parse(hermes.plan!(work, held(id), act)), `${act} ${id}`).toEqual({
          target: { kind: 'plugin', id },
          act,
          available: true,
          runs: { kind: 'terminal', argv: [HERMES, 'plugins', act, id], env: { HERMES_HOME: root } },
          display: `${HERMES} plugins ${act} ${id}`,
          reaches: [],
        });
      }
    }
    // The native default is Hermes's own root: nothing points the command elsewhere.
    const native = ExtensionActPlanSchema.parse(
      hermes.plan!(nativeProfile('/nowhere/.hermes'), held('disk-cleanup'), 'update'),
    );
    expect(native).toMatchObject({
      available: true,
      runs: { kind: 'terminal', argv: [HERMES, 'plugins', 'update', 'disk-cleanup'] },
    });
    expect(native).not.toHaveProperty('runs.env');
  });

  it('removes a plugin only as Hermes does, keeping its data: there is no purge', async () => {
    const { hermes, work, held } = await readRoot();
    for (const id of ['disk-cleanup', 'web/firecrawl']) {
      expect(hermes.plan!(work, held(id), 'purge'), id).toEqual({
        target: { kind: 'plugin', id },
        act: 'purge',
        available: false,
        reason: 'unsupported',
        message: "Hermes keeps a plugin's data in plugin-data when it removes it, and has no way to delete it",
      });
    }
  });

  it("refuses a key its commands would read as a path, a plugin that is not the root's, and acts a plugin has none of", async () => {
    const { hermes, work, held } = await readRoot();
    for (const act of ['enable', 'disable', 'remove', 'update'] as const) {
      expect(hermes.plan!(work, held('web/firecrawl'), act), act).toEqual({
        target: { kind: 'plugin', id: 'web/firecrawl' },
        act,
        available: false,
        reason: 'no-command',
        message: "Hermes's commands do not take this plugin's name",
      });
    }
    const managed: PluginItem = { kind: 'plugin', id: 'org-pack', name: 'org-pack', origin: 'managed', enabled: true };
    for (const act of ['enable', 'disable', 'remove'] as const) {
      expect(hermes.plan!(work, managed, act), act).toMatchObject({
        available: false,
        reason: 'not-own',
        message: "Hermes's app or your organization adds it, and changes it",
      });
    }
    expect(hermes.plan!(work, held('disk-cleanup'), 'add')).toMatchObject({
      available: false,
      reason: 'unsupported',
      message: 'Hermes installs a plugin from its catalog or a repository',
    });
    for (const act of ['sign-in', 'sign-out'] as const) {
      expect(hermes.plan!(work, held('bundled:kanban'), act), act).toMatchObject({
        available: false,
        reason: 'unsupported',
        message: 'Hermes has no sign-in for a plugin',
      });
    }
  });
});

// ── the catalog and installs (RFC 006 C2) ──

/** A commit whose first eight characters are `digit`; never all digits, which YAML would read as a number. */
const sha = (digit: string) => `${digit.repeat(39)}f`;
const catalogNow = () => new Date('2026-09-27T12:00:00.000Z');
/** The installer's wrapper, which names the checkout that ships the catalog. */
const wrapperFor = (checkout: string) =>
  `#!/usr/bin/env bash\nunset PYTHONPATH\nexec "${checkout}/venv/bin/python" "${checkout}/hermes" "$@"\n`;

/** Shipped entries as the real catalog writes them: block and flow lists, folded text, quoted labels. */
const SHIPPED: Record<string, string> = {
  'aihubmix.yaml': [
    'name: aihubmix',
    'repo: https://github.com/AIhubmix/hermes-provider-aihubmix',
    `sha: ${sha('2')}`,
    'subdir: aihubmix',
    'description: AIHubMix — unified OpenAI-compatible access to 400+ models.',
    'maintainer: Ada Lovelace <ada@example.com>',
    'tier: community',
    'category: models',
    'docs_url: "https://docs.example.com/aihubmix?token=ghp_docs0secret0value"',
    'capabilities:',
    '  provides_tools:',
    '    - aihubmix_models',
    '  provides_hooks:',
    '  - pre_llm_call',
    '  provides_middleware: []',
    '  requires_env:',
    '  - AIHUBMIX_API_KEY',
    '',
  ].join('\n'),
  'blender.yaml': [
    'name: blender',
    'repo: https://github.com/NousResearch/hermes-plugin-blender',
    `sha: ${sha('1')}`,
    'version: "0.1.0"',
    'description: >-',
    '  Official Blender Lab MCP server over stdio,',
    '  with a Blender workflow skill.',
    'title: Blender',
    'maintainer: NousResearch',
    'tier: official',
    'category: tools',
    'docs_url: https://github.com/NousResearch/hermes-plugin-blender#readme',
    'platforms: [windows, macos, linux]',
    'onboarding: true',
    'capabilities:',
    '  provides_tools: []',
    '  provides_hooks: []',
    '  provides_middleware: []',
    '  requires_env: []',
    '',
  ].join('\n'),
  // Dropped as Hermes drops them: no commit pinned, a repository not on https.
  'broken.yaml': 'name: broken\nrepo: https://github.com/acme/broken\nsha: not-a-commit\nmaintainer: acme\n',
  'http-repo.yaml': `name: http-repo\nrepo: http://example.com/acme/http-repo\nsha: ${sha('9')}\nmaintainer: acme\n`,
  'evil-tools.yaml': `name: evil-tools\nrepo: https://github.com/evil/bad\nsha: ${sha('3')}\ndescription: Looked useful\nmaintainer: evil\n`,
  'hermes-plugin-notes.yaml': [
    'name: hermes-plugin-notes',
    'repo: https://github.com/acme/hermes-plugin-notes',
    `sha: ${sha('5')}`,
    'version: 1.4.0',
    'description: Keeps notes between sessions',
    'maintainer: acme',
    'category: tools',
    'capabilities:',
    '  provides_tools: [notes_write, notes_read]',
    '',
  ].join('\n'),
  'kanban-sync.yaml': `name: kanban-sync\nrepo: https://github.com/acme/kanban-sync\nsha: ${sha('6')}\nmaintainer: acme\ncategory: automation\n`,
  'orbit-desktop.yaml': `name: orbit-desktop\nrepo: https://github.com/orbit/orbit-desktop\nsha: ${sha('4')}\nmaintainer: orbit\nplatforms:\n- linux\n`,
  'tagged.yaml': `name: tagged\nrepo: https://github.com/acme/tagged\nsha: ${sha('7')}\nmaintainer: acme\ncategory: general\n`,
  // The kill list names a repository the way a person might spell it.
  'removed.yaml': [
    '# Blocklist for plugins pulled from the catalog.',
    'removed:',
    '  - name: something-else',
    '    repo: git@github.com:Evil/Bad.git',
    '    reason: Sent credentials',
    '      to a third party',
    '    date: "2026-09-20"',
    '',
  ].join('\n'),
  'README.md': '# The catalog\n',
};

/** A record of the installer's, for a folder installed from a catalog entry at a commit. */
const record = (name: string, commit: string, pin = commit) => ({
  pinned: true,
  revision: commit,
  source: `https://github.com/acme/${name}.git`,
  catalog: { name, repo: `https://github.com/acme/${name}`, tier: 'community', sha: commit, pin },
});

async function catalogRoot(files: Record<string, string> = SHIPPED) {
  const home = await tempHome();
  const checkout = join(home, 'hermes-agent');
  for (const [file, content] of Object.entries(files)) await write(join(checkout, 'plugin-catalog', file), content);
  const root = join(home, 'profiles', 'hermes', 'h-c47a');
  const plugins = join(root, 'plugins');
  await write(join(root, '.env'), 'AIHUBMIX_API_KEY=sk-live-secret-value\n');
  await write(join(plugins, 'notes', 'plugin.yaml'), 'name: notes\nversion: 1.3.0\n');
  await write(join(plugins, 'kanban', 'plugin.yaml'), 'name: kanban\n');
  await write(join(plugins, 'tagged', 'plugin.yaml'), 'name: tagged\n');
  await write(join(plugins, 'spotify', 'plugin.yaml'), 'name: spotify\n');
  // A repository's own claim to be a catalog install is never read.
  await write(join(plugins, 'forged', 'plugin.yaml'), 'name: forged\n');
  await write(join(plugins, 'forged', '.hermes-catalog.json'), { catalog_name: 'orbit-desktop', sha: sha('4') });
  await write(join(plugins, 'pinned-tool', 'plugin.yaml'), 'name: pinned-tool\nversion: 0.4.0\n');
  // installed before the record named its entry: Hermes may adopt the file in its tree as a catalog install
  await write(join(plugins, 'legacy', 'plugin.yaml'), 'name: legacy\n');
  await write(join(plugins, 'legacy', '.hermes-catalog.json'), { catalog_name: 'blender', sha: sha('1') });
  await write(join(plugins, '.install-metadata.json'), {
    // installed from `hermes-plugin-notes` into a folder its manifest names, at an older pin
    notes: record('hermes-plugin-notes', sha('e')),
    kanban: record('kanban-sync', sha('6')),
    // an annotated tag pin: the tag object is the pin, the commit it names is checked out
    tagged: record('tagged', sha('8'), sha('7')),
    spotify: record('spotify', sha('b')),
    // its folder is gone, so it holds nothing — nor does it take the entry from the folder that holds it
    ghost: record('blender', sha('1')),
    'kanban-old': record('kanban-sync', sha('0')),
    forged: { pinned: false, revision: sha('d'), source: 'https://github.com/someone/forged.git' },
    // a repository installed at one commit with `--ref`
    'pinned-tool': { pinned: true, revision: sha('c'), source: 'https://github.com/acme/pinned-tool.git' },
    legacy: { pinned: true, revision: sha('1'), source: 'https://github.com/NousResearch/hermes-plugin-blender.git' },
  });
  const hermes = createHermesExtensionService({
    home,
    now: catalogNow,
    readWrapper: async () => wrapperFor(checkout),
    platform: 'darwin',
  });
  return { home, checkout, root, hermes, profile: managedProfile(root) };
}

async function readCatalog(hermes: ReturnType<typeof createHermesExtensionService>, root: string) {
  return ExtensionCatalogSchema.parse(await hermes.catalog!(managedProfile(root)));
}

const listedIn = (plugins: readonly CatalogPlugin[], id: string) => plugins.find((plugin) => plugin.id === id);

/** A copy of the published catalog as Hermes caches it, `hoursOld` before the read. */
async function fetchedCopy(root: string, document: unknown, hoursOld: number): Promise<void> {
  const path = join(root, 'cache', 'plugin-catalog.json');
  await write(path, document);
  const modified = new Date(catalogNow().getTime() - hoursOld * 60 * 60 * 1000);
  await utimes(path, modified, modified);
}

const FETCHED = {
  generated_at: '2026-09-27T08:30:00.123456+00:00',
  entries: [
    // at the checkout's pin, published before the entry had a title
    {
      name: 'blender',
      repo: 'https://github.com/NousResearch/hermes-plugin-blender',
      sha: sha('1'),
      version: '0.1.0',
      description: 'Official Blender Lab MCP server over stdio.',
      maintainer: 'NousResearch',
      tier: 'official',
      category: 'tools',
      capabilities: { provides_tools: [], provides_hooks: [], provides_middleware: [], requires_env: [] },
    },
    { name: 'spotify', repo: 'https://github.com/acme/spotify', sha: sha('b'), version: '0.1.2', maintainer: 'acme' },
    { name: 'aihubmix', repo: 'https://github.com/AIhubmix/hermes-provider-aihubmix', sha: sha('c'), maintainer: 'x' },
    { name: 'pre-release', repo: 'https://github.com/acme/pre-release', sha: sha('4'), version: '0.9.0' },
    { name: 'beta-dev', repo: 'https://github.com/acme/beta-dev', sha: sha('6'), version: '0.2.0.dev1' },
    { name: 'local-label', repo: 'https://github.com/acme/local-label', sha: sha('8'), version: '0.1.3' },
    { name: 'fresh-plugin', repo: 'https://github.com/acme/fresh-plugin', sha: sha('9'), maintainer: 'acme' },
    { name: 'Not A Name', repo: 'https://github.com/acme/not-a-name', sha: sha('a') },
  ],
  removed: [
    { name: 'fresh-plugin', reason: 'Pulled after review', date: '2026-09-26' },
    { name: 'orbit-desktop', reason: 'Abandoned' },
  ],
};

/** The checkout's side of the same entries: some pinned newer, some older, one only here. */
const SHIPPED_BESIDE_FETCHED: Record<string, string> = {
  'blender.yaml': SHIPPED['blender.yaml']!,
  'aihubmix.yaml': SHIPPED['aihubmix.yaml']!,
  'orbit-desktop.yaml': SHIPPED['orbit-desktop.yaml']!,
  'spotify.yaml': `name: spotify\nrepo: https://github.com/acme/spotify\nsha: ${sha('a')}\nversion: "0.2.0"\nmaintainer: acme\n`,
  'pre-release.yaml': `name: pre-release\nrepo: https://github.com/acme/pre-release\nsha: ${sha('3')}\nversion: 0.9.0-pre.3\n`,
  'beta-dev.yaml': `name: beta-dev\nrepo: https://github.com/acme/beta-dev\nsha: ${sha('5')}\nversion: 0.2.0-beta.1\n`,
  'local-label.yaml': `name: local-label\nrepo: https://github.com/acme/local-label\nsha: ${sha('7')}\nversion: 0.1.3+a0782b7\n`,
};

describe('Hermes catalog', () => {
  it("reads the checkout's catalog: each entry as Hermes offers it, what the root holds from it, and no secret", async () => {
    const { root, hermes } = await catalogRoot();
    const catalog = await readCatalog(hermes, root);

    const document = JSON.stringify(catalog);
    for (const secret of ['ada@example.com', 'ghp_docs0secret0value', 'sk-live-secret-value']) {
      expect(document).not.toContain(secret);
    }
    expect(catalog).toMatchObject({
      provider: 'hermes',
      profileId: 'work-hermes',
      fetchedAt: '2026-09-27T12:00:00.000Z',
      source: { kind: 'native-store', stability: 'experimental' },
    });
    // No copy fetched yet: the catalog is the install's own, with no fetch to date it.
    expect(catalog.marketplaces).toEqual([
      {
        id: 'hermes-catalog',
        name: 'Hermes plugin catalog',
        source: 'hermes-agent.nousresearch.com',
        origin: 'bundled',
      },
    ]);
    expect(catalog.suggested).toBeUndefined();
    // In file order; the entries Hermes drops are gone.
    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual([
      'aihubmix',
      'blender',
      'evil-tools',
      'hermes-plugin-notes',
      'kanban-sync',
      'orbit-desktop',
      'tagged',
    ]);

    expect(listedIn(catalog.plugins, 'aihubmix')).toEqual({
      id: 'aihubmix',
      name: 'aihubmix',
      marketplace: 'hermes-catalog',
      description: 'AIHubMix — unified OpenAI-compatible access to 400+ models.',
      author: 'Ada Lovelace',
      category: 'models',
      version: '22222222',
      homepage: 'https://docs.example.com/aihubmix?•••',
      brings: { tools: ['aihubmix_models'], hooks: ['pre_llm_call'] },
      asks: [{ kind: 'scan' }, { kind: 'values', names: ['AIHUBMIX_API_KEY'] }, { kind: 'consent' }],
    });
    // Its title names it; its label rides the pin; its docs lose their fragment. The record of it is a
    // folder that is gone, so it is not held.
    expect(listedIn(catalog.plugins, 'blender')).toEqual({
      id: 'blender',
      name: 'Blender',
      marketplace: 'hermes-catalog',
      description: 'Official Blender Lab MCP server over stdio, with a Blender workflow skill.',
      author: 'NousResearch',
      category: 'tools',
      version: '0.1.0 @ 11111111',
      homepage: 'https://github.com/NousResearch/hermes-plugin-blender',
      asks: [{ kind: 'scan' }, { kind: 'consent' }],
    });
    // Kill-listed by its repository, however the list spells it.
    expect(listedIn(catalog.plugins, 'evil-tools')).toMatchObject({
      category: 'desktop',
      homepage: 'https://github.com/evil/bad',
      blocked: 'It was removed from the Hermes plugin catalog: Sent credentials to a third party',
    });
    expect(listedIn(catalog.plugins, 'orbit-desktop')).toMatchObject({ blocked: 'Hermes offers it only on Linux' });
    // Installed from the entry into a folder of another name, at an older pin: held by the inventory's id.
    expect(listedIn(catalog.plugins, 'hermes-plugin-notes')).toMatchObject({
      version: '1.4.0 @ 55555555',
      brings: { tools: ['notes_write', 'notes_read'] },
      held: 'notes',
      newer: true,
    });
    expect(listedIn(catalog.plugins, 'kanban-sync')).toMatchObject({ held: 'kanban' });
    expect(listedIn(catalog.plugins, 'tagged')).toMatchObject({ held: 'tagged' });
    for (const id of ['kanban-sync', 'tagged']) expect(listedIn(catalog.plugins, id), id).not.toHaveProperty('newer');
    for (const id of ['aihubmix', 'blender', 'evil-tools', 'orbit-desktop']) {
      expect(listedIn(catalog.plugins, id), id).not.toHaveProperty('held');
    }

    // The ids it gives are the inventory's.
    const inventory = ExtensionInventorySchema.parse(await hermes.inventory(managedProfile(root)));
    for (const plugin of catalog.plugins.filter((listed) => listed.held !== undefined)) {
      expect(find(inventory, 'plugin', plugin.held!), plugin.id).toBeDefined();
    }
  });

  it('reads a repository installed at one commit as pinned, and plans no update for it', async () => {
    const { root, hermes } = await catalogRoot();
    const work = managedProfile(root);
    const inventory = ExtensionInventorySchema.parse(await hermes.inventory(work));
    const held = (id: string): PluginItem => {
      const item = find(inventory, 'plugin', id);
      if (item?.kind !== 'plugin') throw new Error(`no plugin ${id}`);
      return item;
    };
    expect(held('pinned-tool')).toMatchObject({ version: '0.4.0', pinned: true });
    // A catalog install is recorded pinned, but its update moves it to the catalog's pin; so may one Hermes
    // adopts as a catalog install from the file in its tree; a repository followed at its branch moves.
    for (const id of ['notes', 'kanban', 'legacy', 'forged']) expect(held(id), id).not.toHaveProperty('pinned');

    expect(ExtensionActPlanSchema.parse(hermes.plan!(work, held('pinned-tool'), 'update'))).toEqual({
      target: { kind: 'plugin', id: 'pinned-tool' },
      act: 'update',
      available: false,
      reason: 'no-command',
      message: 'Hermes keeps pinned-tool pinned to the commit it was installed at; its update never moves it',
    });
    // The rest of its acts are its own still; a catalog install updates in a terminal.
    expect(hermes.plan!(work, held('pinned-tool'), 'remove')).toMatchObject({
      available: true,
      runs: { kind: 'command' },
    });
    expect(hermes.plan!(work, held('notes'), 'update')).toMatchObject({
      available: true,
      runs: { kind: 'terminal', argv: [expect.any(String), 'plugins', 'update', 'notes'] },
    });
  });

  it("takes the root's fetched copy as the catalog while it is under a day old, each entry from the newer copy", async () => {
    const { root, hermes } = await catalogRoot(SHIPPED_BESIDE_FETCHED);
    await fetchedCopy(root, FETCHED, 7);
    const catalog = await readCatalog(hermes, root);
    expect(catalog.marketplaces).toEqual([
      {
        id: 'hermes-catalog',
        name: 'Hermes plugin catalog',
        source: 'hermes-agent.nousresearch.com',
        updatedAt: '2026-09-27T08:30:00.123Z',
        origin: 'bundled',
      },
    ]);
    // The fetched copy's entries, in its order: one only in the checkout is not offered, an invalid one is dropped.
    expect(catalog.plugins.map((plugin) => [plugin.id, plugin.version])).toEqual([
      ['blender', '0.1.0 @ 11111111'],
      // the checkout's label is the later one
      ['spotify', '0.2.0 @ aaaaaaaa'],
      // no labels to compare: the fetched copy's
      ['aihubmix', 'cccccccc'],
      // 0.9.0rc3 is before 0.9.0
      ['pre-release', '0.9.0 @ 44444444'],
      // a beta is after a dev release
      ['beta-dev', '0.2.0-beta.1 @ 55555555'],
      // a local label is after the release it builds on
      ['local-label', '0.1.3+a0782b7 @ 77777777'],
      ['fresh-plugin', '99999999'],
    ]);
    // The copy was published before the entry had a title: the checkout's, at the same pin, names it.
    expect(listedIn(catalog.plugins, 'blender')).toMatchObject({
      name: 'Blender',
      description: 'Official Blender Lab MCP server over stdio.',
    });
    expect(listedIn(catalog.plugins, 'fresh-plugin')).toMatchObject({
      blocked: 'It was removed from the Hermes plugin catalog: Pulled after review',
    });
    // Held at the fetched copy's pin, which the checkout's newer pin replaces.
    expect(listedIn(catalog.plugins, 'spotify')).toMatchObject({ held: 'spotify', newer: true });
  });

  it('lists no more of a fetched copy than a catalog carries', async () => {
    const { root, hermes } = await catalogRoot(SHIPPED_BESIDE_FETCHED);
    const entries = Array.from({ length: 9_000 }, (_, index) => ({
      name: `plugin-${index}`,
      repo: `https://github.com/acme/plugin-${index}`,
      sha: sha('b'),
    }));
    await fetchedCopy(root, { generated_at: '2026-09-27T08:30:00Z', entries }, 1);
    const catalog = await readCatalog(hermes, root);
    expect(catalog.plugins).toHaveLength(8_192);
    expect(catalog.plugins.at(-1)).toMatchObject({ id: 'plugin-8191', version: 'bbbbbbbb' });
  });

  it('blocks an entry as Hermes asks: by its name, then its repository, the first removal in the list', async () => {
    const { root, hermes } = await catalogRoot(SHIPPED_BESIDE_FETCHED);
    await fetchedCopy(
      root,
      {
        ...FETCHED,
        removed: [
          { name: 'something-else', repo: 'git@github.com:Acme/Spotify.git', reason: 'Its repository' },
          { name: 'spotify', reason: 'Its name' },
          { name: 'fresh-plugin', reason: 'Listed first' },
          { name: 'fresh-plugin', reason: 'Listed again' },
          {
            name: 'another',
            repo: 'https://www.github.com/AIhubmix/hermes-provider-aihubmix/',
            reason: 'Its repository, spelled otherwise',
          },
        ],
      },
      1,
    );
    const catalog = await readCatalog(hermes, root);
    const blocked = (id: string) => listedIn(catalog.plugins, id)?.blocked;
    // `raise_if_removed(name, repo)`: the name is asked first, whatever else the list holds before it
    expect(blocked('spotify')).toBe('It was removed from the Hermes plugin catalog: Its name');
    expect(blocked('fresh-plugin')).toBe('It was removed from the Hermes plugin catalog: Listed first');
    expect(blocked('aihubmix')).toBe(
      'It was removed from the Hermes plugin catalog: Its repository, spelled otherwise',
    );
    expect(blocked('blender')).toBeUndefined();
  });

  it("reads a copy past a day old for its removals alone, and a copy that is not Hermes's as none", async () => {
    const { root, hermes } = await catalogRoot(SHIPPED_BESIDE_FETCHED);
    await fetchedCopy(root, FETCHED, 48);
    const stale = await readCatalog(hermes, root);
    expect(stale.marketplaces[0]).not.toHaveProperty('updatedAt');
    expect(stale.plugins.map((plugin) => [plugin.id, plugin.version])).toEqual([
      ['aihubmix', '22222222'],
      ['beta-dev', '0.2.0-beta.1 @ 55555555'],
      ['blender', '0.1.0 @ 11111111'],
      ['local-label', '0.1.3+a0782b7 @ 77777777'],
      ['orbit-desktop', '44444444'],
      ['pre-release', '0.9.0-pre.3 @ 33333333'],
      ['spotify', '0.2.0 @ aaaaaaaa'],
    ]);
    // A removal never expires, and comes before the platform.
    expect(listedIn(stale.plugins, 'orbit-desktop')).toMatchObject({
      blocked: 'It was removed from the Hermes plugin catalog: Abandoned',
    });
    expect(listedIn(stale.plugins, 'spotify')).toMatchObject({ held: 'spotify', newer: true });

    for (const copy of ['{"entries": [', '["not", "a", "catalog"]']) {
      await fetchedCopy(root, copy, 1);
      const unreadable = await readCatalog(hermes, root);
      expect(unreadable.marketplaces[0]).not.toHaveProperty('updatedAt');
      expect(unreadable.plugins.map((plugin) => plugin.id)).toHaveLength(7);
      expect(listedIn(unreadable.plugins, 'orbit-desktop')).toMatchObject({
        blocked: 'Hermes offers it only on Linux',
      });
    }
  });

  it('reads a fetched copy alone when no checkout is found, and says the catalog is unread when neither is', async () => {
    const home = await tempHome();
    const root = join(home, 'profiles', 'hermes', 'h-5d02');
    const without = createHermesExtensionService({ home, now: catalogNow, readWrapper: async () => undefined });
    const unread = await readCatalog(without, root);
    expect(unread.plugins).toEqual([]);
    expect(unread.marketplaces).toEqual([
      {
        id: 'hermes-catalog',
        name: 'Hermes plugin catalog',
        source: 'hermes-agent.nousresearch.com',
        origin: 'bundled',
        unread: "Hermes's catalog could not be read from its install",
      },
    ]);
    // A wrapper whose checkout ships no catalog, or a wrapper that is not the installer's.
    for (const wrapper of [wrapperFor(join(home, 'old-checkout')), '#!/bin/sh\nexec python3 -m hermes "$@"\n']) {
      const service = createHermesExtensionService({ home, now: catalogNow, readWrapper: async () => wrapper });
      expect((await readCatalog(service, root)).marketplaces[0], wrapper).toHaveProperty('unread');
    }

    // The native default keeps its copy in `~/.hermes`, whatever path the profile carries.
    await fetchedCopy(join(home, '.hermes'), FETCHED, 1);
    const native = ExtensionCatalogSchema.parse(await without.catalog!(nativeProfile('/nowhere/.hermes')));
    expect(native.marketplaces[0]).toMatchObject({ updatedAt: '2026-09-27T08:30:00.123Z' });
    expect(native.marketplaces[0]).not.toHaveProperty('unread');
    expect(native.plugins.map((plugin) => [plugin.id, plugin.version])).toEqual([
      ['blender', '0.1.0 @ 11111111'],
      ['spotify', '0.1.2 @ bbbbbbbb'],
      ['aihubmix', 'cccccccc'],
      ['pre-release', '0.9.0 @ 44444444'],
      ['beta-dev', '0.2.0.dev1 @ 66666666'],
      ['local-label', '0.1.3 @ 88888888'],
      ['fresh-plugin', '99999999'],
    ]);
    expect(listedIn(native.plugins, 'blender')).toMatchObject({ name: 'blender' });
  });
});

describe('Hermes reads crafted text in time', () => {
  // Every file here is anyone's to write, and the read runs on the host's event loop: each crafted value (~20k
  // characters, or 20k lines) is one that a backtracking pattern, or a rescan per line, once took seconds over.
  it('reads a catalog and a root whose values are built to backtrack, in well under two seconds', async () => {
    const { home, checkout, root } = await catalogRoot({});
    const catalogFile = (name: string, lines: string[]) =>
      write(
        join(checkout, 'plugin-catalog', `${name}.yaml`),
        [`name: ${name}`, 'repo: https://github.com/acme/tool', `sha: ${sha('a')}`, ...lines, ''].join('\n'),
      );
    const run = ' '.repeat(20_000);
    await catalogFile('quoted-run', [`description: "a${run}b"`]);
    await catalogFile('plain-run', ['description: first line', `  a${run}b`]);
    await catalogFile('flow-lines', [
      'capabilities:',
      '  provides_tools: [',
      ...Array(20_000).fill('    tool,'),
      // deeper than its key, as a flow collection's lines must be
      '    ]',
    ]);
    await catalogFile('open-quote', ['description: "', ...Array(20_000).fill('  word'), '  "']);
    await catalogFile('long-words', [
      `maintainer: ${'a'.repeat(20_000)}`,
      `docs_url: https://docs.example.com/${'/'.repeat(20_000)}x`,
    ]);
    await write(
      join(checkout, 'plugin-catalog', 'removed.yaml'),
      `removed:\n  - name: gone\n    repo: git@github.com:${'/'.repeat(20_000)}x\n`,
    );
    await fetchedCopy(
      root,
      {
        generated_at: `2026-09-27T08:30:00.${'1'.repeat(20_000)}x`,
        entries: [
          {
            name: 'fetched-run',
            repo: `https://github.com/acme${'/'.repeat(20_000)}tool`,
            sha: sha('b'),
            maintainer: `${'('.repeat(10_000)}${'a'.repeat(10_000)}`,
          },
        ],
        removed: [{ name: 'gone', repo: `https://github.com/${'_/'.repeat(10_000)}x` }],
      },
      1,
    );
    await write(
      join(root, 'config.yaml'),
      [
        'mcp_servers:',
        `  "a${'_'.repeat(20_000)}b":`,
        '    url: https://mcp.example.com/mcp',
        '    auth: oauth',
        '  templated:',
        '    command: node',
        // what a server reads through `${…}` is found in every value; the command line itself stays short
        '    env:',
        `      TOKEN: "${'${'.repeat(10_000)}"`,
        '',
      ].join('\n'),
    );
    const hermes = createHermesExtensionService({
      home,
      now: catalogNow,
      readWrapper: async () => wrapperFor(checkout),
      platform: 'darwin',
    });

    const started = performance.now();
    const catalog = await readCatalog(hermes, root);
    const inventory = ExtensionInventorySchema.parse(await hermes.inventory(managedProfile(root)));
    expect(performance.now() - started).toBeLessThan(2_000);

    // The fetched copy is the catalog while it is fresh; read without it, the checkout's entries all parse.
    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual(['fetched-run']);
    expect(listedIn(catalog.plugins, 'fetched-run')).toMatchObject({
      author: `${'('.repeat(10_000)}${'a'.repeat(10_000)}`.slice(0, 256),
    });
    expect(catalog.marketplaces[0]).not.toHaveProperty('updatedAt');
    await rm(join(root, 'cache'), { recursive: true });
    const shipped = await readCatalog(hermes, root);
    expect(shipped.plugins.map((plugin) => plugin.id)).toEqual([
      'flow-lines',
      'long-words',
      'open-quote',
      'plain-run',
      'quoted-run',
    ]);
    // cut at 2,048 characters, all spaces after the `a`, which the catalog's schema trims
    expect(listedIn(shipped.plugins, 'quoted-run')?.description).toBe('a');
    expect(listedIn(shipped.plugins, 'plain-run')?.description).toBe('first line a');
    expect(listedIn(shipped.plugins, 'flow-lines')?.brings).toEqual({ tools: ['tool'] });
    expect(listedIn(shipped.plugins, 'open-quote')?.description).toMatch(/^word word word/u);
    expect(listedIn(shipped.plugins, 'long-words')).toMatchObject({ author: 'a'.repeat(256) });
    expect(find(inventory, 'mcp-server', `a${'_'.repeat(20_000)}b`.slice(0, 512))).toMatchObject({
      auth: 'needs-sign-in',
    });
    expect(find(inventory, 'mcp-server', 'templated')).toMatchObject({ transport: 'stdio', env: ['TOKEN'] });
  });
});

describe('Hermes installs', () => {
  const HERMES = '/opt/hermes/bin/hermes';
  const hermes = createHermesExtensionService({
    executable: HERMES,
    home: '/Users/test',
    readWrapper: async () => undefined,
  });
  const work = actProfile('managed', '/profiles/work/hermes');
  const native = actProfile('native-default', '/Users/test/.hermes');
  const entry = (fields: Partial<CatalogPlugin> = {}): CatalogPlugin => ({
    id: 'aihubmix',
    name: 'aihubmix',
    marketplace: 'hermes-catalog',
    version: 'b55e9163',
    asks: [{ kind: 'scan' }, { kind: 'values', names: ['AIHUBMIX_API_KEY'] }, { kind: 'consent' }],
    ...fields,
  });
  /** The plugin as the runtime hands an install from a catalog entry to the adapter. */
  const fromCatalog = (listed: CatalogPlugin): PluginItem => ({
    kind: 'plugin',
    id: listed.id,
    name: listed.name,
    origin: 'own',
    enabled: true,
    marketplace: listed.marketplace,
    ...(listed.version === undefined ? {} : { version: listed.version }),
  });
  const fromSource = (source: string): PluginItem => ({
    kind: 'plugin',
    id: source,
    name: source,
    origin: 'own',
    enabled: true,
  });

  it('installs a catalog entry by its name, in a terminal the person answers', () => {
    const listed = entry();
    expect(ExtensionActPlanSchema.parse(hermes.plan!(work, fromCatalog(listed), 'install', { listed }))).toEqual({
      target: { kind: 'plugin', id: 'aihubmix' },
      act: 'install',
      available: true,
      runs: {
        kind: 'terminal',
        argv: [HERMES, 'plugins', 'install', 'aihubmix'],
        env: { HERMES_HOME: '/profiles/work/hermes' },
      },
      display: `${HERMES} plugins install aihubmix`,
      reaches: [],
    });
    const plan = ExtensionActPlanSchema.parse(hermes.plan!(native, fromCatalog(listed), 'install', { listed }));
    expect(plan).toMatchObject({
      available: true,
      runs: { kind: 'terminal', argv: [HERMES, 'plugins', 'install', 'aihubmix'] },
    });
    expect(plan).not.toHaveProperty('runs.env');
  });

  it('refuses an entry the root holds, one its catalog blocks here, and a name its catalog cannot have', () => {
    const held = entry({ held: 'aihubmix-provider', newer: true });
    expect(hermes.plan!(work, fromCatalog(held), 'install', { listed: held })).toEqual({
      target: { kind: 'plugin', id: 'aihubmix' },
      act: 'install',
      available: false,
      reason: 'held',
      message: 'Hermes already has aihubmix; update it instead',
    });
    const blocked = entry({ blocked: 'Hermes offers it only on Linux' });
    expect(hermes.plan!(work, fromCatalog(blocked), 'install', { listed: blocked })).toEqual({
      target: { kind: 'plugin', id: 'aihubmix' },
      act: 'install',
      available: false,
      reason: 'blocked',
      message: 'Hermes offers it only on Linux',
    });
    for (const id of ['Aihubmix', 'acme/notes', '-rf', 'a'.repeat(65)]) {
      const listed = entry({ id, name: id });
      expect(hermes.plan!(work, fromCatalog(listed), 'install', { listed }), id).toEqual({
        target: { kind: 'plugin', id },
        act: 'install',
        available: false,
        reason: 'unsupported',
        message: `Hermes's catalog has no plugin named ${id}`,
      });
    }
  });

  it('installs a repository or a git address it is given in a terminal, and refuses any other source', () => {
    for (const source of [
      'NousResearch/hermes-plugin-blender',
      'acme/monorepo/plugins/notes',
      'acme/monorepo#plugins/notes',
      'https://github.com/acme/hermes-plugin-notes',
      'https://github.com/acme/monorepo/tree/main/plugins/notes',
      'https://gitlab.com/acme/notes.git#plugins/notes',
      'ssh://git.example.com/acme/notes.git',
      'git@github.com:acme/notes.git',
      'https://github.com/acme/notes/',
      'ssh://git.example.com:2222/acme/notes.git',
      'git@gitlab.example.com:team/sub/notes.git#plugins/notes',
    ]) {
      expect(
        ExtensionActPlanSchema.parse(hermes.plan!(work, fromSource(source), 'install', { source, holds: ['notes'] })),
        source,
      ).toEqual({
        target: { kind: 'plugin', id: source },
        act: 'install',
        available: true,
        runs: {
          kind: 'terminal',
          argv: [HERMES, 'plugins', 'install', source],
          env: { HERMES_HOME: '/profiles/work/hermes' },
        },
        display: `${HERMES} plugins install ${source}`,
        reaches: [],
      });
    }
    for (const source of [
      // its catalog's, by name
      'brave-search',
      'http://example.com/acme/notes',
      'file:///Users/test/notes',
      '/Users/test/notes',
      './notes/plugin',
      '~/notes/plugin',
      '../acme/notes',
      'acme/../notes',
      'git://github.com/acme/notes',
      'https://token@github.com/acme/notes',
      'https://github.com/acme/notes?ref=main',
      'https://github.com',
      '-acme/notes',
      'acme/notes plugin',
      // an address's path is whole: one segment or more, never from `/`, nothing a shell or git would read
      'git@github.com:/srv/notes',
      'git@github.com:',
      'git@github.com:acme/notes;touch',
      'git@github.com:acme/notes#',
      'https://github.com/acme/no%20tes',
      'https://github.com/acme/notes;x',
      'ssh://git.example.com',
    ]) {
      expect(hermes.plan!(work, fromSource(source), 'install', { source, holds: [] }), source).toEqual({
        target: { kind: 'plugin', id: source },
        act: 'install',
        available: false,
        reason: 'unsupported',
        message: 'Hermes installs from its catalog by name, or from a GitHub repository or a git address',
      });
    }
  });

  it('has no marketplace: every act on one says so', () => {
    const marketplace: ExtensionActItem = {
      kind: 'marketplace',
      id: 'acme/marketplace',
      name: 'acme/marketplace',
      origin: 'own',
      enabled: true,
      source: 'acme/marketplace',
    };
    for (const act of ExtensionActKindSchema.options) {
      expect(ExtensionActPlanSchema.parse(hermes.plan!(work, marketplace, act)), act).toEqual({
        target: { kind: 'marketplace', id: 'acme/marketplace' },
        act,
        available: false,
        reason: 'unsupported',
        message:
          'Hermes installs plugins from its one reviewed catalog or from a repository; it has no marketplaces to add',
      });
    }
  });

  it('answers every act on every kind with a plan for that item, never a throw', () => {
    const items: ExtensionActItem[] = [
      { kind: 'plugin', id: 'disk-cleanup', name: 'disk-cleanup', origin: 'own', enabled: true },
      { kind: 'plugin', id: 'web/firecrawl', name: 'firecrawl', origin: 'own', enabled: false },
      { kind: 'plugin', id: 'bundled:kanban', name: 'kanban', origin: 'bundled', enabled: true },
      { kind: 'plugin', id: 'org-pack', name: 'org-pack', origin: 'managed', enabled: true },
      { kind: 'marketplace', id: 'hermes-catalog', name: 'Hermes plugin catalog', origin: 'bundled', enabled: true },
      actServer(),
      actServer({ id: 'fetch', name: 'fetch', transport: 'stdio', target: 'uvx mcp-server-fetch' }),
      actSkill(),
      actSkill({ id: 'changelog', name: 'changelog', linkTarget: '/Users/test/kept/changelog' }),
    ];
    const variants = [
      {},
      { listed: entry() },
      { source: 'acme/notes', holds: ['disk-cleanup'] },
      { keepIn: '/Users/test/kept/release-notes' },
    ];
    for (const item of items) {
      for (const act of ExtensionActKindSchema.options) {
        for (const options of variants) {
          const label = `${item.kind} ${item.id} ${act} ${JSON.stringify(options)}`;
          const plan = ExtensionActPlanSchema.parse(hermes.plan!(native, item, act, options));
          expect(plan.target, label).toEqual({ kind: item.kind, id: item.id });
          expect(plan.act, label).toBe(act);
          if (act === 'install' && item.kind !== 'plugin' && item.kind !== 'marketplace') {
            expect(plan, label).toMatchObject({ available: false, message: 'Hermes installs only plugins' });
          }
        }
      }
    }
  });
});
