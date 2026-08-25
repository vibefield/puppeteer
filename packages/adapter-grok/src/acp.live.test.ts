/**
 * Opt-in live coverage of the complete Grok product recipe: shared leader,
 * native terminal viewer, ACP controller, durable-log observer, and resume.
 *
 *   GROK_LIVE=1 pnpm --filter @vibecook/chopsticks-adapter-grok test
 *
 * A self-hosted reconciliation runner should set GROK_LIVE_HOME to an isolated,
 * pre-authenticated Grok home. Without it the installed binary's normal home is
 * used and Grok retains the session just as it does for an interactive launch.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEventEnvelope, AgentHost, TerminalSpec } from '@vibecook/chopsticks-core';
import { describe, expect, it } from 'vitest';
import { createGrokBackend } from './backend.js';

const live = process.env.GROK_LIVE === '1';
const GROK_BIN = process.env.CHOPSTICKS_GROK_BIN ?? 'grok';

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function terminalHost(children: Set<ChildProcess>, launches: TerminalSpec[]): AgentHost {
  return {
    async spawnTerminal(spec) {
      launches.push(spec);
      // macOS `script` supplies the PTY that the real native viewer expects.
      // This lane is intentionally Darwin-only until the declared Windows and
      // Linux viewer recipes have their own acquired-artifact evidence.
      const child = spawn('script', ['-q', '/dev/null', spec.command, ...spec.args], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      children.add(child);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return { runtimeSessionId: `grok-live-terminal-${child.pid ?? 'unknown'}` };
    },
    automateTerminal: async () => ({ accepted: true }),
  };
}

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGKILL');
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

describe.skipIf(!live || process.platform !== 'darwin')('Grok native composition (live)', () => {
  it('shares one session across leader, TUI, ACP, durable observation, and resume', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'grok-composition-live-')));
    const children = new Set<ChildProcess>();
    const launches: TerminalSpec[] = [];
    const liveHome = process.env.GROK_LIVE_HOME;
    const backend = createGrokBackend({
      executable: GROK_BIN,
      host: terminalHost(children, launches),
      ...(liveHome ? { appServerEnv: { GROK_HOME: liveHome } } : {}),
    });

    try {
      const session = await backend.createSession({ cwd, permissionMode: 'default' });
      const events: AgentEventEnvelope[] = [];
      session.onEvent((event) => events.push(event));
      const originalId = session.sessionId;

      expect(launches).toHaveLength(1);
      expect(launches[0]?.args).toEqual(expect.arrayContaining(['--leader', '--resume', originalId]));
      expect(session.observationLevel()).toBe('native-log');

      const receipt = await session.submitPrompt({
        text: 'Reply with exactly the single word: pong. Do not use any tools.',
      });
      expect(receipt.status).toBe('confirmed');
      await waitFor(() => events.some(({ event }) => event.type === 'turn.completed'), 'durable turn completion');
      expect(session.state().lastAssistantMessage?.toLowerCase()).toContain('pong');
      expect(events.some(({ source }) => source === 'native-transcript')).toBe(true);
      await session.dispose();
      await Promise.all([...children].map(reap));
      children.clear();

      const resumed = await backend.createSession({ cwd, resume: originalId });
      expect(resumed.sessionId).toBe(originalId);
      expect(launches).toHaveLength(2);
      await waitFor(
        () => (resumed.state().lastAssistantMessage ?? '').toLowerCase().includes('pong'),
        'resumed durable history',
      );
      expect(resumed.observationLevel()).toBe('native-log');
      await resumed.dispose();
    } finally {
      backend.dispose();
      await Promise.all([...children].map(reap));
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
