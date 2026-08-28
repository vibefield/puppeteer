import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { delay, inheritedProcessEnvironment } from './live-harness.js';

export const KIMI_LIVE_MODEL = 'puppeteer-kimi-live';
export const KIMI_LIVE_RESPONSE_MARKER = 'SURFACE_KIMI_TUI_OK';

export interface KimiLiveModelProvider {
  readonly baseUrl: string;
  readonly requests: unknown[];
  close(): Promise<void>;
}

function openAiChunk(index: number, delta: Record<string, unknown>, finishReason: string | null, usage?: object) {
  return {
    id: 'chatcmpl-puppeteer-kimi-live',
    object: 'chat.completion.chunk',
    created: 1_788_019_200,
    model: KIMI_LIVE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
    system_fingerprint: `kimi-live-${index}`,
  };
}

/** Deterministic local OpenAI-compatible provider for the native Kimi TUI. */
export async function startKimiLoopbackProvider(): Promise<KimiLiveModelProvider> {
  const requests: unknown[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString('utf8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Preserve invalid input for the assertion instead of hiding it.
      }
      requests.push({ method: request.method, url: request.url, body });
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
      for (const chunk of [
        openAiChunk(0, { role: 'assistant' }, null),
        openAiChunk(1, { reasoning_content: 'Returning the requested controlled marker. ' }, null),
        openAiChunk(2, { content: 'SURFACE_KIMI_' }, null),
        openAiChunk(3, { content: 'TUI_OK' }, null),
        openAiChunk(4, {}, 'stop', { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 }),
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
  if (!address || typeof address === 'string') throw new Error('Kimi loopback provider did not bind a TCP port');
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

/** Build isolated Kimi state without copying user settings or credentials. */
export function isolatedKimiLiveEnvironment(root: string, kimiHome: string, baseUrl: string): Record<string, string> {
  mkdirSync(join(root, 'xdg-config'), { recursive: true });
  mkdirSync(join(root, 'xdg-cache'), { recursive: true });
  mkdirSync(join(root, 'xdg-data'), { recursive: true });
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
    KIMI_MODEL_NAME: KIMI_LIVE_MODEL,
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
