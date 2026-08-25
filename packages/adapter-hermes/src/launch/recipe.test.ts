import { describe, expect, it } from 'vitest';
import { buildHermesAttachLaunch } from './recipe.js';

describe('Hermes attach launch recipe', () => {
  it('points the native TUI at the owned gateway and isolated home', () => {
    const launch = buildHermesAttachLaunch({
      cwd: '/work',
      hermesHome: '/tmp/hermes-home',
      gatewayUrl: 'ws://127.0.0.1:9/api/ws',
      resume: '20260812_132919_ae981b',
    });
    expect(launch.command).toBe('hermes');
    expect(launch.args).toEqual(['--tui', '--resume', '20260812_132919_ae981b']);
    expect(launch.env).toMatchObject({
      HERMES_HOME: '/tmp/hermes-home',
      HERMES_TUI_GATEWAY_URL: 'ws://127.0.0.1:9/api/ws',
    });
    expect(launch.args).not.toContain('acp');
  });
});
