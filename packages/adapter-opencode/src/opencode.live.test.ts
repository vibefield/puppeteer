/**
 * Opt-in proof of the complete OpenCode product composition: exact private
 * backend, exact session, structured prompt control, HTTP/SSE observation,
 * and the real native TUI attached to that same session through a PTY.
 *
 *   OPENCODE_LIVE=1 PUPPETEER_OPENCODE_BIN=/absolute/path/to/opencode pnpm test
 */

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AgentHost, TerminalAutomationOperation, TerminalSpec } from '@vibecook/puppeteer-core';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { attestLiveAdapter } from '@vibecook/puppeteer-testing/live-attestation';
import { spawn, type IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { probeOpenCodeVersion, resolveOpenCodeExecutable } from './detection.js';
import { createOpenCodeTuiSession } from './driver.js';

const live = process.env.OPENCODE_LIVE === '1';
const MODEL = 'puppeteer-opencode-live';
const RESPONSE_MARKER = 'SURFACE_OPENCODE_TUI_OK';

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

interface PtyRecord {
  readonly terminal: IPty;
  output: string;
  exited: boolean;
  readonly exit: Promise<void>;
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
    const runtimeSessionId = `opencode-live-terminal-${terminal.pid}`;
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => (resolveExit = resolve));
    const record: PtyRecord = { terminal, output: '', exited: false, exit };
    this.records.set(runtimeSessionId, record);
    terminal.onData((data) => {
      record.output = `${record.output}${data}`.slice(-131_072);
    });
    terminal.onExit(() => {
      record.exited = true;
      resolveExit();
    });
    await waitFor(() => record.exited || record.output.length > 0, 'OpenCode native TUI startup', 15_000);
    if (record.exited) throw new Error(`OpenCode TUI exited during startup:\n${this.output(runtimeSessionId)}`);
    return { runtimeSessionId };
  }

  async automateTerminal(runtimeSessionId: string, operation: TerminalAutomationOperation) {
    const record = this.records.get(runtimeSessionId);
    if (!record || record.exited) return { accepted: false as const, reason: 'terminal is not running' };
    if (operation.kind === 'interrupt') record.terminal.write('\x03');
    else if (operation.kind === 'text') record.terminal.write(operation.text);
    else record.terminal.write(`\x1b[200~${operation.text}\x1b[201~${operation.submit ? '\r' : ''}`);
    return { accepted: true as const };
  }

  output(runtimeSessionId: string): string {
    return stripVTControlCharacters(this.records.get(runtimeSessionId)?.output ?? '');
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
  readonly requests: Array<{ method?: string; url?: string; body: unknown }>;
  close(): Promise<void>;
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null, usage?: object) {
  return {
    id: 'chatcmpl-puppeteer-opencode-live',
    object: 'chat.completion.chunk',
    created: 1_788_019_200,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function startLoopbackProvider(): Promise<LoopbackProvider> {
  const requests: LoopbackProvider['requests'] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // Keep malformed input visible to the assertion.
      }
      requests.push({ method: request.method, url: request.url, body });
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      for (const chunk of [
        chatChunk({ role: 'assistant' }, null),
        chatChunk({ reasoning_content: 'Returning the controlled native-TUI marker. ' }, null),
        chatChunk({ content: 'SURFACE_OPENCODE_' }, null),
        chatChunk({ content: 'TUI_OK' }, null),
        chatChunk({}, 'stop', { prompt_tokens: 29, completion_tokens: 8, total_tokens: 37 }),
      ]) {
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

function providerConfig(baseUrl: string) {
  return {
    formatter: false,
    lsp: false,
    model: `test/${MODEL}`,
    small_model: `test/${MODEL}`,
    provider: {
      test: {
        name: 'Puppeteer Live',
        id: 'test',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [MODEL]: {
            id: MODEL,
            name: 'Puppeteer Live Model',
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: '2025-01-01',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'not-a-real-key', baseURL: baseUrl },
      },
    },
  };
}

function isolatedOpenCodeEnvironment(root: string, baseUrl: string): Record<string, string> {
  const config = providerConfig(baseUrl);
  return {
    ...inheritedProcessEnvironment(),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
    OPENCODE_TEST_HOME: join(root, 'opencode-home'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode-config'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_AUTH_CONTENT: '{}',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_PURE: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

describe.runIf(live)('OpenCode adapter through real native TUI (live)', () => {
  it('shares one exact session across native TUI, structured control, and HTTP/SSE observation', async () => {
    const cwd = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-opencode-live-')));
    mkdirSync(join(cwd, 'tmp'), { recursive: true });
    const provider = await startLoopbackProvider();
    const host = new PtyAgentHost();
    const executable = resolveOpenCodeExecutable();
    const environment = isolatedOpenCodeEnvironment(cwd, provider.baseUrl);
    let session: Awaited<ReturnType<typeof createOpenCodeTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect(await probeOpenCodeVersion(executable)).toBe('1.18.16');
      session = await createOpenCodeTuiSession({
        cwd,
        host,
        executable,
        env: environment,
        title: 'Puppeteer Native TUI Proof',
        model: { providerID: 'test', modelID: MODEL },
        permission: [{ permission: '*', pattern: '*', action: 'allow' }],
        promptConfirmationTimeoutMs: 30_000,
      });
      projection = projectAgentEvents(session);
      expect(session.sessionId).toMatch(/^ses_/);
      expect(projection.state.lifecycle).toBe('ready');
      expect(session.observationLevel()).toBe('structured');

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({ status: 'confirmed' });
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'normalized OpenCode turn completion',
      );
      expect(projection.state.lastAssistantMessage).toContain(RESPONSE_MARKER);
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(RESPONSE_MARKER),
        'the attached native TUI to render the controlled response',
      );
      expect(provider.requests.filter((request) => request.url?.startsWith('/v1/chat/completions'))).toHaveLength(1);
      await attestLiveAdapter({ vendor: 'opencode', artifact: executable, testId: 'opencode:native-tui-wire' });
    } finally {
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      await provider.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 90_000);
});
