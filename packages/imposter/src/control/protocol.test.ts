import { describe, expect, it } from 'vitest';
import type { SurfaceModel } from '@vibefield/puppeteer-surface';
import {
  defaultSocketPath,
  defaultTokenPath,
  httpStatusForCode,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  nativeEventsFromModel,
  NOT_FOUND,
  opsFromPersona,
  parseFault,
  parseHello,
  parseRunflows,
  parseScenarioDriver,
  parseScenarioRunProgress,
  parseOpRequest,
  parseScenarioControl,
  parseScenarioRun,
  parseTrigger,
  REFUSED,
} from './protocol.ts';

const scenarioDriver = { state: 'ready', enabled: ['turn.start'], offModel: 0, applied: 3, heartbeats: 1 };
const nativeBehavior = {
  behaviorVersion: 1,
  title: 'Claude native hooks',
  lanes: [{ id: 'turn', label: 'Turn' }],
  nodes: [
    {
      id: 'notification',
      event: 'Notification',
      confidence: 'verified-interactive',
      lane: 'turn',
      order: 0,
    },
  ],
  relations: [],
};

const hello = {
  token: 'secret',
  vendor: 'claude',
  version: '2.1.207',
  sessionId: 'd0ffe3f0-0000-4000-8000-000000000000',
  pid: 4242,
  cwd: '/work',
  channels: ['hook', 'hook', 'transcript'],
  nativeBehavior,
  nativeEvents: [
    {
      event: 'Notification',
      fields: ['message', 'message', 'prompt_id'],
      channel: 'hook',
      channels: ['hook'],
      confidence: 'verified-interactive',
    },
  ],
  ops: [{ op: 'turn.start', channels: ['hook'], events: ['UserPromptSubmit'], fields: ['text'] }],
  runflows: [
    {
      id: 'happy-turn',
      intent: 'turn.basic',
      scenario: 'happy-turn',
      title: 'Basic turn',
      summary: 'A basic executable turn.',
      kind: 'typical',
      danger: 'safe',
      tags: ['turn'],
      defaultStimulus: { text: 'hello' },
      defaultSpeed: 4,
      steps: 3,
      events: ['UserPromptSubmit', 'Stop'],
      channels: ['hook'],
      requiresClient: false,
    },
  ],
  scenarioDriver,
};

