import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { AdapterEventCandidate, AgentHost } from '@vibecook/puppeteer-core';
import {
  runAgentAdapterConformance,
  runAgentMonitorConformance,
  type AgentAdapterHarness,
  type AgentMonitorAdapterHarness,
} from '@vibecook/puppeteer-testing/conformance';
import { createAntigravityTuiSession } from './driver.js';
import { antigravitySessionLocation } from './observation/session-store.js';

const REPLY = 'antigravity adapter conformance reply';
const roots = new Set<string>();
let runtimeSequence = 0;
let nativeSequence = 0;

interface DurableStore {
  cwd: string;
  dataRoot: string;
  sessionId: string;
  transcriptPath: string;
  nextStep: number;
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

function createStore(cwd: string, dataRoot: string): DurableStore {
  const sessionId = `antigravity-conformance-${++nativeSequence}`;
  const location = antigravitySessionLocation(dataRoot, sessionId);
  mkdirSync(join(location.sessionDir, '.system_generated', 'logs'), { recursive: true });
  writeFileSync(location.transcriptPath, '');
  return { cwd, dataRoot, sessionId, transcriptPath: location.transcriptPath, nextStep: 0 };
}

function append(store: DurableStore, record: Record<string, unknown>): void {
  appendFileSync(store.transcriptPath, `${JSON.stringify(record)}\n`);
}

function appendTurn(store: DurableStore, prompt: string): void {
  append(store, {
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    status: 'DONE',
    step_index: store.nextStep++,
    created_at: new Date().toISOString(),
    content: `<USER_REQUEST>${prompt}</USER_REQUEST>`,
  });
  append(store, {
    type: 'PLANNER_RESPONSE',
    source: 'MODEL',
    status: 'DONE',
    step_index: store.nextStep++,
    created_at: new Date().toISOString(),
    content: REPLY,
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

async function createHarness(existing?: DurableStore): Promise<AgentAdapterHarness> {
  const cwd = existing?.cwd ?? temporaryDirectory('puppeteer-antigravity-conformance-cwd-');
  const dataRoot = existing?.dataRoot ?? temporaryDirectory('puppeteer-antigravity-conformance-data-');
  let store = existing;
  const host: AgentHost = {
    async spawnTerminal() {
      store ??= createStore(cwd, dataRoot);
      return { runtimeSessionId: `runtime-antigravity-conformance-${++runtimeSequence}` };
    },
    async automateTerminal(_runtimeSessionId, operation) {
      if (operation.kind !== 'paste' || !operation.submit)
        return { accepted: false, reason: 'the conformance host accepts submitted paste operations only' };
      if (!store) return { accepted: false, reason: 'Antigravity durable store is unavailable' };
      appendTurn(store, operation.text);
      return { accepted: true };
    },
  };
  const session = await createAntigravityTuiSession({
    cwd,
    host,
    dataRoot,
    resume: existing?.sessionId,
    pollIntervalMs: 10,
    promptConfirmationTimeoutMs: 2_000,
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
      if (!store) throw new Error('cannot resume before Antigravity creates its durable session');
      return createHarness(store);
    },
    assertNoOrphans: async () => {
      if (!disposed) throw new Error('Antigravity observer remains active');
    },
    driveTurn: async (prompt) => {
      let completed = false;
      const off = session.events.onCandidate((candidate: AdapterEventCandidate) => {
        if (!candidate.replay && candidate.event.type === 'turn:completed') completed = true;
      });
      try {
        const receipt = await session.services.prompt.submit({ text: prompt });
        if (receipt.status !== 'confirmed')
          throw new Error(`expected confirmed Antigravity prompt receipt, got ${receipt.status}: ${receipt.reason}`);
        await waitFor(() => completed, 'Antigravity turn completion');
      } finally {
        off();
      }
    },
  };
}

runAgentAdapterConformance('antigravity-transcript', () => createHarness());

async function createMonitorHarness(): Promise<AgentMonitorAdapterHarness> {
  const cwd = temporaryDirectory('puppeteer-antigravity-monitor-cwd-');
  const dataRoot = temporaryDirectory('puppeteer-antigravity-monitor-data-');
  const store = createStore(cwd, dataRoot);
  const host: AgentHost = {
    async spawnTerminal() {
      return { runtimeSessionId: `runtime-antigravity-monitor-${++runtimeSequence}` };
    },
    async automateTerminal() {
      return { accepted: false, reason: 'monitor conformance does not inject prompts' };
    },
  };
  const session = await createAntigravityTuiSession({
    cwd,
    host,
    dataRoot,
    resume: store.sessionId,
    pollIntervalMs: 10,
  });
  return {
    binding: session,
    async closeObservationRail() {
      let degraded = false;
      const off = session.events.onCandidate(({ event }) => {
        if (event.type === 'monitor:batch' && event.batch.readiness === 'degraded') degraded = true;
      });
      appendFileSync(store.transcriptPath, '{invalid-antigravity-record}\n');
      await waitFor(() => degraded, 'Antigravity observation degradation');
      off();
    },
  };
}

runAgentMonitorConformance('antigravity-transcript', createMonitorHarness);
