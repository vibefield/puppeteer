import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { AdapterEventCandidate, AgentHost } from '@vibefield/puppeteer-core';
import {
  runAgentAdapterConformance,
  runAgentMonitorConformance,
  type AgentAdapterHarness,
  type AgentMonitorAdapterHarness,
} from '@vibefield/puppeteer-testing/conformance';
import { createPiTuiSession } from './driver.js';
import { resolvePiSessionDir } from './observation/session-store.js';

const REPLY = 'pi adapter conformance reply';
const roots = new Set<string>();
let runtimeSequence = 0;
let recordSequence = 0;

interface DurableStore {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  sessionId: string;
  sessionPath: string;
}

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.add(directory);
  return directory;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 20 });
  roots.clear();
});

function append(store: DurableStore, record: Record<string, unknown>): void {
  appendFileSync(store.sessionPath, `${JSON.stringify(record)}\n`);
}

function createStore(cwd: string, agentDir: string, sessionId: string): DurableStore {
  const sessionDir = resolvePiSessionDir(cwd, agentDir);
  const sessionPath = join(sessionDir, `2026-08-25T00-00-00-000Z_${sessionId}.jsonl`);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionPath, '');
  const store = { cwd, agentDir, sessionDir, sessionId, sessionPath };
  append(store, {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  });
  append(store, {
    type: 'model_change',
    id: `model-${++recordSequence}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    provider: 'conformance',
    modelId: 'pi-conformance-model',
  });
  return store;
}

function appendTurn(store: DurableStore, prompt: string): void {
  const now = Date.now();
  const userId = `user-${++recordSequence}`;
  append(store, {
    type: 'message',
    id: userId,
    parentId: null,
    timestamp: new Date(now).toISOString(),
    message: { role: 'user', timestamp: now, content: [{ type: 'text', text: prompt }] },
  });
  append(store, {
    type: 'message',
    id: `assistant-${++recordSequence}`,
    parentId: userId,
    timestamp: new Date(now + 1).toISOString(),
    message: {
      role: 'assistant',
      timestamp: now + 1,
      provider: 'conformance',
      model: 'pi-conformance-model',
      content: [{ type: 'text', text: REPLY }],
      stopReason: 'stop',
      usage: {
        input: 8,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sessionIdFromArgs(args: readonly string[]): string | undefined {
  const index = args.indexOf('--session-id');
  return index >= 0 ? args[index + 1] : undefined;
}

async function createHarness(existing?: DurableStore): Promise<AgentAdapterHarness> {
  const cwd = existing?.cwd ?? temporaryDirectory('puppeteer-pi-conformance-cwd-');
  const agentDir = existing?.agentDir ?? temporaryDirectory('puppeteer-pi-conformance-agent-');
  let store = existing;
  const host: AgentHost = {
    async spawnTerminal(spec) {
      if (!store) {
        const sessionId = sessionIdFromArgs(spec.args);
        if (!sessionId) throw new Error('fresh Pi launch did not declare --session-id');
        store = createStore(cwd, agentDir, sessionId);
      }
      return { runtimeSessionId: `runtime-pi-conformance-${++runtimeSequence}` };
    },
    async automateTerminal(_runtimeSessionId, operation) {
      if (operation.kind !== 'paste' || !operation.submit)
        return { accepted: false, reason: 'the conformance host accepts submitted paste operations only' };
      if (!store) return { accepted: false, reason: 'Pi durable store is unavailable' };
      appendTurn(store, operation.text);
      return { accepted: true };
    },
  };
  const session = await createPiTuiSession({
    cwd,
    host,
    piAgentDir: agentDir,
    resume: existing?.sessionId,
    pollIntervalMs: 10,
  });
  let disposed = false;
  const dispose = session.dispose.bind(session);
  session.dispose = async () => {
    await dispose();
    disposed = true;
  };
  return {
    binding: session,
    reply: REPLY,
    resume: async () => {
      if (!store) throw new Error('cannot resume before Pi creates its durable session');
      return createHarness(store);
    },
    assertNoOrphans: async () => {
      if (!disposed) throw new Error('Pi observer remains active');
    },
    driveTurn: async (prompt) => {
      let completed = false;
      const off = session.events.onCandidate((candidate: AdapterEventCandidate) => {
        if (!candidate.replay && candidate.event.type === 'turn:completed') completed = true;
      });
      try {
        const receipt = await session.services.prompt.submit({ text: prompt });
        if (receipt.status === 'rejected') throw new Error(`Pi prompt was rejected: ${receipt.reason}`);
        await waitFor(() => completed, 'Pi turn completion');
      } finally {
        off();
      }
    },
  };
}

runAgentAdapterConformance('pi-session-jsonl', () => createHarness());

async function createMonitorHarness(): Promise<AgentMonitorAdapterHarness> {
  const cwd = temporaryDirectory('puppeteer-pi-monitor-cwd-');
  const agentDir = temporaryDirectory('puppeteer-pi-monitor-agent-');
  const store = createStore(cwd, agentDir, `monitor-${++recordSequence}`);
  const host: AgentHost = {
    async spawnTerminal() {
      return { runtimeSessionId: `runtime-pi-monitor-${++runtimeSequence}` };
    },
    async automateTerminal() {
      return { accepted: false, reason: 'monitor conformance does not inject prompts' };
    },
  };
  const session = await createPiTuiSession({ cwd, host, piAgentDir: agentDir, resume: store.sessionId });
  return {
    binding: session,
    async closeObservationRail() {
      let degraded = false;
      const off = session.events.onCandidate(({ event }) => {
        if (event.type === 'monitor:batch' && event.batch.readiness === 'degraded') degraded = true;
      });
      appendFileSync(store.sessionPath, '{invalid-pi-record}\n');
      await waitFor(() => degraded, 'Pi observation degradation');
      off();
    },
  };
}

runAgentMonitorConformance('pi-session-jsonl', createMonitorHarness);
