/**
 * Shared, line-neutral pieces of the OpenCode census harnesses.
 *
 * Everything here was proven by the 1.x census and is reused unchanged by it:
 * small file/flag/timer utilities, the isolated environment, the hermetic fake
 * OpenAI-compatible provider, the controlled git workspace, Basic auth and the
 * loopback fetch policy, a server-process launcher with a readiness pattern,
 * and an SSE JSON-record reader. What differs between release lines (the
 * serve flags and ready line, the route grammar a trace records, the event
 * envelope, the scenarios) stays in each line's harness and is passed in.
 *
 * `isolatedEnvironment` is the 1.x-proven variable set. A harness for another
 * line adjusts the returned object (its password variables, say) rather than
 * changing the set here, so the 1.x census keeps launching exactly as captured.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function jsonLines(records) {
  return records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function outputDirectory(path) {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`refusing to append to an existing raw capture: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function binaryPath(input) {
  return isAbsolute(input) || input.includes('/') ? resolve(input) : input;
}

export function providerConfig(baseURL, limit = { context: 100_000, output: 10_000 }, modelID = 'test-model') {
  return {
    formatter: false,
    lsp: false,
    model: `test/${modelID}`,
    small_model: `test/${modelID}`,
    provider: {
      test: {
        name: 'Surface Census',
        id: 'test',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [modelID]: {
            id: modelID,
            name: 'Surface Census Model',
            attachment: false,
            reasoning: true,
            temperature: false,
            tool_call: true,
            release_date: '2025-01-01',
            limit,
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: 'test-key', baseURL },
      },
    },
  };
}

export function isolatedEnvironment(root, config, password, options = {}) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: process.env.SHELL ?? '/bin/sh',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    XDG_CACHE_HOME: join(root, 'xdg', 'cache'),
    OPENCODE_TEST_HOME: join(root, 'opencode-home'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode-config'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_AUTH_CONTENT: '{}',
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...(options.allowAutoCompact ? {} : { OPENCODE_DISABLE_AUTOCOMPACT: '1' }),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    ...(options.allowBackgroundSubagents ? { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true' } : {}),
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_PURE: '1',
  };
}

export function chatChunk(turn, delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-surface-${turn}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function textResponse(
  turn,
  text = 'surface census complete',
  usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
) {
  return [
    chatChunk(turn, { role: 'assistant' }),
    chatChunk(turn, { reasoning_content: 'controlled reasoning' }),
    chatChunk(turn, { content: text }),
    chatChunk(turn, {}, 'stop', usage),
  ];
}

export function delayedTextResponse(turn, text = 'surface census partial') {
  return {
    chunks: textResponse(turn, text),
    // Hold the stream open after the first text delta so the abort request is
    // guaranteed to race an active provider response rather than a completed
    // turn. Closing the client connection releases this pause immediately.
    pauseAfterChunk: { 2: 30_000 },
  };
}

export function gatedTextResponse(turn, gate, text = 'surface census rehydrated') {
  return {
    chunks: textResponse(turn, text),
    // Unlike a wall-clock pause, a named gate lets the harness prove that the
    // provider completes strictly after the observer disconnects.
    pauseAfterChunk: { 2: { gate } },
  };
}

export const BACKGROUND_CHILD_PROMPT = 'Return the controlled background child result without using tools.';

export function backgroundRoutedResponse(turn, request, gate) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const last = messages.at(-1);
  if (JSON.stringify(last).includes(BACKGROUND_CHILD_PROMPT)) {
    return gatedTextResponse(turn, gate, 'controlled background child result');
  }
  return textResponse(turn, 'controlled parent response around background child');
}

export function providerErrorResponse(status, message, headers = {}) {
  return {
    status,
    headers,
    body: {
      error: {
        message,
        type: status === 429 ? 'rate_limit_error' : 'invalid_request_error',
        code: status === 429 ? 'rate_limit_exceeded' : 'controlled_provider_failure',
      },
    },
  };
}

export function toolResponse(turn, name, input) {
  return [
    chatChunk(turn, { role: 'assistant' }),
    chatChunk(turn, {
      tool_calls: [
        {
          index: 0,
          id: `call_surface_${turn}`,
          type: 'function',
          function: { name, arguments: '' },
        },
      ],
    }),
    chatChunk(turn, {
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }],
    }),
    chatChunk(turn, {}, 'tool_calls', {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    }),
  ];
}

export function responseStillOpen(response) {
  return !response.destroyed && !response.writableEnded;
}

export async function pauseProviderResponse(response, ms) {
  if (!responseStillOpen(response)) return false;
  return new Promise((resolvePause) => {
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off('close', closed);
      resolvePause(open && responseStillOpen(response));
    };
    const closed = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    response.once('close', closed);
  });
}

export async function sendProviderResponse(response, result, waitForGate) {
  if (!Array.isArray(result) && typeof result?.status === 'number') {
    response.writeHead(result.status, {
      'content-type': 'application/json',
      connection: 'close',
      ...result.headers,
    });
    response.end(JSON.stringify(result.body));
    return;
  }

  const plan = Array.isArray(result) ? { chunks: result } : result;
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  });
  for (const [index, chunk] of plan.chunks.entries()) {
    if (!responseStillOpen(response)) return;
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const pause = plan.pauseAfterChunk?.[index];
    if (typeof pause === 'number' && !(await pauseProviderResponse(response, pause))) return;
    if (pause?.gate && !(await waitForGate(pause.gate, response))) return;
  }
  if (responseStillOpen(response)) response.end('data: [DONE]\n\n');
}

export async function startProvider(scenario, context) {
  const requests = [];
  const releasedGates = new Set();
  const gateWaiters = new Map();
  let turn = 0;

  const waitForGate = (name, response) => {
    if (releasedGates.has(name)) return Promise.resolve(responseStillOpen(response));
    return new Promise((resolveGate) => {
      let settled = false;
      const finish = (open) => {
        if (settled) return;
        settled = true;
        response.off('close', closed);
        gateWaiters.get(name)?.delete(released);
        resolveGate(open && responseStillOpen(response));
      };
      const closed = () => finish(false);
      const released = () => finish(true);
      const waiters = gateWaiters.get(name) ?? new Set();
      waiters.add(released);
      gateWaiters.set(name, waiters);
      response.once('close', closed);
    });
  };

  const release = (name) => {
    releasedGates.add(name);
    for (const waiter of gateWaiters.get(name) ?? []) waiter();
    gateWaiters.delete(name);
  };

  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) request.destroy(new Error('provider request exceeded 4 MiB'));
    });
    request.on('end', () => {
      let body;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = { unparsed: raw };
      }
      requests.push({ method: request.method, url: request.url, body });

      if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ object: 'list', data: [{ id: scenario.modelID ?? 'test-model', object: 'model' }] }),
        );
        return;
      }
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'controlled provider route not found' } }));
        return;
      }

      turn += 1;
      const build = scenario.responses[turn - 1] ?? (() => textResponse(turn));
      void sendProviderResponse(response, build({ ...context, request: body, turn }), waitForGate).catch((error) => {
        if (!responseStillOpen(response)) return;
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      });
    });
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake provider did not bind a TCP port');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    release,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((done) => server.close(done));
    },
  };
}

/** The `--version` output's version: the first group of `pattern` (or the whole match) on the trimmed output. */
export function probeVersion(artifact, environment, pattern = /^(\d+\.\d+\.\d+)$/) {
  const result = spawnSync(artifact, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(`OpenCode version probe failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const output = result.stdout.trim();
  const match = pattern.exec(output);
  if (!match) {
    throw new Error(`unrecognized OpenCode version output: ${JSON.stringify(output)}`);
  }
  return match[1] ?? match[0];
}

export function initializeControlledRepository(workspace) {
  const git = (...args) => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=Surface Census',
        '-c',
        'user.email=surface-census@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: workspace, encoding: 'utf8', timeout: 15_000 },
    );
    if (result.status !== 0) {
      throw new Error(`controlled git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
    }
  };
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--no-gpg-sign', '-m', 'controlled census baseline');
}

