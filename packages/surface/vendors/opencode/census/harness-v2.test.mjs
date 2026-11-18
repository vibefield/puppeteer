import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artifactIdentityProblems,
  blockingHostInputs,
  callerMessageID,
  changedHostInputs,
  CHILD_PROMPT,
  configDirectoryFiles,
  DROPPED_V1_VARIABLES,
  durableSequenceGaps,
  entityID,
  ENVIRONMENT_STATUS,
  errorTag,
  eventData,
  eventSessionID,
  findOperation,
  helpCommandPaths,
  helpFileName,
  helpIndexEntry,
  hostInputs,
  hostPlatform,
  interceptV2,
  isolatedEnvironmentV2,
  listItems,
  literalsAfterSanitization,
  NOT_COVERED_V2,
  operationBody,
  operationPath,
  OPERATIONS,
  probeLoopbackPort,
  READY_PATTERN_V2,
  requestFailure,
  rootDirectories,
  routeCarrierV2,
  scenarioNames,
  SCENARIOS_V2,
  scrubRoot,
  scrubSecrets,
  secretForms,
  statHostInputs,
  tempRootProblem,
  VERSION_PATTERN_V2,
} from './harness-v2.mjs';

// The harness builds paths with node:path `join`, so on Windows they carry backslashes;
// every expectation is built the same way.
describe('2.x launch environment', () => {
  const environment = isolatedEnvironmentV2('/r', { model: 'test/test-model' }, 'pw');

  it('isolates HOME and passes the password through both 2.x variables and nothing else', () => {
    expect(environment.HOME).toBe(join('/r', 'home'));
    expect(environment.TMPDIR).toBe(join('/r', 'tmp'));
    expect(environment.XDG_DATA_HOME).toBe(join('/r', 'xdg', 'data'));
    expect(environment.OPENCODE_PASSWORD).toBe('pw');
    expect(environment.OPENCODE_SERVER_PASSWORD).toBe('pw');
    expect(environment.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(environment.OPENCODE_DISABLE_MODELS_FETCH).toBe('1');
    expect(environment.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
    expect(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe('1');
    for (const name of Object.keys(DROPPED_V1_VARIABLES)) expect(environment).not.toHaveProperty(name);
    const passwordCarriers = Object.entries(environment).filter(([, value]) => value === 'pw');
    expect(passwordCarriers.map(([name]) => name).sort()).toEqual(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD']);
  });

  it('says what is known about every variable it sets, and sets every variable it describes', () => {
    const withOptions = isolatedEnvironmentV2('/r', {}, 'pw', { allowBackgroundSubagents: true });
    const names = new Set([...Object.keys(environment), ...Object.keys(withOptions)]);
    expect([...names].sort()).toEqual(Object.keys(ENVIRONMENT_STATUS).sort());
  });

  it('writes the update policy where 2.x reads it, inside the disposable root', () => {
    expect(JSON.parse(configDirectoryFiles()['opencode.json'])).toEqual({ update: 'disable' });
    expect(rootDirectories('/r').every((path) => path.startsWith(`${join('/r')}${sep}`))).toBe(true);
    expect(rootDirectories('/r')).toContain(join('/r', 'home'));
  });
});

describe('2.x version and readiness lines', () => {
  it('reads the 2.x version line and refuses the bare 1.x one', () => {
    expect(VERSION_PATTERN_V2.exec('opencode v2.2.5')?.[1]).toBe('2.2.5');
    expect(VERSION_PATTERN_V2.test('1.19.5')).toBe(false);
    expect(VERSION_PATTERN_V2.test('opencode v3.0.0')).toBe(false);
  });

  it('matches the 2.x ready line on loopback only, and not the 1.x one', () => {
    const output = 'booting\nserver listening on http://127.0.0.1:52011\n';
    expect(READY_PATTERN_V2.exec(output)?.[1]).toBe('http://127.0.0.1:52011');
    expect(READY_PATTERN_V2.exec('server listening on http://127.0.0.1:4096')?.[1]).toBe('http://127.0.0.1:4096');
    expect(READY_PATTERN_V2.test('opencode server listening on http://127.0.0.1:4096')).toBe(false);
    expect(READY_PATTERN_V2.test('server listening on http://0.0.0.0:4096')).toBe(false);
  });
});

describe('binary identity before anything runs', () => {
  const sha256 = 'a'.repeat(64);
  const metadata = { vendor: 'opencode', version: '2.2.5', platform: 'darwin-arm64', sha256 };

  it('accepts only the acquired bytes of the census version for this host', () => {
    expect(artifactIdentityProblems(metadata, { version: '2.2.5', platform: 'darwin-arm64', sha256 })).toEqual([]);
    expect(
      artifactIdentityProblems(
        { ...metadata, version: '2.2.4', platform: 'linux-x64' },
        { version: '2.2.5', platform: 'darwin-arm64', sha256: 'b'.repeat(64) },
      ),
    ).toEqual([
      'artifact metadata is for 2.2.4, not 2.2.5',
      "artifact metadata is for linux-x64, not this host's darwin-arm64",
      `the binary's sha256 ${'b'.repeat(64)} is not the metadata's ${sha256}`,
    ]);
    expect(artifactIdentityProblems({}, { version: '2.2.5', platform: 'darwin-arm64', sha256 })).toContain(
      'artifact metadata has no sha256',
    );
  });

  it('names the host as the acquisition and the ledger do', () => {
    expect(hostPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(hostPlatform('win32', 'x64')).toBe('windows-x64');
    expect(hostPlatform('linux', 'x64')).toBe('linux-x64');
  });

  it('runs only under a temp root the shared text patterns recognize', () => {
    expect(tempRootProblem('/private/tmp/census', 'darwin')).toBeUndefined();
    expect(tempRootProblem('/private/var/folders/xy/T', 'darwin')).toBeUndefined();
    expect(tempRootProblem('/tmp/census', 'linux')).toBeUndefined();
    expect(tempRootProblem('/Volumes/Scratch/census', 'darwin')).toMatch(/^TMPDIR must resolve under/);
    expect(tempRootProblem('/private/tmpfoo', 'darwin')).toMatch(/^TMPDIR must resolve under/);
    expect(tempRootProblem('/home/someone/tmp', 'linux')).toMatch(/^TMPDIR must resolve under/);
  });
});

describe('what the raw outputs may hold', () => {
  it('finds the server password and its Basic-auth form, and scrubs them from raw dumps', () => {
    const secrets = secretForms('pw-123');
    expect(secrets).toEqual(['pw-123', Buffer.from('opencode:pw-123').toString('base64')]);
    expect(scrubSecrets(`a pw-123 b ${secrets[1]}`, secrets)).toBe(
      'a <redacted:server-password> b <redacted:server-password>',
    );
  });

  it('finds the disposable root that sanitization leaves behind, as spelled or URL-encoded', () => {
    const root = '/Volumes/Scratch/puppeteer-opencode2-turn-abc123';
    const records = [
      { type: 'session.created', location: { directory: `${root}/workspace` } },
      { type: 'project.updated', data: { origin: `${root}/workspace` } },
      { response: { body: { next: `cursor=${encodeURIComponent(root)}` } } },
      { type: 'session.text.delta', data: { delta: `${root}/workspace` } },
    ];
    // A path key and a prose key are redacted; a key no rule names is not.
    expect(literalsAfterSanitization(records, [root])).toEqual([2, 3]);
    expect(literalsAfterSanitization(records, ['/'])).toEqual([]);
  });

  it('reports a failed request by route shape, status and error tag only', () => {
    expect(errorTag({ _tag: 'PermissionNotFoundError', message: 'per_x at /Users/alice' })).toBe(
      'PermissionNotFoundError',
    );
    expect(errorTag({ data: { _tag: 'Not a tag!' } })).toBeUndefined();
    expect(
      requestFailure('GET', '/api/session/ses_abc/message?directory=/Users/alice/p', 404, {
        _tag: 'SessionNotFoundError',
      }),
    ).toBe('GET /api/session/:sessionID/message failed with 404 (SessionNotFoundError)');
    expect(requestFailure('POST', '/api/session', 500, 'raw /Users/alice text')).toBe('POST /api/session failed with 500');
  });
});

describe('2.x route grammar', () => {
  it('carries native ids as params and keeps every repeated query value', () => {
    expect(routeCarrierV2('/api/session/ses_abc123/permission/per_def456/reply')).toEqual({
      route: '/api/session/:sessionID/permission/:requestID/reply',
      params: { sessionID: 'ses_abc123', requestID: 'per_def456' },
    });
    expect(routeCarrierV2('/api/event?types=session.created&types=session.renamed')).toEqual({
      route: '/api/event',
      query: { types: ['session.created', 'session.renamed'] },
    });
    expect(routeCarrierV2('/api/session/ses_a/form/frm_b')).toMatchObject({
      route: '/api/session/:sessionID/form/:formID',
    });
    expect(routeCarrierV2('/openapi.json')).toEqual({ route: '/openapi.json' });
  });
});

describe('routes and bodies from the served OpenAPI document', () => {
  const document = {
    openapi: '3.1.0',
    paths: {
      '/api/session': { post: { operationId: 'session.create', requestBody: { $ref: '#/components/requestBodies/Create' } } },
      '/api/session/{sessionID}': { delete: { operationId: 'session.remove' } },
      '/api/session/{sessionID}/permission': {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PermissionCreate' } } },
          },
        },
      },
      '/api/session/{sessionID}/metadata': {
        patch: { requestBody: { content: { 'application/json': { schema: { type: 'object', additionalProperties: {} } } } } },
      },
      '/api/session/{sessionID}/fork': {
        post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { at: {} } } } } } },
      },
    },
    components: {
      requestBodies: {
        Create: {
          content: {
            'application/json': {
              schema: { allOf: [{ type: 'object', properties: { title: {} } }, { properties: { permissions: {} } }] },
            },
          },
        },
      },
      schemas: {
        PermissionCreate: {
          type: 'object',
          properties: { action: {}, resources: {}, message: {} },
          required: ['action', 'resources'],
        },
      },
    },
  };

  it('finds an operation by id, else by method and path shape, and never guesses between several', () => {
    expect(findOperation(document, OPERATIONS.sessionCreate)).toMatchObject({ method: 'POST', path: '/api/session' });
    expect(findOperation(document, OPERATIONS.permissionCreate).path).toBe('/api/session/{sessionID}/permission');
    // `session.delete` is not an id here; the DELETE on the session path is.
    expect(findOperation(document, OPERATIONS.delete).operationId).toBe('session.remove');
    expect(() => findOperation(document, OPERATIONS.archive)).toThrow('has no operation(s) for session.archive');
    expect(() => findOperation(document, { methods: [], path: /^\/api\/session/ })).toThrow('has 5 operation(s)');
  });

  it('sends only fields the served schema names, and every field it requires', () => {
    const create = findOperation(document, OPERATIONS.sessionCreate);
    expect(operationBody(document, create, { title: 't', permissions: [] })).toEqual({ title: 't', permissions: [] });
    expect(() => operationBody(document, create, { title: 't', permission: [] })).toThrow(
      'POST /api/session: the served schema has no permission (its fields: permissions, title)',
    );
    const permission = findOperation(document, OPERATIONS.permissionCreate);
    expect(() => operationBody(document, permission, { action: 'shell' })).toThrow('requires resources');
    // A record-shaped body cannot be checked by name; it is sent as given.
    expect(operationBody(document, findOperation(document, OPERATIONS.metadata), { metadata: {} })).toEqual({
      metadata: {},
    });
    // An optional body the census has nothing for is left out; a body-less operation takes none.
    expect(operationBody(document, findOperation(document, OPERATIONS.fork), {})).toBeUndefined();
    expect(operationBody(document, findOperation(document, OPERATIONS.delete), {})).toBeUndefined();
    expect(() => operationBody(document, findOperation(document, OPERATIONS.delete), { x: 1 })).toThrow(
      'takes no JSON body',
    );
  });

  it('fills path parameters in order, encoded', () => {
    const permission = findOperation(document, OPERATIONS.permissionCreate);
    expect(operationPath(permission, ['ses_a/b'])).toBe('/api/session/ses_a%2Fb/permission');
    expect(() => operationPath(permission, [])).toThrow('takes 1 path parameter(s), not 0');
  });
});

