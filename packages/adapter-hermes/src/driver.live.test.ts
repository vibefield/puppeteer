/**
 * Opt-in proof of the complete Hermes composition: one adapter-owned gateway,
 * the exact native TUI attached through a PTY, structured prompt control, and
 * normalized events fanned out from that same live session. Provider traffic
 * and user state remain isolated and local.
 *
 *   HERMES_LIVE=1 PUPPETEER_HERMES_BIN=/path/to/hermes \
 *     HERMES_PYTHON=/path/to/python HERMES_TUI_DIR=/path/to/ui-tui pnpm test
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { AgentHost, TerminalAutomationOperation, TerminalSpec } from '@vibecook/puppeteer-core';
import { projectAgentEvents } from '@vibecook/puppeteer-testing';
import { attestLiveAdapter } from '@vibecook/puppeteer-testing/live-attestation';
import { spawn, type IPty } from 'node-pty';
import { describe, expect, it } from 'vitest';
import { probeHermesVersion, resolveHermesExecutable } from './detection.js';
import { createHermesTuiSession } from './driver.js';
import { resolveHermesPython } from './launch/gateway-host.js';

const live = process.env.HERMES_LIVE === '1';
const MODEL = 'puppeteer-hermes-live';
const RESPONSE_MARKER = 'SURFACE_HERMES_TUI_OK';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
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
    const runtimeSessionId = `hermes-live-terminal-${terminal.pid}`;
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
    await waitFor(() => record.exited || record.output.length > 0, 'Hermes native TUI startup', 20_000);
    if (record.exited) throw new Error(`Hermes TUI exited during startup:\n${this.output(runtimeSessionId)}`);
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
    id: 'chatcmpl-puppeteer-hermes-live',
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
        // Preserve malformed input for the assertion.
      }
      requests.push({ method: request.method, url: request.url, body });
      if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
        return;
      }
      if (request.method !== 'POST' || !request.url?.includes('/chat/completions')) {
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
        chatChunk({ content: 'SURFACE_HERMES_' }, null),
        chatChunk({ content: 'TUI_OK' }, null),
        chatChunk({}, 'stop', { prompt_tokens: 27, completion_tokens: 7, total_tokens: 34 }),
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

function writeHermesConfiguration(home: string, baseUrl: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, 'config.yaml'),
    [
      'model:',
      `  default: ${MODEL}`,
      '  provider: custom',
      `  base_url: ${JSON.stringify(baseUrl)}`,
      '  api_key: not-a-real-key',
      'approvals:',
      '  mode: manual',
      '  timeout: 20',
      'platform_toolsets:',
      '  tui: [terminal]',
      'display:',
      '  interface: tui',
      '  interim_assistant_messages: false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(join(home, '.env'), `OPENAI_API_KEY=not-a-real-key\nOPENAI_BASE_URL=${baseUrl}\n`, { mode: 0o600 });
}

function isolatedHermesEnvironment(root: string, home: string, tuiDirectory: string, baseUrl: string) {
  return {
    ...inheritedProcessEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    HERMES_HOME: home,
    HERMES_TUI_DIR: tuiDirectory,
    HERMES_NODE: process.execPath,
    HERMES_QUIET: '1',
    OPENAI_API_KEY: 'not-a-real-key',
    OPENAI_BASE_URL: baseUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

describe.runIf(live)('Hermes adapter through real native TUI (live)', () => {
  it('fans one exact-session turn out to structured observation and the native viewer', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-hermes-live-')));
    const cwd = join(root, 'workspace');
    const home = join(root, 'hermes-home');
    const tuiDirectory = process.env.HERMES_TUI_DIR;
    if (!tuiDirectory) throw new Error('HERMES_TUI_DIR is required for the locked native-TUI live lane');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const provider = await startLoopbackProvider();
    writeHermesConfiguration(home, provider.baseUrl);
    const host = new PtyAgentHost();
    const executable = resolveHermesExecutable();
    const python = resolveHermesPython();
    const environment = isolatedHermesEnvironment(root, home, tuiDirectory, provider.baseUrl);
    let session: Awaited<ReturnType<typeof createHermesTuiSession>> | undefined;
    let projection: ReturnType<typeof projectAgentEvents> | undefined;
    try {
      expect(await probeHermesVersion(executable)).toEqual({ version: '0.20.0', releaseTag: '2026.8.3' });
      session = await createHermesTuiSession({
        cwd,
        host,
        executable,
        python,
        hermesHome: home,
        env: environment,
        promptConfirmationTimeoutMs: 45_000,
      });
      projection = projectAgentEvents(session);
      expect(session.sessionId).toBeTruthy();
      expect(session.liveSessionId()).toBeTruthy();
      expect(session.observationLevel()).toBe('structured');

      const receipt = await session.services.prompt.submit({
        text: `Reply with exactly ${RESPONSE_MARKER} and do not use tools.`,
      });
      expect(receipt, host.output(session.runtimeSessionId)).toMatchObject({ status: 'confirmed' });
      await waitFor(
        () => projection!.envelopes.some(({ event }) => event.type === 'turn:completed'),
        'normalized Hermes turn completion',
      );
      expect(projection.state.lastAssistantMessage).toContain(RESPONSE_MARKER);
      await waitFor(
        () => host.output(session!.runtimeSessionId).includes(RESPONSE_MARKER),
        'the attached Hermes TUI to render the controlled response',
      );
      expect(provider.requests.filter((request) => request.url?.includes('/chat/completions'))).toHaveLength(1);
      const promotionArtifact = process.env.PUPPETEER_LIVE_ARTIFACT ?? executable;
      await attestLiveAdapter({
        vendor: 'hermes',
        artifact: promotionArtifact,
        testId: 'hermes:native-tui-gateway',
      });
    } finally {
      projection?.dispose();
      await session?.dispose();
      await host.dispose();
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 120_000);
});