/**
 * Start a server process and resolve with the origin its stdout announces.
 * `ready` must capture the origin in its first group; stderr is kept for logs.
 */
export async function startServerProcess(artifact, args, { cwd, environment, ready: readyPattern, name = 'OpenCode' }) {
  const child = spawn(artifact, args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBuffer = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const exited = new Promise((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  child.once('error', readyReject);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout.push(chunk);
    stdoutBuffer += chunk;
    const match = readyPattern.exec(stdoutBuffer);
    if (match) readyResolve(match[1]);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('exit', (code, signal) => {
    readyReject(new Error(`${name} exited before readiness (code=${String(code)}, signal=${String(signal)})`));
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(3_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  };
  let baseURL;
  try {
    baseURL = await withTimeout(ready, 30_000, `${name} server readiness`);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    child,
    baseURL,
    logs: () => `--- stdout ---\n${stdout.join('')}\n--- stderr ---\n${stderr.join('')}`,
    stop,
  };
}

export function authHeader(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

export const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);
export const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** One request on a connection of its own (`agent: false`), closed after the response and never retried. */
export function freshConnectionFetch(url, { method, headers = {}, body, signal }) {
  const payload = body === undefined ? undefined : Buffer.from(body);
  return new Promise((resolveResponse, reject) => {
    const outgoing = httpRequest(
      url,
      {
        method,
        headers: { ...headers, ...(payload ? { 'content-length': String(payload.byteLength) } : {}) },
        agent: false,
        signal,
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const headerList = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of [value].flat()) if (item !== undefined) headerList.append(name, item);
          }
          const status = incoming.statusCode ?? 0;
          const content = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks);
          resolveResponse(new Response(content, { status, headers: headerList }));
        });
      },
    );
    outgoing.on('error', (error) => reject(new TypeError('fetch failed', { cause: error })));
    outgoing.end(payload);
  });
}

