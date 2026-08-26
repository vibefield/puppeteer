import { rmSync } from 'node:fs';
import { afterEach, expect } from 'vitest';
import type { AgentEventEnvelope, AgentHost } from '@vibecook/puppeteer-core';
import {
  runAgentMonitorConformance,
  runAgentSessionConformance,
  type AgentSessionHarness,
} from '@vibecook/puppeteer-testing/conformance';
import { createOpenCodeTuiSession, type OpenCodeTuiSession } from './driver.js';
import { createOpenCodeImposterFixture, type OpenCodeImposterFixture } from './test-support/imposter.js';

const REPLY = 'imposter: ok';
const roots = new Set<string>();
let runtimeSequence = 0;

interface OpenCodeHarness extends AgentSessionHarness {
  closeObservationRail(): Promise<void>;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function createHarness(existing?: {
  fixture: OpenCodeImposterFixture;
  sessionID: string;
}): Promise<OpenCodeHarness> {
  const fixture = existing?.fixture ?? createOpenCodeImposterFixture();
  roots.add(fixture.root);
  const host: AgentHost = {
    async spawnTerminal(spec) {
      expect(spec.command).toBe(fixture.executable);
      expect(spec.args[0]).toBe('attach');
      return { runtimeSessionId: `runtime-opencode-conformance-${++runtimeSequence}` };
    },
    async automateTerminal() {
      return { accepted: false, reason: 'OpenCode uses structured REST prompt control' };
    },
  };
  const session = await createOpenCodeTuiSession({
    cwd: fixture.cwd,
    host,
    executable: fixture.executable,
    env: fixture.env,
    resume: existing?.sessionID,
    promptConfirmationTimeoutMs: 2_000,
  });
  let disposed = false;
  const originalDispose = session.dispose.bind(session);
  session.dispose = async () => {
    await originalDispose();
    disposed = true;
  };

  return {
    session,
    reply: REPLY,
    resume: () => createHarness({ fixture, sessionID: session.sessionId }),
    async assertNoOrphans() {
      if (!disposed) throw new Error('OpenCode session was not disposed');
      expect((session as OpenCodeTuiSession).backendRunning()).toBe(false);
    },
    async closeObservationRail() {
      const openCode = session as OpenCodeTuiSession;
      const pid = openCode.backendPid();
      if (pid === undefined) throw new Error('OpenCode backend has no pid');
      const degraded = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error('timed out waiting for OpenCode observation rail degradation'));
        }, 5_000);
        const off = session.onEvent(({ event }) => {
          if (event.type !== 'monitor:batch' || event.batch.readiness !== 'degraded') return;
          clearTimeout(timer);
          off?.();
          resolve();
        });
      });
      process.kill(pid, 'SIGTERM');
      await degraded;
    },
    async driveTurn(prompt) {
      let completed = false;
      const off = session.onEvent((envelope: AgentEventEnvelope) => {
        if (!envelope.replay && envelope.event.type === 'turn:completed') completed = true;
      });
      try {
        const receipt = await session.submitPrompt({ text: prompt });
        if (receipt.status !== 'confirmed') {
          throw new Error(`expected confirmed OpenCode receipt, got ${receipt.status}: ${receipt.reason}`);
        }
        await waitFor(() => completed, 'OpenCode turn completion');
      } finally {
        off();
      }
    },
  };
}

runAgentSessionConformance('opencode-http-sse', () => createHarness());
runAgentMonitorConformance('opencode-http-sse', async () => {
  const harness = await createHarness();
  return { session: harness.session, closeObservationRail: harness.closeObservationRail };
});
