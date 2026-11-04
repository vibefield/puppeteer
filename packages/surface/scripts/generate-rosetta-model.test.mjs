import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mergeRosettaRecordTypes,
  mergeRosettaShapes,
  rosettaEventInventory,
  rosettaShapeToJsonSchema,
  scopeRosettaInventory,
} from './generate-rosetta-model.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(packageRoot, path), 'utf8'));

describe('rosettaShapeToJsonSchema', () => {
  it("projects Rosetta's folded `<dynamic>` map key onto additionalProperties", () => {
    const schema = rosettaShapeToJsonSchema({
      kind: 'object',
      fields: {
        '<dynamic>': { shape: { kind: 'number' }, required: true },
        known: { shape: { kind: 'string', values: { on: 1 } }, required: true },
      },
    });
    expect(schema).toEqual({
      type: 'object',
      properties: { known: { type: 'string', enum: ['on'] } },
      required: ['known'],
      additionalProperties: { type: 'number' },
    });
  });
  it('keeps an object without folded keys open', () => {
    expect(rosettaShapeToJsonSchema({ kind: 'object', fields: { a: { shape: { kind: 'null' } } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'null' } },
      additionalProperties: true,
    });
  });
});

describe('version-scoped Rosetta inventory', () => {
  const field = (kind, required, observed) => ({ shape: { kind }, required, observed });
  const document = (agentVersion, evidence, records) => ({
    agent_version: agentVersion,
    evidence,
    streams: [{ id: 'session', record_types: records }],
  });

  it("merges shapes the way Rosetta's merge_shapes does", () => {
    expect(
      mergeRosettaShapes(
        { kind: 'object', fields: { a: field('string', true, 0), b: field('number', true, 0) } },
        { kind: 'object', fields: { a: field('null', true, 2) } },
      ),
    ).toEqual({
      kind: 'object',
      fields: {
        a: { shape: { kind: 'any_of', variants: [{ kind: 'string' }, { kind: 'null' }] }, required: true, observed: 2 },
        b: { shape: { kind: 'number' }, required: false, observed: 0 },
      },
    });
  });

  it("credits only the pinned release's sources and leaves other releases' records as contract leads", () => {
    const canonical = {
      streams: [
        {
          id: 'session',
          glob: 'sessions/*.jsonl',
          file_format: 'jsonl',
          record_types: {
            message: { observed: 5, evidence: 'writer', shape: { kind: 'object', fields: {} } },
            retired: { observed: 3, evidence: 'fixture', shape: { kind: 'object', fields: {} } },
          },
        },
      ],
    };
    const current = mergeRosettaRecordTypes([
      document('1.5.0', 'fixture', {
        message: { observed: 2, shape: { kind: 'object', fields: { role: field('string', true, 2) } } },
      }),
      document('1.5.0', 'writer', {
        message: {
          observed: 0,
          shape: { kind: 'object', fields: { role: field('string', true, 0), extra: field('number', false, 0) } },
        },
      }),
    ]);
    const [message, retired] = scopeRosettaInventory(rosettaEventInventory(canonical, 'session'), current);
    expect(message.record).toMatchObject({ observed: 2, evidence: 'writer' });
    expect(Object.keys(message.record.shape.fields)).toEqual(['extra', 'role']);
    expect(message.inVersionSources).toBe(true);
    expect(retired.record).toMatchObject({ observed: 0, evidence: 'fixture' });
    expect(retired.inVersionSources).toBe(false);
  });

  it('keeps 0.84.3-only Pi fields and counts out of the 1.5.0 model', () => {
    const events = 'vendors/pi/model/pi@1.5.0/events';
    const message = readJson(`${events}/message.json`);
    expect(message.recordSchema.properties.message.properties).not.toHaveProperty('addedToolNames');
    expect(message.notes).toContain('36 retained observation(s) in the 1.5.0 sources');
    const messageStart = readJson(`${events}/farm%3Aheadless-stdout%3Amessage_start.json`);
    expect(messageStart.payloadSchema.properties.message.properties).not.toHaveProperty('responseId');
    expect(messageStart.notes).toContain('33 retained observation(s) in the 1.5.0 sources');
  });
});
