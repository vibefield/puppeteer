import { describe, expect, it } from 'vitest';
import {
  describeArgv,
  describeMcpCommand,
  describeMcpDefinition,
  describeMcpUrl,
  describeFileSteps,
  EXTENSION_COMMAND_NAME,
  EXTENSION_SKILL_FOLDER_NAME,
  ExtensionActPlanSchema,
  ExtensionActReceiptSchema,
  extensionActUnavailable,
  extensionCommandPlan,
  extensionFilesPlan,
  extensionNotOwnWords,
  extensionSignInAbsentWords,
  extensionSkillFolderPlan,
  extensionTerminalPlan,
  ExtensionFailureSchema,
  ExtensionInventorySchema,
  ExtensionItemSchema,
  ExtensionProviderSchema,
  isNormalizedAbsolutePath,
  mcpServerDefinition,
  McpServerDefinitionSchema,
  parseSkillFrontmatter,
  type McpServerDefinition,
  type SkillItem,
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
    // a sign-in the agent keeps where no read looks is neither changed nor unchanged
    expect(
      ExtensionActReceiptSchema.parse({ ...receipt, act: 'sign-in', status: 'unconfirmed', message: 'x' }),
    ).toMatchObject({ act: 'sign-in', status: 'unconfirmed' });
  });

  it("plans a sign-in as the agent's own login in a terminal the person answers, and a sign-out as a command", () => {
    const signIn = extensionTerminalPlan({
      target,
      act: 'sign-in',
      argv: ['codex', 'mcp', 'login', 'linear'],
      env: { CODEX_HOME: '/profiles/work/codex' },
      reaches: ['every-profile'],
    });
    expect(ExtensionActPlanSchema.parse(signIn)).toEqual({
      target,
      act: 'sign-in',
      available: true,
      runs: {
        kind: 'terminal',
        argv: ['codex', 'mcp', 'login', 'linear'],
        env: { CODEX_HOME: '/profiles/work/codex' },
      },
      display: 'codex mcp login linear',
      reaches: ['every-profile'],
    });
    expect(
      ExtensionActPlanSchema.parse(
        extensionCommandPlan({ target, act: 'sign-out', argv: ['codex', 'mcp', 'logout', 'linear'] }),
      ),
    ).toMatchObject({ act: 'sign-out', runs: { kind: 'command' } });
    expect(
      ExtensionActPlanSchema.parse(
        extensionActUnavailable(target, 'sign-in', 'no-sign-in', 'linear sends its own key'),
      ),
    ).toMatchObject({ available: false, reason: 'no-sign-in' });
  });

  it("says when a server has no sign-in of the agent's: local, WebSocket, or sending its own key", () => {
    const server = (fields: Record<string, unknown>) =>
      ExtensionItemSchema.parse({
        kind: 'mcp-server',
        id: 'linear',
        name: 'linear',
        origin: 'own',
        enabled: true,
        transport: 'http',
        target: 'https://mcp.linear.app/mcp',
        ...fields,
      }) as Parameters<typeof extensionSignInAbsentWords>[1];
    expect(extensionSignInAbsentWords('Claude Code', server({}))).toBeUndefined();
    expect(extensionSignInAbsentWords('Claude Code', server({ headers: ['X-Trace'] }))).toBeUndefined();
    expect(extensionSignInAbsentWords('Claude Code', server({ headers: ['authorization'] }))).toBe(
      'linear sends its own key, so Claude Code has no sign-in for it',
    );
    expect(extensionSignInAbsentWords('Claude Code', server({ transport: 'stdio', target: 'npx linear' }))).toBe(
      'linear runs on this machine and has no sign-in',
    );
    expect(extensionSignInAbsentWords('Claude Code', server({ transport: 'ws', target: 'wss://x.example' }))).toBe(
      'Claude Code reaches a WebSocket server with a header, never a sign-in',
    );
  });
});