describe('2.x records', () => {
  const record = (overrides) => ({ id: 'evt_1', created: 1, type: 'session.text.delta', data: {}, ...overrides });

  it('reads `data` as an object or as the encoded string the OpenAPI declares', () => {
    expect(eventData(record({ data: { sessionID: 'ses_a' } }))).toEqual({ sessionID: 'ses_a' });
    expect(eventData(record({ data: '{"sessionID":"ses_a"}' }))).toEqual({ sessionID: 'ses_a' });
    expect(eventData(record({ data: 'not json' }))).toBeUndefined();
  });

  it('assigns a record to its session by payload, else by a session event aggregate', () => {
    expect(eventSessionID(record({ data: { sessionID: 'ses_a' } }))).toBe('ses_a');
    const renamed = record({ type: 'session.renamed', data: {}, durable: { aggregateID: 'ses_b', seq: 4 } });
    expect(eventSessionID(renamed)).toBe('ses_b');
    const project = record({ type: 'worktree.resolved', data: {}, durable: { aggregateID: 'prj_c', seq: 0 } });
    expect(eventSessionID(project)).toBeUndefined();
  });

  it('finds per-aggregate durable seq breaks and ignores ephemeral records', () => {
    const durable = (aggregateID, seq, type = 'session.step.ended') => ({ type, durable: { aggregateID, seq } });
    expect(
      durableSequenceGaps([
        durable('ses_a', 0),
        { type: 'session.text.delta' },
        durable('ses_a', 1),
        durable('ses_b', 5),
        durable('ses_b', 6),
        durable('ses_a', 4, 'session.inbox.enqueued'),
      ]),
    ).toEqual([{ aggregateID: 'ses_a', after: 1, next: 4, type: 'session.inbox.enqueued' }]);
    expect(durableSequenceGaps([durable('ses_a', 3), durable('ses_a', 4)])).toEqual([]);
  });

  it('unwraps list and entity responses in either form', () => {
    expect(listItems([{ id: 'ses_a' }])).toEqual([{ id: 'ses_a' }]);
    expect(listItems({ data: [{ id: 'ses_a' }], cursor: 'x' })).toEqual([{ id: 'ses_a' }]);
    expect(listItems({ items: [1] })).toEqual([1]);
    expect(listItems(undefined)).toEqual([]);
    expect(entityID({ id: 'ses_a' })).toBe('ses_a');
    expect(entityID({ data: { id: 'msg_b' } })).toBe('msg_b');
    expect(entityID({})).toBeUndefined();
  });

  it('mints caller message ids in the accepted `msg_` + 26 form', () => {
    const id = callerMessageID();
    expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(callerMessageID(() => Buffer.alloc(26))).toBe(`msg_${'0'.repeat(26)}`);
  });
});

