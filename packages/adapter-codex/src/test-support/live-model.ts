import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const CODEX_LIVE_MODEL = 'puppeteer-codex-live';
export const CODEX_LIVE_RESPONSE_MARKER = 'SURFACE_CODEX_TUI_OK';
export const CODEX_LIVE_API_KEY = 'sk-puppeteer-not-a-real-key';

export interface CodexLiveModelRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly body: unknown;
  readonly kind: 'turn' | 'thread-title';
}

export interface CodexLiveModelProvider {
  readonly baseUrl: string;
  readonly requests: CodexLiveModelRequest[];
  close(): Promise<void>;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function requestKind(body: unknown): CodexLiveModelRequest['kind'] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'turn';
  const text = (body as { text?: unknown }).text;
  if (!text || typeof text !== 'object' || Array.isArray(text)) return 'turn';
  const format = (text as { format?: unknown }).format;
  if (!format || typeof format !== 'object' || Array.isArray(format)) return 'turn';
  return (format as { name?: unknown }).name === 'codex_output_schema' ? 'thread-title' : 'turn';
}

/** Write a credential-free profile that can reach only the loopback Responses endpoint. */
export function writeCodexLiveConfiguration(home: string, cwd: string, baseUrl: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'auth.json'), `${JSON.stringify({ OPENAI_API_KEY: CODEX_LIVE_API_KEY })}\n`, 'utf8');
  writeFileSync(
    join(home, 'config.toml'),
    [
      `model = ${tomlString(CODEX_LIVE_MODEL)}`,
      'model_provider = "puppeteer"',
      '',
      '[model_providers.puppeteer]',
      'name = "Puppeteer loopback"',
      `base_url = ${tomlString(`${baseUrl}/v1`)}`,
      'wire_api = "responses"',
      'env_key = "FAKE_KEY"',
      '',
      `[projects.${tomlString(cwd)}]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * The Codex and OpenAI variables {@link isolatedCodexLiveEnvironment} sets, so that a caller's own values
 * never reach the codex it spawns. 0.164.0 keeps its state, thread-history and log databases under
 * `CODEX_SQLITE_HOME` when that is set, so it is pinned to the profile's CODEX_HOME with everything else.
 */
export const CODEX_LIVE_PINNED_VARIABLES: readonly string[] = [
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

export function isolatedCodexLiveEnvironment(root: string, home: string): Record<string, string> {
  const isolatedHome = join(root, 'home');
  const isolatedTmp = join(root, 'tmp');
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(isolatedTmp, { recursive: true });
  return {
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home,
    FAKE_KEY: CODEX_LIVE_API_KEY,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
  };
}

/** Deterministic local implementation of the one Responses API turn this proof needs. */
export async function startCodexLoopbackProvider(): Promise<CodexLiveModelProvider> {
  const requests: CodexLiveModelRequest[] = [];
  let turn = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Retain malformed input for diagnostics; the route still fails closed below.
      }
      const kind = requestKind(body);
      requests.push({ method: request.method, url: request.url, body, kind });
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/responses')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'unsupported loopback route' } }));
        return;
      }

      turn += 1;
      const text =
        kind === 'thread-title' ? JSON.stringify({ title: 'Verify Codex native TUI' }) : CODEX_LIVE_RESPONSE_MARKER;
      const item = {
        type: 'message',
        role: 'assistant',
        id: `msg_puppeteer_${turn}`,
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
      const send = (type: string, data: Record<string, unknown>): void => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      };
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      send('response.created', { response: { id: `resp_puppeteer_${turn}`, output: [] } });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', {
        response: {
          id: `resp_puppeteer_${turn}`,
          status: 'completed',
          usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
          output: [item],
        },
      });
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Codex loopback provider did not bind a TCP port');
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
