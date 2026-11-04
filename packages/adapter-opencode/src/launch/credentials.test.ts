import { describe, expect, it } from 'vitest';
import { OPENCODE_SERVER_PASSWORD_VARIABLES, withoutOpenCodeServerPasswords } from './credentials.js';

describe('OpenCode server password scrubbing', () => {
  it('removes both the 1.x and the 2.x password names and keeps everything else', () => {
    expect(OPENCODE_SERVER_PASSWORD_VARIABLES).toEqual(['OPENCODE_SERVER_PASSWORD', 'OPENCODE_PASSWORD']);
    const env = { OPENCODE_SERVER_PASSWORD: 'a', OPENCODE_PASSWORD: 'b', OPENCODE_SERVER_USERNAME: 'u', PATH: '/bin' };
    expect(withoutOpenCodeServerPasswords(env)).toEqual({ OPENCODE_SERVER_USERNAME: 'u', PATH: '/bin' });
    // A copy: the caller's environment is never edited.
    expect(env.OPENCODE_PASSWORD).toBe('b');
    expect(withoutOpenCodeServerPasswords(undefined)).toEqual({});
  });
});
