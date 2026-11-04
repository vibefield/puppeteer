import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { delay, inheritedProcessEnvironment } from './live-harness.js';

export const COPILOT_LIVE_MODEL = 'copilot-live';
export const COPILOT_LIVE_RESPONSE_MARKER = 'SURFACE_COPILOT_TUI_OK';

export async function startCopilotLoopbackProvider() {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString('utf8');
      requests.push(JSON.parse(raw));
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close',
      });
      for (const [delta, finish_reason] of [
        [{ role: 'assistant' }, null],
        [{ content: 'SURFACE_COPILOT_' }, null],
        [{ content: 'TUI_OK' }, null],
        [{}, 'stop'],
      ] as const) {
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-copilot-live', object: 'chat.completion.chunk', created: 1_788_019_200, model: COPILOT_LIVE_MODEL, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } } : {}) })}\n\n`,
        );
        await delay(15);
      }
      response.end('data: [DONE]\n\n');
    })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Copilot test provider failed to bind');
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

export function isolatedCopilotLiveEnvironment(
  root: string,
  agentDir: string,
  baseUrl: string,
): Record<string, string> {
  mkdirSync(agentDir, { recursive: true });
  return {
    ...inheritedProcessEnvironment(),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    COPILOT_HOME: agentDir,
    COPILOT_CACHE_HOME: join(root, 'cache'),
    COPILOT_PROVIDER_BASE_URL: baseUrl,
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_API_KEY: 'not-a-real-key',
    COPILOT_MODEL: COPILOT_LIVE_MODEL,
    COPILOT_OFFLINE: 'true',
  };
}
