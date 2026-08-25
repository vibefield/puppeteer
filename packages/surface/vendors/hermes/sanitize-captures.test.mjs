import { describe, expect, it } from 'vitest';
import { checkRecord, sanitizeRecord } from '@vibecook/puppeteer-surface/sanitize';
import { hermesRules } from './privacy.mjs';
import { SCENARIOS } from './census/turn-census.mjs';

describe('Hermes turn-capture privacy', () => {
  it('exports the required census scenarios', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(
      ['basic-turn', 'interrupt', 'permission-deny', 'resume-turn', 'tool-success'].sort(),
    );
    expect(SCENARIOS['resume-turn'].resumeAfter).toBe('basic-turn');
  });

  it('redacts hook kwargs and webhook extras without dropping event names', () => {
    const raw = {
      hook_event_name: 'pre_llm_call',
      kwargs: {
        session_id: '20260812_143052_a1b2c3',
        user_message: 'print the customer secret',
        cwd: '/Users/alice/customer-project',
      },
      extra: { command: 'cat /Users/alice/.hermes/.env' },
    };
    expect(checkRecord(raw, hermesRules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(raw, hermesRules);
    expect(sanitized.hook_event_name).toBe('pre_llm_call');
    expect(sanitized.kwargs.user_message).toMatch(/redacted/i);
    expect(sanitized.kwargs.cwd).toMatch(/^\/workspace/);
    expect(sanitized.kwargs.session_id).toMatch(/^anon-[0-9a-f]{16}$/);
    expect(sanitized.extra.command).toMatch(/redacted/i);
    expect(checkRecord(sanitized, hermesRules)).toEqual([]);
  });
});
