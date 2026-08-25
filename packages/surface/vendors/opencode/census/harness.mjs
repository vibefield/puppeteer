#!/usr/bin/env node
/**
 * Controlled OpenCode HTTP/SSE census.
 *
 * The harness starts the exact caller-supplied OpenCode binary in `serve`
 * mode, points it at a local fake OpenAI-compatible model, subscribes to the
 * native event stream before creating a session, and records both the live
 * events and durable REST state. It does not read the user's OpenCode config,
 * credentials, plugins, skills, or model account.
 *
 * Raw output is deliberately confined to the gitignored `captures-raw` tree.
 * It is not safe to commit until an OpenCode-specific sanitizer and privacy
 * audit have passed.
 *
 * usage:
 *   node harness.mjs --artifact /path/to/opencode --version 1.18.16
 *   node harness.mjs --scenario permission-accept --output /safe/raw/path
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function withTimeout(promise, ms, label) {
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

function jsonLines(records) {
  return records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function outputDirectory(path) {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`refusing to append to an existing raw capture: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function binaryPath(input) {
  return isAbsolute(input) || input.includes('/') ? resolve(input) : input;
}

function providerConfig(baseURL, limit = { context: 100_000, output: 10_000 }, modelID = 'test-model') {
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

function isolatedEnvironment(root, config, password, options = {}) {
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

function chatChunk(turn, delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-surface-${turn}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function textResponse(
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

function delayedTextResponse(turn, text = 'surface census partial') {
  return {
    chunks: textResponse(turn, text),
    // Hold the stream open after the first text delta so the abort request is
    // guaranteed to race an active provider response rather than a completed
    // turn. Closing the client connection releases this pause immediately.
    pauseAfterChunk: { 2: 30_000 },
  };
}

function gatedTextResponse(turn, gate, text = 'surface census rehydrated') {
  return {
    chunks: textResponse(turn, text),
    // Unlike a wall-clock pause, a named gate lets the harness prove that the
    // provider completes strictly after the observer disconnects.
    pauseAfterChunk: { 2: { gate } },
  };
}

const BACKGROUND_CHILD_PROMPT = 'Return the controlled background child result without using tools.';

function backgroundRoutedResponse(turn, request, gate) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const last = messages.at(-1);
  if (JSON.stringify(last).includes(BACKGROUND_CHILD_PROMPT)) {
    return gatedTextResponse(turn, gate, 'controlled background child result');
  }
  return textResponse(turn, 'controlled parent response around background child');
}

function providerErrorResponse(status, message, headers = {}) {
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

function toolResponse(turn, name, input) {
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

export const SCENARIOS = {
  turn: {
    prompt: 'Reply with the controlled census response.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    responses: [() => textResponse(1, 'hello from the controlled provider')],
  },
  'session-lifecycle': {
    prompt: 'Create the controlled history for session lifecycle operations.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    sessionLifecycle: true,
    responses: [() => textResponse(1, 'controlled history for session lifecycle operations')],
  },
  'file-part': {
    prompt: 'Inspect the controlled text attachment.',
    promptParts: [
      { type: 'text', text: 'Inspect the controlled text attachment.' },
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'surface-census.txt',
        url: 'data:text/plain;base64,Y29udHJvbGxlZCBmaWxlIHBhcnQK',
      },
    ],
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    responses: [() => textResponse(1, 'controlled file-part response')],
  },
  'file-write': {
    prompt: 'Create the controlled census file.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    git: true,
    inspectDiff: true,
    responses: [
      ({ workspace }) =>
        toolResponse(1, 'write', {
          filePath: join(workspace, 'surface-census-write.txt'),
          content: 'controlled write before edit\n',
        }),
      () => textResponse(2, 'controlled file written'),
    ],
  },
  'file-edit': {
    prompt: 'Read and edit the controlled census file.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    git: true,
    inspectDiff: true,
    seedFiles: { 'surface-census-edit.txt': 'controlled text before edit\n' },
    responses: [
      ({ workspace }) =>
        toolResponse(1, 'read', {
          filePath: join(workspace, 'surface-census-edit.txt'),
        }),
      ({ workspace }) =>
        toolResponse(2, 'edit', {
          filePath: join(workspace, 'surface-census-edit.txt'),
          oldString: 'before edit',
          newString: 'after edit',
        }),
      () => textResponse(3, 'controlled file edited'),
    ],
  },
  'file-delete': {
    prompt: 'Delete the controlled census file.',
    modelID: 'gpt-5-surface',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    git: true,
    inspectDiff: true,
    seedFiles: { 'surface-census-delete.txt': 'controlled text before deletion\n' },
    responses: [
      () =>
        toolResponse(1, 'apply_patch', {
          patchText: [
            '*** Begin Patch',
            '*** Delete File: surface-census-delete.txt',
            '*** End Patch',
          ].join('\n'),
        }),
      () => textResponse(2, 'controlled file deleted'),
    ],
  },
  'task-child': {
    prompt: 'Launch the controlled foreground child task.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    inspectChildren: true,
    responses: [
      () =>
        toolResponse(1, 'task', {
          description: 'Inspect controlled marker',
          prompt: 'Return the controlled child result without using tools.',
          subagent_type: 'explore',
        }),
      () => textResponse(2, 'controlled child result'),
      () => textResponse(3, 'controlled parent result after child'),
    ],
  },
  'subtask-part': {
    prompt: 'Launch the controlled direct subtask part.',
    promptParts: [
      {
        type: 'subtask',
        prompt: 'Return the controlled direct subtask result without using tools.',
        description: 'Inspect controlled direct subtask',
        agent: 'explore',
        model: { providerID: 'test', modelID: 'test-model' },
      },
    ],
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    inspectChildren: true,
    responses: [
      () => textResponse(1, 'controlled direct subtask result'),
      () => textResponse(2, 'controlled parent result after direct subtask'),
    ],
  },
  'agent-part': {
    prompt: 'Invoke the controlled agent mention.',
    promptParts: [
      { type: 'text', text: 'Use the controlled agent mention.' },
      { type: 'agent', name: 'explore' },
    ],
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    inspectChildren: true,
    responses: [
      () =>
        toolResponse(1, 'task', {
          description: 'Inspect agent mention',
          prompt: 'Return the controlled agent-part child result without using tools.',
          subagent_type: 'explore',
        }),
      () => textResponse(2, 'controlled agent-part child result'),
      () => textResponse(3, 'controlled parent result after agent mention'),
    ],
  },
  'background-task': {
    prompt: 'Launch the controlled task directly in the background.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    allowBackgroundSubagents: true,
    background: { gate: 'background-task-child-complete' },
    inspectChildren: true,
    terminal: (event) => event?.type === 'session.status' && event?.properties?.status?.type === 'idle',
    responses: [
      () =>
        toolResponse(1, 'task', {
          description: 'Inspect background marker',
          prompt: BACKGROUND_CHILD_PROMPT,
          subagent_type: 'explore',
          background: true,
        }),
      ({ request, turn }) => backgroundRoutedResponse(turn, request, 'background-task-child-complete'),
      ({ request, turn }) => backgroundRoutedResponse(turn, request, 'background-task-child-complete'),
      ({ request, turn }) => backgroundRoutedResponse(turn, request, 'background-task-child-complete'),
    ],
  },
  'detach-task': {
    prompt: 'Launch the controlled foreground task, then detach it.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    allowBackgroundSubagents: true,
    detach: {
      label: 'active child text delta before detachment',
      when: (event, parentID) =>
        event?.type === 'message.part.delta' &&
        event?.properties?.sessionID !== parentID &&
        event?.properties?.field === 'text',
    },
    background: { gate: 'detached-task-child-complete' },
    inspectChildren: true,
    terminal: (event) => event?.type === 'session.status' && event?.properties?.status?.type === 'idle',
    responses: [
      () =>
        toolResponse(1, 'task', {
          description: 'Inspect detached marker',
          prompt: BACKGROUND_CHILD_PROMPT,
          subagent_type: 'explore',
        }),
      ({ request, turn }) => backgroundRoutedResponse(turn, request, 'detached-task-child-complete'),
      ({ request, turn }) => backgroundRoutedResponse(turn, request, 'detached-task-child-complete'),
      ({ request, turn }) => backgroundRoutedResponse(turn, request, 'detached-task-child-complete'),
    ],
  },
  'permission-accept': {
    prompt: 'Run the controlled command.',
    permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    blocker: { event: 'permission.asked', path: 'permission', body: { reply: 'once' } },
    responses: [
      () =>
        toolResponse(1, 'bash', {
          command: 'printf surface-census',
          description: 'Print a controlled marker',
        }),
      () => textResponse(2, 'permission accepted'),
    ],
  },
  'permission-reject': {
    prompt: 'Run the controlled command.',
    permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    blocker: { event: 'permission.asked', path: 'permission', body: { reply: 'reject' } },
    responses: [
      () =>
        toolResponse(1, 'bash', {
          command: 'printf surface-census',
          description: 'Print a controlled marker',
        }),
      () => textResponse(2, 'permission rejected'),
    ],
  },
  'question-reply': {
    prompt: 'Ask the controlled question.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    blocker: { event: 'question.asked', path: 'question', body: { answers: [['Blue']] } },
    responses: [
      () =>
        toolResponse(1, 'question', {
          questions: [
            {
              header: 'Color',
              question: 'Choose a controlled color.',
              options: [
                { label: 'Blue', description: 'The controlled answer' },
                { label: 'Green', description: 'The alternate answer' },
              ],
              multiple: false,
            },
          ],
        }),
      () => textResponse(2, 'question answered'),
    ],
  },
  'question-reject': {
    prompt: 'Ask the controlled question.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    blocker: { event: 'question.asked', path: 'question', reject: true },
    responses: [
      () =>
        toolResponse(1, 'question', {
          questions: [
            {
              header: 'Color',
              question: 'Choose a controlled color.',
              options: [{ label: 'Blue', description: 'The controlled answer' }],
              multiple: false,
            },
          ],
        }),
      () => textResponse(2, 'question rejected'),
    ],
  },
  'abort-stream': {
    prompt: 'Begin the controlled streaming response.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    abort: {
      label: 'streaming text delta',
      when: (event) =>
        event?.type === 'message.part.delta' &&
        event?.properties?.field === 'text' &&
        typeof event?.properties?.delta === 'string',
    },
    responses: [() => delayedTextResponse(1)],
  },
  'abort-tool': {
    prompt: 'Run the controlled long-running command.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    abort: {
      label: 'running Bash tool',
      when: (event) => {
        const part = event?.properties?.part;
        return (
          event?.type === 'message.part.updated' &&
          part?.type === 'tool' &&
          part?.tool === 'bash' &&
          part?.state?.status === 'running'
        );
      },
    },
    responses: [
      () =>
        toolResponse(1, 'bash', {
          command: 'sleep 30',
          description: 'Wait for the controlled abort',
        }),
      () => textResponse(2, 'tool unexpectedly completed'),
    ],
  },
  'provider-retry': {
    prompt: 'Recover from the controlled retryable provider failure.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    responses: [
      () => providerErrorResponse(429, 'controlled retryable provider failure', { 'retry-after': '0' }),
      () => textResponse(2, 'provider retry recovered'),
    ],
  },
  'provider-error': {
    prompt: 'Surface the controlled terminal provider failure.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    terminal: (event) => event?.type === 'session.error',
    responses: [() => providerErrorResponse(400, 'controlled terminal provider failure')],
  },
  'reconnect-rehydrate': {
    prompt: 'Complete while the controlled observer is disconnected.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    reconnect: {
      gate: 'complete-after-disconnect',
      label: 'pre-disconnect text delta',
      when: (event) =>
        event?.type === 'message.part.delta' &&
        event?.properties?.field === 'text' &&
        typeof event?.properties?.delta === 'string',
    },
    responses: [() => gatedTextResponse(1, 'complete-after-disconnect')],
  },
  'exact-resume': {
    prompt: 'Complete the first controlled resume turn.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    resume: { prompt: 'Complete the second turn on the exact resumed session.' },
    responses: [() => textResponse(1, 'before backend restart'), () => textResponse(2, 'after backend restart')],
  },
  'attach-exact-resume': {
    prompt: 'Complete the controlled turn before native attach resumes.',
    permission: [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ],
    resume: { prompt: 'Run the command after restart and request native permission.' },
    attachAfterRestart: {
      blocker: 'permission.asked',
      resolution: 'permission.replied',
      expectedReply: 'always',
    },
    responses: [
      () => textResponse(1, 'before backend restart and native attach'),
      () =>
        toolResponse(2, 'bash', {
          command: 'printf surface-census-resumed',
          description: 'Print a controlled marker after native attach resumes',
        }),
      () => textResponse(3, 'native attach resumed after backend restart'),
    ],
  },
  'manual-compaction': {
    prompt: 'Create the controlled history that will be compacted.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    compact: { providerID: 'test', modelID: 'test-model', auto: false },
    responses: [
      () => textResponse(1, 'controlled history before compaction'),
      () => textResponse(2, 'controlled compacted summary'),
    ],
  },
  'auto-compaction': {
    prompt: 'Complete the controlled turn that crosses the declared context threshold.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    allowAutoCompact: true,
    modelLimit: { context: 128, output: 32 },
    responses: [
      () =>
        textResponse(1, 'controlled response before automatic compaction', {
          prompt_tokens: 110,
          completion_tokens: 10,
          total_tokens: 120,
        }),
      () => textResponse(2, 'controlled automatic compaction summary'),
      () => textResponse(3, 'controlled continuation after automatic compaction'),
    ],
  },
  'overflow-compaction': {
    prompt: 'Recover from the controlled provider context overflow.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    allowAutoCompact: true,
    terminal: (event) => event?.type === 'session.status' && event?.properties?.status?.type === 'idle',
    responses: [
      () => providerErrorResponse(413, 'controlled provider context overflow'),
      () => textResponse(2, 'controlled overflow compaction summary'),
      () => textResponse(3, 'controlled continuation after overflow compaction'),
    ],
  },
  'unknown-context': {
    prompt: 'Complete with a model whose context capacity is unknown.',
    permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    allowAutoCompact: true,
    modelLimit: { context: 0, output: 32 },
    responses: [
      () =>
        textResponse(1, 'controlled response with unknown context capacity', {
          prompt_tokens: 1_000_000,
          completion_tokens: 10,
          total_tokens: 1_000_010,
        }),
    ],
  },
  'attach-permission-always': {
    prompt: 'Run the command and request the controlled native permission.',
    permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    attach: {
      blocker: 'permission.asked',
      resolution: 'permission.replied',
      expectedReply: 'always',
    },
    responses: [
      () =>
        toolResponse(1, 'bash', {
          command: 'printf surface-census',
          description: 'Print a controlled marker through attach',
        }),
      () => textResponse(2, 'native permission accepted'),
    ],
  },
};

function responseStillOpen(response) {
  return !response.destroyed && !response.writableEnded;
}

async function pauseProviderResponse(response, ms) {
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

async function sendProviderResponse(response, result, waitForGate) {
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

async function startProvider(scenario, context) {
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

function probeVersion(artifact, environment) {
  const result = spawnSync(artifact, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(`OpenCode version probe failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const version = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`unrecognized OpenCode version output: ${JSON.stringify(version)}`);
  }
  return version;
}

function initializeControlledRepository(workspace) {
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

async function startOpenCode(artifact, cwd, environment) {
  const child = spawn(artifact, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'], {
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
    const match = /opencode server listening on (http:\/\/[^\s]+)/.exec(stdoutBuffer);
    if (match) readyResolve(match[1]);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('exit', (code, signal) => {
    readyReject(new Error(`OpenCode exited before readiness (code=${String(code)}, signal=${String(signal)})`));
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
    baseURL = await withTimeout(ready, 30_000, 'OpenCode server readiness');
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

async function startAttach(artifact, baseURL, cwd, environment, sessionID) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('the attach census requires an interactive TTY');
  }
  const child = spawn(artifact, ['attach', baseURL, '--dir', cwd, '--session', sessionID, '--pure'], {
    cwd,
    env: environment,
    stdio: 'inherit',
  });
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  const exited = new Promise((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  // `attach` has no machine-readable ready signal. Give the alternate-screen UI
  // time to finish connecting before the harness submits the prompt it must show.
  await delay(5_000);
  if (spawnError) throw spawnError;
  if (child.exitCode !== null || child.signalCode !== null) {
    const result = await exited;
    throw new Error(`OpenCode attach exited before interaction (${JSON.stringify(result)})`);
  }
  return {
    child,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, delay(3_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

function authHeader(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

function instanceURL(baseURL, path, directory) {
  const url = new URL(path, baseURL);
  url.searchParams.set('directory', directory);
  return url;
}

function routeCarrier(path) {
  const url = new URL(path, 'https://surface.invalid');
  const params = {};
  const segments = url.pathname.split('/').map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (/^ses_/.test(decoded)) {
      params.sessionID = decoded;
      return ':sessionID';
    }
    if (/^(?:per|que)_/.test(decoded)) {
      params.requestID = decoded;
      return ':requestID';
    }
    return segment;
  });
  const query = Object.fromEntries(url.searchParams);
  return {
    route: segments.join('/'),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
  };
}

async function apiRequest(trace, baseURL, password, directory, method, path, body) {
  const response = await fetch(instanceURL(baseURL, path, directory), {
    method,
    headers: {
      authorization: authHeader(password),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  trace.push({
    direction: 'client-to-agent',
    // `route` is intentionally not named `path`: the shared privacy engine
    // correctly treats a generic `path` field as a filesystem path. API routes
    // are public protocol structure and must survive sanitization.
    request: { method, ...routeCarrier(path), ...(body === undefined ? {} : { body }) },
  });
  trace.push({
    direction: 'agent-to-client',
    response: {
      method,
      ...routeCarrier(path),
      status: response.status,
      ...(data === undefined ? {} : { body: data }),
    },
  });
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  return data;
}

async function submitPrompt(trace, baseURL, password, directory, sessionID, prompt, parts, modelID = 'test-model') {
  const messageID = `msg_surface_${randomUUID().replaceAll('-', '')}`;
  await apiRequest(
    trace,
    baseURL,
    password,
    directory,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/prompt_async`,
    {
      messageID,
      model: { providerID: 'test', modelID },
      agent: 'build',
      parts: parts ?? [{ type: 'text', text: prompt }],
    },
  );
  return messageID;
}

function terminalSessionEvent(event, scenario, sessionID) {
  return (
    sessionEvent(event, sessionID) &&
    (scenario.terminal?.(event) ??
      (event?.type === 'session.idle' ||
        (event?.type === 'session.status' && event?.properties?.status?.type === 'idle') ||
        event?.type === 'session.error'))
  );
}

async function waitForDurableIdle(trace, baseURL, password, directory, sessionID) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const statuses = await apiRequest(trace, baseURL, password, directory, 'GET', '/session/status');
    const status = statuses?.[sessionID];
    if (!status || status.type === 'idle') return statuses;
    await delay(25);
  }
  throw new Error(`timed out waiting for durable idle status for ${sessionID}`);
}

async function fetchOpenApi(baseURL, password) {
  const response = await fetch(new URL('/doc', baseURL), {
    headers: { authorization: authHeader(password) },
  });
  if (!response.ok) throw new Error(`GET /doc failed with ${response.status}`);
  return response.json();
}

function eventStream(baseURL, password, directory) {
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
    failure = error ?? failure ?? new Error('OpenCode event stream ended');
    for (const waiter of waiters) waiter.reject(failure);
    waiters.clear();
  };

  const running = (async () => {
    try {
      const response = await fetch(instanceURL(baseURL, '/event', directory), {
        headers: { accept: 'text/event-stream', authorization: authHeader(password) },
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`GET /event failed with ${response.status}`);
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
    return withTimeout(pending, options.timeoutMs ?? 30_000, options.label ?? 'OpenCode event');
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

function sessionEvent(event, sessionID) {
  const properties = event?.properties;
  return (
    properties?.sessionID === sessionID ||
    properties?.info?.id === sessionID ||
    properties?.part?.sessionID === sessionID
  );
}

async function runScenario(name, options) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name} (have: ${Object.keys(SCENARIOS).join(', ')})`);

  const captureRoot = outputDirectory(options.output);
  const temporary = mkdtempSync(join(tmpdir(), 'puppeteer-opencode-census-'));
  const workspace = join(temporary, 'workspace');
  const password = randomBytes(32).toString('base64url');
  mkdirSync(workspace, { recursive: true });
  for (const path of [
    join(temporary, 'tmp'),
    join(temporary, 'xdg', 'config'),
    join(temporary, 'xdg', 'data'),
    join(temporary, 'xdg', 'state'),
    join(temporary, 'xdg', 'cache'),
    join(temporary, 'opencode-home'),
    join(temporary, 'opencode-config'),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(workspace, 'AGENTS.md'), 'Controlled Surface census workspace. Do not modify files.\n');
  for (const [relativePath, content] of Object.entries(scenario.seedFiles ?? {})) {
    const target = resolve(workspace, relativePath);
    if (target !== workspace && !target.startsWith(`${workspace}/`)) {
      throw new Error(`refusing to seed a file outside the controlled workspace: ${relativePath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
  }
  if (scenario.git) initializeControlledRepository(workspace);

  let provider;
  let opencode;
  let stream;
  let attach;
  const backends = [];
  const streamSegments = [];
  const httpTrace = [];
  const capturedEvents = () => streamSegments.flatMap((segment) => segment.stream.events);
  const capturedLogs = () => backends.map((entry) => `=== ${entry.phase} ===\n${entry.backend.logs()}`).join('\n');
  const openEventStream = (phase, baseURL) => {
    const next = eventStream(baseURL, password, workspace);
    streamSegments.push({ phase, stream: next });
    stream = next;
    return next;
  };
  try {
    provider = await startProvider(scenario, { workspace });
    const config = providerConfig(provider.baseURL, scenario.modelLimit, scenario.modelID);
    const environment = isolatedEnvironment(temporary, config, password, scenario);
    const actualVersion = probeVersion(options.artifact, environment);
    if (options.version && actualVersion !== options.version) {
      throw new Error(`expected OpenCode ${options.version}, got ${actualVersion}`);
    }

    opencode = await startOpenCode(options.artifact, workspace, environment);
    backends.push({ phase: 'initial-backend', backend: opencode });
    const openapi = await fetchOpenApi(opencode.baseURL, password);
    const initialStreamPhase = scenario.reconnect
      ? 'before-disconnect'
      : scenario.resume
        ? 'before-restart'
        : 'initial';
    stream = openEventStream(initialStreamPhase, opencode.baseURL);
    await stream.waitFor((event) => event?.type === 'server.connected', {
      label: 'server.connected',
      timeoutMs: 60_000,
    });

    const session = await apiRequest(httpTrace, opencode.baseURL, password, workspace, 'POST', '/session', {
      title: `Surface census: ${name}`,
      model: { id: scenario.modelID ?? 'test-model', providerID: 'test' },
      permission: scenario.permission,
    });
    const sessionID = session?.id;
    if (typeof sessionID !== 'string') throw new Error('session.create returned no native session id');
    if (scenario.attach) {
      attach = await startAttach(options.artifact, opencode.baseURL, workspace, environment, sessionID);
    }
    const startIndex = stream.events.length;
    const submittedMessageID = await submitPrompt(
      httpTrace,
      opencode.baseURL,
      password,
      workspace,
      sessionID,
      scenario.prompt,
      scenario.promptParts,
      scenario.modelID,
    );

    let terminalAfter = startIndex;
    if (scenario.blocker) {
      const asked = await stream.waitFor(
        (event) => event?.type === scenario.blocker.event && sessionEvent(event, sessionID),
        { after: startIndex, timeoutMs: 90_000, label: scenario.blocker.event },
      );
      const requestID = asked?.properties?.id;
      if (typeof requestID !== 'string') throw new Error(`${scenario.blocker.event} carried no request id`);
      const suffix = scenario.blocker.reject ? 'reject' : 'reply';
      await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'POST',
        `/${scenario.blocker.path}/${encodeURIComponent(requestID)}/${suffix}`,
        scenario.blocker.reject ? undefined : scenario.blocker.body,
      );
    }

    if (scenario.abort) {
      await stream.waitFor((event) => sessionEvent(event, sessionID) && scenario.abort.when(event), {
        after: startIndex,
        timeoutMs: 90_000,
        label: scenario.abort.label,
      });
      terminalAfter = stream.events.length;
      await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'POST',
        `/session/${encodeURIComponent(sessionID)}/abort`,
      );
    }

    if (scenario.attach) {
      const asked = await stream.waitFor(
        (event) => event?.type === scenario.attach.blocker && sessionEvent(event, sessionID),
        { after: startIndex, timeoutMs: 90_000, label: `${scenario.attach.blocker} for native attach` },
      );
      const requestID = asked?.properties?.id;
      if (typeof requestID !== 'string') throw new Error(`${scenario.attach.blocker} carried no request id`);
      const resolutionAfter = stream.events.length;
      console.log(
        `\n[surface-census] Native permission ${requestID} is ready. ` +
          `Choose ${scenario.attach.expectedReply} in the attached OpenCode TUI.`,
      );
      const resolved = await stream.waitFor(
        (event) =>
          event?.type === scenario.attach.resolution &&
          event?.properties?.requestID === requestID &&
          sessionEvent(event, sessionID),
        { after: resolutionAfter, timeoutMs: 180_000, label: scenario.attach.resolution },
      );
      if (resolved?.properties?.reply !== scenario.attach.expectedReply) {
        throw new Error(
          `expected native attach reply ${scenario.attach.expectedReply}, got ${String(resolved?.properties?.reply)}`,
        );
      }
    }

    if (scenario.detach) {
      await stream.waitFor((event) => scenario.detach.when(event, sessionID), {
        after: startIndex,
        timeoutMs: 90_000,
        label: scenario.detach.label,
      });
      const detached = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'POST',
        `/experimental/session/${encodeURIComponent(sessionID)}/background`,
      );
      if (detached !== true) {
        throw new Error(`experimental session background returned ${JSON.stringify(detached)} instead of true`);
      }
      terminalAfter = stream.events.length;
    }

    let terminal;
    let terminalObservation;
    if (scenario.reconnect) {
      await stream.waitFor((event) => sessionEvent(event, sessionID) && scenario.reconnect.when(event), {
        after: startIndex,
        timeoutMs: 90_000,
        label: scenario.reconnect.label,
      });
      await stream.close();
      provider.release(scenario.reconnect.gate);
      await waitForDurableIdle(httpTrace, opencode.baseURL, password, workspace, sessionID);

      stream = openEventStream('after-reconnect', opencode.baseURL);
      await stream.waitFor((event) => event?.type === 'server.connected', {
        label: 'server.connected after reconnect',
        timeoutMs: 60_000,
      });
      terminalObservation = 'durable-rehydration';
      // Give the fresh stream a bounded opportunity to replay session history.
      // The fixture records that it does not; REST provides the durable state.
      await delay(150);
    } else {
      terminal = await stream.waitFor((event) => terminalSessionEvent(event, scenario, sessionID), {
        after: terminalAfter,
        timeoutMs: 90_000,
        label: 'terminal session event',
      });
      terminalObservation = terminal?.type;
      await delay(150);
    }

    if (scenario.background) {
      const backgroundAfter = stream.events.length;
      provider.release(scenario.background.gate);
      await stream.waitFor(
        (event) =>
          event?.type === 'session.idle' &&
          typeof event?.properties?.sessionID === 'string' &&
          event.properties.sessionID !== sessionID,
        { after: backgroundAfter, timeoutMs: 90_000, label: 'background child idle' },
      );
      const injected = await stream.waitFor(
        (event) =>
          event?.type === 'message.part.updated' &&
          event?.properties?.part?.sessionID === sessionID &&
          event?.properties?.part?.type === 'text' &&
          event?.properties?.part?.synthetic === true,
        { after: backgroundAfter, timeoutMs: 90_000, label: 'background result injection' },
      );
      const injectedIndex = stream.events.indexOf(injected);
      terminal = await stream.waitFor((event) => terminalSessionEvent(event, scenario, sessionID), {
        after: injectedIndex + 1,
        timeoutMs: 90_000,
        label: 'post-background parent terminal event',
      });
      terminalObservation = 'background-completed';
      await delay(150);
    }

    let messagesBeforeRestart;
    let messagesAfterRestart;
    if (scenario.resume) {
      messagesBeforeRestart = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(sessionID)}/message`,
      );
      await stream.close();
      await opencode.stop();

      opencode = await startOpenCode(options.artifact, workspace, environment);
      backends.push({ phase: 'resumed-backend', backend: opencode });
      stream = openEventStream('after-restart', opencode.baseURL);
      await stream.waitFor((event) => event?.type === 'server.connected', {
        label: 'server.connected after backend restart',
        timeoutMs: 60_000,
      });

      const resumedSession = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(sessionID)}`,
      );
      if (resumedSession?.id !== sessionID) {
        throw new Error(`backend restart did not recover exact session ${sessionID}`);
      }
      messagesAfterRestart = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(sessionID)}/message`,
      );
      if (scenario.attachAfterRestart) {
        attach = await startAttach(options.artifact, opencode.baseURL, workspace, environment, sessionID);
      }

      const resumeStartIndex = stream.events.length;
      const resumedMessageID = await submitPrompt(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        sessionID,
        scenario.resume.prompt,
      );
      await stream.waitFor(
        (event) =>
          event?.type === 'message.updated' &&
          event?.properties?.info?.role === 'user' &&
          event?.properties?.info?.id === resumedMessageID &&
          sessionEvent(event, sessionID),
        { after: resumeStartIndex, timeoutMs: 90_000, label: 'exact resumed prompt echo' },
      );
      if (scenario.attachAfterRestart) {
        const asked = await stream.waitFor(
          (event) =>
            event?.type === scenario.attachAfterRestart.blocker &&
            sessionEvent(event, sessionID),
          {
            after: resumeStartIndex,
            timeoutMs: 90_000,
            label: `${scenario.attachAfterRestart.blocker} after backend restart`,
          },
        );
        const requestID = asked?.properties?.id;
        if (typeof requestID !== 'string') {
          throw new Error(`${scenario.attachAfterRestart.blocker} carried no request id`);
        }
        const resolutionAfter = stream.events.length;
        console.log(
          `\n[surface-census] Resumed native permission ${requestID} is ready. ` +
            `Choose ${scenario.attachAfterRestart.expectedReply} in the attached OpenCode TUI.`,
        );
        const resolved = await stream.waitFor(
          (event) =>
            event?.type === scenario.attachAfterRestart.resolution &&
            event?.properties?.requestID === requestID &&
            sessionEvent(event, sessionID),
          {
            after: resolutionAfter,
            timeoutMs: 180_000,
            label: `${scenario.attachAfterRestart.resolution} after backend restart`,
          },
        );
        if (resolved?.properties?.reply !== scenario.attachAfterRestart.expectedReply) {
          throw new Error(
            `expected resumed native attach reply ${scenario.attachAfterRestart.expectedReply}, got ${String(resolved?.properties?.reply)}`,
          );
        }
      }
      terminal = await stream.waitFor((event) => terminalSessionEvent(event, scenario, sessionID), {
        after: resumeStartIndex,
        timeoutMs: 90_000,
        label: 'resumed terminal session event',
      });
      terminalObservation = terminal?.type;
      await delay(150);
    }

    if (scenario.compact) {
      const compactAfter = stream.events.length;
      const compactedResult = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'POST',
        `/session/${encodeURIComponent(sessionID)}/summarize`,
        scenario.compact,
      );
      if (compactedResult !== true) {
        throw new Error(`session summarize returned ${JSON.stringify(compactedResult)} instead of true`);
      }
      await stream.waitFor(
        (event) => event?.type === 'session.compacted' && sessionEvent(event, sessionID),
        { after: compactAfter, timeoutMs: 90_000, label: 'session.compacted' },
      );
      terminal = await stream.waitFor((event) => terminalSessionEvent(event, scenario, sessionID), {
        after: compactAfter,
        timeoutMs: 90_000,
        label: 'post-compaction terminal session event',
      });
      terminalObservation = terminal?.type;
      await delay(150);
    }

    if (scenario.sessionLifecycle) {
      const originalMessages = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(sessionID)}/message`,
      );
      const assistant = originalMessages?.find((message) => message?.info?.role === 'assistant');
      if (typeof assistant?.info?.id !== 'string') {
        throw new Error('session lifecycle scenario found no assistant message to fork before');
      }

      const partialForkAfter = stream.events.length;
      const partialFork = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'POST',
        `/session/${encodeURIComponent(sessionID)}/fork`,
        { messageID: assistant.info.id },
      );
      if (typeof partialFork?.id !== 'string' || partialFork.id === sessionID || partialFork.parentID !== undefined) {
        throw new Error(`session fork returned an invalid independent session: ${JSON.stringify(partialFork)}`);
      }
      await stream.waitFor(
        (event) => event?.type === 'session.created' && event?.properties?.sessionID === partialFork.id,
        { after: partialForkAfter, timeoutMs: 90_000, label: 'partial fork session.created' },
      );
      const partialMessages = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(partialFork.id)}/message`,
      );
      if (
        !Array.isArray(partialMessages) ||
        partialMessages.length !== 1 ||
        partialMessages[0]?.info?.role !== 'user' ||
        partialMessages[0]?.info?.sessionID !== partialFork.id ||
        partialMessages[0]?.info?.id === originalMessages[0]?.info?.id
      ) {
        throw new Error(`message-scoped fork did not clone exactly the history before its target: ${JSON.stringify(partialMessages)}`);
      }

      const fullForkAfter = stream.events.length;
      const fullFork = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'POST',
        `/session/${encodeURIComponent(sessionID)}/fork`,
      );
      if (typeof fullFork?.id !== 'string' || fullFork.id === sessionID || fullFork.id === partialFork.id) {
        throw new Error(`full session fork returned an invalid session: ${JSON.stringify(fullFork)}`);
      }
      await stream.waitFor(
        (event) => event?.type === 'session.created' && event?.properties?.sessionID === fullFork.id,
        { after: fullForkAfter, timeoutMs: 90_000, label: 'full fork session.created' },
      );
      const fullMessages = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(fullFork.id)}/message`,
      );
      if (
        !Array.isArray(fullMessages) ||
        fullMessages.map((message) => message?.info?.role).join(',') !== 'user,assistant' ||
        fullMessages.some((message) => message?.info?.sessionID !== fullFork.id) ||
        fullMessages[1]?.info?.parentID !== fullMessages[0]?.info?.id
      ) {
        throw new Error(`full fork did not clone and remap the complete history: ${JSON.stringify(fullMessages)}`);
      }

      const archivedAt = Date.UTC(2026, 0, 1);
      const archiveAfter = stream.events.length;
      const archivedFork = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'PATCH',
        `/session/${encodeURIComponent(partialFork.id)}`,
        { time: { archived: archivedAt } },
      );
      if (archivedFork?.time?.archived !== archivedAt) {
        throw new Error(`session archive update did not persist its timestamp: ${JSON.stringify(archivedFork)}`);
      }
      await stream.waitFor(
        (event) =>
          event?.type === 'session.updated' &&
          event?.properties?.sessionID === partialFork.id &&
          event?.properties?.info?.time?.archived === archivedAt,
        { after: archiveAfter, timeoutMs: 90_000, label: 'archived session.updated' },
      );

      const projectSessions = await apiRequest(httpTrace, opencode.baseURL, password, workspace, 'GET', '/session');
      if (
        !Array.isArray(projectSessions) ||
        !projectSessions.some((entry) => entry?.id === partialFork.id) ||
        !projectSessions.some((entry) => entry?.id === sessionID) ||
        !projectSessions.some((entry) => entry?.id === fullFork.id)
      ) {
        throw new Error(`stable project session list did not retain all forks: ${JSON.stringify(projectSessions)}`);
      }
      const activeSessions = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        '/experimental/session',
      );
      if (
        !Array.isArray(activeSessions) ||
        activeSessions.some((entry) => entry?.id === partialFork.id) ||
        !activeSessions.some((entry) => entry?.id === sessionID) ||
        !activeSessions.some((entry) => entry?.id === fullFork.id)
      ) {
        throw new Error(`default experimental session list did not exclude only the archived fork: ${JSON.stringify(activeSessions)}`);
      }
      const includingArchived = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        '/experimental/session?archived=true',
      );
      if (!Array.isArray(includingArchived) || !includingArchived.some((entry) => entry?.id === partialFork.id)) {
        throw new Error(`archived session list did not include the archived fork: ${JSON.stringify(includingArchived)}`);
      }

      const deleteAfter = stream.events.length;
      const deleted = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'DELETE',
        `/session/${encodeURIComponent(partialFork.id)}`,
      );
      if (deleted !== true) throw new Error(`session delete returned ${JSON.stringify(deleted)} instead of true`);
      await stream.waitFor(
        (event) => event?.type === 'session.deleted' && event?.properties?.sessionID === partialFork.id,
        { after: deleteAfter, timeoutMs: 90_000, label: 'session.deleted' },
      );
      const afterDelete = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        '/experimental/session?archived=true',
      );
      if (Array.isArray(afterDelete) && afterDelete.some((entry) => entry?.id === partialFork.id)) {
        throw new Error(`deleted session remained in the global list: ${JSON.stringify(afterDelete)}`);
      }
    }

    if (scenario.inspectDiff) {
      await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(sessionID)}/diff`,
      );
      const messageDiff = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(sessionID)}/diff?messageID=${encodeURIComponent(submittedMessageID)}`,
      );
      if (!Array.isArray(messageDiff) || messageDiff.length === 0) {
        throw new Error(`session message diff returned no controlled file change for ${submittedMessageID}`);
      }
      await apiRequest(httpTrace, opencode.baseURL, password, workspace, 'GET', '/vcs/diff?mode=git');
    }

    let children;
    const childMessages = [];
    if (scenario.inspectChildren) {
      children = await apiRequest(
        httpTrace,
        opencode.baseURL,
        password,
        workspace,
        'GET',
        `/session/${encodeURIComponent(sessionID)}/children`,
      );
      if (!Array.isArray(children) || children.length === 0) {
        throw new Error(`session children returned no controlled child for ${sessionID}`);
      }
      for (const child of children) {
        if (child?.parentID !== sessionID || typeof child?.id !== 'string') {
          throw new Error(`session children returned an invalid parent/child join: ${JSON.stringify(child)}`);
        }
        const durable = await apiRequest(
          httpTrace,
          opencode.baseURL,
          password,
          workspace,
          'GET',
          `/session/${encodeURIComponent(child.id)}/message`,
        );
        if (Array.isArray(durable)) childMessages.push(...durable);
      }
    }

    const messages = await apiRequest(
      httpTrace,
      opencode.baseURL,
      password,
      workspace,
      'GET',
      `/session/${encodeURIComponent(sessionID)}/message`,
    );
    const statuses = await apiRequest(httpTrace, opencode.baseURL, password, workspace, 'GET', '/session/status');
    const pendingPermissions = await apiRequest(httpTrace, opencode.baseURL, password, workspace, 'GET', '/permission');
    const pendingQuestions = await apiRequest(httpTrace, opencode.baseURL, password, workspace, 'GET', '/question');

    writeJson(join(captureRoot, 'manifest.json'), {
      vendor: 'opencode',
      vendorVersion: actualVersion,
      scenario: name,
      capturedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      transport: 'http+sse',
      sessionID,
      terminalEvent: terminalObservation,
      ...(scenario.attach || scenario.attachAfterRestart ? { nativeAttach: true } : {}),
    });
    const allEvents = capturedEvents();
    writeFileSync(join(captureRoot, 'events.jsonl'), jsonLines(allEvents), { mode: 0o600 });
    if (streamSegments.length > 1) {
      for (const segment of streamSegments) {
        writeFileSync(join(captureRoot, `events-${segment.phase}.jsonl`), jsonLines(segment.stream.events), {
          mode: 0o600,
        });
      }
    }
    writeFileSync(join(captureRoot, 'http-roundtrip.jsonl'), jsonLines(httpTrace), { mode: 0o600 });
    writeFileSync(join(captureRoot, 'provider-requests.jsonl'), jsonLines(provider.requests), { mode: 0o600 });
    writeFileSync(join(captureRoot, 'messages.jsonl'), jsonLines(Array.isArray(messages) ? messages : []), {
      mode: 0o600,
    });
    if (Array.isArray(messagesBeforeRestart)) {
      writeFileSync(join(captureRoot, 'messages-before-restart.jsonl'), jsonLines(messagesBeforeRestart), {
        mode: 0o600,
      });
    }
    if (Array.isArray(messagesAfterRestart)) {
      writeFileSync(join(captureRoot, 'messages-after-restart.jsonl'), jsonLines(messagesAfterRestart), {
        mode: 0o600,
      });
    }
    if (Array.isArray(children)) {
      writeFileSync(join(captureRoot, 'children.jsonl'), jsonLines(children), { mode: 0o600 });
      writeFileSync(join(captureRoot, 'child-messages.jsonl'), jsonLines(childMessages), { mode: 0o600 });
    }
    writeJson(join(captureRoot, 'session-status.json'), statuses);
    writeJson(join(captureRoot, 'pending-permissions.json'), pendingPermissions);
    writeJson(join(captureRoot, 'pending-questions.json'), pendingQuestions);
    writeJson(join(captureRoot, 'openapi.json'), openapi);
    writeFileSync(join(captureRoot, 'server.log'), capturedLogs(), { mode: 0o600 });

    return {
      version: actualVersion,
      events: allEvents.length,
      eventTypes: [...new Set(allEvents.map((event) => event?.type).filter(Boolean))].sort(),
      providerRequests: provider.requests.length,
      terminalEvent: terminalObservation,
      output: captureRoot,
    };
  } catch (error) {
    if (backends.length > 0) {
      writeFileSync(join(captureRoot, 'server.failure.log'), capturedLogs(), { mode: 0o600 });
    }
    if (streamSegments.length > 0) {
      writeFileSync(join(captureRoot, 'events.failure.jsonl'), jsonLines(capturedEvents()), { mode: 0o600 });
    }
    if (provider) {
      writeFileSync(join(captureRoot, 'provider-requests.failure.jsonl'), jsonLines(provider.requests), {
        mode: 0o600,
      });
    }
    writeFileSync(join(captureRoot, 'http-roundtrip.failure.jsonl'), jsonLines(httpTrace), { mode: 0o600 });
    throw error;
  } finally {
    await attach?.stop().catch(() => {});
    await stream?.close().catch(() => {});
    await opencode?.stop().catch(() => {});
    await provider?.close().catch(() => {});
    rmSync(temporary, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const artifact = binaryPath(flag('--artifact', process.env.PUPPETEER_OPENCODE_BIN ?? 'opencode'));
  const expectedVersion = flag('--version');
  const only = flag('--scenario');
  const names = only ? [only] : Object.keys(SCENARIOS);
  for (const name of names) {
    const versionLabel = expectedVersion ?? 'unversioned';
    const base = resolve(flag('--output', join(vendorRoot, 'captures-raw', `opencode@${versionLabel}`)));
    const output = names.length === 1 && flag('--output') ? base : join(base, name);
    const result = await runScenario(name, { artifact, version: expectedVersion, output });
    console.log(
      `${name.padEnd(20)} events=${String(result.events).padStart(3)} ` +
        `providerRequests=${result.providerRequests} terminal=${result.terminalEvent}`,
    );
    console.log(`  types: ${result.eventTypes.join(', ')}`);
    console.log(`  raw:   ${result.output}`);
  }
  console.log('Raw captures are gitignored. Sanitize and audit them before committing any fixture.');
}

export { runScenario };
