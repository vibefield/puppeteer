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
import { createCopilotTuiSession } from './driver.js';

const REPLY = 'copilot adapter conformance reply';
const roots = new Set<string>();
let runtimeSequence = 0;
let recordSequence = 0;

interface DurableStore {
  cwd: string;
  home: string;
  sessionId: string;
  eventsPath: string;
  nextTurn: number;
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

function append(store: DurableStore, type: string, data: Record<string, unknown>, agentId?: string): void {
  const id = `event-${++recordSequence}`;
  appendFileSync(
    store.eventsPath,
    `${JSON.stringify({ type, data, id, parentId: null, timestamp: new Date().toISOString(), ...(agentId ? { agentId } : {}) })}\n`,
  );
}

function createStore(cwd: string, home: string, sessionId: string): DurableStore {
  const sessionDir = join(home, 'session-state', sessionId);
  const eventsPath = join(sessionDir, 'events.jsonl');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(eventsPath, '');
  const store = { cwd, home, sessionId, eventsPath, nextTurn: 0 };
  append(store, 'session.start', {
    sessionId,
    version: 1,
    producer: 'copilot-agent',
    copilotVersion: '1.0.80',
    startTime: new Date().toISOString(),
    context: { cwd },
    selectedModel: 'conformance-model',
    reasoningEffort: 'medium',
  });
  return store;
}

function appendTurn(store: DurableStore, prompt: string): void {
  const turn = String(store.nextTurn++);
  const interactionId = `interaction-${recordSequence + 1}`;
  append(store, 'user.message', { content: prompt, interactionId });
  append(store, 'assistant.turn_start', { turnId: turn, interactionId, model: 'conformance-model' });
  append(store, 'assistant.message', {
    turnId: turn,
    interactionId,
    messageId: `message-${recordSequence + 1}`,
    content: REPLY,
    toolRequests: [],
    outputTokens: 4,
  });
  append(store, 'assistant.turn_end', { turnId: turn, model: 'conformance-model' });
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
  const cwd = existing?.cwd ?? temporaryDirectory('puppeteer-copilot-conformance-cwd-');
  const home = existing?.home ?? temporaryDirectory('puppeteer-copilot-conformance-home-');
  let store = existing;
  const host: AgentHost = {
    async spawnTerminal(spec) {
      if (!store) {
        const sessionId = sessionIdFromArgs(spec.args);
        if (!sessionId) throw new Error('fresh Copilot launch did not declare --session-id');
        store = createStore(cwd, home, sessionId);
      }
      return { runtimeSessionId: `runtime-copilot-conformance-${++runtimeSequence}` };
    },
    async automateTerminal(_runtimeSessionId, operation) {
      if (operation.kind !== 'paste' || !operation.submit)
        return { accepted: false, reason: 'the conformance host accepts submitted paste operations only' };
      if (!store) return { accepted: false, reason: 'Copilot durable store is unavailable' };
      appendTurn(store, operation.text);
      return { accepted: true };
    },
  };
  const session = await createCopilotTuiSession({
    cwd,
    host,
    copilotHome: home,
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
      if (!store) throw new Error('cannot resume before Copilot creates its durable session');
      return createHarness(store);
    },
    assertNoOrphans: async () => {
      if (!disposed) throw new Error('Copilot observer remains active');
    },
    driveTurn: async (prompt) => {
      let completed = false;
      const off = session.events.onCandidate((candidate: AdapterEventCandidate) => {
        if (!candidate.replay && candidate.event.type === 'turn:completed') completed = true;
      });
      try {
        const receipt = await session.services.prompt.submit({ text: prompt });
        if (receipt.status !== 'confirmed')
          throw new Error(`expected confirmed Copilot prompt receipt, got ${receipt.status}: ${receipt.reason}`);
        await waitFor(() => completed, 'Copilot turn completion');
      } finally {
        off();
      }
    },
  };
}

runAgentAdapterConformance('copilot-session-events', () => createHarness());

async function createMonitorHarness(): Promise<AgentMonitorAdapterHarness> {
  const cwd = temporaryDirectory('puppeteer-copilot-monitor-cwd-');
  const home = temporaryDirectory('puppeteer-copilot-monitor-home-');
  const store = createStore(cwd, home, `monitor-${++recordSequence}`);
  const host: AgentHost = {
    async spawnTerminal() {
      return { runtimeSessionId: `runtime-copilot-monitor-${++runtimeSequence}` };
    },
    async automateTerminal() {
      return { accepted: false, reason: 'monitor conformance does not inject prompts' };
    },
  };
  const session = await createCopilotTuiSession({ cwd, host, copilotHome: home, resume: store.sessionId });
  return {
    binding: session,
    async closeObservationRail() {
      let degraded = false;
      const off = session.events.onCandidate(({ event }) => {
        if (event.type === 'monitor:batch' && event.batch.readiness === 'degraded') degraded = true;
      });
      appendFileSync(store.eventsPath, '{invalid-copilot-record}\n');
      await waitFor(() => degraded, 'Copilot observation degradation');
      off();
    },
  };
}

runAgentMonitorConformance('copilot-session-events', createMonitorHarness);
