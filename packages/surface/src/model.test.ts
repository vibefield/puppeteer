import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  diffModelVsReport,
  loadModel,
  validatePayload,
  type PayloadSchema,
  type SurfaceModel,
} from './model.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'puppeteer-asm-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validatePayload', () => {
  const schema: PayloadSchema = {
    type: 'object',
    required: ['session_id', 'prompt'],
    properties: {
      session_id: { type: 'string' },
      prompt: { type: 'string' },
      background_tasks: { type: 'array' },
      effort: { type: 'object' },
      stop_hook_active: { type: 'boolean' },
    },
  };

  it('accepts a payload satisfying the schema', () => {
    expect(validatePayload(schema, { session_id: 'x', prompt: 'hi' })).toEqual([]);
  });

  it('flags missing required fields', () => {
    expect(validatePayload(schema, { session_id: 'x' })).toEqual(['missing required field "prompt"']);
  });

  it('flags top-level type mismatches, arrays as arrays, null as null', () => {
    const violations = validatePayload(schema, {
      session_id: 'x',
      prompt: 'hi',
      background_tasks: {},
      effort: null,
      stop_hook_active: 'yes',
    });
    expect(violations).toEqual([
      'field "background_tasks" is object, expected array',
      'field "effort" is null, expected object',
      'field "stop_hook_active" is string, expected boolean',
    ]);
  });

  it('rejects non-object payloads', () => {
    expect(validatePayload(schema, [1, 2])).toEqual(['payload is array, expected object']);
    expect(validatePayload(schema, 'x')).toEqual(['payload is string, expected object']);
  });

  it('enforces enums when present', () => {
    const withEnum: PayloadSchema = {
      type: 'object',
      properties: { level: { type: 'string', enum: ['high', 'low'] } },
    };
    expect(validatePayload(withEnum, { level: 'high' })).toEqual([]);
    expect(validatePayload(withEnum, { level: 'xhigh' })).toEqual(['field "level" value not in enum']);
  });

  it('enforces numeric bounds used by transport carriers', () => {
    const bounded: PayloadSchema = {
      type: 'object',
      properties: { timestamp: { type: 'number', minimum: 1_000_000_000_000 } },
    };
    expect(validatePayload(bounded, { timestamp: 1_767_225_600_000 })).toEqual([]);
    expect(validatePayload(bounded, { timestamp: 1_767_225_600 })).toEqual([
      'field "timestamp" is below minimum 1000000000000',
    ]);
  });

  it('enforces integers, exclusive numeric bounds, and union branches', () => {
    const constrained: PayloadSchema = {
      type: 'object',
      required: ['count', 'compaction'],
      properties: {
        count: { type: 'integer', exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        compaction: {
          type: 'object',
          anyOf: [
            { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
            {
              type: 'object',
              required: ['contextSummary'],
              properties: { contextSummary: { type: 'string' } },
            },
          ],
        },
      },
    };
    expect(validatePayload(constrained, { count: 1, compaction: { summary: 'kept' } })).toEqual([]);
    expect(validatePayload(constrained, { count: 0, compaction: {} })).toEqual([
      'field "count" is not above exclusive minimum 0',
      'field "compaction" does not satisfy anyOf',
    ]);
    expect(validatePayload(constrained, { count: 1.5, compaction: { contextSummary: 'kept' } })).toEqual([
      'field "count" is number, expected integer',
    ]);
  });

  it('validates required fields and enums recursively', () => {
    const nested: PayloadSchema = {
      type: 'object',
      required: ['update'],
      properties: {
        update: {
          type: 'object',
          required: ['sessionUpdate'],
          properties: {
            sessionUpdate: { type: 'string', enum: ['tool_call', 'tool_call_update'] },
          },
        },
      },
    };
    expect(validatePayload(nested, { update: {} })).toEqual(['missing required field "update.sessionUpdate"']);
    expect(validatePayload(nested, { update: { sessionUpdate: 'future_type' } })).toEqual([
      'field "update.sessionUpdate" value not in enum',
    ]);
  });
});

// ---------------------------------------------------------------------------

