import { describe, expect, it } from 'vitest';
import { checkRecord, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { kimiRules } from './sanitize-captures.mjs';

describe('Kimi capture privacy', () => {
  it('redacts reasoning and environment facts without breaking turn correlation', () => {
    const raw = {
      session_id: 'session_9231d1d3-6e1b-452d-a0ce-6ab46d86f4bc',
      turnId: '0',
      systemPrompt: 'private system prompt',
      environmentDisclosure: {
        cwd: '/Users/alice/private-project',
        date: { disclosed: true, value: { localDate: '2026-08-10', timeZone: 'America/Los_Angeles' } },
      },
      event: { type: 'content.part', part: { type: 'think', think: 'private reasoning' } },
      tool: { arguments: '{"command":"private command"}', args: { command: 'private command' } },
    };

    expect(checkRecord(raw, kimiRules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(raw, kimiRules);
    expect(sanitized).toMatchObject({
      session_id: expect.stringMatching(/^session_a11a5ed0/),
      turnId: '0',
      systemPrompt: '<redacted:systemPrompt>',
      environmentDisclosure: {
        cwd: '/workspace',
        date: {
          disclosed: true,
          value: { localDate: '<redacted:localDate>', timeZone: '<redacted:timeZone>' },
        },
      },
      event: { type: 'content.part', part: { type: 'think', think: '<redacted:think>' } },
      tool: { arguments: '<redacted:arguments>', args: { command: '<redacted:command>' } },
    });
    expect(checkRecord(sanitized, kimiRules)).toEqual([]);
  });
});
