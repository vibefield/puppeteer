import { describe, expect, it, vi } from 'vitest';
import { announceRunHelper } from './host.js';
import { isAgentLaunchRefusedError } from './services/launch.js';
import { AgentBriefingCapabilitiesSchema } from './services/provider.js';

describe('naming a run helper to the host', () => {
  it('hands the host the pid and start and waits for its answer', async () => {
    let answer!: () => void;
    const onHelperProcess = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
    let settled = false;
    const announced = announceRunHelper({ onHelperProcess }, { pid: 4242, startedAtMs: 1_700_000 }, 'Example').then(
      () => (settled = true),
    );
    expect(onHelperProcess).toHaveBeenCalledWith({ pid: 4242, startedAtMs: 1_700_000 });
    await Promise.resolve();
    expect(settled).toBe(false);
    answer();
    await announced;
    expect(settled).toBe(true);
  });

  it('asks nothing of a host that has no hook, even with no pid', async () => {
    await expect(announceRunHelper(undefined, { startedAtMs: 1 }, 'Example')).resolves.toBeUndefined();
    await expect(announceRunHelper({}, { pid: 7, startedAtMs: 1 }, 'Example')).resolves.toBeUndefined();
  });

  it.each([
    ['a hook that throws', () => Promise.reject(new Error('floor refused: secret-detail')), 7],
    [
      'a hook that throws synchronously',
      () => {
        throw new Error('floor refused: secret-detail');
      },
      7,
    ],
    ['a helper with no pid', () => undefined, undefined],
  ])('refuses the launch honestly for %s, without repeating the host words', async (_name, hook, pid) => {
    const error: unknown = await announceRunHelper(
      { onHelperProcess: hook },
      { ...(pid === undefined ? {} : { pid }), startedAtMs: 1 },
      'Example',
    ).then(
      () => expect.fail('expected a refusal'),
      (cause: unknown) => cause,
    );
    expect(isAgentLaunchRefusedError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'RUN_HELPER_UNNAMED' });
    expect(String(error)).toContain('Example');
    expect(String(error)).not.toContain('secret-detail');
  });

  it('never calls the hook for a helper with no pid', async () => {
    const onHelperProcess = vi.fn();
    await expect(announceRunHelper({ onHelperProcess }, { startedAtMs: 1 }, 'Example')).rejects.toMatchObject({
      code: 'RUN_HELPER_UNNAMED',
    });
    expect(onHelperProcess).not.toHaveBeenCalled();
  });

  it("accepts 'run-helper' as a place MCP servers run", () => {
    expect(
      AgentBriefingCapabilitiesSchema.parse({
        mcpServers: true,
        allowTools: true,
        instructions: true,
        mcpServerProcess: 'run-helper',
      }).mcpServerProcess,
    ).toBe('run-helper');
  });
});
