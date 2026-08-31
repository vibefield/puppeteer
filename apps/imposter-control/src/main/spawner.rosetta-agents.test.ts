/** End-to-end control-plane coverage for the Rosetta-imported personas. */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlPlane, type ControlPlane } from './plane.js';
import { createPersonaSpawner } from './spawner.js';
import { controlPaths, waitFor } from './testing.js';

const temporaryDirectories: string[] = [];
let plane: ControlPlane | undefined;
let spawner: ReturnType<typeof createPersonaSpawner> | undefined;

afterEach(async () => {
  await spawner?.disposeAll();
  await plane?.stop();
  spawner = undefined;
  plane = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('Rosetta persona spawners', () => {
  it.each([
    {
      vendor: 'antigravity',
      label: 'Antigravity native surface',
      version: '1.1.20',
      event: 'USER_INPUT',
      channel: 'transcript',
      bootEvent: undefined,
    },
    {
      vendor: 'copilot',
      label: 'GitHub Copilot CLI native surface',
      version: '1.0.80',
      event: 'user.message',
      channel: 'events',
      bootEvent: 'session.start',
    },
    {
      vendor: 'pi',
      label: 'Pi native surface',
      version: '0.84.3',
      event: 'message',
      channel: 'session',
      bootEvent: 'session',
    },
  ])(
    'launches $vendor from its persona-owned recipe',
    async ({ vendor, label, version, event, channel, bootEvent }) => {
      const paths = controlPaths();
      temporaryDirectories.push(paths.root);
      spawner = createPersonaSpawner(vendor, label, {
        controlSocketPath: paths.socketPath,
        controlTokenPath: paths.tokenPath,
      });
      plane = createControlPlane({
        socketPath: paths.socketPath,
        tokenPath: paths.tokenPath,
        spawners: [spawner],
      });
      await plane.start();

      const { sessionId } = await spawner.spawn();
      await waitFor(() => plane!.sessions.some((session) => session.sessionId === sessionId), `${vendor} session join`);
      const joined = plane.sessions.find((session) => session.sessionId === sessionId)!;
      expect(joined).toMatchObject({ vendor, version });
      expect(joined.nativeEvents).toEqual(
        expect.arrayContaining([expect.objectContaining({ event, channel, transport: 'jsonl-record' })]),
      );
      expect(joined).not.toHaveProperty('state');

      const logResponse = await fetch(`${plane.url}/api/sessions/${sessionId}/log?vendor=${vendor}`, {
        headers: { authorization: `Bearer ${plane.token}` },
      });
      const log = (await logResponse.json()) as { entries: Array<{ event: string }> };
      if (bootEvent) expect(log.entries.map((entry) => entry.event)).toContain(bootEvent);
      else expect(log.entries).toEqual([]);
    },
  );
});
