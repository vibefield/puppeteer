import { describe, expect, it } from 'vitest';
import { OPENCODE_LAUNCH_FLAGS, parseOpenCodeVersion, resolveOpenCodeExecutable } from './detection.js';

describe('OpenCode detection projection', () => {
  it('matches the pinned Surface version shape and launch flags', () => {
    expect(parseOpenCodeVersion('1.18.16\n')).toBe('1.18.16');
    expect(parseOpenCodeVersion('opencode 1.18.16')).toBeUndefined();
    expect(OPENCODE_LAUNCH_FLAGS).toEqual({
      serve: 'serve',
      hostname: '--hostname',
      port: '--port',
      attach: 'attach',
      directory: '--dir',
      session: '--session',
      pure: '--pure',
    });
  });

  it('gives an explicit executable precedence over the environment', () => {
    expect(resolveOpenCodeExecutable('/test/opencode')).toBe('/test/opencode');
  });
});
