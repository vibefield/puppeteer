import { describe, expect, it } from 'vitest';
import { checkRecord, sanitizeRecord } from '@vibecook/puppeteer-surface/sanitize';
import { antigravityRules } from './privacy.mjs';

describe('Antigravity capture privacy', () => {
  it('aliases native joins and removes paths, account data, tool arguments, and prose', () => {
    const raw = {
      conversationId: '0198f2b9-4312-7abc-8def-0123456789ab',
      workspacePaths: ['/Users/alice/customer-project'],
      transcriptPath:
        '/Users/alice/.gemini/antigravity-cli/brain/0198f2b9-4312-7abc-8def-0123456789ab/.system_generated/logs/transcript.jsonl',
      artifactDirectoryPath: '/Users/alice/.gemini/antigravity-cli/brain/private/artifacts',
      modelName: 'gemini-3-pro',
      toolCall: {
        name: 'run_command',
        args: { command: 'print the customer secret', futureField: 'private future value' },
      },
      account: { email: 'alice@example.com', planTier: 'enterprise-private' },
      reason: 'customer-specific permission reason',
    };

    expect(checkRecord(raw, antigravityRules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(raw, antigravityRules);
    expect(checkRecord(sanitized, antigravityRules)).toEqual([]);
    expect(sanitized).toMatchObject({
      modelName: 'gemini-3-pro',
      toolCall: {
        name: 'run_command',
        args: {
          command: '<redacted:command>',
          futureField: '<redacted:futureField>',
        },
      },
      account: {
        email: '<redacted:email>',
        planTier: '<redacted:planTier>',
      },
      reason: '<redacted:reason>',
    });
    expect(sanitized.conversationId).toMatch(/^a11a5ed0-/);
    expect(sanitized.workspacePaths).toEqual(['/workspace/redacted-file']);
    expect(sanitized.transcriptPath).toContain('/workspace/transcripts/');
    expect(sanitized.artifactDirectoryPath).toBe('/workspace/redacted-file');
  });

  it('rejects Google credential and authorization shapes under unknown keys', () => {
    expect(checkRecord({ future: 'ya29.abcdefghijklmnopqrstuvwxyz123456' }, antigravityRules)).toEqual([
      '<record>.future: unsafe text at future',
    ]);
    expect(checkRecord({ future: 'Bearer abcdefghijklmnopqrstuvwxyz' }, antigravityRules)).toEqual([
      '<record>.future: unsafe text at future',
    ]);
  });
});
