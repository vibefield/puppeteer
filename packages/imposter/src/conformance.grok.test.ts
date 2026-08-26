/**
 * Grok's complete native composition against `ai`: leader socket, strict ACP
 * controller, leader-attached terminal recipe, and persisted session observer.
 * This is the gate for exposing Grok Imposter through Godview.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHost, TerminalSpec } from '@vibecook/puppeteer-core';
import { createGrokBackend, type GrokBackend } from '@vibecook/puppeteer-adapter-grok';
import { projectAgentSession } from '@vibecook/puppeteer-testing';

const AI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'ai.mjs');
const children = new Set<ChildProcess>();
const roots = new Set<string>();
let backend: GrokBackend | undefined;

async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 2_000).unref?.();
  });
}

afterEach(async () => {
  backend?.dispose();
  backend = undefined;
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
      return { runtimeSessionId: 'grok-imposter-pane' };
    },
    automateTerminal: async () => ({ accepted: true }),
  };
}

describe.skipIf(process.platform === 'win32')('the Grok native recipe against `ai`', () => {
  it('converges leader, ACP, terminal, and persisted-log observation on one session', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'puppeteer-grok-imposter-')));
    roots.add(cwd);
    const launched: TerminalSpec[] = [];
    const terminals: ChildProcess[] = [];
    backend = createGrokBackend({
      executable: AI,
      host: spawningHost(launched, terminals),
      // The backend expands this into one isolated PUPPETEER_IMPOSTER_HOME /
      // GROK_HOME shared by every child and the observer.
      appServerEnv: { AI_PERSONA: 'grok', PUPPETEER_IMPOSTER_TUI: 'off' },
    });

    const session = await Promise.race([
      backend.createSession({ cwd }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out creating the Grok leader/ACP/TUI composition')), 12_000),
      ),
    ]);
    const projection = projectAgentSession(session);
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

    const receipt = await session.submitPrompt({ text: 'say hello' });
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
    expect(records.every(({ timestamp }) => typeof timestamp === 'number' && timestamp > 10_000_000_000)).toBe(true);
    expect(
      records.some(
        ({ params }) =>
          params?.update?.sessionUpdate === 'user_message_chunk' &&
          (params.update as { content?: { text?: string } }).content?.text === 'typed in the native terminal',
      ),
    ).toBe(true);
    expect(
      records.filter(
        ({ params }) =>
          params?.update?.sessionUpdate === 'hook_execution' && params.update.event_name === 'session_start',
      ),
    ).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(store, 'summary.json'), 'utf8'))).toMatchObject({
      info: { id: session.sessionId, cwd },
      num_messages: 4,
      num_chat_messages: 4,
    });
    expect(JSON.parse(readFileSync(join(store, 'signals.json'), 'utf8'))).toMatchObject({
      contextTokensUsed: 32,
      compactionCount: 0,
      turnCount: 2,
      toolCallCount: 0,
    });

    await session.dispose();
  });
});
