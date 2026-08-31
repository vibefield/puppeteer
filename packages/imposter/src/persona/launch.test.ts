import { describe, expect, it } from 'vitest';
import { createPersonaLaunchSpec } from './launch.ts';

describe('createPersonaLaunchSpec', () => {
  it('resolves native session flags from persona detection truth', () => {
    expect(createPersonaLaunchSpec('kimi', 'session-one', '/isolated')).toMatchObject({
      args: ['--session', 'session-one'],
    });
    expect(createPersonaLaunchSpec('copilot', 'session-two', '/isolated')).toMatchObject({
      args: ['--session-id', 'session-two'],
    });
  });

  it.each([
    ['antigravity', 'PUPPETEER_ANTIGRAVITY_DATA_ROOT'],
    ['copilot', 'COPILOT_HOME'],
    ['grok', 'GROK_HOME'],
    ['hermes', undefined],
    ['kimi', 'KIMI_CODE_HOME'],
    ['pi', 'PI_CODING_AGENT_DIR'],
  ] as const)('keeps the %s native store in the managed root', (vendor, rootVariable) => {
    const spec = createPersonaLaunchSpec(vendor, 'session-one', '/isolated');
    expect(spec.env).toMatchObject({
      AI_PERSONA: vendor,
      PUPPETEER_IMPOSTER_HOME: '/isolated',
      PUPPETEER_IMPOSTER_TUI: 'off',
    });
    if (rootVariable) expect(spec.env[rootVariable]).toBe('/isolated');
  });
});
