/**
 * Opt-in candidate test that crosses the complete Kimi product boundary:
 * real native TUI in a PTY, adapter-owned prompt control, durable-wire
 * observation, and normalized events. The model backend and user state stay
 * isolated so this lane needs neither credentials nor external model access.
 *
 *   KIMI_LIVE=1 PUPPETEER_KIMI_BIN=/absolute/path/to/kimi pnpm test
 */

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AgentHost, TerminalAutomationOperation, TerminalSpec } from '@vibecook/puppeteer-core';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { attestLiveAdapter } from '@vibecook/puppeteer-testing/live-attestation';
// The exact beta is pinned because node-pty 1.1.0 packaged its macOS
// spawn-helper without an executable bit; later betas also carry ConPTY fixes.
import { spawn, type IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { detectKimiInstallation, resolveKimiExecutable } from './detection.js';
import { createKimiTuiSession } from './driver.js';

const live = process.env.KIMI_LIVE === '1';
const MODEL = 'puppeteer-kimi-live';
const RESPONSE_MARKER = 'SURFACE_KIMI_TUI_OK';

interface PtyRecord {
  terminal: IPty;
  output: string;
  exited: boolean;
  exit: Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function inheritedProcessEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of ['PATH', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

class PtyAgentHost implements AgentHost {
  private readonly records = new Map<string, PtyRecord>();

  async spawnTerminal(spec: TerminalSpec): Promise<{ runtimeSessionId: string }> {
    const terminal = spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols ?? 120,
      rows: spec.rows ?? 40,
      cwd: spec.cwd,
      env: { ...inheritedProcessEnvironment(), TERM: 'xterm-256color', ...spec.env },
    });
    const runtimeSessionId = `kimi-live-terminal-${terminal.pid}`;
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => (resolveExit = resolve));
    const record: PtyRecord = { terminal, output: '', exited: false, exit };
    this.records.set(runtimeSessionId, record);
    terminal.onData((data) => {
      record.output = `${record.output}${data}`.slice(-32_768);
    });
    terminal.onExit(() => {
      record.exited = true;
      resolveExit();
    });
    await waitFor(
      () =>
        record.exited ||
        record.output.includes('Trust this folder?') ||
        record.output.includes('Welcome to Kimi Code!'),
      'Kimi native startup gate',
      15_000,
    );
    if (record.exited) throw new Error(`Kimi TUI exited during startup:\n${record.output}`);
    if (record.output.includes('Trust this folder?') && !record.output.includes('Welcome to Kimi Code!')) {
      // This is the test user's explicit security decision. The adapter does
      // not auto-trust workspaces; production users make it in the native TUI.
      terminal.write('\r');
    }
    await waitFor(
      () => record.exited || record.output.includes('Welcome to Kimi Code!'),
      'Kimi native prompt readiness',
      15_000,
    );
    if (record.exited) throw new Error(`Kimi TUI exited before prompt readiness:\n${record.output}`);
    return { runtimeSessionId };
  }

  async automateTerminal(runtimeSessionId: string, operation: TerminalAutomationOperation) {
    const record = this.records.get(runtimeSessionId);
    if (!record || record.exited) return { accepted: false as const, reason: 'terminal is not running' };
    if (operation.kind === 'interrupt') {
      record.terminal.write('\x03');
    } else if (operation.kind === 'text') {
      record.terminal.write(operation.text);
    } else {
      const paste = `\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`;
      record.terminal.write(paste);
    }
    return { accepted: true as const };
  }

  output(runtimeSessionId: string): string {
    return this.records.get(runtimeSessionId)?.output ?? '';
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.records.values()].map(async (record) => {
        if (!record.exited) record.terminal.kill();
        await Promise.race([record.exit, delay(2_000)]);
      }),
    );
    this.records.clear();
  }
}

interface LoopbackProvider {
  readonly baseUrl: string;
  readonly requests: unknown[];
  close(): Promise<void>;
}

function openAiChunk(index: number, delta: Record<string, unknown>, finishReason: string | null, usage?: object) {
  return {
    id: 'chatcmpl-puppeteer-kimi-live',
    object: 'chat.completion.chunk',
    created: 1_788_019_200,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
    system_fingerprint: `kimi-live-${index}`,
  };
}

async function startLoopbackProvider(): Promise<LoopbackProvider> {
  const requests: unknown[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk.toString('utf8');
      let parsedBody: unknown = body;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        // Preserve invalid input for the assertion instead of hiding it.
      }
      requests.push({ method: request.method, url: request.url, body: parsedBody });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunks = [
        openAiChunk(0, { role: 'assistant' }, null),
        openAiChunk(1, { reasoning_content: 'Returning the requested controlled marker. ' }, null),
        openAiChunk(2, { content: 'SURFACE_KIMI_' }, null),
        openAiChunk(3, { content: 'TUI_OK' }, null),
        openAiChunk(4, {}, 'stop', { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 }),
      ];
      for (const chunk of chunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await delay(15);
      }
      response.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback provider did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function isolatedKimiEnvironment(root: string, kimiHome: string, baseUrl: string): Record<string, string> {
  return {
    ...inheritedProcessEnvironment(),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    KIMI_CODE_HOME: kimiHome,
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    KIMI_CODE_BUILTIN_PRODUCT_SKILLS: '0',
    KIMI_MODEL_NAME: MODEL,
    KIMI_MODEL_API_KEY: 'sk-not-a-real-key',
    KIMI_MODEL_PROVIDER_TYPE: 'openai',
    KIMI_MODEL_BASE_URL: baseUrl,
    KIMI_MODEL_MAX_CONTEXT_SIZE: '32768',
    KIMI_MODEL_CAPABILITIES: 'thinking,tool_use',
    KIMI_MODEL_REASONING_KEY: 'reasoning_content',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

describe.runIf(live)('Kimi adapter through real native TUI (live)', () => {
  it('injects through a PTY and observes the exact candidate durable wire', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-kimi-live-')));
    const kimiHome = join(root, 'kimi-home');
    const cwd = join(root, 'workspace');
    mkdirSync(kimiHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const provider = await startLoopbackProvider();
    const host = new PtyAgentHost();
    const executable = resolveKimiExecutable();
    const environment = isolatedKimiEnvironment(root, kimiHome, provider.baseUrl);
    let session: Awaited<ReturnType<typeof createKimiTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      const installation = await detectKimiInstallation(executable, { env: environment });
      expect(installation.exactTarget).toBe(true);
      session = await createKimiTuiSession({
        cwd,
        host,
        executable,
        env: environment,
        kimiHome,
        pollIntervalMs: 25,
        promptConfirmationTimeoutMs: 30_000,
      });
      projection = projectAgentEvents(session);
      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toEqual({ status: 'confirmed' });
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'normalized durable turn completion',
      );
      expect(projection.state.lastAssistantMessage).toContain(RESPONSE_MARKER);
      expect(projection.envelopes.some(({ source }) => source === 'native-log')).toBe(true);
      expect(session.observationLevel()).toBe('native-log');
      const sessionDirectory = session.sessionDirectory();
      expect(sessionDirectory).toBeDefined();
      expect(relative(kimiHome, sessionDirectory!)).not.toMatch(/^\.\.(?:[/\\]|$)/);
      expect(provider.requests).toHaveLength(1);
      await attestLiveAdapter({ vendor: 'kimi', artifact: executable, testId: 'kimi:native-tui-wire' });
    } finally {
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 90_000);
});
