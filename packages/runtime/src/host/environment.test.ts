import { describe, expect, it } from 'vitest';
import { buildAgentEnvironment } from './environment.js';

describe('buildAgentEnvironment', () => {
  it('win32 grants carry SystemRoot and user dirs (clean-env ConPTY aborts without them)', () => {
    const env = buildAgentEnvironment({ platform: 'win32' });
    expect(env.SystemRoot).toBeTruthy();
    expect(env.TEMP).toBe(process.env.TEMP);
    expect(env.USERPROFILE).toBe(process.env.USERPROFILE);
    // HOME falls back to USERPROFILE on win32 when HOME is unset.
    expect(env.HOME).toBe(process.env.HOME ?? process.env.USERPROFILE);
  });

  it('posix grants stay minimal and carry no Windows variables', () => {
    const env = buildAgentEnvironment({ platform: 'linux', username: 'agent-user' });
    expect(env.SystemRoot).toBeUndefined();
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
    expect(env.USER).toBe('agent-user');
    expect(env.LOGNAME).toBe('agent-user');
  });

  it('lets an explicit grant override the inherited POSIX login identity', () => {
    const env = buildAgentEnvironment({
      platform: 'darwin',
      username: 'host-user',
      allowed: { USER: 'session-user' },
    });
    expect(env.USER).toBe('session-user');
    expect(env.LOGNAME).toBe('host-user');
  });

  it('allowed variables still merge over the base', () => {
    const env = buildAgentEnvironment({ platform: 'linux', allowed: { PUPPETEER_HOOK_TOKEN: 'tok' } });
    expect(env.PUPPETEER_HOOK_TOKEN).toBe('tok');
  });
});
