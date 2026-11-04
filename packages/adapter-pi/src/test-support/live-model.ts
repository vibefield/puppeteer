import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { delay, inheritedProcessEnvironment } from './live-harness.js';

export const PI_LIVE_MODEL = 'pi-live';
export const PI_LIVE_RESPONSE_MARKER = 'SURFACE_PI_TUI_OK';

export async function startPiLoopbackProvider() {
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
        [{ content: 'SURFACE_PI_' }, null],
        [{ content: 'TUI_OK' }, null],
        [{}, 'stop'],
      ] as const) {
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-pi-live', object: 'chat.completion.chunk', created: 1_788_019_200, model: PI_LIVE_MODEL, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } } : {}) })}\n\n`,
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
  if (!address || typeof address === 'string') throw new Error('Pi test provider failed to bind');
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

export function isolatedPiLiveEnvironment(root: string, agentDir: string, baseUrl: string): Record<string, string> {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl,
          api: 'openai-completions',
          apiKey: 'not-a-real-key',
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
          models: [
            {
              id: PI_LIVE_MODEL,
              name: PI_LIVE_MODEL,
              reasoning: false,
              input: ['text'],
              contextWindow: 32768,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ enableInstallTelemetry: false, defaultProjectTrust: 'never', retry: { enabled: false } }),
  );
  return {
    ...inheritedProcessEnvironment(),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}