describe('server definitions (RFC 006 C2, add)', () => {
  it('travels only when nothing about it was hidden, and carries the names it reads, never a value', () => {
    expect(
      mcpServerDefinition({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: ['GITHUB_TOKEN'],
      }),
    ).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: ['GITHUB_TOKEN'],
    });
    expect(mcpServerDefinition({ transport: 'http', url: 'https://mcp.linear.app/mcp' })).toEqual({
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
    });
    expect(mcpServerDefinition({ transport: 'sse', url: ' https://mcp.example.com/sse ' })).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
    });
  });

  it('stays behind when it could hold a key, sends a header, names a variable inside itself, or speaks WebSocket', () => {
    const cases = [
      { transport: 'stdio', command: 'uvx', args: ['server', '--api-key', 'abc'] },
      { transport: 'stdio', command: 'npx', args: ['server', 'postgres://me:pw@db/prod'] },
      { transport: 'stdio', command: 'npx', args: ['server', '--token=${TOKEN}'] },
      { transport: 'stdio', command: 'npx', args: ['ghp_0123456789abcdefghijklmnopqrstuvwxyz'] },
      { transport: 'http', url: 'https://mcp.example.com/mcp?key=abc' },
      { transport: 'http', url: 'https://me:pw@mcp.example.com/mcp' },
      { transport: 'http', url: '${MCP_URL}' },
      { transport: 'http', url: 'https://mcp.example.com/mcp', headers: ['Authorization'] },
      { transport: 'ws', url: 'wss://mcp.example.com' },
      { transport: 'stdio', args: ['x'] },
      { transport: 'stdio', command: 'npx', args: Array.from({ length: 25 }, (_, index) => `a${index}`) },
    ] as const;
    for (const server of cases) expect(mcpServerDefinition(server), JSON.stringify(server)).toBeUndefined();
  });

  it('rides on a read server, and a definition never takes a value where only a name belongs', () => {
    const definition: McpServerDefinition = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'context7'],
      env: ['API_KEY'],
    };
    expect(
      ExtensionItemSchema.parse({
        kind: 'mcp-server',
        id: 'context7',
        name: 'context7',
        origin: 'own',
        enabled: true,
        transport: 'stdio',
        target: describeMcpDefinition(definition),
        env: ['API_KEY'],
        definition,
      }),
    ).toMatchObject({ target: 'npx -y context7', definition });
    expect(McpServerDefinitionSchema.safeParse({ ...definition, env: { API_KEY: 'x' } }).success).toBe(false);
    expect(McpServerDefinitionSchema.safeParse({ ...definition, env: ['API KEY'] }).success).toBe(false);
    expect(
      McpServerDefinitionSchema.safeParse({ transport: 'http', url: 'https://x.example', env: ['A'] }).success,
    ).toBe(false);
  });

  it('plans an add as the agent answers it, and says when it already holds one or cannot take it', () => {
    const target = { kind: 'mcp-server', id: 'context7' } as const;
    expect(
      ExtensionActPlanSchema.parse(
        extensionCommandPlan({
          target,
          act: 'add',
          argv: [
            'claude',
            'mcp',
            'add',
            'context7',
            '--scope',
            'user',
            '-e',
            'API_KEY=${API_KEY}',
            '--',
            'npx',
            'context7',
          ],
        }),
      ),
    ).toMatchObject({
      act: 'add',
      display: 'claude mcp add context7 --scope user -e API_KEY=${API_KEY} -- npx context7',
    });
    expect(
      extensionActUnavailable(target, 'add', 'held', 'Claude Code already has a server named context7'),
    ).toMatchObject({
      available: false,
      reason: 'held',
    });
    expect(
      ExtensionActPlanSchema.parse(extensionActUnavailable(target, 'add', 'unsupported', 'Codex does not speak SSE')),
    ).toMatchObject({ reason: 'unsupported' });
  });
});

