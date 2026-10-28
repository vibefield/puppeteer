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

  it("carries the gateway's bearer in the URL the TUI dials, and nowhere else", () => {
    const launch = buildHermesAttachLaunch({
      cwd: '/work',
      hermesHome: '/tmp/hermes-home',
      gatewayUrl: 'ws://127.0.0.1:9/api/ws',
      gatewayToken: 'launch-token_0',
      resume: '20260812_132919_ae981b',
    });
    expect(launch.env?.HERMES_TUI_GATEWAY_URL).toBe('ws://127.0.0.1:9/api/ws?token=launch-token_0');
    expect(launch.args.join(' ')).not.toContain('launch-token_0');
    expect(
      Object.entries(launch.env ?? {})
        .filter(([, value]) => value.includes('launch-token_0'))
        .map(([key]) => key),
    ).toEqual(['HERMES_TUI_GATEWAY_URL']);
  });
});
