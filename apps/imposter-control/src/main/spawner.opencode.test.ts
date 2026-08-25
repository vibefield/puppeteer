/** OpenCode's native SSE surface remains observable when launched in preview mode. */
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

describe.skipIf(process.platform === 'win32')('OpenCode persona spawner', () => {
  it('joins Control with its HTTP/SSE ASM and raw boot emission', async () => {
    const paths = controlPaths();
    tmps.push(paths.root);
    const spawner = createPersonaSpawner('opencode', 'OpenCode native surface', {
      controlSocketPath: paths.socketPath,
      controlTokenPath: paths.tokenPath,
    });
    plane = createControlPlane({ socketPath: paths.socketPath, tokenPath: paths.tokenPath, spawners: [spawner] });
    await plane.start();

    const { sessionId } = await spawner.spawn();
    try {
      await waitFor(() => plane!.sessions.some((session) => session.sessionId === sessionId), 'OpenCode session join');
      await waitFor(
        () => plane!.sessions.find((session) => session.sessionId === sessionId)?.scenarioDriver.state === 'ready',
        'OpenCode scenario driver boot',
      );
      const joined = plane.sessions.find((session) => session.sessionId === sessionId)!;
      expect(joined).toMatchObject({
        vendor: 'opencode',
        nativeBehavior: { title: expect.stringContaining('OpenCode HTTP/SSE') },
        scenarioDriver: { state: 'ready' },
      });
      expect(joined.nativeEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: 'session.created', channel: 'sse', transport: 'sse-event' }),
          expect.objectContaining({ event: 'permission.asked', channel: 'sse', transport: 'sse-event' }),
          expect.objectContaining({ event: 'question.asked', channel: 'sse', transport: 'sse-event' }),
        ]),
      );
      expect(joined.runflows.map((flow) => flow.intent)).toEqual(
        expect.arrayContaining(['turn.basic', 'blocker.permission.allow', 'transport.reconnect']),
      );
      expect(joined).not.toHaveProperty('state');

      const logResponse = await fetch(`${plane!.url}/api/sessions/${sessionId}/log?vendor=opencode`, {
        headers: { authorization: `Bearer ${plane!.token}` },
      });
      const log = (await logResponse.json()) as { entries: Array<{ event: string }> };
      expect(log.entries.map((entry) => entry.event)).toContain('session.created');
    } finally {
      await spawner.disposeAll();
    }
  });
});
