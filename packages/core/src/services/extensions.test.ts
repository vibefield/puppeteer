import { describe, expect, it } from 'vitest';
import {
  describeArgv,
  describeMcpCommand,
  describeMcpUrl,
  EXTENSION_COMMAND_NAME,
  ExtensionActPlanSchema,
  ExtensionActReceiptSchema,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionNotOwnWords,
  ExtensionFailureSchema,
  ExtensionInventorySchema,
  ExtensionItemSchema,
  ExtensionProviderSchema,
  parseSkillFrontmatter,
} from './extensions.js';

const inventory = (items: unknown[]) => ({
  provider: 'example',
  profileId: 'example:native-default',
  fetchedAt: '2026-09-25T09:00:00.000Z',
  items,
  source: { kind: 'native-store', stability: 'documented' },
});

describe('extension contracts', () => {
  it('accepts one inventory holding every kind, each with where it comes from', () => {
    const parsed = ExtensionInventorySchema.parse(
      inventory([
        {
          kind: 'marketplace',
          id: 'official',
          name: 'official',
          origin: 'own',
          enabled: true,
          source: 'owner/plugins',
        },
        {
          kind: 'plugin',
          id: 'review@official',
          name: 'review',
          origin: 'own',
          enabled: false,
          version: '3f9c2a1b7d04',
          marketplace: 'official',
        },
        {
          kind: 'mcp-server',
          id: 'linear',
          name: 'linear',
          origin: 'own',
          enabled: true,
          transport: 'http',
          target: 'https://mcp.linear.app/mcp',
          headers: ['Authorization'],
        },
        {
          kind: 'mcp-server',
          id: 'docs',
          name: 'docs',
          origin: 'plugin',
          plugin: 'review@official',
          enabled: true,
          transport: 'stdio',
          target: 'npx -y docs-mcp',
        },
        {
          kind: 'skill',
          id: 'release-notes',
          name: 'release-notes',
          origin: 'own',
          enabled: true,
          description: 'Drafts release notes',
          linkTarget: '/profiles/work/skills/release-notes',
        },
        {
          kind: 'skill',
          id: 'shared:browser-use',
          name: 'browser-use',
          origin: 'own',
          shared: true,
          enabled: true,
          switchable: true,
        },
        { kind: 'skill', id: 'borrowed:review', name: 'review', origin: 'borrowed', lender: 'other', enabled: true },
      ]),
    );
    expect(parsed.items.map((item) => item.kind)).toEqual([
      'marketplace',
      'plugin',
      'mcp-server',
      'mcp-server',
      'skill',
      'skill',
      'skill',
    ]);
  });

  it('never takes a value where only a name belongs', () => {
    const server = {
      kind: 'mcp-server',
      id: 'db',
      name: 'db',
      origin: 'own',
      enabled: true,
      transport: 'stdio',
      target: 'npx db-mcp',
    };
    expect(ExtensionItemSchema.safeParse({ ...server, env: ['DATABASE_URL'] }).success).toBe(true);
    expect(ExtensionItemSchema.safeParse({ ...server, env: ['DATABASE_URL=postgres://u:p@h/d'] }).success).toBe(false);
    expect(ExtensionItemSchema.safeParse({ ...server, headers: ['Authorization: Bearer x'] }).success).toBe(false);
    expect(ExtensionItemSchema.safeParse({ ...server, token: 'sk-secret' }).success).toBe(false);
  });

  it('ties plugin, lender and project to the origin that has them', () => {
    const skill = { kind: 'skill', id: 's', name: 's', enabled: true };
    expect(ExtensionItemSchema.safeParse({ ...skill, origin: 'own', plugin: 'p' }).success).toBe(false);
    expect(ExtensionItemSchema.safeParse({ ...skill, origin: 'own', lender: 'other' }).success).toBe(false);
    expect(ExtensionItemSchema.safeParse({ ...skill, origin: 'borrowed' }).success).toBe(false);
    expect(ExtensionItemSchema.safeParse({ ...skill, origin: 'own', project: '/repo' }).success).toBe(false);
    expect(ExtensionItemSchema.safeParse({ ...skill, origin: 'project', project: '/repo' }).success).toBe(true);
  });

  it('keeps ids unique per kind, and lets two kinds share a name', () => {
    const skill = { kind: 'skill', id: 'linear', name: 'linear', origin: 'own', enabled: true };
    const server = {
      kind: 'mcp-server',
      id: 'linear',
      name: 'linear',
      origin: 'own',
      enabled: true,
      transport: 'http',
      target: 'https://mcp.linear.app/mcp',
    };
    expect(ExtensionInventorySchema.safeParse(inventory([skill, server])).success).toBe(true);
    expect(ExtensionInventorySchema.safeParse(inventory([skill, { ...skill }])).success).toBe(false);
  });

  it('declares a missing kind by leaving it out', () => {
    const provider = ExtensionProviderSchema.parse({
      id: 'example',
      label: 'Example',
      support: {
        plugins: { store: 'profile', changes: 'command', read: true },
        skills: { store: 'shared', changes: 'folder', read: true },
      },
    });
    expect(provider.support.mcpServers).toBeUndefined();
    expect(
      ExtensionProviderSchema.safeParse({
        ...provider,
        support: { skills: { store: 'everywhere', changes: 'folder', read: true } },
      }).success,
    ).toBe(false);
    expect(
      ExtensionFailureSchema.parse({
        status: 'unavailable',
        provider: 'example',
        message: 'store unreadable',
        retryable: true,
      }).status,
    ).toBe('unavailable');
  });
});