describe('skills placed (RFC 006 C2, a skill kept once)', () => {
  const folder = '/Users/me/.claude/skills';
  const kept = '/Users/me/Library/Application Support/VibeField/agents/skills/work/release-notes';
  const skill = (fields: Partial<SkillItem>): SkillItem => ({
    kind: 'skill',
    id: 'release-notes',
    name: 'release-notes',
    origin: 'own',
    enabled: true,
    ...fields,
  });

  it('takes only a normalized absolute path, and a folder name that stays one folder', () => {
    for (const path of ['/Users/me/.claude/skills/x', 'C:\\Users\\me\\skills\\x', '/a']) {
      expect(isNormalizedAbsolutePath(path)).toBe(true);
    }
    for (const path of ['', '/', 'skills/x', '~/x', '/a/../b', '/a/./b', '/a//b', '/a/b/', 'C:\\', '/a\u0000b']) {
      expect(isNormalizedAbsolutePath(path)).toBe(false);
    }
    for (const name of ['release-notes', 'Release Notes', 'pdf_2', 'ünïcode']) {
      expect(EXTENSION_SKILL_FOLDER_NAME.test(name)).toBe(true);
    }
    for (const name of ['', '.hidden', '..', 'a/b', 'a\\b', 'tab\there', 'x'.repeat(129)]) {
      expect(EXTENSION_SKILL_FOLDER_NAME.test(name)).toBe(false);
    }
  });

  it('shows each step on its own line, from the home when it is under it', () => {
    const plan = extensionFilesPlan({
      target: { kind: 'skill', id: 'release-notes' },
      act: 'add',
      steps: [
        { op: 'move', from: kept, to: '/Users/me/.agents/skills/release-notes' },
        { op: 'link', path: kept, target: '/Users/me/.agents/skills/release-notes' },
      ],
      reaches: ['shared-folder'],
      home: '/Users/me',
    });
    expect(ExtensionActPlanSchema.parse(plan)).toEqual(plan);
    expect(plan.display).toBe(
      [
        'move ~/Library/Application Support/VibeField/agents/skills/work/release-notes → ~/.agents/skills/release-notes',
        'link ~/.agents/skills/release-notes → ~/Library/Application Support/VibeField/agents/skills/work/release-notes',
      ].join('\n'),
    );
    expect(describeFileSteps([{ op: 'unlink', path: '/Users/me2/skills/x' }], '/Users/me')).toBe(
      'unlink /Users/me2/skills/x',
    );
    // a relative path, a doubled separator or a fifth step is no plan
    for (const steps of [
      [{ op: 'unlink', path: 'skills/x' }],
      [{ op: 'link', path: '/a//x', target: '/b' }],
      Array.from({ length: 5 }, () => ({ op: 'unlink', path: '/a/x' })),
    ]) {
      expect(ExtensionActPlanSchema.safeParse({ ...plan, runs: { kind: 'files', steps } }).success).toBe(false);
    }
  });

  it('links a kept folder in where the agent looks, and takes away only its own: a link goes, a folder moves to the host', () => {
    const add = extensionSkillFolderPlan({
      label: 'Claude Code',
      folder,
      item: skill({ linkTarget: kept }),
      act: 'add',
      home: '/Users/me',
    });
    expect(add).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'link', path: `${folder}/release-notes`, target: kept }] },
      reaches: [],
    });
    expect(extensionSkillFolderPlan({ label: 'Claude Code', folder, item: skill({}), act: 'add' })).toMatchObject({
      available: false,
      reason: 'unsupported',
    });
    expect(
      extensionSkillFolderPlan({
        label: 'Claude Code',
        folder,
        item: skill({ id: '../escape', linkTarget: kept }),
        act: 'add',
      }),
    ).toMatchObject({ available: false, reason: 'unsupported' });

    const linked = skill({ location: `${folder}/release-notes`, linkTarget: kept });
    expect(
      extensionSkillFolderPlan({ label: 'OpenCode', folder, item: linked, act: 'remove', reaches: ['every-profile'] }),
    ).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'unlink', path: `${folder}/release-notes` }] },
      reaches: ['every-profile'],
    });
    const own = skill({ location: `${folder}/release-notes` });
    expect(
      extensionSkillFolderPlan({ label: 'Claude Code', folder, item: own, act: 'remove', keepIn: kept }),
    ).toMatchObject({
      available: true,
      runs: { kind: 'files', steps: [{ op: 'move', from: `${folder}/release-notes`, to: kept }] },
    });
    // with nowhere to keep it, the agent's own folder stays
    expect(extensionSkillFolderPlan({ label: 'Claude Code', folder, item: own, act: 'remove' })).toMatchObject({
      available: false,
      reason: 'no-command',
    });
    // a folder deeper down, somewhere else, or another origin's is not this folder's to take
    for (const item of [
      skill({ location: `${folder}/team/release-notes` }),
      skill({ location: '/Users/me/.agents/skills/release-notes', shared: true }),
      skill({ location: `${folder}/release-notes`, origin: 'plugin', plugin: 'docs' }),
    ]) {
      expect(
        extensionSkillFolderPlan({ label: 'Claude Code', folder, item, act: 'remove', keepIn: kept }),
      ).toMatchObject({ available: false, reason: 'not-own' });
    }
  });
});
