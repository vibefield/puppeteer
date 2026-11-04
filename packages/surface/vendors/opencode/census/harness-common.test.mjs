import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLoopbackFetch,
  isolatedEnvironment,
  probeVersion,
  providerErrorResponse,
  sseJsonStream,
  startProvider,
  startServerProcess,
  textResponse,
  toolResponse,
} from './harness-common.mjs';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function sseRecords(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: ') && !block.includes('[DONE]'))
    .map((block) => JSON.parse(block.slice('data: '.length)));
}

describe('isolated environment', () => {
  it('is exactly the variable set the 1.x census was captured with', () => {
    const environment = isolatedEnvironment('/r', { model: 'test/test-model' }, 'pw');
    expect(Object.keys(environment)).toEqual([
      'PATH',
      'SHELL',
      'LANG',
      'LC_ALL',
      'TERM',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_CACHE_HOME',
      'OPENCODE_TEST_HOME',
      'OPENCODE_CONFIG_DIR',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_AUTH_CONTENT',
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_SERVER_USERNAME',
      'OPENCODE_DISABLE_PROJECT_CONFIG',
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_AUTOCOMPACT',
      'OPENCODE_DISABLE_MODELS_FETCH',
      'OPENCODE_DISABLE_DEFAULT_PLUGINS',
      'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      'OPENCODE_DISABLE_LSP_DOWNLOAD',
      'OPENCODE_DISABLE_CLAUDE_CODE',
      'OPENCODE_PURE',
    ]);
    expect(environment.XDG_DATA_HOME).toBe('/r/xdg/data');
    expect(environment.OPENCODE_SERVER_PASSWORD).toBe('pw');
    const options = isolatedEnvironment('/r', {}, 'pw', { allowAutoCompact: true, allowBackgroundSubagents: true });
    expect(options.OPENCODE_DISABLE_AUTOCOMPACT).toBeUndefined();
    expect(options.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe('true');
  });
});

describe('fake provider', () => {
  it('serves models, scripted streams, scripted errors and a 404, and records every request', async () => {
    const provider = await startProvider(
      {
        responses: [
          () => textResponse(1, 'first'),
          ({ turn }) => toolResponse(turn, 'bash', { command: 'true' }),
          () => providerErrorResponse(429, 'slow down', { 'retry-after': '0' }),
        ],
      },
      {},
    );
    cleanups.push(provider.close);
    const models = await (await fetch(`${provider.baseURL}/models`)).json();
    expect(models.data[0].id).toBe('test-model');

    const chat = (body) =>
      fetch(`${provider.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const first = await chat({ messages: [] });
    expect(first.headers.get('content-type')).toBe('text/event-stream');
    const text = await first.text();
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(
      sseRecords(text)
        .map((chunk) => chunk.choices[0].delta.content)
        .filter(Boolean),
    ).toEqual(['first']);
    const tool = sseRecords(await (await chat({})).text());
    expect(tool.at(-1).choices[0].finish_reason).toBe('tool_calls');
    const limited = await chat({});
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('0');
    expect((await limited.json()).error.type).toBe('rate_limit_error');
    // Past the script, every turn is a plain text response.
    expect(sseRecords(await (await chat({})).text()).length).toBe(4);
    expect((await fetch(`${provider.baseURL}/elsewhere`)).status).toBe(404);
    expect(provider.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /v1/models',
      'POST /v1/chat/completions',
      'POST /v1/chat/completions',
      'POST /v1/chat/completions',
      'POST /v1/chat/completions',
      'GET /v1/elsewhere',
    ]);
  });

  it('holds a gated stream until the harness releases the gate', async () => {
    const provider = await startProvider(
      { responses: [() => ({ chunks: textResponse(1, 'gated'), pauseAfterChunk: { 1: { gate: 'go' } } })] },
      {},
    );
    cleanups.push(provider.close);
    const response = await fetch(`${provider.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
    const reader = response.body.getReader();
    let seen = '';
    while (!seen.includes('controlled reasoning')) seen += new TextDecoder().decode((await reader.read()).value);
    expect(seen).not.toContain('gated');
    provider.release('go');
    let rest = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toContain('gated');
    expect(rest.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});

describe('loopback fetch', () => {
  it('sends non-idempotent requests once on their own connection and keeps null-body statuses null', async () => {
    const seen = [];
    const origin = await listen((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        seen.push({ method: request.method, body, connection: request.headers.connection });
        response.writeHead(request.method === 'DELETE' ? 204 : 200, { 'content-type': 'application/json' });
        response.end(request.method === 'DELETE' ? undefined : JSON.stringify({ ok: true }));
      });
    });
    const loopbackFetch = createLoopbackFetch((path) => ({ route: path }));
    const posted = await loopbackFetch(new URL('/x', origin), { method: 'POST', body: '{"a":1}' });
    expect(await posted.json()).toEqual({ ok: true });
    const deleted = await loopbackFetch(new URL('/x', origin), { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeNull();
    const got = await loopbackFetch(new URL('/x', origin));
    expect(got.status).toBe(200);
    expect(seen.map((request) => [request.method, request.body])).toEqual([
      ['POST', '{"a":1}'],
      ['DELETE', ''],
      ['GET', ''],
    ]);
    expect(seen[0].connection).toBe('close');
  });
});

describe('SSE JSON stream', () => {
  it('reads data records across heartbeats and split chunks, and fails waiters once the stream ends', async () => {
    const origin = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': heartbeat\n\n');
      response.write('data: {"type":"server.connected"}\r\n\r\ndata: {"type":');
      setTimeout(() => {
        response.write('"one",\ndata: "n":1}\n\n');
        response.end('data: {"type":"two"}\n\n');
      }, 20);
    });
    const stream = sseJsonStream((signal) => fetch(`${origin}/event`, { signal }), {
      request: 'GET /event',
      ended: 'stream ended',
      waitLabel: 'record',
    });
    cleanups.push(stream.close);
    expect(await stream.waitFor((event) => event.type === 'two')).toEqual({ type: 'two' });
    expect(stream.events).toEqual([{ type: 'server.connected' }, { type: 'one', n: 1 }, { type: 'two' }]);
    expect(await stream.waitFor((event) => event.type === 'one', { after: 1 })).toEqual({ type: 'one', n: 1 });
    await expect(stream.waitFor((event) => event.type === 'one', { after: 2 })).rejects.toThrow('stream ended');
  });

  it('names the subscription request when it is refused', async () => {
    const origin = await listen((request, response) => {
      response.writeHead(401);
      response.end();
    });
    const stream = sseJsonStream((signal) => fetch(origin, { signal }), {
      request: 'GET /api/event',
      ended: 'stream ended',
      waitLabel: 'record',
    });
    cleanups.push(stream.close);
    await expect(stream.waitFor(() => true)).rejects.toThrow('GET /api/event failed with 401');
  });

  it('times out a waiter with its label', async () => {
    const origin = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': heartbeat\n\n');
    });
    const stream = sseJsonStream((signal) => fetch(origin, { signal }), {
      request: 'GET /event',
      ended: 'stream ended',
      waitLabel: 'record',
    });
    cleanups.push(stream.close);
    await expect(stream.waitFor(() => true, { timeoutMs: 50 })).rejects.toThrow('timed out waiting for record');
  });
});

describe('server process and version probe', () => {
  it('resolves the origin the ready line announces, and stops the process', async () => {
    const script = "console.log('ready at http://127.0.0.1:1234'); setInterval(() => {}, 1000);";
    const server = await startServerProcess(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
      ready: /ready at (http:\/\/[^\s]+)/,
      name: 'Probe',
    });
    expect(server.baseURL).toBe('http://127.0.0.1:1234');
    await server.stop();
    expect(server.child.exitCode !== null || server.child.signalCode !== null).toBe(true);
    expect(server.logs()).toContain('ready at');
  });

  it('reports a process that exits before readiness under its name', async () => {
    await expect(
      startServerProcess(process.execPath, ['-e', 'process.exit(3)'], {
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH },
        ready: /never (\S+)/,
        name: 'Probe',
      }),
    ).rejects.toThrow('Probe exited before readiness (code=3, signal=null)');
  });

  it('captures the version with a line-specific pattern and refuses an unrecognized output', () => {
    const environment = { PATH: process.env.PATH };
    expect(probeVersion(process.execPath, environment, /^v(\d+\.\d+\.\d+)$/)).toBe(process.versions.node);
    expect(() => probeVersion(process.execPath, environment)).toThrow('unrecognized OpenCode version output');
  });
});
