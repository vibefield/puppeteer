import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { delay, inheritedProcessEnvironment } from './live-harness.js';

export const HERMES_LIVE_MODEL = 'puppeteer-hermes-live';
export const HERMES_LIVE_RESPONSE_MARKER = 'SURFACE_HERMES_TUI_OK';

export interface HermesLiveModelRequest {
  readonly method?: string;
  readonly url?: string;
  readonly body: unknown;
}

export interface HermesLiveModelProvider {
  readonly baseUrl: string;
  readonly requests: HermesLiveModelRequest[];
  close(): Promise<void>;
}

function messageContent(body: unknown, role: string): string[] {
  if (!body || typeof body !== 'object') return [];
  const messages = Reflect.get(body, 'messages');
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== 'object' || Reflect.get(message, 'role') !== role) return [];
    const content = Reflect.get(message, 'content');
    return typeof content === 'string' ? [content] : [];
  });
}

function isTitleRequest(body: unknown): boolean {
  return messageContent(body, 'system').some((content) => content.includes('Generate a short, descriptive title'));
}

export function isHermesLiveTurnRequest(request: HermesLiveModelRequest): boolean {
  return (
    request.method === 'POST' &&
    Boolean(request.url?.includes('/chat/completions')) &&
    !isTitleRequest(request.body) &&
    messageContent(request.body, 'user').some((content) => content.includes(HERMES_LIVE_RESPONSE_MARKER))
  );
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null, usage?: object) {
  return {
    id: 'chatcmpl-puppeteer-hermes-live',
    object: 'chat.completion.chunk',
    created: 1_788_019_200,
    model: HERMES_LIVE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/** Deterministic local OpenAI-compatible provider for the native Hermes TUI. */
export async function startHermesLoopbackProvider(): Promise<HermesLiveModelProvider> {
  const requests: HermesLiveModelRequest[] = [];
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
        response.end(JSON.stringify({ object: 'list', data: [{ id: HERMES_LIVE_MODEL, object: 'model' }] }));
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
      const titleRequest = isTitleRequest(body);
      for (const chunk of [
        chatChunk({ role: 'assistant' }, null),
        ...(titleRequest
          ? [chatChunk({ content: 'Hermes Resume Proof' }, null)]
          : [chatChunk({ content: 'SURFACE_HERMES_' }, null), chatChunk({ content: 'TUI_OK' }, null)]),
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
  if (!address || typeof address === 'string') throw new Error('Hermes loopback provider did not bind a TCP port');
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
      `  default: ${HERMES_LIVE_MODEL}`,
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

/** Build isolated Hermes state without copying user settings or credentials. */
export function isolatedHermesLiveEnvironment(
  root: string,
  home: string,
  tuiDirectory: string,
  baseUrl: string,
): Record<string, string> {
  const temporary = join(root, 'tmp');
  mkdirSync(temporary, { recursive: true });
  writeHermesConfiguration(home, baseUrl);
  return {
    ...inheritedProcessEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
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
