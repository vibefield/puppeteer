import { describe, expect, it, vi } from 'vitest';
import type { AgentLaunchProvider, AgentProfile } from '@vibecook/puppeteer-core';
import { prewarmTerminalAgents } from './agent-prewarm.js';

function setup() {
  const provider = (id: string): AgentLaunchProvider => ({
    id,
    label: id,
    resume: true,
    nativeInvocation: { commands: [{ name: id, executable: id }], environmentVariables: [] },
  });
  return {
    launchProviders: () => ['codex', 'example', 'missing'].map(provider),
    profiles: vi.fn(
      async () =>
        [
          { id: 'account-1', provider: 'codex' },
          { id: 'account-2', provider: 'codex' },
        ] as AgentProfile[],
    ),
    prewarm: vi.fn(async (_providerId: string, _profileId?: string) => undefined),
  };
}

describe('Godview background prewarming', () => {
  it('warms only installed providers and uses the account selected for new panes', async () => {
    const runtime = setup();
    await prewarmTerminalAgents({ runtime, defaults: { codex: 'account-1' }, available: (bin) => bin !== 'missing' });
    expect(runtime.prewarm.mock.calls).toEqual([
      ['codex', 'account-1'],
      ['example', undefined],
    ]);
  });

  it('uses explicit pane accounts instead of the stored defaults', async () => {
    const runtime = setup();
    await prewarmTerminalAgents({
      runtime,
      defaults: { codex: 'account-1' },
      profileIds: ['account-2'],
      available: () => true,
    });
    expect(runtime.prewarm).toHaveBeenCalledWith('codex', 'account-2');
    expect(runtime.prewarm).not.toHaveBeenCalledWith('codex', 'account-1');
  });

  it('does not read profiles for native defaults and tolerates an unavailable provider', async () => {
    const runtime = setup();
    runtime.prewarm.mockRejectedValueOnce(new Error('offline'));
    await expect(prewarmTerminalAgents({ runtime, defaults: {}, available: () => true })).resolves.toBeUndefined();
    expect(runtime.profiles).not.toHaveBeenCalled();
    expect(runtime.prewarm).toHaveBeenCalledWith('codex', undefined);
    expect(runtime.prewarm).toHaveBeenCalledWith('example', undefined);
  });
});
