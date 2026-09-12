import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { delay, inheritedProcessEnvironment } from './live-harness.js';

export const OPENCODE_LIVE_MODEL = 'puppeteer-opencode-live';
export const OPENCODE_LIVE_RESPONSE_MARKER = 'SURFACE_OPENCODE_TUI_OK';

export interface OpenCodeLiveModelRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly body: unknown;
}

export interface OpenCodeLiveModelProvider {
  readonly baseUrl: string;
  readonly requests: OpenCodeLiveModelRequest[];
  close(): Promise<void>;
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null, usage?: object) {
  return {
    id: 'chatcmpl-puppeteer-opencode-live',
    object: 'chat.completion.chunk',
    created: 1_788_019_200,
    model: OPENCODE_LIVE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/** Deterministic local OpenAI-compatible provider for the native OpenCode TUI. */
export async function startOpenCodeLoopbackProvider(): Promise<OpenCodeLiveModelProvider> {
  const requests: OpenCodeLiveModelRequest[] = [];
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
  if (!address || typeof address === 'string') throw new Error('OpenCode loopback provider did not bind a TCP port');
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

export function openCodeLiveProviderConfig(baseUrl: string) {
  return {
    formatter: false,
    lsp: false,
    model: `test/${OPENCODE_LIVE_MODEL}`,
    small_model: `test/${OPENCODE_LIVE_MODEL}`,
    provider: {
      test: {
        name: 'Puppeteer Live',
        id: 'test',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [OPENCODE_LIVE_MODEL]: {
            id: OPENCODE_LIVE_MODEL,
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

/** Build isolated OpenCode state without copying user settings or credentials. */
export function isolatedOpenCodeLiveEnvironment(root: string, baseUrl: string): Record<string, string> {
  const temporary = join(root, 'tmp');
  const config = openCodeLiveProviderConfig(baseUrl);
  for (const directory of [
    temporary,
    join(root, 'xdg', 'config'),
    join(root, 'xdg', 'data'),
    join(root, 'xdg', 'state'),
    join(root, 'xdg', 'cache'),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    ...inheritedProcessEnvironment(),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
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
