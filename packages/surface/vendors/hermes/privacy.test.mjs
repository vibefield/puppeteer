import { describe, expect, it } from 'vitest';
import { checkRecord, sanitizeRecord } from '@vibecook/chopsticks-surface/sanitize';
import { hermesRules } from './privacy.mjs';

describe('Hermes capture privacy', () => {
  it('aliases session joins and removes prompts, paths, and tool arguments', () => {
    const raw = {
      session_id: '20260812_143052_a1b2c3',
      tool_call_id: 'call_1',
      cwd: '/Users/alice/customer-project',
      type: 'tool.start',
      args: { command: 'cat /Users/alice/.hermes/.env' },
      extra: { user_message: 'print the customer secret' },
    };

    expect(checkRecord(raw, hermesRules).length).toBeGreaterThan(0);
    const sanitized = sanitizeRecord(raw, hermesRules);
    expect(checkRecord(sanitized, hermesRules)).toEqual([]);
    expect(sanitized.type).toBe('tool.start');
    expect(sanitized.args.command).toMatch(/redacted/i);
    expect(sanitized.extra.user_message).toMatch(/redacted/i);
    expect(sanitized.cwd).toMatch(/^\/workspace/);
    expect(sanitized.session_id).toMatch(/^anon-[0-9a-f]{16}$/);
    expect(sanitized.session_id).not.toBe(raw.session_id);
    expect(sanitized.type).toBe('tool.start');
  });

  it('rejects provider key shapes under unknown keys', () => {
    expect(checkRecord({ future: 'sk-abcdefghijklmnopqrstuvwxyz' }, hermesRules)).toEqual([
      '<record>.future: unsafe text at future',
    ]);
    expect(checkRecord({ future: 'Bearer abcdefghijklmnopqrstuvwxyz' }, hermesRules)).toEqual([
      '<record>.future: unsafe text at future',
    ]);
  });
});