describe('control protocol', () => {
  it('parses a hello and collapses duplicate channels and fields', () => {
    const parsed = parseHello(hello);
    expect(parsed.channels).toEqual(['hook', 'transcript']);
    expect(parsed.nativeEvents[0]!.fields).toEqual(['message', 'prompt_id']);
    expect(parsed.nativeBehavior.nodes[0]!.event).toBe('Notification');
    expect(parsed.runflows[0]).toMatchObject({ id: 'happy-turn', steps: 3, events: ['UserPromptSubmit', 'Stop'] });
  });

  it('validates curated runflows and defaults older hello messages to none', () => {
    expect(parseHello({ ...hello, runflows: undefined }).runflows).toEqual([]);
    expect(parseRunflows(hello.runflows)).toHaveLength(1);
    expect(() => parseRunflows([{ ...hello.runflows[0], defaultSpeed: 101 }])).toThrow(/defaultSpeed/);
    expect(() => parseRunflows([hello.runflows[0], hello.runflows[0]])).toThrow(/unique/);
  });

  it('preserves bounded multiline Surface descriptions without relaxing identity fields', () => {
    const descriptive = {
      ...hello,
      nativeEvents: [
        {
          ...hello.nativeEvents[0],
          trigger: 'First observed route.\n\nSecond documented route.',
          notes: 'Evidence is version-pinned.\nOrdering remains unverified.',
        },
      ],
    };
    expect(parseHello(descriptive).nativeEvents[0]).toMatchObject({
      trigger: 'First observed route.\n\nSecond documented route.',
      notes: 'Evidence is version-pinned.\nOrdering remains unverified.',
    });
    expect(() =>
      parseHello({
        ...descriptive,
        nativeEvents: [{ ...descriptive.nativeEvents[0], trigger: 'invalid\0description' }],
      }),
    ).toThrow(/trigger/);
  });

  it('refuses a hello with an unusable pid or a multi-line field', () => {
    expect(() => parseHello({ ...hello, pid: 0 })).toThrow(/pid/);
    expect(() => parseHello({ ...hello, vendor: 'cla\nude' })).toThrow(/vendor/);
  });

  it('refuses a scenario-driver snapshot with a negative or fractional count', () => {
    expect(() => parseHello({ ...hello, scenarioDriver: { ...scenarioDriver, offModel: -1 } })).toThrow(/offModel/);
    expect(() => parseHello({ ...hello, scenarioDriver: { ...scenarioDriver, applied: 1.5 } })).toThrow(/applied/);
    expect(parseScenarioDriver(scenarioDriver).state).toBe('ready');
  });

  it('requires native graph nodes to be exact events carried by the same Surface', () => {
    expect(() =>
      parseHello({
        ...hello,
        nativeBehavior: {
          ...nativeBehavior,
          nodes: [
            {
              id: 'normalized',
              event: 'agent.compacting',
              confidence: 'verified-headless',
              lane: 'turn',
              order: 0,
            },
          ],
        },
      }),
    ).toThrow(/unknown native event/);
  });

  it('does not let a payload-discriminated node borrow confidence implicitly from its method', () => {
    const node = { ...nativeBehavior.nodes[0], match: { 'item.type': 'contextCompaction' } };
    delete (node as Partial<typeof node>).confidence;
    expect(() => parseHello({ ...hello, nativeBehavior: { ...nativeBehavior, nodes: [node] } })).toThrow(/confidence/);
  });

  it('defaults an op argument to an empty object, like a trigger payload', () => {
    expect(parseOpRequest({ op: 'turn.end' })).toEqual({ op: 'turn.end', with: {} });
    expect(() => parseOpRequest({ op: 'turn.end', with: 'text' })).toThrow(/must be an object/);
    expect(() => parseOpRequest({})).toThrow(/op/);
  });

  it('defaults a trigger payload to an empty object but not to a non-object', () => {
    expect(parseTrigger({ event: 'Stop' })).toEqual({ event: 'Stop', with: {} });
    expect(parseTrigger({ event: 'session/update', channel: 'session-log' })).toEqual({
      event: 'session/update',
      channel: 'session-log',
      with: {},
    });
    expect(() => parseTrigger({ event: 'Stop', with: [] })).toThrow(/must be an object/);
    expect(() => parseTrigger({})).toThrow(/event/);
  });

  it('requires exactly one of scenario name or script', () => {
    expect(() => parseScenarioRun({})).toThrow(/exactly one/);
    expect(() => parseScenarioRun({ name: 'flood', script: [] })).toThrow(/exactly one/);
    expect(parseScenarioRun({ name: 'flood', runflowId: 'stress-flood' })).toMatchObject({
      name: 'flood',
      runflowId: 'stress-flood',
      mode: 'play',
      speed: 1,
    });
    expect(() => parseScenarioRun({ script: [], runflowId: 'stress-flood' })).toThrow(/named scenario/);
    expect(() => parseScenarioRun({ name: 'flood', runflowId: 'Not Valid' })).toThrow(/lowercase/);
  });

  it('bounds scenario mode and speed', () => {
    expect(() => parseScenarioRun({ name: 'flood', mode: 'rewind' })).toThrow(/play\|pause\|step/);
    expect(() => parseScenarioRun({ name: 'flood', speed: 0 })).toThrow(/speed/);
    expect(() => parseScenarioRun({ name: 'flood', speed: 101 })).toThrow(/speed/);
    expect(parseScenarioRun({ name: 'flood', mode: 'pause', speed: 4 })).toMatchObject({ mode: 'pause', speed: 4 });
  });

  it('accepts only the three scenario control actions', () => {
    expect(parseScenarioControl({ action: 'step' })).toEqual({ action: 'step' });
    expect(() => parseScenarioControl({ action: 'rewind' })).toThrow(/pause\|step\|resume/);
  });

  it('validates scenario-run progress as bounded control metadata', () => {
    const progress = {
      runId: 'run-1',
      runflowId: 'happy-turn',
      scenario: 'happy-turn',
      mode: 'step',
      status: 'paused',
      step: 1,
      steps: 3,
      fromSequence: 4,
    };
    expect(parseScenarioRunProgress(progress)).toEqual(progress);
    expect(() => parseScenarioRunProgress({ ...progress, step: 4 })).toThrow(/step/);
    expect(() => parseScenarioRunProgress({ ...progress, status: 'cancelled' })).toThrow(/status/);
    expect(() => parseScenarioRunProgress({ ...progress, status: 'completed' })).toThrow(/throughSequence/);
    expect(() => parseScenarioRunProgress({ ...progress, status: 'failed', throughSequence: 4 })).toThrow(/error/);
  });

  it('checks channel-drop against the session live channels', () => {
    expect(() => parseFault({ kind: 'channel-drop' }, ['hook'])).toThrow(/channel-drop/);
    expect(() => parseFault({ kind: 'channel-drop', channel: 'smoke' }, ['hook'])).toThrow(/channel-drop/);
    expect(parseFault({ kind: 'channel-drop', channel: 'hook' }, ['hook'])).toMatchObject({ channel: 'hook' });
  });

  it('bounds a flood count and rejects an unknown fault kind', () => {
    expect(() => parseFault({ kind: 'meltdown' })).toThrow(/fault kind/);
    expect(() => parseFault({ kind: 'flood', count: 10_001 })).toThrow(/count/);
    expect(parseFault({ kind: 'flood', count: 250, event: 'Notification' })).toMatchObject({ count: 250 });
  });

  it('maps JSON-RPC codes onto the statuses the console already expects', () => {
    expect(httpStatusForCode(REFUSED)).toBe(422);
    expect(httpStatusForCode(NOT_FOUND)).toBe(404);
    expect(httpStatusForCode(METHOD_NOT_FOUND)).toBe(404);
    expect(httpStatusForCode(INVALID_PARAMS)).toBe(400);
    expect(httpStatusForCode(-1)).toBe(500);
  });

  it('derives native event controls from the Surface, with evidence metadata', () => {
    const model = {
      events: [
        {
          event: 'Stop',
          channel: 'hooks',
          channels: ['hooks', 'transcript'],
          confidence: 'verified-headless',
          transport: 'stdin/stdout',
          payloadSchema: { type: 'object', properties: { stop_hook_active: {}, prompt_id: {} } },
        },
        { event: 'Bare', channel: 'hooks', channels: ['hooks'], confidence: 'unverified' },
      ],
    } as unknown as SurfaceModel;
    expect(nativeEventsFromModel(model)).toEqual([
      {
        event: 'Stop',
        fields: ['prompt_id', 'stop_hook_active'],
        channel: 'hooks',
        channels: ['hooks', 'transcript'],
        confidence: 'verified-headless',
        transport: 'stdin/stdout',
      },
      { event: 'Bare', fields: [], channel: 'hooks', channels: ['hooks'], confidence: 'unverified' },
    ]);
  });

  it('derives op descriptors from the persona bindings, arguments included', () => {
    const persona = {
      channelFor: (kind: string) => (kind === 'jsonrpc' ? 'app-server' : kind),
      ops: {
        'tool.start': [{ channel: 'jsonrpc', event: 'item/started', with: { item: { command: '$op.command' } } }],
        'permission.ask': [{ channel: 'jsonrpc', event: 'ask', await: true, with: { id: '$op.toolId' } }],
      },
    } as unknown as Parameters<typeof opsFromPersona>[0];
    expect(opsFromPersona(persona)).toEqual([
      // `command` is found nested inside the template, which is where codex
      // puts it — a shallow scan would have offered an argument-less form.
      { op: 'tool.start', channels: ['app-server'], events: ['item/started'], fields: ['command'] },
      { op: 'permission.ask', channels: ['app-server'], events: ['ask'], fields: ['toolId'], awaits: true },
    ]);
  });

  it('honours the socket and token overrides so tests never touch the real home', () => {
    expect(defaultSocketPath({ PUPPETEER_IMPOSTER_SOCKET: '/tmp/p/x.sock' })).toBe('/tmp/p/x.sock');
    expect(defaultTokenPath({ PUPPETEER_IMPOSTER_TOKEN_FILE: '/tmp/p/x.token' })).toBe('/tmp/p/x.token');
    expect(defaultSocketPath({})).toMatch(/imposter\.sock$|puppeteer-imposter$/);
  });
});
