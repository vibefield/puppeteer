import { describe, expect, it } from 'vitest';
import { checkRecord, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { piRules } from './privacy.mjs';

/** A 1.5.0 SystemMessage carrying extension-authored prompt and tool text, as `message` and `compaction` persist it. */
function systemMessage() {
  return {
    role: 'system',
    content: 'You are working for Alice on the private Falcon migration.',
    sections: {
      preamble: 'You are a coding assistant for the private Falcon migration.',
      project: '<project>Customer: Example Bank</project>',
      cwd: '/Users/alice/falcon',
    },
    timestamp: 1_790_000_000_000,
    toolsAdded: [
      {
        name: 'falcon_deploy',
        description: 'Deploy the private Falcon service to the customer cluster.',
        parameters: {
          type: 'object',
          required: ['cluster'],
          properties: { cluster: { type: 'string', description: 'Customer cluster name', enum: ['bank-prod'] } },
        },
      },
    ],
    toolsRemoved: [{ name: 'bash' }],
  };
}

describe('Pi capture privacy', () => {
  it('redacts 1.5.0 system-prompt sections and tool text while keeping their shape', () => {
    const raw = {
      type: 'compaction',
      id: 'a1b2c3d4',
      parentId: 'e5f6a7b8',
      timestamp: '2026-11-03T19:35:32.000Z',
      summary: 'private summary',
      systemMessage: systemMessage(),
    };
    for (const record of [{ type: 'message', id: 'a1b2c3d4', message: systemMessage() }, raw]) {
      expect(checkRecord(record, piRules).length).toBeGreaterThan(0);
      const sanitized = sanitizeRecord(record, piRules);
      expect(checkRecord(sanitized, piRules)).toEqual([]);
      const message = sanitized.message ?? sanitized.systemMessage;
      expect(message).toMatchObject({
        role: 'system',
        content: '<redacted:content>',
        sections: {
          preamble: '<redacted:preamble>',
          project: '<redacted:project>',
          cwd: '/workspace',
        },
        toolsAdded: [
          {
            name: 'falcon_deploy',
            description: '<redacted:description>',
            parameters: {
              type: 'object',
              required: ['<redacted:required>'],
              properties: {
                cluster: { type: 'string', description: '<redacted:description>', enum: ['<redacted:enum>'] },
              },
            },
          },
        ],
        toolsRemoved: [{ name: 'bash' }],
      });
      expect(JSON.stringify(sanitized)).not.toMatch(/Falcon|Alice|Example Bank|bank-prod/);
    }
  });

  it('flags an unredacted free-text section the redactor has never seen', () => {
    expect(checkRecord({ message: { role: 'system', sections: { futureSection: 'private text' } } }, piRules)).toEqual([
      '<record>.message.sections.futureSection: unsanitized sensitive field futureSection',
    ]);
  });

  it('redacts the raw model text a 1.5.0 tool call keeps in argumentsError', () => {
    const raw = {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'bash',
            arguments: {},
            argumentsError: 'Unexpected token in {"command":"cat secrets.txt',
          },
        ],
      },
    };
    expect(checkRecord(raw, piRules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(raw, piRules);
    expect(checkRecord(sanitized, piRules)).toEqual([]);
    expect(sanitized.message.content[0]).toMatchObject({
      type: 'toolCall',
      name: 'bash',
      arguments: {},
      argumentsError: '<redacted:argumentsError>',
    });
  });
});