function writeModel(modelDir: string, events: Record<string, unknown>[]): void {
  mkdirSync(join(modelDir, 'events'), { recursive: true });
  writeFileSync(
    join(modelDir, 'manifest.json'),
    JSON.stringify({ asmVersion: 1, vendor: 'fake', vendorVersion: '1.0.0', generatedAt: '2026-08-07' }),
  );
  writeFileSync(join(modelDir, 'detection.json'), JSON.stringify({ executables: ['fake'] }));
  writeFileSync(join(modelDir, 'channels.json'), JSON.stringify({ channels: { hook: { kind: 'hook-http' } } }));
  writeFileSync(
    join(modelDir, 'behavior.json'),
    JSON.stringify({
      behaviorVersion: 1,
      title: 'Fake native lifecycle',
      lanes: [{ id: 'session', label: 'Session' }],
      nodes: events.map((event, index) => ({
        id: `event-${index}`,
        event: event.event,
        confidence: event.confidence,
        lane: 'session',
        order: index,
      })),
      relations: events.slice(1).map((_event, index) => ({
        from: `event-${index}`,
        to: `event-${index + 1}`,
        kind: 'sequence',
        confidence: 'verified-headless',
      })),
    }),
  );
  for (const event of events) {
    const eventPath = join(modelDir, 'events', `${event.event as string}.json`);
    mkdirSync(dirname(eventPath), { recursive: true });
    writeFileSync(eventPath, JSON.stringify(event));
  }
}

function eventFile(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    surface: 'fake',
    surfaceVersion: '1.0.0',
    channel: 'hook',
    confidence: 'verified-headless',
    fixture: 'captures/fake.jsonl',
    firstSeen: '1.0.0',
    lastVerified: '1.0.0',
    ...overrides,
  };
}

function upgradeFixtureToV2(modelDir: string): void {
  const manifestPath = join(modelDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, asmVersion: 2, evidence: 'evidence.json' }));
  writeFileSync(
    join(modelDir, 'evidence.json'),
    JSON.stringify({
      evidenceVersion: 2,
      vendor: 'fake',
      vendorVersion: '1.0.0',
      artifacts: [{ id: 'fake-binary' }],
      sourceReferences: [{ repository: 'https://example.invalid/fake', revision: 'one' }],
      records: [{ id: 'captures' }],
      claims: [
        {
          id: 'captured',
          kind: 'runtime-capture',
          confidence: 'verified-headless',
          record: 'captures',
          artifact: 'fake-binary',
          platform: 'test-platform',
          harness: 'fixture',
          capturedAt: '2026-08-07T00:00:00Z',
        },
        {
          id: 'source-lead',
          kind: 'exact-source',
          confidence: 'unverified',
          sourceReference: 0,
        },
      ],
    }),
  );
  const behaviorPath = join(modelDir, 'behavior.json');
  const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8')) as {
    nodes: Array<Record<string, unknown>>;
    relations: Array<Record<string, unknown>>;
  };
  for (const node of behavior.nodes) node.evidence = { existence: ['captured'], shape: ['captured'] };
  for (const relation of behavior.relations) {
    relation.evidence = { existence: ['captured'], shape: ['captured'], ordering: ['captured'] };
  }
  writeFileSync(behaviorPath, JSON.stringify(behavior));
  for (const event of eventDocumentPaths(modelDir)) {
    const document = JSON.parse(readFileSync(event, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      event,
      JSON.stringify({
        ...document,
        direction: 'agent-to-client',
        evidence: { existence: ['captured'], shape: ['captured'] },
      }),
    );
  }
}

function eventDocumentPaths(modelDir: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.json')) found.push(path);
    }
  };
  visit(join(modelDir, 'events'));
  return found;
}

