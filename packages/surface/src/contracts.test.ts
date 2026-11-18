import { describe, expect, it } from 'vitest';
import {
  exactSourceEventContractProblems,
  exactSourceEventSchemas,
  OPENAPI_JSON_MEDIA_TYPES,
  openApiHttpOperations,
  openApiRoute,
  resolveOpenApiReference,
  validatePayload,
  type ExactSourceEventContract,
} from './model.js';

/** A small OpenAPI 3.1 document exercising what OpenCode 2.x's `/openapi.json` uses, and the spec rules around it. */
function document(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    paths: {
      '/api/session/{sessionID}/permission/{requestID}/reply': {
        parameters: [
          { $ref: '#/components/parameters/SessionID', description: 'the owning session' },
          { name: 'requestID', in: 'path', schema: { type: 'integer' } },
        ],
        post: {
          operationId: 'session.permission.reply',
          summary: 'Reply to pending permission request',
          description: 'Reply to pending permission request',
          parameters: [
            // Overrides the path-level parameter of the same name and location.
            { name: 'requestID', in: 'path', required: true, schema: { $ref: '#/components/schemas/Permission.ID' } },
            { name: 'Authorization', in: 'header', schema: { type: 'string' } },
            { name: 'x-opencode-ticket', in: 'header', schema: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
            { name: 'trace', in: 'cookie', required: true, schema: { type: 'string' } },
            { name: 'location', in: 'query', content: { 'application/json': { schema: { type: 'object' } } } },
          ],
          requestBody: { $ref: '#/components/requestBodies/Decision' },
          responses: {
            '204': { description: '<No Content>' },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
        // No operationId: no stable event name, so it is skipped.
        delete: { responses: { '204': { description: 'gone' } } },
      },
      '/api/event': {
        get: {
          operationId: 'event.subscribe',
          responses: {
            '200': {
              content: {
                'text/event-stream': {
                  schema: {
                    type: 'object',
                    properties: { data: { $ref: '#/components/schemas/V2EventEncoded' } },
                    required: ['data'],
                  },
                },
              },
            },
          },
        },
      },
      '/api/experimental/fs/write': {
        post: {
          operationId: 'fs.write',
          requestBody: {
            required: true,
            content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
          },
          responses: {
            '2XX': { content: { 'application/problem+json': { schema: { type: 'object' } } } },
          },
        },
      },
      '/api/config': {
        get: {
          operationId: 'config.get',
          responses: {
            '200': {
              content: {
                'application/json; charset=utf-8': {
                  schema: { type: 'object', prefixItems: [{ const: 'a' }], properties: { tag: { const: 'x' } } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      parameters: {
        SessionID: {
          name: 'sessionID',
          in: 'path',
          description: 'component text',
          schema: { $ref: '#/components/schemas/Session.ID' },
        },
      },
      requestBodies: {
        Decision: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { decision: { enum: ['once', 'always', 'reject'] } },
                required: ['decision'],
                additionalProperties: false,
              },
            },
          },
        },
      },
      responses: {
        NotFound: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { _tag: { const: 'PermissionNotFoundError' } } },
            },
          },
        },
      },
      schemas: {
        'Session.ID': { type: 'string', pattern: '^ses_' },
        'Permission.ID': { type: 'string', pattern: '^per_' },
        V2EventEncoded: { type: 'string', contentMediaType: 'application/json' },
      },
    },
  };
}

describe('OpenAPI 3.1 HTTP projection', () => {
  const operations = openApiHttpOperations(document());
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));

  it('lists operations with an operationId, sorted by path then method', () => {
    expect(operations.map((operation) => `${operation.method} ${operation.route}`)).toEqual([
      'GET /api/config',
      'GET /api/event',
      'POST /api/experimental/fs/write',
      'POST /api/session/:sessionID/permission/:requestID/reply',
    ]);
    expect(openApiRoute('/api/fs/read/*')).toBe('/api/fs/read/*');
  });

  it('merges path and operation parameters, follows component references, and drops the spec-ignored headers', () => {
    const reply = byId.get('session.permission.reply')!;
    expect(reply.trigger).toBe('Reply to pending permission request');
    const properties = reply.payloadSchema.properties!;
    expect(Object.keys(properties).sort()).toEqual([
      'body',
      'cookies',
      'headers',
      'method',
      'params',
      'query',
      'route',
    ]);
    expect(reply.payloadSchema.required).toEqual(['method', 'route', 'params', 'cookies', 'body']);
    expect(properties.params!.required).toEqual(['requestID', 'sessionID']);
    expect(properties.params!.properties!.requestID).toEqual({ $ref: '#/$defs/Permission.ID' });
    expect(Object.keys(properties.headers!.properties!)).toEqual(['x-opencode-ticket']);
    expect(properties.query!.properties!.location).toEqual({ type: 'object' });
    expect(reply.payloadSchema.$defs).toEqual({
      'Permission.ID': { type: 'string', pattern: '^per_' },
      'Session.ID': { type: 'string', pattern: '^ses_' },
    });
    expect(reply.requestMediaType).toBe('application/json');
    expect(reply.successStatus).toBe(204);
    expect(reply.resultSchema.required).toEqual(['method', 'route', 'status', 'params']);
    expect(reply.resultSchema.properties!.headers).toBeUndefined();
    expect(reply.responses.map((response) => [response.status, response.mediaType])).toEqual([
      ['204', undefined],
      ['404', 'application/json'],
    ]);
  });

  it('produces schemas that accept the 2.x body and reject the 1.x one', () => {
    const reply = byId.get('session.permission.reply')!;
    const request = {
      method: 'POST',
      route: reply.route,
      params: { sessionID: 'ses_1', requestID: 'per_1' },
      cookies: { trace: 't' },
      body: { decision: 'once' },
    };
    expect(validatePayload(reply.payloadSchema, request)).toEqual([]);
    expect(validatePayload(reply.recordSchema, { direction: 'client-to-agent', request })).toEqual([]);
    expect(validatePayload(reply.payloadSchema, { ...request, body: { reply: 'once' } })).not.toEqual([]);
    expect(
      validatePayload(reply.recordSchema, { direction: 'client-to-agent', request: { ...request, method: 'GET' } }),
    ).not.toEqual([]);
    expect(
      validatePayload(reply.resultSchema, { method: 'POST', route: reply.route, status: 204, params: request.params }),
    ).toEqual([]);
  });

  it('keeps non-JSON bodies by default and their media types, including a 2XX range', () => {
    const write = byId.get('fs.write')!;
    expect(write.requestMediaType).toBe('application/octet-stream');
    expect(write.payloadSchema.properties!.body).toEqual({ type: 'string', format: 'binary' });
    expect(write.payloadSchema.required).toContain('body');
    expect(write.successStatus).toBeUndefined();
    expect(write.successMediaType).toBe('application/problem+json');
    const event = byId.get('event.subscribe')!;
    expect(event.successMediaType).toBe('text/event-stream');
    expect(event.resultSchema.properties!.body!.properties!.data).toEqual({ $ref: '#/$defs/V2EventEncoded' });
    expect(event.resultSchema.$defs!.V2EventEncoded).toEqual({ type: 'string', contentMediaType: 'application/json' });
    const config = byId.get('config.get')!;
    expect(config.successMediaType).toBe('application/json; charset=utf-8');
    expect(config.resultSchema.properties!.body!.prefixItems).toEqual([{ const: 'a' }]);
  });

  it('restricts bodies to JSON media types when asked, as the 1.x generator does', () => {
    const json = new Map(
      openApiHttpOperations(document(), { bodyMediaTypes: OPENAPI_JSON_MEDIA_TYPES }).map((operation) => [
        operation.operationId,
        operation,
      ]),
    );
    expect(json.get('fs.write')!.payloadSchema.properties!.body).toBeUndefined();
    expect(json.get('fs.write')!.requestMediaType).toBeUndefined();
    expect(json.get('event.subscribe')!.resultSchema.properties!.body).toBeUndefined();
    expect(json.get('fs.write')!.successMediaType).toBe('application/problem+json');
    expect(json.get('config.get')!.successMediaType).toBe('application/json; charset=utf-8');
  });

  it('resolves references of any component kind, outermost summary first, and refuses cycles', () => {
    const root = {
      components: {
        responses: { A: { $ref: '#/components/responses/B', description: 'inner' }, B: { description: 'target' } },
        parameters: { Loop: { $ref: '#/components/parameters/Loop' } },
      },
    };
    expect(resolveOpenApiReference({ $ref: '#/components/responses/A', description: 'outer' }, root)).toEqual({
      description: 'outer',
    });
    expect(resolveOpenApiReference({ $ref: '#/components/responses/A' }, root)).toEqual({ description: 'inner' });
    expect(resolveOpenApiReference({ $ref: '#/components/parameters/Loop' }, root)).toBeUndefined();
    expect(resolveOpenApiReference({ $ref: 'https://example.invalid/x' }, root)).toBeUndefined();
  });
});

