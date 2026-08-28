import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const CLAUDE_LIVE_MODEL = 'claude-sonnet-4-5-20250929';
export const CLAUDE_LIVE_RESPONSE_MARKER = 'SURFACE_CLAUDE_TUI_OK';
export const CLAUDE_LIVE_AUTH_TOKEN = 'puppeteer-not-a-real-token';

export interface ClaudeLiveModelRequest {
  readonly method?: string;
  readonly url?: string;
  readonly body: unknown;
  readonly kind: 'turn' | 'auxiliary' | 'count-tokens' | 'hello' | 'unsupported';
}

export interface ClaudeLiveModelProvider {
  readonly baseUrl: string;
  readonly requests: ClaudeLiveModelRequest[];
  close(): Promise<void>;
}

function containsText(value: unknown, text: string): boolean {
  return JSON.stringify(value).includes(text);
}

function requestKind(url: string | undefined, body: unknown): ClaudeLiveModelRequest['kind'] {
  if (url === '/api/hello') return 'hello';
  if (url?.startsWith('/v1/messages/count_tokens')) return 'count-tokens';
  if (!url?.startsWith('/v1/messages')) return 'unsupported';
  return containsText(body, CLAUDE_LIVE_RESPONSE_MARKER) ? 'turn' : 'auxiliary';
}

function sendEvent(response: import('node:http').ServerResponse, type: string, data: object): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function streamMessage(
  response: import('node:http').ServerResponse,
  requestNumber: number,
  model: string,
  text: string,
): void {
  const messageId = `msg_puppeteer_claude_${requestNumber}`;
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  sendEvent(response, 'message_start', {
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  sendEvent(response, 'content_block_start', {
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  sendEvent(response, 'content_block_delta', {
    index: 0,
    delta: { type: 'text_delta', text },
  });
  sendEvent(response, 'content_block_stop', { index: 0 });
  sendEvent(response, 'message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  sendEvent(response, 'message_stop', {});
  response.end();
}

/** Build an isolated Claude state root without copying user settings or credentials. */
export function isolatedClaudeLiveEnvironment(
  root: string,
  configDir: string,
  cwd: string,
  baseUrl: string,
): Record<string, string> {
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  writeFileSync(
    join(configDir, '.claude.json'),
    `${JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        [cwd]: {
          hasTrustDialogAccepted: true,
          allowedTools: [],
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: [],
          mcpContextUris: [],
          mcpServers: {},
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    CLAUDE_CONFIG_DIR: configDir,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: CLAUDE_LIVE_AUTH_TOKEN,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: CLAUDE_LIVE_MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_THINKING: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_UPDATES: '1',
  };
}

/** Deterministic local implementation of Claude's streaming Messages API. */
export async function startClaudeLoopbackProvider(): Promise<ClaudeLiveModelProvider> {
  const requests: ClaudeLiveModelRequest[] = [];
  let requestNumber = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Retain malformed input for diagnostics; unsupported input fails closed below.
      }
      const kind = requestKind(request.url, body);
      requests.push({ method: request.method, url: request.url, body, kind });
      if (request.method === 'HEAD' && kind === 'hello') {
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.method !== 'POST' || kind === 'unsupported' || kind === 'hello') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
        return;
      }
      if (kind === 'count-tokens') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 12 }));
        return;
      }

      requestNumber += 1;
      const requestedModel =
        body &&
        typeof body === 'object' &&
        !Array.isArray(body) &&
        typeof (body as { model?: unknown }).model === 'string'
          ? (body as { model: string }).model
          : CLAUDE_LIVE_MODEL;
      streamMessage(
        response,
        requestNumber,
        requestedModel,
        kind === 'turn' ? CLAUDE_LIVE_RESPONSE_MARKER : 'Claude native TUI',
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Claude loopback provider did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
