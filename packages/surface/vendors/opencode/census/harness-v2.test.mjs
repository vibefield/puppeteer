import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  blockingHostInputs,
  callerMessageID,
  changedHostInputs,
  CHILD_PROMPT,
  configDirectoryFiles,
  DROPPED_V1_VARIABLES,
  durableSequenceGaps,
  entityID,
  ENVIRONMENT_STATUS,
  eventData,
  eventSessionID,
  helpCommandPaths,
  helpFileName,
  hostInputs,
  interceptV2,
  isolatedEnvironmentV2,
  listItems,
  probeLoopbackPort,
  READY_PATTERN_V2,
  rootDirectories,
  routeCarrierV2,
  scenarioNames,
  SCENARIOS_V2,
  scrubRoot,
  statHostInputs,
  VERSION_PATTERN_V2,
} from './harness-v2.mjs';

describe('2.x launch environment', () => {
  const environment = isolatedEnvironmentV2('/r', { model: 'test/test-model' }, 'pw');

  it('isolates HOME and passes the password through both 2.x variables and nothing else', () => {
    expect(environment.HOME).toBe('/r/home');
    expect(environment.TMPDIR).toBe('/r/tmp');
    expect(environment.XDG_DATA_HOME).toBe('/r/xdg/data');
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
    expect(rootDirectories('/r').every((path) => path.startsWith('/r/'))).toBe(true);
    expect(rootDirectories('/r')).toContain('/r/home');
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

  it('records labels only and refuses the inputs 2.x reads but the census cannot redirect', () => {
    const inputs = hostInputs({ platform: 'darwin', user: 'someone' });
    const stats = statHostInputs(inputs, {
      home: '/h',
      stat: fakeStat(
        new Map([
          ['/h/.local/share/opencode', 1],
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

  it('reports a watched home that appeared, vanished or changed, and nothing else', () => {
    const inputs = hostInputs({ platform: 'linux' });
    const before = statHostInputs(inputs, { home: '/h', stat: fakeStat(new Map([['/h/.local/share/opencode', 1]])) });
    const same = statHostInputs(inputs, { home: '/h', stat: fakeStat(new Map([['/h/.local/share/opencode', 1]])) });
    expect(changedHostInputs(before, same)).toEqual([]);
    const after = statHostInputs(inputs, {
      home: '/h',
      stat: fakeStat(
        new Map([
          ['/h/.local/share/opencode', 2],
          ['/h/.opencode', 3],
          ['/h/.claude/skills', 4],
        ]),
      ),
    });
    expect(changedHostInputs(before, after)).toEqual(['user-opencode-data', 'user-opencode-install']);
  });
});

describe('background service port probe', () => {
  it('tells an open loopback port from a closed one', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    expect(await probeLoopbackPort(port)).toBe('open');
    await new Promise((done) => server.close(done));
    expect(await probeLoopbackPort(port)).toBe('closed');
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
    expect(call('tool-read')).toEqual({ name: 'read', input: { path: '/w/surface-census-read.txt' } });
    expect(call('tool-shell').name).toBe('shell');
    expect(call('subagent')).toMatchObject({ name: 'subagent', input: { prompt: CHILD_PROMPT } });
    expect(call('tool-failure')).toEqual({ name: 'read', input: { filePath: '/w/surface-census-read.txt' } });
  });

  it('probes every help page of the draft tree under a stable file name, and scrubs the probe root', () => {
    expect(helpCommandPaths({ commands: [{ path: [] }, { path: ['session', 'list'] }] })).toEqual([[], ['session', 'list']]);
    expect(helpCommandPaths({})).toEqual([[]]);
    expect(helpFileName([])).toBe('root.txt');
    expect(helpFileName(['service', 'status'])).toBe('service-status.txt');
    expect(scrubRoot('log at /t/x/root/state and /private/t/x/root', ['/t/x/root', '/private/t/x/root'])).toBe(
      'log at <probe-root>/state and <probe-root>',
    );
  });
});
