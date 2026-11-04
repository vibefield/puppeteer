import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inheritedProcessEnvironment } from './live-harness.js';

export const ANTIGRAVITY_LIVE_MARKER = 'SURFACE_ANTIGRAVITY_TUI_OK';

/** Synthetic Gemini endpoint; the native TUI owns every request and journal write. */
export async function startAntigravityLoopbackProvider() {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const path = request.url ?? '';
    response.setHeader('content-type', 'application/json');
    if (path.includes(':countTokens')) {
      response.end(JSON.stringify({ totalTokens: 27 }));
    } else if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) {
      requests.push(JSON.parse(body));
      const value = {
        candidates: [
          { content: { role: 'model', parts: [{ text: ANTIGRAVITY_LIVE_MARKER }] }, finishReason: 'STOP', index: 0 },
        ],
        usageMetadata: { promptTokenCount: 27, candidatesTokenCount: 7, totalTokenCount: 34 },
        modelVersion: 'gemini-3.1-pro',
      };
      const streamed = path.includes(':streamGenerateContent');
      response.setHeader('content-type', streamed ? 'text/event-stream' : 'application/json');
      response.end(streamed ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value));
    } else if (path.includes('/models')) {
      response.end(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-3.1-pro',
              version: 'mock',
              displayName: 'Gemini 3.1 Pro',
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
          ],
        }),
      );
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback listener has no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

export function isolatedAntigravityLiveEnvironment(
  root: string,
  home: string,
  baseUrl: string,
): Record<string, string> {
  const data = join(home, '.gemini', 'antigravity-cli');
  const temporary = join(root, 'tmp');
  mkdirSync(data, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  // First-run consent is completed in the real native UI with its collection checkbox unchecked.
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ modelProvider: 'gemini', enableTelemetry: false }));
  return {
    ...inheritedProcessEnvironment(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    GEMINI_API_KEY: 'not-a-real-key',
    GOOGLE_GEMINI_BASE_URL: baseUrl,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    AGY_CLI_HIDE_ACCOUNT_INFO: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}
