/** The complete Kimi native-TUI + durable-wire recipe against the real `ai` process. */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import type { AdapterEventCandidate, AgentHost } from '@vibecook/puppeteer-core';
import { createKimiTuiSession, type KimiTuiSession } from '@vibecook/puppeteer-adapter-kimi';
import { projectAgentEvents, type TestAgentProjection } from '@vibecook/puppeteer-testing';
import { runAgentAdapterConformance, type AgentAdapterHarness } from '@vibecook/puppeteer-testing/conformance';

const AI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai.mjs');
const REPLY = 'imposter: ok';
const children = new Set<ChildProcess>();
const roots = new Set<string>();
let runtimeSequence = 0;

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 2_000).unref?.();
  });
}

afterEach(async () => {
  await Promise.all([...children].map(reap));
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  roots.clear();
});

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.add(directory);
  return directory;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface KimiImposterHarness extends AgentAdapterHarness {
  binding: KimiTuiSession;
  projection: TestAgentProjection;
  cwd: string;
  home: string;
}

async function kimiImposterHarness(
  resume?: string,
  existing?: { cwd: string; home: string },
): Promise<KimiImposterHarness> {
  const cwd = existing?.cwd ?? temporaryDirectory('puppeteer-kimi-imposter-cwd-');
  const home = existing?.home ?? temporaryDirectory('puppeteer-kimi-imposter-home-');
  let child: ChildProcess | undefined;
  const host: AgentHost = {
    async spawnTerminal(spec) {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: {
          ...process.env,
          ...spec.env,
          AI_PERSONA: 'kimi',
          PUPPETEER_IMPOSTER_HOME: home,
          PUPPETEER_IMPOSTER_TUI: 'off',
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      children.add(child);
      await new Promise<void>((resolve, reject) => {
        child!.once('spawn', resolve);
        child!.once('error', reject);
      });
      return { runtimeSessionId: `runtime-kimi-imposter-${++runtimeSequence}` };
    },
    async automateTerminal(_runtimeSessionId, operation) {
      if (!child?.stdin?.writable) return { accepted: false, reason: 'Kimi Imposter terminal is not writable' };
      if (operation.kind === 'paste') {
        child.stdin.write(`\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`);
      } else if (operation.kind === 'text') {
        child.stdin.write(operation.text);
      } else {
        child.stdin.write('\x03');
      }
      return { accepted: true };
    },
  };

  const session = await createKimiTuiSession({
    cwd,
    host,
    executable: AI,
    env: {
      AI_PERSONA: 'kimi',
      KIMI_CODE_HOME: home,
      PUPPETEER_IMPOSTER_HOME: home,
      PUPPETEER_IMPOSTER_TUI: 'off',
    },
    resume,
    pollIntervalMs: 25,
    promptConfirmationTimeoutMs: 5_000,
  });
  const projection = projectAgentEvents(session);
  if (resume) {
    await waitFor(() => projection.state.lastAssistantMessage === REPLY, 'resumed Kimi wire history');
  }

  return {
    binding: session,
    projection,
    cwd,
    home,
    reply: REPLY,
    resume: () => kimiImposterHarness(session.sessionId, { cwd, home }),
    assertNoOrphans: async () => {
      if (!child) throw new Error('Kimi Imposter process was never spawned');
      await reap(child);
      children.delete(child);
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error('Kimi Imposter process survived cleanup');
      }
    },
    driveTurn: async (prompt) => {
      let completed = false;
      const off = session.events.onCandidate((envelope: AdapterEventCandidate) => {
        if (!envelope.replay && envelope.event.type === 'turn:completed') completed = true;
      });
      try {
        const receipt = await session.services.prompt.submit({ text: prompt });
        if (receipt.status !== 'confirmed') {
          throw new Error(`expected confirmed Kimi prompt receipt, got ${receipt.status}: ${receipt.reason}`);
        }
        await waitFor(() => completed, 'non-replay Kimi turn completion');
      } finally {
        off();
      }
    },
  };
}

runAgentAdapterConformance('kimi-imposter', kimiImposterHarness);