describe('2.x provider routing', () => {
  const intercept = interceptV2();

  it('answers a tool-less title request out of band', () => {
    const answer = intercept({ request: { messages: [{ role: 'system', content: 'Generate a title' }] } });
    expect(answer?.label).toBe('title');
    expect(interceptV2({ answerTitles: false })({ request: { messages: [{ content: 'title' }] } })).toBeUndefined();
  });

  it('routes the subagent model call by its newest message only', () => {
    const child = { tools: [{}], messages: [{ role: 'user', content: CHILD_PROMPT }] };
    expect(intercept({ request: child })?.label).toBe('subagent');
    const parentFollowUp = {
      tools: [{}],
      messages: [
        { role: 'assistant', tool_calls: [{ function: { arguments: JSON.stringify({ prompt: CHILD_PROMPT }) } }] },
        { role: 'tool', content: 'controlled subagent result' },
      ],
    };
    expect(intercept({ request: parentFollowUp })).toBeUndefined();
    expect(intercept({ request: { tools: [{}], messages: [{ role: 'user', content: 'scripted' }] } })).toBeUndefined();
  });
});

describe('host inputs', () => {
  function fakeStat(present) {
    return (path) => (present.has(path) ? { isDirectory: () => true, size: 64, mtimeMs: present.get(path) } : undefined);
  }
  const home = (relative) => join('/h', relative);

  it('records labels only and refuses the inputs 2.x reads but the census cannot redirect', () => {
    const inputs = hostInputs({ platform: 'darwin', user: 'someone' });
    const stats = statHostInputs(inputs, {
      home: '/h',
      stat: fakeStat(
        new Map([
          [home('.local/share/opencode'), 1],
          ['/Library/Application Support/opencode', 2],
        ]),
      ),
    });
    expect(JSON.stringify(stats)).not.toContain('/h');
    expect(JSON.stringify(stats)).not.toContain('someone');
    expect(JSON.stringify(stats)).not.toContain('Library');
    expect(stats.find((entry) => entry.label === 'user-opencode-data')).toMatchObject({ present: true, watch: true });
    expect(blockingHostInputs(stats)).toEqual(['system-config-directory']);
    const linuxBlocking = hostInputs({ platform: 'linux' }).filter((input) => input.blocking);
    expect(linuxBlocking.map((input) => input.label)).toEqual(['system-config-directory']);
  });

  it('watches the files an in-place write changes without touching their directory', () => {
    const watched = hostInputs({ platform: 'linux' }).filter((input) => input.watch);
    expect(watched.map((input) => input.home)).toEqual(
      expect.arrayContaining([
        '.local/share/opencode/opencode.db',
        '.local/share/opencode/opencode.db-wal',
        '.local/share/opencode/opencode.db-shm',
        '.local/share/opencode/auth.json',
        '.local/state/opencode/latest/tui/tabs.json',
        '.opencode/bin/opencode',
      ]),
    );
  });

  it('reports a watched home or file that appeared, vanished or changed, and nothing else', () => {
    const inputs = hostInputs({ platform: 'linux' });
    const before = statHostInputs(inputs, { home: '/h', stat: fakeStat(new Map([[home('.local/share/opencode'), 1]])) });
    const same = statHostInputs(inputs, { home: '/h', stat: fakeStat(new Map([[home('.local/share/opencode'), 1]])) });
    expect(changedHostInputs(before, same)).toEqual([]);
    const after = statHostInputs(inputs, {
      home: '/h',
      stat: fakeStat(
        new Map([
          [home('.local/share/opencode'), 2],
          [home('.local/share/opencode/opencode.db-wal'), 5],
          [home('.opencode'), 3],
          [home('.claude/skills'), 4],
        ]),
      ),
    });
    expect(changedHostInputs(before, after)).toEqual([
      'user-opencode-data',
      'user-opencode-db-wal',
      'user-opencode-install',
    ]);
  });
});

