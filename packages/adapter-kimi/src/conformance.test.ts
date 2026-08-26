/** Shared adapter-session contract over a deterministic Kimi durable-wire host. */

import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { AdapterEventCandidate, AgentHost } from '@vibecook/puppeteer-core';
import {
  runAgentMonitorConformance,
  runAgentSessionConformance,
  type AgentMonitorSessionHarness,
  type AgentSessionHarness,
} from '@vibecook/puppeteer-testing/conformance';
import { encodeKimiWorkDirKey } from './session-store.js';
import { createKimiTuiSession, type KimiTuiSession } from './tui-session.js';

const REPLY = 'kimi adapter conformance reply';
const roots = new Set<string>();
let runtimeSequence = 0;
let nativeSequence = 0;

interface DurableStore {
  cwd: string;
  home: string;
  sessionId: string;
  sessionDir: string;
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

function appendWire(store: DurableStore, record: Record<string, unknown>): void {
  appendFileSync(join(store.sessionDir, 'agents', 'main', 'wire.jsonl'), `${JSON.stringify(record)}\n`);
}

function createStore(cwd: string, home: string): DurableStore {
  const sessionId = `session_conformance_${++nativeSequence}`;
  const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
  mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(sessionDir, 'state.json'),
    `${JSON.stringify({
      id: sessionId,
      version: 2,
      cwd,
      createdAt: now,
      updatedAt: now,
      archived: false,
      agents: { main: { homedir: cwd, type: 'main' } },
      custom: {},
    })}\n`,
  );
  appendFileSync(join(home, 'session_index.jsonl'), `${JSON.stringify({ sessionId, sessionDir, workDir: cwd })}\n`);
  const store = { cwd, home, sessionId, sessionDir, nextTurn: 0 };
  appendWire(store, { type: 'metadata', protocol_version: '1.5', created_at: now });
  appendWire(store, {
    type: 'profile.bind',
    modelAlias: 'kimi-conformance',
    profileName: 'agent',
    thinkingEffort: 'on',
    systemPrompt: 'test',
    environmentDisclosure: { cwd, date: { disclosed: false } },
    agentsMdPaths: [],
    activeToolNames: [],
    disallowedTools: [],
    time: now,
  });
  appendWire(store, { type: 'permission.set_mode', mode: 'manual', time: now });
  return store;
}

function appendTurn(store: DurableStore, prompt: string): void {
  const turn = store.nextTurn++;
  const turnId = String(turn);
  const now = Date.now();
  appendWire(store, {
    type: 'turn.prompt',
    input: [{ type: 'text', text: prompt }],
    origin: { kind: 'user' },
    time: now,
  });
  appendWire(store, {
    type: 'context.append_loop_event',
    event: { type: 'step.begin', uuid: `step-${turn}`, turnId, step: 1 },
    time: now + 1,
  });
  appendWire(store, {
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      uuid: `content-${turn}`,
      turnId,
      step: 1,
      stepUuid: `step-${turn}`,
      part: { type: 'text', text: REPLY },
    },
    time: now + 2,
  });
  appendWire(store, {
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      uuid: `step-${turn}`,
      turnId,
      step: 1,
      finishReason: 'end_turn',
      providerFinishReason: 'completed',
      rawFinishReason: 'stop',
    },
    time: now + 3,
  });
  appendWire(store, { type: 'turn.ended', turnId: turn, reason: 'completed', durationMs: 3, time: now + 4 });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function createHarness(existing?: DurableStore): Promise<AgentSessionHarness> {
  const cwd = existing?.cwd ?? temporaryDirectory('puppeteer-kimi-conformance-cwd-');
  const home = existing?.home ?? temporaryDirectory('puppeteer-kimi-conformance-home-');
  let store = existing;
  const host: AgentHost = {
    async spawnTerminal() {
      return { runtimeSessionId: `runtime-kimi-conformance-${++runtimeSequence}` };
    },
    async automateTerminal(_runtimeSessionId, operation) {
      if (operation.kind !== 'paste' || !operation.submit) {
        return { accepted: false, reason: 'the conformance host accepts submitted paste operations only' };
      }
      store ??= createStore(cwd, home);
      appendTurn(store, operation.text);
      return { accepted: true };
    },
  };

  const session = await createKimiTuiSession({
    cwd,
    host,
    kimiHome: home,
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
    session,
    reply: REPLY,
    resume: async () => {
      if (!store) throw new Error('cannot resume before Kimi creates its durable session');
      return createHarness(store);
    },
    assertNoOrphans: async () => {
      if (!disposed) throw new Error('Kimi observer remains active');
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
        await waitFor(() => completed, 'Kimi turn completion');
      } finally {
        off();
      }
    },
  };
}

runAgentSessionConformance('kimi-durable-wire', () => createHarness());

async function createMonitorHarness(): Promise<AgentMonitorSessionHarness> {
  const cwd = temporaryDirectory('puppeteer-kimi-monitor-cwd-');
  const home = temporaryDirectory('puppeteer-kimi-monitor-home-');
  const store = createStore(cwd, home);
  const host: AgentHost = {
    async spawnTerminal() {
      return { runtimeSessionId: `runtime-kimi-monitor-${++runtimeSequence}` };
    },
    async automateTerminal() {
      return { accepted: false, reason: 'monitor conformance does not inject prompts' };
    },
  };
  const session = await createKimiTuiSession({
    cwd,
    host,
    kimiHome: home,
    resume: store.sessionId,
    pollIntervalMs: 10,
  });
  return {
    session,
    async closeObservationRail() {
      let degraded = false;
      const off = session.events.onCandidate(({ event }) => {
        if (event.type === 'monitor:batch' && event.batch.readiness === 'degraded') degraded = true;
      });
      appendFileSync(join(store.sessionDir, 'agents', 'main', 'wire.jsonl'), '{invalid-monitor-record}\n');
      await waitFor(() => degraded, 'Kimi observation degradation');
      off();
    },
  };
}

runAgentMonitorConformance('kimi-durable-wire', createMonitorHarness);
