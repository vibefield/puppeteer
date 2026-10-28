/**
 * Grok's complete native composition against `ai`: leader socket, strict ACP
 * controller, leader-attached terminal recipe, and persisted session observer.
 * This is the gate for exposing Grok Imposter through Godview.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapterBinding, AgentHost, TerminalSpec } from '@vibefield/puppeteer-core';
import { createGrokBackend, type GrokBackend } from '@vibefield/puppeteer-adapter-grok';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';
import { runAgentAdapterConformance, type AgentAdapterHarness } from '@vibefield/puppeteer-testing/conformance';

const AI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai.mjs');
const children = new Set<ChildProcess>();
const roots = new Set<string>();
const backends = new Set<GrokBackend>();

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 2_000).unref?.();
  });
}

afterEach(async () => {
  // The leader drains before its directory goes, so disposal is awaited.
  await Promise.all([...backends].map((backend) => backend.dispose()));
  backends.clear();
  await Promise.all([...children].map(reap));
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  roots.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Grok rewrites its native state files (summary.json, signals.json) in place and after the turn result, and the
// imposter does the same, so a read just after `turn:completed` can land on the previous turn's state or on a
// truncated file. The session observer treats a partial rewrite as "not yet"; so does this read, until the file
// parses and `settled` accepts it.
async function settledJson(
  path: string,
  settled: (value: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  let value: Record<string, unknown> | undefined;
  let lastRead = 'nothing read';
  try {
    await waitFor(() => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        lastRead = JSON.stringify(parsed);
        if (!settled(parsed)) return false;
        value = parsed;
        return true;
      } catch (error) {
        lastRead = error instanceof Error ? error.message : String(error);
        return false;
      }
    }, label);
  } catch (error) {
    throw new Error(`${(error as Error).message}; last read: ${lastRead}`);
  }
  return value!;
}

function spawningHost(launched: TerminalSpec[], terminals: ChildProcess[]): AgentHost {
  return {
    async spawnTerminal(spec) {
      launched.push(spec);
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      children.add(child);
      terminals.push(child);
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return { runtimeSessionId: `grok-imposter-pane-${child.pid ?? 'unknown'}` };
    },
    automateTerminal: async () => ({ accepted: true }),
  };
}

interface GrokHarnessContext {
  cwd: string;
  home: string;
}

function createHarnessContext(): GrokHarnessContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-grok-conformance-')));
  roots.add(root);
  const cwd = join(root, 'workspace');
  const home = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { cwd, home };
}

async function createGrokHarness(
  context: GrokHarnessContext = createHarnessContext(),
  resume?: string,
): Promise<AgentAdapterHarness> {
  const launched: TerminalSpec[] = [];
  const terminals: ChildProcess[] = [];
  const backend = createGrokBackend({
    executable: AI,
    host: spawningHost(launched, terminals),
    appServerEnv: {
      AI_PERSONA: 'grok',
      GROK_HOME: context.home,
      PUPPETEER_IMPOSTER_HOME: context.home,
      PUPPETEER_IMPOSTER_TUI: 'off',
    },
  });
  backends.add(backend);

  let session: AgentAdapterBinding;
  try {
    session = await Promise.race([
      backend.createSession({ cwd: context.cwd, ...(resume ? { resume } : {}) }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out creating the Grok conformance composition')), 12_000),
      ),
    ]);
  } catch (error) {
    await backend.dispose();
    backends.delete(backend);
    await Promise.all(terminals.map(reap));
    throw error;
  }

  const projection = projectAgentEvents(session);
  const nativeSessionId = session.sessionId;
  return {
    binding: session,
    projection,
    reply: 'imposter: ok',
    async driveTurn(prompt: string) {
      const completedBefore = projection.envelopes.filter(({ event }) => event.type === 'turn:completed').length;
      const receipt = await session.services.prompt.submit({ text: prompt });
      if (receipt.status === 'rejected') throw new Error(receipt.reason);
      await waitFor(
        () =>
          projection.envelopes.filter(({ event }) => event.type === 'turn:completed').length > completedBefore &&
          projection.state.lastAssistantMessage === 'imposter: ok',
        'Grok conformance turn',
      );
    },
    async resume() {
      return createGrokHarness(context, nativeSessionId);
    },
    async assertNoOrphans() {
      await backend.dispose();
      backends.delete(backend);
      await Promise.all(terminals.map(reap));
      expect(terminals.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
      for (const launch of launched) {
        const socketFlag = launch.args.indexOf('--leader-socket');
        const socketPath = socketFlag >= 0 ? launch.args[socketFlag + 1] : undefined;
        if (socketPath) expect(existsSync(dirname(socketPath))).toBe(false);
      }
    },
  };
}

if (process.platform !== 'win32') runAgentAdapterConformance('grok-imposter', createGrokHarness);

describe.skipIf(process.platform === 'win32')('the Grok native recipe against `ai`', () => {
  it('converges leader, ACP, terminal, and persisted-log observation on one session', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-grok-imposter-')));
    roots.add(cwd);
    const launched: TerminalSpec[] = [];
    const terminals: ChildProcess[] = [];
    const backend = createGrokBackend({
      executable: AI,
      host: spawningHost(launched, terminals),
      // The backend expands this into one isolated PUPPETEER_IMPOSTER_HOME /
      // GROK_HOME shared by every child and the observer.
      appServerEnv: { AI_PERSONA: 'grok', PUPPETEER_IMPOSTER_TUI: 'off' },
    });
    backends.add(backend);

    const session = await Promise.race([
      backend.createSession({ cwd }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out creating the Grok leader/ACP/TUI composition')), 12_000),
      ),
    ]);
    const projection = projectAgentEvents(session);
    const events = projection.envelopes;

    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.args).toContain('--leader');
    expect(launched[0]?.args).toContain('--resume');
    expect(launched[0]?.args).toContain(session.sessionId);
    expect(launched[0]?.env).toMatchObject({
      AI_PERSONA: 'grok',
      GROK_HOME: expect.any(String),
      PUPPETEER_IMPOSTER_HOME: expect.any(String),
    });
    expect(launched[0]?.env?.GROK_HOME).toBe(launched[0]?.env?.PUPPETEER_IMPOSTER_HOME);

    expect(terminals).toHaveLength(1);
    terminals[0]!.stdin!.write('\x1b[200~typed in the native terminal\x1b[201~\r');
    await waitFor(() => events.some((event) => event.event.type === 'turn:completed'), 'terminal-authored turn');

    const receipt = await session.services.prompt.submit({ text: 'say hello' });
    expect(receipt.status).toBe('confirmed');
    await waitFor(
      () => events.filter((event) => event.event.type === 'turn:completed').length >= 2,
      'controller-authored turn completion',
    );

    const types = events.map((event) => event.event.type);
    expect(projection.state.lifecycle).toBe('ready');
    expect(types).toContain('turn:started');
    expect(types).toContain('conversation:assistant-message');
    expect(types).toContain('turn:completed');
    expect(session.observationLevel()).toBe('native-log');
    expect(events.find((event) => event.event.type === 'conversation:assistant-message')?.source).toBe(
      'native-transcript',
    );

    const grokHome = launched[0]?.env?.GROK_HOME;
    expect(grokHome).toBeTypeOf('string');
    const store = join(grokHome!, 'sessions', encodeURIComponent(cwd), session.sessionId);
    const records = readFileSync(join(store, 'updates.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            timestamp?: number;
            params?: { update?: { sessionUpdate?: string; event_name?: string } };
          },
      );
    // Grok persists Unix seconds on the durable envelope.
    expect(
      records.every(
        ({ timestamp }) => Number.isInteger(timestamp) && timestamp! >= 1_000_000_000 && timestamp! < 100_000_000_000,
      ),
    ).toBe(true);
    expect(
      records.some(
        ({ params }) =>
          params?.update?.sessionUpdate === 'user_message_chunk' &&
          (params.update as { content?: { text?: string } }).content?.text === 'typed in the native terminal',
      ),
    ).toBe(true);
    // Without configured hooks 1.0.70 records no hook_execution at all.
    expect(records.filter(({ params }) => params?.update?.sessionUpdate === 'hook_execution')).toEqual([]);
    expect(
      await settledJson(
        join(store, 'summary.json'),
        (summary) => summary.num_messages === 4,
        'the two-turn summary.json',
      ),
    ).toMatchObject({
      info: { id: session.sessionId, cwd },
      num_messages: 4,
      num_chat_messages: 4,
    });
    expect(
      await settledJson(join(store, 'signals.json'), (signals) => signals.turnCount === 2, 'the two-turn signals.json'),
    ).toMatchObject({
      contextTokensUsed: 32,
      compactionCount: 0,
      turnCount: 2,
      toolCallCount: 0,
    });

    await session.dispose();
  });
});