describe('loadModel', () => {
  it('loads a model dir with events sorted by name', () => {
    writeModel(dir, [eventFile({ event: 'Stop' }), eventFile({ event: 'SessionStart' })]);
    const model = loadModel(dir);
    expect(model.manifest.vendor).toBe('fake');
    expect(model.events.map((event) => event.event)).toEqual(['SessionStart', 'Stop']);
    expect(model.behavior.title).toBe('Fake native lifecycle');
    expect(model.behavior.nodes.map((node) => node.event)).toEqual(['Stop', 'SessionStart']);
  });

  it('throws on a malformed event file', () => {
    writeModel(dir, [{ event: 'Broken' }]);
    expect(() => loadModel(dir)).toThrow(/missing required field/);
  });

  it('throws on an unsupported asmVersion', () => {
    writeModel(dir, [eventFile({ event: 'Stop' })]);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ asmVersion: 99, vendor: 'fake', vendorVersion: '1.0.0', generatedAt: '2026-08-07' }),
    );
    expect(() => loadModel(dir)).toThrow(/asmVersion/);
  });

  it('loads ASM v2 while keeping v1 readable, and computes per-variant confidence from evidence', () => {
    writeModel(dir, [
      eventFile({
        event: 'session/update',
        payloadSchema: {
          type: 'object',
          properties: { update: { type: 'string', enum: ['observed', 'source_only'] } },
        },
      }),
    ]);
    upgradeFixtureToV2(dir);
    const eventPath = join(dir, 'events', 'session', 'update.json');
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
    event.variants = [
      {
        match: { update: 'observed' },
        evidence: { existence: ['captured'], shape: ['captured'] },
      },
      {
        match: { update: 'source_only' },
        evidence: { existence: ['source-lead'], shape: ['source-lead'] },
      },
    ];
    writeFileSync(eventPath, JSON.stringify(event));

    const model = loadModel(dir);
    expect(model.manifest.asmVersion).toBe(2);
    expect(model.evidenceIndex?.claims).toHaveLength(2);
    expect(model.events[0]?.confidence).toBe('verified-headless');
    expect(model.events[0]?.variants?.map((variant) => variant.confidence)).toEqual([
      'verified-headless',
      'unverified',
    ]);
  });

  it('resolves variant discriminants declared inside anyOf branches', () => {
    writeModel(dir, [
      eventFile({
        event: 'union/event',
        payloadSchema: {
          type: 'object',
          required: ['event'],
          properties: {
            event: {
              type: 'object',
              anyOf: [
                { type: 'object', properties: { type: { type: 'string', enum: ['one'] } }, required: ['type'] },
                { type: 'object', properties: { type: { type: 'string', enum: ['two'] } }, required: ['type'] },
              ],
            },
          },
        },
      }),
    ]);
    upgradeFixtureToV2(dir);
    const eventPath = join(dir, 'events', 'union', 'event.json');
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
    event.variants = [
      { match: { 'event.type': 'one' }, evidence: { existence: ['captured'], shape: ['captured'] } },
      { match: { 'event.type': 'two' }, evidence: { existence: ['source-lead'], shape: ['source-lead'] } },
    ];
    writeFileSync(eventPath, JSON.stringify(event));

    expect(loadModel(dir).events[0]?.variants?.map((entry) => entry.match)).toEqual([
      { 'event.type': 'one' },
      { 'event.type': 'two' },
    ]);
  });

  it('rejects v2 enum branches with no attributable evidence and unknown evidence references', () => {
    writeModel(dir, [
      eventFile({
        event: 'Stop',
        payloadSchema: { type: 'object', properties: { reason: { type: 'string', enum: ['done'] } } },
      }),
    ]);
    upgradeFixtureToV2(dir);
    expect(() => loadModel(dir)).toThrow(/payload enums require per-variant evidence/);

    const eventPath = join(dir, 'events', 'Stop.json');
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
    event.variants = [{ match: { reason: 'done' }, evidence: { existence: ['missing'], shape: ['captured'] } }];
    writeFileSync(eventPath, JSON.stringify(event));
    expect(() => loadModel(dir)).toThrow(/references unknown evidence "missing"/);
  });

  it('rejects cross-document identity and channel drift', () => {
    writeModel(dir, [eventFile({ event: 'Stop', surfaceVersion: '2.0.0' })]);
    expect(() => loadModel(dir)).toThrow(/surface identity/);

    writeModel(dir, [eventFile({ event: 'Stop', channel: 'transcript' })]);
    expect(() => loadModel(dir)).toThrow(/unknown channel/);
  });

  it('loads all declared event rails and rejects inconsistent rail declarations', () => {
    writeModel(dir, [eventFile({ event: 'Stop', channels: ['hook'] })]);
    expect(loadModel(dir).events[0]?.channels).toEqual(['hook']);

    writeModel(dir, [eventFile({ event: 'Stop', channels: ['transcript'] })]);
    expect(() => loadModel(dir)).toThrow(/must include primary channel "hook"/);

    writeModel(dir, [eventFile({ event: 'Stop', channels: ['hook', 'missing'] })]);
    expect(() => loadModel(dir)).toThrow(/unknown channel "missing"/);
  });

  it('models HTTP hook results and matcher-gated observation without treating notifications as requests', () => {
    writeModel(dir, [eventFile({ event: 'WorktreeCreate', transport: 'http' })]);
    upgradeFixtureToV2(dir);
    const eventPath = join(dir, 'events', 'WorktreeCreate.json');
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
    event.resultSchema = {
      type: 'object',
      required: ['worktreePath'],
      properties: { worktreePath: { type: 'string' } },
    };
    event.matcherRequired = true;
    (event.evidence as Record<string, unknown>).result = ['captured'];
    writeFileSync(eventPath, JSON.stringify(event));

    const loaded = loadModel(dir).events[0]!;
    expect(loaded.resultSchema?.required).toEqual(['worktreePath']);
    expect(loaded.matcherRequired).toBe(true);

    event.transport = 'jsonrpc-notification';
    writeFileSync(eventPath, JSON.stringify(event));
    expect(() => loadModel(dir)).toThrow(/resultSchema is only valid for a request transport/);

    event.transport = 'http';
    event.matcherRequired = 'yes';
    writeFileSync(eventPath, JSON.stringify(event));
    expect(() => loadModel(dir)).toThrow(/matcherRequired must be a boolean/);
  });

  it('rejects malformed payload schemas before they reach an audit', () => {
    writeModel(dir, [
      eventFile({
        event: 'Stop',
        payloadSchema: { type: 'object', required: ['session_id'], properties: {} },
      }),
    ]);
    expect(() => loadModel(dir)).toThrow(/required payload field "session_id"/);
  });

  it('rejects malformed nested payload schemas before they reach an audit', () => {
    writeModel(dir, [
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          properties: {
            update: { type: 'object', required: ['sessionUpdate'], properties: {} },
          },
        },
      }),
    ]);
    expect(() => loadModel(dir)).toThrow(/required field "sessionUpdate" is absent/);
  });

  it('rejects unknown confidence values and incomplete verification evidence', () => {
    writeModel(dir, [eventFile({ event: 'Stop', confidence: 'probably-verified' })]);
    expect(() => loadModel(dir)).toThrow(/confidence must be/);

    writeModel(dir, [eventFile({ event: 'Stop', lastVerified: undefined })]);
    expect(() => loadModel(dir)).toThrow(/fixture, firstSeen, and lastVerified/);
  });

  it('rejects behavior nodes and relations that invent native topology', () => {
    writeModel(dir, [eventFile({ event: 'Stop' })]);
    const behaviorPath = join(dir, 'behavior.json');
    const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      behaviorPath,
      JSON.stringify({
        ...behavior,
        nodes: [
          {
            id: 'invented',
            event: 'NormalizedThing',
            confidence: 'verified-headless',
            lane: 'session',
            order: 0,
          },
        ],
        relations: [],
      }),
    );
    expect(() => loadModel(dir)).toThrow(/references unknown event "NormalizedThing"/);

    writeModel(dir, [eventFile({ event: 'Stop' }), eventFile({ event: 'SessionStart' })]);
    const valid = JSON.parse(readFileSync(behaviorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      behaviorPath,
      JSON.stringify({
        ...valid,
        relations: [{ from: 'event-0', to: 'missing', kind: 'sequence', confidence: 'verified-headless' }],
      }),
    );
    expect(() => loadModel(dir)).toThrow(/references an unknown node/);
  });

  it('accepts native payload discriminants and rejects normalized objects in a match', () => {
    writeModel(dir, [eventFile({ event: 'item/started' })]);
    const behaviorPath = join(dir, 'behavior.json');
    const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      behaviorPath,
      JSON.stringify({
        ...behavior,
        nodes: [
          {
            id: 'compact-start',
            event: 'item/started',
            confidence: 'unverified',
            lane: 'session',
            order: 0,
            match: { 'item.type': 'contextCompaction' },
          },
        ],
      }),
    );
    expect(loadModel(dir).behavior.nodes[0]?.match).toEqual({ 'item.type': 'contextCompaction' });

    const invalid = JSON.parse(readFileSync(behaviorPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      behaviorPath,
      JSON.stringify({
        ...invalid,
        nodes: [
          {
            id: 'compact-start',
            event: 'item/started',
            confidence: 'unverified',
            lane: 'session',
            order: 0,
            match: { 'item.type': { normalized: true } },
          },
        ],
      }),
    );
    expect(() => loadModel(dir)).toThrow(/must be scalar/);
  });

  it('requires evidence confidence for the event-plus-selector node claim', () => {
    writeModel(dir, [eventFile({ event: 'item/started' })]);
    const behaviorPath = join(dir, 'behavior.json');
    const behavior = JSON.parse(readFileSync(behaviorPath, 'utf8')) as {
      nodes: Array<Record<string, unknown>>;
    };
    delete behavior.nodes[0]!.confidence;
    writeFileSync(behaviorPath, JSON.stringify(behavior));
    expect(() => loadModel(dir)).toThrow(/missing required field "confidence"/);
  });
});

