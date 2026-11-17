import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exactSourceEventContractProblems, exactSourceEventSchemas } from '@vibefield/puppeteer-surface';
import { draftEventContract, draftPayloadSchema, sourceExpressionSchema } from './event-contract-v2.mjs';

const draftPath = new URL('../../../../../draft/opencode-2/event-contract.json', import.meta.url);
const COMMIT = '9bbb8ce18c80f099e0e448775f59d965ead40a21';

function digestsFor(draft) {
  const names = new Set(draft.events.flatMap((definition) => definition.source ?? []));
  return Object.fromEntries(
    [...names].map((name) => [name, { path: `packages/schema/src/${name}`, sha256: '0'.repeat(64), bytes: 1 }]),
  );
}

describe('Effect Schema source expressions', () => {
  const schema = (expression) => sourceExpressionSchema(expression);

  it('projects the known primitives exactly, through pipes, optional() and annotations', () => {
    expect(schema('Schema.String')).toEqual({ schema: { type: 'string' }, exact: true });
    expect(schema('Schema.String.pipe(optional)')).toEqual({ schema: { type: 'string' }, exact: true });
    expect(schema('optional(Schema.Finite)')).toEqual({ schema: { type: 'number' }, exact: true });
    expect(schema('NonNegativeInt')).toEqual({ schema: { type: 'integer', minimum: 0 }, exact: true });
    const defaulted =
      'PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_TOAST_DURATION))).annotate({ description: "ms" })';
    expect(schema(defaulted)).toEqual({ schema: { type: 'integer', minimum: 1 }, exact: true });
    expect(schema('SessionID')).toEqual({ schema: { type: 'string', pattern: '^ses_' }, exact: true });
    expect(schema('SessionMessage.ID.pipe(optional)')).toEqual({
      schema: { type: 'string', pattern: '^msg_' },
      exact: true,
    });
  });

  it('projects literals, nullables, arrays and string-keyed records', () => {
    expect(schema('Schema.Literals(["add", "change", "unlink"])')).toEqual({
      schema: { type: 'string', enum: ['add', 'change', 'unlink'] },
      exact: true,
    });
    expect(schema('Schema.Array(RelativePath).pipe(optional)')).toEqual({
      schema: { type: 'array', items: { type: 'string' } },
      exact: true,
    });
    expect(schema('Schema.Record(Schema.String, Schema.Unknown).pipe(optional)')).toEqual({
      schema: { type: 'object', additionalProperties: {} },
      exact: true,
    });
    expect(schema('Schema.NullOr(ID)')).toEqual({
      schema: { anyOf: [{ type: 'string', description: 'source: ID' }, { type: 'null' }] },
      exact: false,
    });
  });

  it('keeps anything else open, with the expression as its description', () => {
    expect(schema('SessionError.Error')).toEqual({ schema: { description: 'source: SessionError.Error' }, exact: false });
    expect(schema('Project.ID')).toEqual({ schema: { type: 'string', description: 'source: Project.ID' }, exact: false });
    expect(schema('Schema.NonEmptyArray(Content)')).toEqual({
      schema: { type: 'array', items: { description: 'source: Content' }, minItems: 1 },
      exact: false,
    });
  });

  it('builds a payload with required fields and names what it could not resolve', () => {
    expect(
      draftPayloadSchema([
        { name: 'sessionID', optional: false, schema: 'SessionID' },
        { name: 'error', optional: false, schema: 'SessionError.Error' },
        { name: 'note', optional: true, schema: 'Schema.String.pipe(optional)' },
        { spread: 'SessionInbox.MovePayload.fields' },
      ]),
    ).toEqual({
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string', pattern: '^ses_' },
          error: { description: 'source: SessionError.Error' },
          note: { type: 'string' },
        },
        required: ['sessionID', 'error'],
      },
      unresolved: ['error: SessionError.Error', 'spread SessionInbox.MovePayload.fields'],
    });
  });
});

describe('draft to exact-source event contract', () => {
  const draft = {
    upstream: { repository: 'anomalyco/opencode', tag: 'v2.2.5', commit: COMMIT },
    events: [
      { type: 'server.connected', durability: 'ephemeral', publicStream: true, source: ['server-event.ts'], data: [] },
      { type: 'global.disposed', durability: 'ephemeral', publicStream: false, source: ['server-event.ts'], data: [] },
      {
        type: 'session.renamed',
        durability: 'durable',
        durable: { version: 1, aggregate: 'sessionID' },
        publicStream: true,
        source: ['session-event.ts'],
        data: [
          { name: 'sessionID', optional: false, schema: 'SessionID' },
          { name: 'title', optional: false, schema: 'Schema.String' },
        ],
      },
      {
        type: 'session.text.delta',
        durability: 'ephemeral',
        publicStream: true,
        source: ['session-event.ts'],
        data: [{ name: 'sessionID', optional: false, schema: 'SessionID' }],
      },
    ],
  };

  it('refuses a draft read at another tag', () => {
    expect(() => draftEventContract(draft, { vendorVersion: '2.3.0', sourceFiles: digestsFor(draft) })).toThrow(
      'the event draft was read at v2.2.5, not v2.3.0',
    );
  });

  it('keeps public events only, with the envelope rules each kind carries, as a valid contract', () => {
    const contract = draftEventContract(draft, { vendorVersion: '2.2.5', sourceFiles: digestsFor(draft) });
    expect(exactSourceEventContractProblems(contract)).toEqual([]);
    expect(contract.sourceRepository).toBe('https://github.com/anomalyco/opencode');
    expect(contract.sourceRevision).toBe(COMMIT);
    expect(Object.keys(contract.events).sort()).toEqual(['server.connected', 'session.renamed', 'session.text.delta']);
    expect(contract.events['server.connected']).toMatchObject({
      envelopeRequired: [],
      envelopeOmitted: ['created', 'location', 'durable'],
    });
    expect(contract.events['session.renamed']).toMatchObject({
      envelopeRequired: ['created', 'durable'],
      envelopeOmitted: [],
      notes: 'durable v1 (aggregate sessionID)',
    });
    expect(contract.events['session.text.delta'].envelopeOmitted).toEqual(['durable']);
    expect(contract.limitations).toContain('1 definition(s) not on the public GET /api/event stream are omitted.');

    const renamed = exactSourceEventSchemas(contract).find((entry) => entry.event === 'session.renamed');
    expect(renamed.recordSchema.required).toEqual(['id', 'type', 'data', 'created', 'durable']);
    expect(renamed.recordSchema.properties.data.anyOf).toHaveLength(2);
  });

  it('turns the whole recorded 2.2.5 draft into a valid contract of its 97 public types', () => {
    const recorded = JSON.parse(readFileSync(draftPath, 'utf8'));
    const contract = draftEventContract(recorded, { vendorVersion: '2.2.5', sourceFiles: digestsFor(recorded) });
    expect(exactSourceEventContractProblems(contract)).toEqual([]);
    expect(Object.keys(contract.events)).toHaveLength(97);
    expect(exactSourceEventSchemas(contract)).toHaveLength(97);
    expect(contract.events['session.execution.interrupted'].payloadSchema.properties.reason).toEqual({
      type: 'string',
      enum: ['user', 'shutdown', 'superseded', 'inactivity'],
    });
  });
});
