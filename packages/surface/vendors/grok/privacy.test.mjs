import { describe, expect, it } from 'vitest';
import { checkRecord, sanitizeRecord } from '@vibecook/chopsticks-surface/sanitize';
import { grokRules } from './privacy.mjs';

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
});