// ---------------------------------------------------------------------------

function writeCaptures(capturesDir: string, files: Record<string, object[]>): void {
  for (const [name, lines] of Object.entries(files)) {
    const path = join(capturesDir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }
}

describe('buildReport', () => {
  it('counts events and field presence across nested capture dirs', () => {
    writeCaptures(dir, {
      'headless/Stop.jsonl': [
        { hook_event_name: 'Stop', session_id: 'a', stop_hook_active: false },
        { hook_event_name: 'Stop', session_id: 'b', stop_hook_active: true, extra: 1 },
      ],
      'interactive/Notification.jsonl': [{ hook_event_name: 'Notification', session_id: 'a', message: 'm' }],
    });
    const report = buildReport(dir);
    expect(report.unparsedLines).toBe(0);
    expect(report.events.map((event) => event.event)).toEqual(['Notification', 'Stop']);
    const stop = report.events[1]!;
    expect(stop.count).toBe(2);
    expect(stop.fields).toEqual({ extra: 1, hook_event_name: 2, session_id: 2, stop_hook_active: 2 });
  });

  it('falls back to the file basename', () => {
    writeCaptures(dir, { 'Custom.jsonl': [{ no_event_name: true }] });
    const report = buildReport(dir);
    expect(report.events[0]!.event).toBe('Custom');
  });

  it('records invalid JSON and envelopes without retaining payload values', () => {
    writeFileSync(join(dir, 'Broken.jsonl'), '{not json}\n42\n');
    const report = buildReport(dir);
    expect(report.unparsedLines).toBe(2);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['invalid-json', 'invalid-envelope']);
    expect(JSON.stringify(report.issues)).not.toContain('{not json}');
  });

  it('flags empty or misplaced event names in fixture files', () => {
    writeCaptures(dir, {
      'Stop.jsonl': [{ hook_event_name: '' }, { hook_event_name: 'Notification' }],
    });
    const report = buildReport(dir);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['invalid-envelope', 'invalid-envelope']);
    expect(report.issues[1]!.message).toContain('fixture filename "Stop"');
  });
});

