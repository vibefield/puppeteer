import { describe, expect, it } from 'vitest';
import { rosettaShapeToJsonSchema } from './generate-rosetta-model.mjs';

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
