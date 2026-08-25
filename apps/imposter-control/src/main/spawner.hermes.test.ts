/** Hermes interactive Imposter remains observable when launched without tui-gateway. */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from './plane.js';
import { createPersonaSpawner } from './spawner.js';
import { controlPaths, waitFor } from './testing.js';

const tmps: string[] = [];
let plane: ControlPlane | undefined;

afterEach(async () => {
  await plane?.stop();
  plane = undefined;
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('Hermes persona spawner', () => {
  it('joins Control with its tui_gateway ASM and raw boot emission', async () => {
    const paths = controlPaths();
    tmps.push(paths.root);
    const spawner = createPersonaSpawner('hermes', 'Hermes native surface', {
      controlSocketPath: paths.socketPath,
      controlTokenPath: paths.tokenPath,
    });
    plane = createControlPlane({ socketPath: paths.socketPath, tokenPath: paths.tokenPath, spawners: [spawner] });
    await plane.start();

    const { sessionId } = await spawner.spawn();
    try {
      await waitFor(() => plane!.sessions.some((session) => session.sessionId === sessionId), 'Hermes session join');
      await waitFor(
        () => plane!.sessions.find((session) => session.sessionId === sessionId)?.scenarioDriver.state === 'ready',
        'Hermes scenario driver boot',
      );
      const joined = plane.sessions.find((session) => session.sessionId === sessionId)!;
      expect(joined).toMatchObject({
        vendor: 'hermes',
        nativeBehavior: { title: expect.stringContaining('Hermes') },
        scenarioDriver: { state: 'ready' },
      });
      expect(joined.nativeEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'gateway.ready', channel: 'tui-gateway' }),
          expect.objectContaining({ event: 'session.info', channel: 'tui-gateway' }),
          expect.objectContaining({ event: 'on_session_start', channel: 'plugin-hook' }),
        ]),
      );
      expect(joined).not.toHaveProperty('state');

      const logResponse = await fetch(`${plane!.url}/api/sessions/${sessionId}/log?vendor=hermes`, {
        headers: { authorization: `Bearer ${plane!.token}` },
      });
      const log = (await logResponse.json()) as { entries: Array<{ event: string }> };
      expect(log.entries.map((entry) => entry.event)).toEqual(
        expect.arrayContaining(['gateway.ready', 'on_session_start', 'session.info']),
      );
    } finally {
      await spawner.disposeAll();
    }
  });
});