function contract(): ExactSourceEventContract {
  return {
    kind: 'exact-source-event-contract',
    contractVersion: 1,
    vendor: 'example',
    vendorVersion: '2.2.5',
    sourceRepository: 'https://example.invalid/agent',
    sourceTag: 'v2.2.5',
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    sourceFiles: [
      { path: 'packages/schema/src/session.ts', sha256: 'a'.repeat(64), bytes: 10, symbols: ['Created'] },
      { path: 'packages/schema/src/permission.ts', sha256: 'b'.repeat(64), bytes: 20 },
    ],
    envelope: {
      discriminator: 'type',
      payload: 'data',
      payloadEncodings: ['object', 'json-string'],
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          created: { type: 'integer' },
          location: { type: 'object', properties: { directory: { type: 'string' } } },
          durable: { $ref: '#/$defs/Durable' },
          data: {},
        },
        required: ['id'],
      },
    },
    $defs: {
      SessionID: { type: 'string', pattern: '^ses_' },
      Durable: {
        type: 'object',
        properties: { aggregateID: { $ref: '#/$defs/SessionID' }, seq: { type: 'integer' } },
        required: ['aggregateID', 'seq'],
      },
    },
    events: {
      'session.created': {
        payloadSchema: {
          type: 'object',
          properties: { sessionID: { $ref: '#/$defs/SessionID' } },
          required: ['sessionID'],
        },
        source: { path: 'packages/schema/src/session.ts', symbol: 'Created' },
        envelopeRequired: ['durable', 'location'],
      },
      'permission.asked': {
        payloadSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        source: { path: 'packages/schema/src/permission.ts' },
        envelopeOmitted: ['durable'],
        notes: 'Not durable.',
      },
    },
  };
}