describe('background service port probe', () => {
  it('tells an open loopback port from a closed one', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    expect(await probeLoopbackPort(port)).toBe('open');
    await new Promise((done) => server.close(done));
    // Windows answers a connect to a closed loopback port only after about 2 s of SYN retries.
    expect(await probeLoopbackPort(port, { timeoutMs: 5_000 })).toBe('closed');
  });
});

describe('scenarios and probes', () => {
  it('lists the core census the plan names, each with a run step', () => {
    expect(scenarioNames('core')).toEqual([
      'turn',
      'title-generation',
      'tool-read',
      'tool-shell',
      'tool-failure',
      'subagent',
      'resume',
      'event-stream',
      'store-migration',
    ]);
    expect(scenarioNames('all').length).toBe(Object.keys(SCENARIOS_V2).length);
    for (const scenario of Object.values(SCENARIOS_V2)) expect(typeof scenario.run).toBe('function');
  });

  it('covers the plan B9 controls it can drive without guessing', () => {
    expect(scenarioNames('extended')).toEqual(
      expect.arrayContaining([
        'interrupt-stream',
        'interrupt-tool',
        'auto-compaction',
        'overflow-compaction',
        'unknown-context',
        'file-write',
        'file-edit',
        'permission-once',
        'permission-always',
        'permission-reject',
        'session-lifecycle',
      ]),
    );
    for (const name of ['permission-once', 'permission-always', 'permission-reject']) {
      expect(SCENARIOS_V2[name].sessionBody).toEqual({ permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
      expect(SCENARIOS_V2[name].responses).toEqual([]);
    }
  });

  it('names every B9 item it does not cover, and the README names the same ones', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    for (const [item, reason] of Object.entries(NOT_COVERED_V2)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(readme).toContain(item);
    }
  });

  it('scripts 2.x tool inputs, and the 1.x shape only where a failure is the point', () => {
    const workspace = '/w';
    const call = (name, turn = 0) => {
      const chunks = SCENARIOS_V2[name].responses[turn]({ workspace, turn: turn + 1 });
      const [, named, args] = chunks;
      return {
        name: named.choices[0].delta.tool_calls[0].function.name,
        input: JSON.parse(args.choices[0].delta.tool_calls[0].function.arguments),
      };
    };
    expect(call('tool-read')).toEqual({ name: 'read', input: { path: join('/w', 'surface-census-read.txt') } });
    expect(call('tool-shell').name).toBe('shell');
    expect(call('subagent')).toMatchObject({ name: 'subagent', input: { prompt: CHILD_PROMPT } });
    expect(call('tool-failure')).toEqual({ name: 'read', input: { filePath: join('/w', 'surface-census-read.txt') } });
    expect(call('file-write')).toMatchObject({ name: 'write', input: { path: join('/w', 'surface-census-write.txt') } });
    expect(call('file-edit', 1)).toMatchObject({
      name: 'edit',
      input: { path: join('/w', 'surface-census-edit.txt'), oldString: 'before edit', newString: 'after edit' },
    });
    expect(call('interrupt-tool')).toMatchObject({ name: 'shell', input: { command: 'sleep 30' } });
  });

  it('probes every help page of the draft tree under a stable file name, and scrubs the probe root', () => {
    expect(helpCommandPaths({ commands: [{ path: [] }, { path: ['session', 'list'] }] })).toEqual([[], ['session', 'list']]);
    expect(helpCommandPaths({})).toEqual([[]]);
    expect(helpFileName([])).toBe('root.txt');
    expect(helpFileName(['service', 'status'])).toBe('service-status.txt');
    expect(helpIndexEntry(['session', 'list'], { status: 0, signal: null })).toEqual({
      commandPath: ['session', 'list'],
      status: 0,
    });
    expect(scrubRoot('log at /t/x/root/state and /private/t/x/root', ['/t/x/root', '/private/t/x/root'])).toBe(
      'log at <probe-root>/state and <probe-root>',
    );
  });
});
