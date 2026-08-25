#!/usr/bin/env node
/**
 * Drive the pinned Hermes tui_gateway over stdio with an isolated HERMES_HOME
 * and a loopback OpenAI-compatible provider. Records JSON-RPC frames, provider
 * requests, plugin-hook dumps, and outbound webhook bodies under captures-raw/.
 *
 * usage:
 *   node turn-census.mjs --python <venv/bin/python> --checkout <tag-checkout> [--scenario basic-turn]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './harness.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapperPath = join(dirname(fileURLToPath(import.meta.url)), 'tui-gateway-census.py');
const pluginSource = join(dirname(fileURLToPath(import.meta.url)), 'plugin-hooks');

export const SCENARIOS = {
  'basic-turn': {
    prompt: 'Reply with exactly SURFACE_HERMES_OK and do not use tools.',
    responses: [
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_' } },
        { delta: { content: 'HERMES_OK' } },
        { delta: {}, finishReason: 'stop', usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 } },
      ],
    ],
    waitFor: ['message.complete'],
  },
  'tool-success': {
    prompt: 'Use the terminal tool once to print SURFACE_HERMES_TOOL, then confirm.',
    responses: [
      [
        { delta: { role: 'assistant' } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_census_terminal',
                type: 'function',
                function: { name: 'terminal', arguments: '{"command":"printf SURFACE_HERMES_TOOL"}' },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
      ],
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_HERMES_TOOL_DONE' } },
        { delta: {}, finishReason: 'stop', usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
      ],
    ],
    waitFor: ['tool.start', 'message.complete'],
  },
  'permission-deny': {
    prompt: 'Use the terminal tool to run rm -rf /tmp/puppeteer-hermes-census-scratch.',
    responses: [
      [
        { delta: { role: 'assistant' } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_census_rm',
                type: 'function',
                function: { name: 'terminal', arguments: '{"command":"rm -rf /tmp/puppeteer-hermes-census-scratch"}' },
              },
            ],
          },
          finishReason: 'tool_calls',
        },
      ],
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_HERMES_DENIED' } },
        { delta: {}, finishReason: 'stop' },
      ],
    ],
    onEvent: { 'approval.request': { method: 'approval.respond', params: { choice: 'deny' } } },
    waitFor: ['approval.request', 'message.complete'],
  },
  interrupt: {
    prompt: 'Start a long reply so the census can interrupt it.',
    responses: [
      {
        delayMs: 400,
        chunks: [
          { delta: { role: 'assistant' } },
          { delta: { content: 'SURFACE_HERMES_PARTIAL ' } },
          { delayMs: 2500, delta: { content: 'SHOULD_NOT_FINISH' } },
          { delta: {}, finishReason: 'stop' },
        ],
      },
    ],
    interruptAfter: 'message.delta',
    waitFor: ['message.delta', 'message.complete'],
  },
  'resume-turn': {
    prompt: 'Reply with exactly SURFACE_HERMES_RESUME and do not use tools.',
    resumeAfter: 'basic-turn',
    responses: [
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_HERMES_RESUME' } },
        { delta: {}, finishReason: 'stop', usage: { prompt_tokens: 28, completion_tokens: 6, total_tokens: 34 } },
      ],
    ],
    waitFor: ['message.complete'],
  },
};

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function openAiChunk(responseIndex, chunkIndex, chunk) {
  return {
    id: `chatcmpl-puppeteer-hermes-${responseIndex + 1}`,
    object: 'chat.completion.chunk',
    created: 1_786_339_200 + responseIndex,
    model: 'puppeteer-hermes-census',
    choices: [
      {
        index: 0,
        delta: chunk.delta ?? {},
        finish_reason: chunk.finishReason ?? null,
      },
    ],
    ...(chunk.usage ? { usage: chunk.usage } : {}),
  };
}

function isChatCompletion(request) {
  return request.method === 'POST' && String(request.url ?? '').includes('chat/completions');
}

async function startFakeProvider(scenario) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = body;
      }
      requests.push({ method: request.method, url: request.url, body: parsed });
      if (request.method === 'GET' && /\/(v1\/)?models(\/|$)/.test(String(request.url ?? ''))) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'puppeteer-hermes-census', object: 'model', owned_by: 'puppeteer' }],
          }),
        );
        return;
      }
      if (!isChatCompletion({ method: request.method, url: request.url })) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const spec = scenario.responses[requests.filter(isChatCompletion).length - 1];
      if (!spec) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'unexpected extra model request' } }));
        return;
      }
      const chunks = Array.isArray(spec) ? spec : spec.chunks;
      if (!Array.isArray(spec) && spec.delayMs) {
        await sleep(spec.delayMs);
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.delayMs) await sleep(chunk.delayMs);
        response.write(`data: ${JSON.stringify(openAiChunk(0, index, chunk))}\n\n`);
        await sleep(20);
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

async function startWebhookCollector() {
  const deliveries = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let parsed = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        // keep raw
      }
      deliveries.push({
        method: request.method,
        url: request.url,
        headers: {
          'x-hermes-event': request.headers['x-hermes-event'] ?? null,
          'x-hermes-delivery': request.headers['x-hermes-delivery'] ?? null,
        },
        body: parsed,
      });
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    deliveries,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

function writeHome(home, { providerUrl, webhookUrl, workspace }) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, 'config.yaml'),
    [
      'model:',
      '  default: puppeteer-hermes-census',
      '  provider: custom',
      `  base_url: ${JSON.stringify(providerUrl)}`,
      '  api_key: census-placeholder',
      'approvals:',
      '  mode: manual',
      '  timeout: 20',
      'platform_toolsets:',
      '  tui: [terminal]',
      '  cli: [terminal]',
      'terminal:',
      '  backend: local',
      'display:',
      '  interface: cli',
      '  interim_assistant_messages: false',
      'plugins:',
      '  enabled: [census-hooks]',
      'hooks:',
      '  outbound:',
      '    - name: census',
      `      url: ${JSON.stringify(webhookUrl)}`,
      '      events: [on_session_start, on_session_end, on_session_finalize, pre_tool_call, post_tool_call, pre_llm_call, post_llm_call, pre_api_request, post_api_request, pre_approval_request, post_approval_response]',
      '      timeout: 5',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(join(home, '.env'), `OPENAI_API_KEY=census-placeholder\nOPENAI_BASE_URL=${providerUrl}\n`, {
    mode: 0o600,
  });
  mkdirSync(join(home, 'plugins'), { recursive: true });
  cpSync(pluginSource, join(home, 'plugins', 'census-hooks'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
}

function createGateway({ python, checkout, home, workspace, logPath, hookLog }) {
  const child = spawn(python, [wrapperPath], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      HERMES_HOME: home,
      HERMES_PYTHON_SRC_ROOT: checkout,
      PYTHONPATH: checkout,
      HERMES_ACCEPT_HOOKS: '1',
      OPENAI_API_KEY: 'census-placeholder',
      PUPPETEER_HERMES_HOOK_LOG: hookLog,
      TERM: 'dumb',
      LANG: 'C',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  const waiters = [];
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      appendFileSync(logPath, `malformed ${line}\n`);
      return;
    }
    frames.push(frame);
    if (frame.id != null && pending.has(String(frame.id))) {
      const settle = pending.get(String(frame.id));
      pending.delete(String(frame.id));
      if (frame.error) settle.reject(new Error(JSON.stringify(frame.error)));
      else settle.resolve(frame.result);
    }
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  child.stderr.on('data', (chunk) => appendFileSync(logPath, chunk));
  return {
    frames,
    request(method, params = {}) {
      const id = String(nextId++);
      const payload = { jsonrpc: '2.0', id, method, params };
      frames.push({ direction: 'client', ...payload });
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rejectRequest(new Error(`rpc timeout: ${method}`));
          }
        }, 60_000);
      });
    },
    waitFor(predicate, timeoutMs = 60_000) {
      const existing = frames.find((frame) => predicate(frame));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveWait, rejectWait) => {
        const waiter = { match: predicate, resolve: resolveWait };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectWait(new Error('event wait timed out'));
        }, timeoutMs);
      });
    },
    close() {
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      child.kill('SIGTERM');
    },
  };
}

function eventType(frame) {
  return frame?.method === 'event' ? frame.params?.type : undefined;
}

function dumpScenario(rawRoot, { gateway, provider, webhooks, sessionId, storedSessionId, error }) {
  writeFileSync(join(rawRoot, 'rpc.jsonl'), `${gateway.frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`);
  writeFileSync(
    join(rawRoot, 'provider-requests.jsonl'),
    `${provider.requests.map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
  writeFileSync(
    join(rawRoot, 'webhooks.jsonl'),
    `${webhooks.deliveries.map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
  writeFileSync(
    join(rawRoot, 'session.json'),
    `${JSON.stringify({ sessionId, storedSessionId, homeRedacted: true, error: error ? String(error) : undefined }, null, 2)}\n`,
  );
}

export async function runScenario({ name, python, checkout, outputRoot, previous }) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const rawRoot = join(outputRoot, name);
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  const provider = await startFakeProvider(scenario);
  const webhooks = await startWebhookCollector();
  const reused = scenario.resumeAfter ? previous?.[scenario.resumeAfter] : undefined;
  const home = reused?.home ?? mkdtempSync(join(tmpdir(), `puppeteer-hermes-census-${name}-`));
  const workspace = join(home, 'workspace');
  writeHome(home, { providerUrl: provider.baseUrl, webhookUrl: webhooks.url, workspace });
  const gateway = createGateway({
    python,
    checkout,
    home,
    workspace,
    logPath: join(rawRoot, 'gateway.stderr.log'),
    hookLog: join(rawRoot, 'plugin-hooks.jsonl'),
  });
  let sessionId;
  let storedSessionId;
  try {
    await gateway.waitFor((frame) => eventType(frame) === 'gateway.ready', 20_000);
    let session;
    if (scenario.resumeAfter) {
      if (!reused?.storedSessionId) throw new Error(`resume-turn needs a completed ${scenario.resumeAfter}`);
      session = await gateway.request('session.resume', {
        session_id: reused.storedSessionId,
        cwd: workspace,
      });
    } else {
      session = await gateway.request('session.create', { cwd: workspace, source: 'tui' });
    }
    sessionId = session.session_id;
    storedSessionId = session.stored_session_id ?? session.resumed ?? session.session_key ?? session.session_id;
    await gateway
      .waitFor((frame) => eventType(frame) === 'session.info' && frame.params?.session_id === sessionId, 30_000)
      .catch(() => undefined);
    const submit = gateway.request('prompt.submit', { session_id: sessionId, text: scenario.prompt });
    if (scenario.interruptAfter) {
      await gateway.waitFor((frame) => eventType(frame) === scenario.interruptAfter, 20_000);
      await gateway.request('session.interrupt', { session_id: sessionId });
    }
    if (scenario.onEvent) {
      for (const [type, followUp] of Object.entries(scenario.onEvent)) {
        const frame = await gateway.waitFor((candidate) => eventType(candidate) === type, 25_000);
        await gateway.request(followUp.method, { session_id: sessionId, ...followUp.params });
        appendFileSync(
          join(rawRoot, 'follow-ups.jsonl'),
          `${JSON.stringify({ type, frame: frame.params, followUp })}\n`,
        );
      }
    }
    for (const type of scenario.waitFor) {
      await gateway.waitFor((frame) => eventType(frame) === type, 50_000);
    }
    await submit.catch(() => undefined);
    await sleep(1_500);
    dumpScenario(rawRoot, { gateway, provider, webhooks, sessionId, storedSessionId });
    return { sessionId, storedSessionId, home };
  } catch (error) {
    dumpScenario(rawRoot, { gateway, provider, webhooks, sessionId, storedSessionId, error });
    throw error;
  } finally {
    gateway.close();
    await provider.close();
    await webhooks.close();
  }
}

async function main() {
  const python = resolve(flag('--python'));
  const checkout = resolve(flag('--checkout'));
  const only = flag('--scenario');
  const outputRoot = resolve(flag('--output', join(vendorRoot, 'captures-raw', `hermes@${VERSION}`)));
  const names = only ? [only] : ['basic-turn', 'tool-success', 'permission-deny', 'interrupt', 'resume-turn'];
  const previous = {};
  for (const name of names) {
    console.log(`running ${name}`);
    previous[name] = await runScenario({ name, python, checkout, outputRoot, previous });
    console.log(`  session ${previous[name].storedSessionId}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