describe('exact-source event contracts', () => {
  it('accepts a well-formed contract', () => {
    expect(exactSourceEventContractProblems(contract())).toEqual([]);
  });

  it('projects each event onto the shared envelope, sorted, with references closed over', () => {
    const events = exactSourceEventSchemas(contract());
    expect(events.map((event) => event.event)).toEqual(['permission.asked', 'session.created']);
    const created = events[1]!;
    expect(created.source).toEqual({ path: 'packages/schema/src/session.ts', symbol: 'Created' });
    expect(created.payloadSchema).toEqual({
      type: 'object',
      properties: { sessionID: { $ref: '#/$defs/SessionID' } },
      required: ['sessionID'],
      $defs: { SessionID: { type: 'string', pattern: '^ses_' } },
    });
    expect(created.recordSchema.required).toEqual(['id', 'type', 'data', 'durable', 'location']);
    expect(created.recordSchema.properties!.type).toEqual({ type: 'string', enum: ['session.created'] });
    const data = created.recordSchema.properties!.data!;
    expect(data.anyOf![1]).toEqual({
      type: 'string',
      contentMediaType: 'application/json',
      contentSchema: {
        type: 'object',
        properties: { sessionID: { $ref: '#/$defs/SessionID' } },
        required: ['sessionID'],
      },
    });
    expect(Object.keys(created.recordSchema.$defs!).sort()).toEqual(['Durable', 'SessionID']);
  });

  it('builds record schemas that accept both payload encodings and enforce the envelope rules', () => {
    const [asked, created] = exactSourceEventSchemas(contract());
    const record = {
      id: 'evt_1',
      type: 'session.created',
      created: 1,
      location: { directory: '/workspace' },
      durable: { aggregateID: 'ses_1', seq: 0 },
      data: { sessionID: 'ses_1' },
    };
    expect(validatePayload(created!.recordSchema, record)).toEqual([]);
    expect(validatePayload(created!.recordSchema, { ...record, data: JSON.stringify(record.data) })).toEqual([]);
    expect(validatePayload(created!.recordSchema, { ...record, data: 'not json' })).not.toEqual([]);
    expect(validatePayload(created!.recordSchema, { ...record, data: '{"sessionID":"x_1"}' })).not.toEqual([]);
    expect(validatePayload(created!.recordSchema, { ...record, type: 'session.deleted' })).not.toEqual([]);
    const { durable: _durable, ...volatile } = record;
    expect(validatePayload(created!.recordSchema, volatile)).not.toEqual([]);
    const permission = { id: 'evt_2', type: 'permission.asked', data: { id: 'per_1' } };
    expect(validatePayload(asked!.recordSchema, permission)).toEqual([]);
    expect(validatePayload(asked!.recordSchema, { ...permission, durable: record.durable })).not.toEqual([]);
  });

  it('honours a single declared encoding', () => {
    const objectOnly = contract();
    objectOnly.envelope = { ...objectOnly.envelope, payloadEncodings: ['object'] };
    const stringOnly = contract();
    stringOnly.envelope = { ...stringOnly.envelope, payloadEncodings: ['json-string'] };
    const record = { id: 'evt_2', type: 'permission.asked', data: { id: 'per_1' } };
    const objectSchema = exactSourceEventSchemas(objectOnly)[0]!.recordSchema;
    const stringSchema = exactSourceEventSchemas(stringOnly)[0]!.recordSchema;
    expect(validatePayload(objectSchema, record)).toEqual([]);
    expect(validatePayload(objectSchema, { ...record, data: '{"id":"per_1"}' })).not.toEqual([]);
    expect(validatePayload(stringSchema, { ...record, data: '{"id":"per_1"}' })).toEqual([]);
    // The json-string arm asserts its content, not only its type.
    expect(validatePayload(stringSchema, { ...record, data: 'not json' })).toEqual([
      'field "data" is not the JSON document its contentMediaType declares',
    ]);
    expect(validatePayload(stringSchema, { ...record, data: '{"x":1}' })).toEqual(['missing required field "data.id"']);
    expect(validatePayload(stringSchema, record)).not.toEqual([]);
  });

  it('reports every problem in a malformed contract, and refuses to project one', () => {
    const broken = contract() as unknown as Record<string, any>;
    broken.sourceRevision = 'main';
    broken.envelope.payloadEncodings = ['object', 'object'];
    broken.events['session.created'].source.path = 'packages/elsewhere.ts';
    broken.events['session.created'].envelopeRequired = ['missing'];
    broken.events['permission.asked'].envelopeOmitted = ['type'];
    broken.events['permission.asked'].payloadSchema = { $ref: '#/$defs/Nowhere' };
    const problems = exactSourceEventContractProblems(broken);
    expect(problems).toEqual([
      'sourceRevision must be a full commit hash',
      'envelope.payloadEncodings must list "object" and/or "json-string" once each',
      'events["session.created"].source.path must be one of sourceFiles',
      'events["session.created"].envelopeRequired must name fields of envelope.schema',
      'events["permission.asked"] cannot omit the discriminator or the payload',
      'unresolved local reference #/$defs/Nowhere',
    ]);
    expect(() => exactSourceEventSchemas(broken as ExactSourceEventContract)).toThrow(/sourceRevision/);
    expect(exactSourceEventContractProblems([])).toEqual(['contract must be a JSON object']);
  });
});
