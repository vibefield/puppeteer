import { describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';

/**
 * What the driver hands the gateway host it starts. The host is mocked to refuse, so no process starts and no socket
 * opens. The mock has its own file so that driver.test.ts keeps the real host module.
 */
const mocks = vi.hoisted(() => ({ start: vi.fn() }));

vi.mock('./launch/gateway-host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./launch/gateway-host.js')>()),
  startHermesGatewayHost: mocks.start,
}));

import { prepareHermesTuiSession } from './driver.js';

const host = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() } as unknown as AgentHost;

describe("the driver's gateway host", () => {
  it('is started with the hermes executable the session launches, beside its python', async () => {
    mocks.start.mockRejectedValue(new Error('the gateway host is not started here'));
    await expect(
      prepareHermesTuiSession({
        cwd: '/work',
        host,
        executable: '/opt/hermes/bin/hermes',
        python: '/opt/hermes/venv/bin/python',
        hermesHome: '/tmp/hermes-home',
      }),
    ).rejects.toThrow('the gateway host is not started here');
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ executable: '/opt/hermes/bin/hermes', python: '/opt/hermes/venv/bin/python' }),
    );
  });
});