describe('describeMcpUrl', () => {
  it('keeps scheme, host and path, and drops userinfo, query and fragment', () => {
    expect(describeMcpUrl('https://mcp.linear.app/mcp')).toBe('https://mcp.linear.app/mcp');
    expect(describeMcpUrl('https://user:hunter2@mcp.example.com:8443/v1/mcp?api_key=abc#x')).toBe(
      'https://•••@mcp.example.com:8443/v1/mcp?•••',
    );
    expect(describeMcpUrl('HTTP://Example.com')).toBe('http://Example.com');
  });

  it('keeps an environment reference and masks what does not parse', () => {
    expect(describeMcpUrl('${MCP_URL}')).toBe('${MCP_URL}');
    expect(describeMcpUrl('not a url with sk-abc')).toBe('•••');
  });
});

describe('describeMcpCommand', () => {
  it('shows a plain command as it runs', () => {
    expect(describeMcpCommand('npx', ['-y', '@modelcontextprotocol/server-postgres'])).toBe(
      'npx -y @modelcontextprotocol/server-postgres',
    );
    expect(describeMcpCommand('uvx', ['postgres-mcp', '--access-mode=restricted'])).toBe(
      'uvx postgres-mcp --access-mode=restricted',
    );
    expect(describeMcpCommand('npx', ['-y', 'mcp-server-with-a-rather-long-package-name-here'])).toBe(
      'npx -y mcp-server-with-a-rather-long-package-name-here',
    );
  });

  it('masks a connection string’s credentials, secret flags, secret assignments and token-shaped values', () => {
    expect(
      describeMcpCommand('npx', [
        '-y',
        '@modelcontextprotocol/server-postgres',
        'postgresql://app:s3cret@localhost:5432/dev?sslmode=require',
      ]),
    ).toBe('npx -y @modelcontextprotocol/server-postgres postgresql://•••@localhost:5432/dev?•••');
    expect(describeMcpCommand('mcp-proxy', ['--token', 'abc123', '--api-key=xyz', '--port', '8080'])).toBe(
      'mcp-proxy --token ••• --api-key=••• --port 8080',
    );
    expect(
      describeMcpCommand('docker', [
        'run',
        '-e',
        'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abcdef',
        '-e',
        'LOG_LEVEL=debug',
        'ghcr.io/github/github-mcp-server',
      ]),
    ).toBe('docker run -e GITHUB_PERSONAL_ACCESS_TOKEN=••• -e LOG_LEVEL=debug ghcr.io/github/github-mcp-server');
    expect(
      describeMcpCommand('server', [
        'sk-ant-api03-abcdefghijklmnop',
        'Ab3dEf9hIj2kLm5nOp8qRs1tUv4wXy7z',
        'deadbeefdeadbeefdeadbeefdeadbeef',
      ]),
    ).toBe('server ••• ••• •••');
  });

  it('keeps environment references, which are names', () => {
    expect(describeMcpCommand('mcp', ['--token', '${LINEAR_TOKEN}', 'API_KEY=${API_KEY}'])).toBe(
      'mcp --token ${LINEAR_TOKEN} API_KEY=${API_KEY}',
    );
  });

  it('quotes an argument that holds a space', () => {
    expect(describeMcpCommand('/Applications/My Tools/mcp', ['--name', 'two words'])).toBe(
      '"/Applications/My Tools/mcp" --name "two words"',
    );
  });
});