/**
 * `serve --port 0` prefers 4096, so a restarted backend usually reappears at
 * the same origin. After an aborted SSE subscription to the stopped backend,
 * Node's per-origin fetch pool can fail the next request with ECONNRESET
 * before the new backend ever sees it.
 *
 * A reset does not prove the backend never received the request, so only
 * GET/HEAD (the SSE subscription, /doc, state reads) are re-sent, and every
 * retried attempt is recorded in the HTTP trace as a `client-transport`
 * record. Every other method goes out once on a connection of its own, which
 * no stale pooled socket can fail; a failure there ends the scenario rather
 * than risk a duplicate prompt, session, or reply in the evidence.
 *
 * `routeCarrier(path)` turns a request path into the `{route, params?, query?}`
 * a line's trace records, so a retry record matches that line's request records.
 */
export function createLoopbackFetch(routeCarrier) {
  return async function loopbackFetch(url, init = {}, evidence = {}) {
    const method = (init.method ?? 'GET').toUpperCase();
    if (!IDEMPOTENT_METHODS.has(method)) return freshConnectionFetch(url, { ...init, method });
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fetch(url, init);
      } catch (error) {
        const code = error?.cause?.code;
        const stale = code === 'ECONNRESET' || code === 'UND_ERR_SOCKET';
        if (!stale || attempt >= 3 || init.signal?.aborted) throw error;
        evidence.trace?.push({
          direction: 'client-transport',
          retry: { method, ...routeCarrier(evidence.path ?? url.pathname), attempt, failure: code },
        });
        await delay(250);
      }
    }
  };
}

/**
 * Read `data:` JSON records from an SSE response, with waiters.
 *
 * `open(signal)` performs the subscription request. Comment frames (heartbeats)
 * and frames without data are skipped; multi-line data is joined with a newline.
 * `waitFor(predicate, {after, timeoutMs, label})` resolves with the first
 * matching record at or after index `after`, and rejects once the stream fails.
 */
export function sseJsonStream(open, { request, ended, waitLabel }) {
  const events = [];
  const waiters = new Set();
  const abort = new AbortController();
  let failure;

  const notify = (event) => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate(event)) {
        waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  };

  const complete = (error) => {
    failure = error ?? failure ?? new Error(ended);
    for (const waiter of waiters) waiter.reject(failure);
    waiters.clear();
  };

  const running = (async () => {
    try {
      const response = await open(abort.signal);
      if (!response.ok || !response.body) {
        throw new Error(`${request} failed with ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const event = JSON.parse(data);
          events.push(event);
          notify(event);
        }
      }
      complete();
    } catch (error) {
      if (abort.signal.aborted) return;
      complete(error);
    }
  })();

  const waitFor = (predicate, options = {}) => {
    const after = options.after ?? 0;
    const existing = events.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (failure) return Promise.reject(failure);
    const pending = new Promise((resolveEvent, rejectEvent) => {
      waiters.add({ predicate, resolve: resolveEvent, reject: rejectEvent });
    });
    return withTimeout(pending, options.timeoutMs ?? 30_000, options.label ?? waitLabel);
  };

  return {
    events,
    waitFor,
    close: async () => {
      abort.abort();
      await running;
    },
  };
}