// ---------------------------------------------------------------------------

describe('diffModelVsReport', () => {
  function modelWith(events: Record<string, unknown>[]): SurfaceModel {
    writeModel(dir, events);
    return loadModel(dir);
  }

  it('is clean when model and captures agree', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          required: ['session_id'],
          properties: {
            session_id: { type: 'string' },
            stop_hook_active: { type: 'boolean' },
            hook_event_name: { type: 'string' },
          },
        },
      }),
      eventFile({ event: 'Speculative', confidence: 'unverified' }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, {
      'Stop.jsonl': [{ hook_event_name: 'Stop', session_id: 'a', stop_hook_active: false }],
    });
    expect(diffModelVsReport(model, buildReport(capturesDir))).toEqual([]);
  });

  it('flags observed-unmodeled events', () => {
    const model = modelWith([eventFile({ event: 'Stop' })]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, { 'NewEvent.jsonl': [{ hook_event_name: 'NewEvent', x: 1 }] });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    const unmodeled = drift.filter((entry) => entry.kind === 'observed-unmodeled');
    expect(unmodeled).toHaveLength(1);
    expect(unmodeled[0]!.event).toBe('NewEvent');
  });

  it('flags unobserved-verified but not unobserved-unverified', () => {
    const model = modelWith([
      eventFile({ event: 'Stop' }),
      eventFile({ event: 'Speculative', confidence: 'unverified' }),
    ]);
    const capturesDir = join(dir, 'captures');
    mkdirSync(capturesDir, { recursive: true });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    expect(drift.map((entry) => entry.kind)).toEqual(['unobserved-verified']);
    expect(drift[0]!.event).toBe('Stop');
  });

  it('flags required fields missing from some captured lines', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          required: ['session_id'],
          properties: { session_id: { type: 'string' }, hook_event_name: { type: 'string' } },
        },
      }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, {
      'Stop.jsonl': [{ hook_event_name: 'Stop', session_id: 'a' }, { hook_event_name: 'Stop' }],
    });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    expect(drift.map((entry) => entry.kind)).toEqual(['schema-mismatch']);
    expect(drift[0]!.message).toContain('1/2');
  });

  it('flags captured fields the schema does not model', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          properties: { session_id: { type: 'string' }, hook_event_name: { type: 'string' } },
        },
      }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, { 'Stop.jsonl': [{ hook_event_name: 'Stop', session_id: 'a', brand_new: 1 }] });
    const drift = diffModelVsReport(model, buildReport(capturesDir));
    expect(drift.map((entry) => entry.kind)).toEqual(['unmodeled-field']);
    expect(drift[0]!.message).toContain('brand_new');
  });

  it('validates the type and enum of every captured payload', () => {
    const model = modelWith([
      eventFile({
        event: 'Stop',
        payloadSchema: {
          type: 'object',
          properties: {
            hook_event_name: { type: 'string', enum: ['Stop'] },
            session_id: { type: 'string' },
            mode: { type: 'string', enum: ['default', 'plan'] },
          },
        },
      }),
    ]);
    const capturesDir = join(dir, 'captures');
    writeCaptures(capturesDir, {
      'Stop.jsonl': [
        { hook_event_name: 'Stop', session_id: 42, mode: 'surprise' },
        { hook_event_name: 'NotStop', session_id: 'a' },
      ],
    });
    const report = buildReport(capturesDir, model);
    const drift = diffModelVsReport(model, report);
    expect(report.validatedAgainst).toEqual({ vendor: 'fake', vendorVersion: '1.0.0' });
    expect(drift.some((entry) => entry.kind === 'schema-mismatch' && entry.message.includes('expected string'))).toBe(
      true,
    );
    expect(drift.some((entry) => entry.kind === 'schema-mismatch' && entry.message.includes('not in enum'))).toBe(true);
    expect(drift.some((entry) => entry.kind === 'observed-unmodeled' && entry.event === 'NotStop')).toBe(true);
  });

  it('fails drift when any capture line is malformed', () => {
    const model = modelWith([eventFile({ event: 'Stop' })]);
    const capturesDir = join(dir, 'captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, 'Stop.jsonl'), '{broken}\n');
    const drift = diffModelVsReport(model, buildReport(capturesDir, model));
    expect(drift.some((entry) => entry.kind === 'invalid-capture')).toBe(true);
  });
});