describe('parseSkillFrontmatter', () => {
  it('reads plain, quoted and block scalars', () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: release-notes\ndescription: Drafts release notes from merged pull requests\n---\n# Body',
      ),
    ).toEqual({
      name: 'release-notes',
      description: 'Drafts release notes from merged pull requests',
    });
    expect(
      parseSkillFrontmatter("---\nname: \"sql-review\"\ndescription: 'Reviews a migration''s risk'\n---\n"),
    ).toEqual({
      name: 'sql-review',
      description: "Reviews a migration's risk",
    });
    expect(
      parseSkillFrontmatter(
        '---\nname: brand\ndescription: >\n  Checks copy\n  against a brand book\nlicense: MIT\n---\n',
      ),
    ).toEqual({
      name: 'brand',
      description: 'Checks copy against a brand book',
    });
  });

  it('ignores nested keys and yields nothing without an opening fence on the first line', () => {
    expect(parseSkillFrontmatter('---\nmetadata:\n  name: nested\nname: top\n---\n')).toEqual({ name: 'top' });
    expect(parseSkillFrontmatter('\n---\nname: late\n---\n')).toEqual({});
    expect(parseSkillFrontmatter('# Just a body')).toEqual({});
    expect(parseSkillFrontmatter('---\nname: unterminated\n')).toEqual({});
  });
});

describe('extension acts (RFC 006 C2)', () => {
  const target = { kind: 'mcp-server' as const, id: 'linear' };

  it("plans one of the agent's own commands as a person reads it, with only the variables that bind the profile", () => {
    const plan = extensionCommandPlan({
      target,
      act: 'remove',
      argv: ['/Applications/Some Agent.app/bin/agent', 'mcp', 'remove', 'linear'],
      env: { AGENT_HOME: '/profiles/work/agent' },
      reaches: ['definition', 'sign-in'],
    });
    expect(ExtensionActPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.display).toBe('"/Applications/Some Agent.app/bin/agent" mcp remove linear');
    // no binding at all leaves no env: the native default finds its own root
    const bare = extensionCommandPlan({ target, act: 'disable', argv: ['agent', 'mcp', 'disable', 'linear'], env: {} });
    expect('env' in bare.runs).toBe(false);
    expect(describeArgv(['a', 'b c'])).toBe('a "b c"');
  });

  it('says why an agent cannot, and refuses a plan that carries a credential-shaped variable name or an empty command', () => {
    expect(
      ExtensionActPlanSchema.parse(
        extensionActUnavailable(target, 'disable', 'in-app', 'Kimi changes it inside the app'),
      ),
    ).toMatchObject({ available: false, reason: 'in-app' });
    expect(
      ExtensionActPlanSchema.safeParse({
        ...extensionCommandPlan({ target, act: 'disable', argv: ['a'] }),
        runs: { kind: 'command', argv: [] },
      }).success,
    ).toBe(false);
    expect(
      ExtensionActPlanSchema.safeParse({
        ...extensionCommandPlan({ target, act: 'disable', argv: ['a'] }),
        runs: { kind: 'command', argv: ['a'], env: { 'not a name': 'x' } },
      }).success,
    ).toBe(false);
  });

  it('takes a name as an argument only when a command could never read it as a flag or a path', () => {
    expect(EXTENSION_COMMAND_NAME.test('linear')).toBe(true);
    expect(EXTENSION_COMMAND_NAME.test('my_server-2')).toBe(true);
    expect(EXTENSION_COMMAND_NAME.test('--scope')).toBe(false);
    expect(EXTENSION_COMMAND_NAME.test('-v')).toBe(false);
    expect(EXTENSION_COMMAND_NAME.test('../x')).toBe(false);
    expect(EXTENSION_COMMAND_NAME.test('a.b')).toBe(false);
  });

  it("words why an item that is not the profile's own changes where it comes from", () => {
    const item = (fields: Record<string, unknown>) =>
      ExtensionItemSchema.parse({
        kind: 'mcp-server',
        id: 'x',
        name: 'x',
        enabled: true,
        transport: 'http',
        target: 'https://x.example/mcp',
        ...fields,
      });
    expect(extensionNotOwnWords('Codex', item({ origin: 'plugin', plugin: 'docs@openai' }))).toBe(
      'It comes with the docs@openai plugin and changes with it',
    );
    expect(extensionNotOwnWords('Grok', item({ origin: 'borrowed', lender: 'claude' }), 'Claude Code')).toBe(
      'Grok loads it from Claude Code on This Mac, and it changes there',
    );
    expect(extensionNotOwnWords('Codex', item({ origin: 'bundled' }))).toBe('It ships with Codex');
  });

  it('keeps a receipt to what the second read decided and what ran', () => {
    const receipt = {
      provider: 'codex',
      profileId: 'work-codex',
      target,
      act: 'disable',
      status: 'changed',
      startedAt: '2026-09-25T09:00:00.000Z',
      finishedAt: '2026-09-25T09:00:01.000Z',
      display: 'config/value/write mcp_servers.linear.enabled = false',
      message: 'turned off',
    };
    expect(ExtensionActReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(ExtensionActReceiptSchema.safeParse({ ...receipt, output: 'anything' }).success).toBe(false);
  });
});
