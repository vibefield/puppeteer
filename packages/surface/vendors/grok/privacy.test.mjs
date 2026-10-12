import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRecord, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { grokRules } from './privacy.mjs';
import { sanitizeGrokCaptureSet } from './sanitize-captures.mjs';

describe('Grok capture privacy', () => {
  it('treats native prose and signatures as sensitive regardless of nesting', () => {
    const raw = {
      signature: 'provider-authenticated-signature',
      update: {
        prompt_text: 'private user prompt',
        summary_preview: 'private compacted context',
        description: 'private workflow description',
      },
    };
    expect(checkRecord(raw, grokRules)).toEqual([
      '<record>.signature: unsanitized sensitive field signature',
      '<record>.update.prompt_text: unsanitized sensitive field prompt_text',
      '<record>.update.summary_preview: unsanitized sensitive field summary_preview',
      '<record>.update.description: unsanitized sensitive field description',
    ]);
    expect(checkRecord(sanitizeRecord(raw, grokRules), grokRules)).toEqual([]);
  });

  it('preserves all native keys, containers, and JSON types in schemaVersion 2 captures', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'grok-sanitize-'));
    const input = join(temporary, 'raw');
    const output = join(temporary, 'sanitized');
    mkdirSync(input, { recursive: true });
    writeFileSync(
      join(input, 'turn.jsonl'),
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: '123e4567-e89b-42d3-a456-426614174000',
          update: {
            sessionUpdate: 'tool_call_update',
            content: [{ type: 'diff', path: '/Users/alice/project/a.ts', oldText: 'before', newText: 'after' }],
          },
        },
      })}\n`,
    );
    try {
      sanitizeGrokCaptureSet(input, output);
      const record = JSON.parse(readFileSync(join(output, 'turn.jsonl'), 'utf8'));
      const metadata = JSON.parse(readFileSync(join(output, 'capture.json'), 'utf8'));
      expect(metadata).toMatchObject({ schemaVersion: 2, representation: 'type-preserving-redaction' });
      expect(record.params.update.content).toHaveLength(1);
      expect(record.params.update.content[0]).toEqual(
        expect.objectContaining({
          type: 'diff',
          path: expect.any(String),
          oldText: expect.any(String),
          newText: expect.any(String),
        }),
      );
      expect(record.params.update.content[0].path).toMatch(/^\/workspace/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
