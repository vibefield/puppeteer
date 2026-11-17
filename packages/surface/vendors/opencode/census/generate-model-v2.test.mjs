import { describe, expect, it } from 'vitest';
import { exactSourceEventSchemas, openApiHttpOperations } from '@vibefield/puppeteer-surface';
import { draftEventContract } from './event-contract-v2.mjs';
import {
  contractEventDocument,
  detectionDocument,
  emptyObservations,
  httpEventDocument,
  inferredSchema,
  inputProblems,
  observeScenario,
  recordPayload,
  routeShape,
  runtimeEvidence,
  sampledEventDocument,
} from './generate-model-v2.mjs';

const COMMIT = '9bbb8ce18c80f099e0e448775f59d965ead40a21';

const openapi = {
  openapi: '3.1.0',
  info: { title: 'opencode', version: '2.2.5' },
  paths: {
    '/api/session/{sessionID}': {
      get: {
        operationId: 'session.get',
        parameters: [{ name: 'sessionID', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/api/session/{sessionID}/interrupt': {
      post: {
        operationId: 'session.interrupt',
        parameters: [{ name: 'sessionID', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
};

function observedTurn() {
  return observeScenario(emptyObservations(), 'turn', {
    events: [
      { id: 'evt_1', type: 'server.connected', data: {} },
      { id: 'evt_2', created: 1, type: 'session.renamed', data: '{"sessionID":"ses_a","title":"t"}' },
    ],
    http: [
      { direction: 'client-to-agent', request: { method: 'GET', route: '/api/session/:sessionID' } },
      { direction: 'agent-to-client', response: { method: 'GET', route: '/api/session/:sessionID', status: 200 } },
      { direction: 'client-to-agent', line: '1.x', request: { method: 'POST', route: '/session/:sessionID/abort' } },
      { direction: 'agent-to-client', response: { method: 'GET', route: '/api/event', status: 200 } },
    ],
  });
}

describe('observations', () => {
  it('matches trace routes to OpenAPI routes by shape, whatever the parameter names', () => {
    expect(routeShape('/api/session/:sessionID/permission/:requestID/reply')).toBe(
      routeShape('/api/session/{id}/permission/{permissionID}/reply'),
    );
    expect(routeShape('/api/session/{sessionID}')).toBe('/api/session/:*');
    expect(routeShape('/api/event')).toBe('/api/event');
  });

  it('reads either payload form and leaves the 1.x seed traffic out', () => {
    expect(recordPayload({ data: { a: 1 } })).toEqual({ a: 1 });
    expect(recordPayload({ data: '{"a":1}' })).toEqual({ a: 1 });
    expect(recordPayload({ data: '{' })).toBeUndefined();
    const observed = observedTurn();
    expect([...observed.requests.keys()]).toEqual(['GET /api/session/:*']);
    expect([...observed.responses.keys()].sort()).toEqual(['GET /api/event', 'GET /api/session/:*']);
    expect(observed.events.get('session.renamed').samples[0].payload).toEqual({ sessionID: 'ses_a', title: 't' });
    expect(observed.scenarios).toEqual(['turn']);
    expect(runtimeEvidence(observed.events.get('server.connected'))).toEqual({
      id: 'opencode-runtime-turn',
      scenario: 'turn',
      confidence: 'verified-headless',
    });
    expect(runtimeEvidence(undefined).confidence).toBe('unverified');
  });
});

describe('HTTP documents from the runtime OpenAPI 3.1', () => {
  const operations = openApiHttpOperations(openapi);
  const observed = observedTurn();

  it('verifies an operation the census exercised both ways and cites its fixture', () => {
    const document = httpEventDocument(
      operations.find((operation) => operation.operationId === 'session.get'),
      observed,
      '2.2.5',
    );
    expect(document).toMatchObject({
      event: 'http/session.get',
      surfaceVersion: '2.2.5',
      confidence: 'verified-headless',
      fixture: 'captures/opencode@2.2.5/turn/http-roundtrip.jsonl',
      evidence: { existence: ['opencode-generated-openapi', 'opencode-runtime-turn'] },
    });
  });

  it('leaves a schema-only operation unverified on the OpenAPI claim alone', () => {
    const document = httpEventDocument(
      operations.find((operation) => operation.operationId === 'session.interrupt'),
      observed,
      '2.2.5',
    );
    expect(document.confidence).toBe('unverified');
    expect(document.evidence.existence).toEqual(['opencode-generated-openapi']);
    expect(document).not.toHaveProperty('fixture');
  });
});

describe('SSE documents', () => {
  const contract = draftEventContract(
    {
      upstream: { repository: 'anomalyco/opencode', tag: 'v2.2.5', commit: COMMIT },
      events: [
        {
          type: 'session.renamed',
          durability: 'durable',
          durable: { version: 1, aggregate: 'sessionID' },
          publicStream: true,
          source: ['session-event.ts'],
          data: [{ name: 'sessionID', optional: false, schema: 'SessionID' }],
        },
        {
          type: 'session.archived',
          durability: 'durable',
          durable: { version: 1, aggregate: 'sessionID' },
          publicStream: true,
          source: ['session-event.ts'],
          data: [{ name: 'sessionID', optional: false, schema: 'SessionID' }],
        },
      ],
    },
    {
      vendorVersion: '2.2.5',
      sourceFiles: {
        'session-event.ts': { path: 'packages/schema/src/session-event.ts', sha256: '0'.repeat(64), bytes: 1 },
      },
    },
  );
  const schemas = exactSourceEventSchemas(contract);
  const observed = observedTurn();

  it('cites the exact source and, where the census saw the event, the runtime claim', () => {
    const renamed = schemas.find((entry) => entry.event === 'session.renamed');
    expect(contractEventDocument(renamed, observed.events.get('session.renamed'), '2.2.5')).toMatchObject({
      event: 'session.renamed',
      channel: 'sse',
      confidence: 'verified-headless',
      schemaFidelity: { payload: 'semantic', carrier: 'semantic' },
      evidence: { existence: ['opencode-exact-release-source', 'opencode-runtime-turn'] },
      fixture: 'captures/opencode@2.2.5/turn/events.jsonl',
      notes: 'durable v1 (aggregate sessionID)',
    });
    const archived = schemas.find((entry) => entry.event === 'session.archived');
    const unseen = contractEventDocument(archived, undefined, '2.2.5');
    expect(unseen.confidence).toBe('unverified');
    expect(unseen.evidence.existence).toEqual(['opencode-exact-release-source']);
  });

  it('samples an observed event the contract lacks, with its type pinned', () => {
    const document = sampledEventDocument('server.connected', observed.events.get('server.connected'), '2.2.5');
    expect(document).toMatchObject({
      event: 'server.connected',
      schemaFidelity: { payload: 'sampled', carrier: 'sampled' },
      confidence: 'verified-headless',
      evidence: { existence: ['opencode-runtime-turn'] },
    });
    expect(document.recordSchema.properties.type).toEqual({ type: 'string', enum: ['server.connected'] });
    expect(document.payloadSchema).toEqual({ type: 'object' });
  });

  it('infers only the shapes present', () => {
    expect(inferredSchema([{ a: 1 }, { a: 2, b: 'x' }])).toEqual({
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'string' } },
      required: ['a'],
    });
    expect(inferredSchema([1, 'x'])).toEqual({ anyOf: [{ type: 'integer' }, { type: 'string' }] });
    expect(inferredSchema([])).toEqual({});
  });
});

describe('detection and inputs', () => {
  it('detects the 2.x line by its own version line and launch flags', () => {
    const detection = detectionDocument('2.2.5');
    expect(new RegExp(detection.versionPattern).exec(detection.versionOutput)?.[1]).toBe('2.2.5');
    expect(new RegExp(detection.versionPattern).test('1.19.5')).toBe(false);
    expect(detection.launchFlags).toEqual({
      serve: 'serve',
      hostname: '--hostname',
      port: '--port',
      server: '--server',
      session: '--session',
    });
    expect(detection.passwordEnv).toEqual(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD']);
  });

  const artifact = {
    version: '2.2.5',
    platform: 'darwin-arm64',
    sha256: 'a'.repeat(64),
    sourceRevision: COMMIT,
    capturedAt: '2026-11-18T10:00:00.000Z',
  };
  const run = { vendorVersion: '2.2.5', platform: 'darwin-arm64', scenarios: {} };

  it('accepts a consistent run and names every inconsistency otherwise', () => {
    expect(inputProblems({ version: '2.2.5', artifact, run, openapi })).toEqual([]);
    expect(
      inputProblems({
        version: '2.2.5',
        artifact: { ...artifact, sourceRevision: null },
        run: { ...run, platform: 'linux-x64' },
        openapi: { openapi: '3.0.3' },
        contract: { kind: 'exact-source-event-contract', vendorVersion: '2.2.4', sourceRevision: 'b'.repeat(40) },
      }),
    ).toEqual(
      expect.arrayContaining([
        'artifact.json needs the commit of tag v2.2.5 as sourceRevision (a reviewer records it)',
        "census platform linux-x64 is not the artifact's darwin-arm64",
        'expected OpenAPI 3.1.0, got 3.0.3',
        'event contract is for 2.2.4',
        'event contract and artifact name different source revisions',
      ]),
    );
    expect(inputProblems({ version: '1.19.5', artifact, run, openapi })).toContain('version 1.19.5 is not a 2.x release');
  });
});
