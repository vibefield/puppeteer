/**
 * Authentication-independent pinned-real acceptance lane.
 *
 * The protected promotion workflow supplies the exact acquired artifact. This
 * test runs its --init-only path with a disposable Claude home and the actual
 * generated adapter settings, proving command-only and HTTP hooks both reach
 * the bridge without borrowing user credentials or configuration.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope } from '@vibecook/chopsticks-core';
import { prepareClaudeTuiSession } from './driver.js';
import { CLAUDE_SURFACE_VERSION } from './generated/registry.js';

const live = process.env.CHOPSTICKS_REAL_CLAUDE === '1';

function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Claude --init-only did not exit within 30 seconds'));
    }, 30_000);
    timer.unref?.();
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

describe.skipIf(!live)('Claude pinned artifact (live)', () => {
  it('accepts generated settings and emits the init lifecycle over both hook transports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chopsticks-claude-pinned-real-'));
    const cwd = join(root, 'workspace');
    const configDir = join(root, 'config');
    await mkdir(cwd);
    await mkdir(configDir);
    await writeFile(join(cwd, 'CLAUDE.md'), 'Pinned-real adapter fixture.\n', 'utf8');

    const executable = process.env.CHOPSTICKS_CLAUDE_BIN ?? 'claude';
    const prepared = await prepareClaudeTuiSession({
      cwd,
      executable,
      title: `chopsticks-${CLAUDE_SURFACE_VERSION}`,
      automate: async () => ({ accepted: false, reason: 'init-only has no prompt automation' }),
    });
    const session = await prepared.adopt('pinned-real-init');
    const events: AgentEventEnvelope[] = [];
    session.onEvent((event) => events.push(event));
    let child: ChildProcess | undefined;
    try {
      child = spawn(prepared.launch.command, ['--init-only', ...prepared.launch.args], {
        cwd,
        env: {
          ...process.env,
          ...prepared.launch.env,
          CLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const result = await waitForExit(child);
      expect(result.code, result.stderr).toBe(0);
      expect(events.map((event) => event.event.type)).toEqual(
        expect.arrayContaining(['session.started', 'session.ready', 'session.exited', 'adapter.native-event']),
      );
      expect(
        events.some((event) => event.event.type === 'adapter.native-event' && event.event.nativeType === 'Setup'),
      ).toBe(true);
      expect(session.observationLevel()).toBe('native-hooks');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await session.dispose();
      expect(existsSync(prepared.launch.settingsPath)).toBe(false);
      expect(existsSync(prepared.launch.hookForwarderPath)).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
});
