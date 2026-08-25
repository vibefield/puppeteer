#!/usr/bin/env node
/**
 * Controlled Kimi Code census.
 *
 * Runs the exact caller-supplied binary with an isolated KIMI_CODE_HOME and a
 * loopback OpenAI-compatible provider. The provider, hook stdin, process logs,
 * and native wire journals are captured verbatim under the gitignored
 * captures-raw tree. No user config, credentials, sessions, or external model
 * endpoint are used.
 *
 * usage:
 *   node harness.mjs --artifact <kimi> --version <x.y.z> [--output <dir>]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));

export const KIMI_CANDIDATE_VERSION = '0.34.0';

export const KIMI_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'UserPromptSubmit',
  'UserPromptQueued',
  'TurnStarted',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SessionHeartbeat',
  'SubagentStart',
  'SubagentStop',
  'TaskStarted',
  'PreCompact',
  'PostCompact',
  'Notification',
];

export const SCENARIOS = {
  'basic-turn': {
    prompt: 'Reply with exactly SURFACE_KIMI_OK and do not use tools.',
    responses: [
      [
        { delta: { role: 'assistant' } },
        { delta: { reasoning_content: 'Checking the requested exact response. ' } },
        { delta: { content: 'SURFACE_' } },
        { delta: { content: 'KIMI_OK' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 },
        },
      ],
    ],
  },
  'tool-success': {
    prompt: 'Use Bash once to print the requested marker, then report completion.',
    responses: [
      [
        { delta: { role: 'assistant', reasoning_content: 'I will run the requested safe command. ' } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_surface_success',
                type: 'function',
                function: {
                  name: 'Bash',
                  arguments: '{"command":"printf KIMI_TOOL_OK","description":"Print the census marker"}',
                },
              },
            ],
          },
        },
        {
          delta: {},
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 41, completion_tokens: 11, total_tokens: 52 },
        },
      ],
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'TOOL_SUCCESS_RECORDED' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
        },
      ],
    ],
  },
  'tool-nonzero': {
    prompt: 'Use Bash once to run the requested failing command, then report its result.',
    responses: [
      [
        { delta: { role: 'assistant', reasoning_content: 'I will record the nonzero command result. ' } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_surface_nonzero',
                type: 'function',
                function: {
                  name: 'Bash',
                  arguments: '{"command":"printf KIMI_TOOL_FAILURE >&2; exit 7","description":"Exercise nonzero exit"}',
                },
              },
            ],
          },
        },
        {
          delta: {},
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 43, completion_tokens: 12, total_tokens: 55 },
        },
      ],
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'TOOL_NONZERO_RECORDED' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 59, completion_tokens: 8, total_tokens: 67 },
        },
      ],
    ],
  },
  'resume-turn': {
    prompts: ['Reply with exactly SURFACE_KIMI_RESUME_ONE.', 'Reply with exactly SURFACE_KIMI_RESUME_TWO.'],
    resumeAfterFirst: true,
    responses: [
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_KIMI_RESUME_ONE' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 29, completion_tokens: 7, total_tokens: 36 },
        },
      ],
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_KIMI_RESUME_TWO' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 44, completion_tokens: 7, total_tokens: 51 },
        },
      ],
    ],
  },
  'background-task': {
    prompt: 'Use Bash once in the background to print the requested marker, then report completion.',
    responses: [
      [
        { delta: { role: 'assistant', reasoning_content: 'I will start the requested background task. ' } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_surface_background',
                type: 'function',
                function: {
                  name: 'Bash',
                  arguments:
                    '{"command":"sleep 0.2; printf KIMI_BACKGROUND_OK","description":"Exercise background task lifecycle","run_in_background":true}',
                },
              },
            ],
          },
        },
        {
          delta: {},
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 47, completion_tokens: 13, total_tokens: 60 },
        },
      ],
      {
        delayMs: 700,
        chunks: [
          { delta: { role: 'assistant' } },
          { delta: { content: 'BACKGROUND_TASK_RECORDED' } },
          {
            delta: {},
            finishReason: 'stop',
            usage: { prompt_tokens: 61, completion_tokens: 8, total_tokens: 69 },
          },
        ],
      },
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'BACKGROUND_NOTIFICATION_RECORDED' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 75, completion_tokens: 8, total_tokens: 83 },
        },
      ],
    ],
  },
  'provider-error': {
    prompt: 'Exercise the controlled provider failure path.',
    expectedExitCodes: [1],
    responses: [
      {
        status: 401,
        body: { error: { type: 'authentication_error', message: 'controlled census provider rejection' } },
      },
    ],
  },
  'hook-block-prompt': {
    prompt: 'This prompt must be blocked by the UserPromptSubmit hook.',
    expectedExitCodes: [1],
    requireWire: false,
    hookPolicy: {
      UserPromptSubmit: { exitCode: 2, stderr: 'census blocked this prompt' },
    },
    responses: [],
    expectedProviderRequests: 0,
  },
  'hook-deny-tool': {
    prompt: 'Use Bash once to print the requested marker, then report the denial.',
    hookPolicy: {
      PreToolUse: { exitCode: 2, stderr: 'census denied this tool' },
    },
    responses: [
      [
        { delta: { role: 'assistant', reasoning_content: 'I will attempt the requested command. ' } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_surface_denied',
                type: 'function',
                function: {
                  name: 'Bash',
                  arguments: '{"command":"printf KIMI_TOOL_DENIED","description":"Exercise hook deny"}',
                },
              },
            ],
          },
        },
        {
          delta: {},
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 41, completion_tokens: 11, total_tokens: 52 },
        },
      ],
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'TOOL_DENIED_RECORDED' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 58, completion_tokens: 7, total_tokens: 65 },
        },
      ],
    ],
  },
  'provider-retry': {
    prompt: 'Reply with exactly SURFACE_KIMI_RETRY after the controlled retry.',
    responses: [
      {
        status: 429,
        body: { error: { type: 'rate_limit_error', message: 'controlled census rate limit' } },
      },
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_KIMI_RETRY' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 33, completion_tokens: 6, total_tokens: 39 },
        },
      ],
    ],
  },
  'malformed-stream': {
    prompt: 'Exercise the controlled malformed provider stream.',
    expectedExitCodes: [1],
    responses: [{ malformed: true }],
  },
  'subagent-turn': {
    prompt: 'Use Agent once so a foreground subagent replies with the census marker, then report completion.',
    timeoutMs: 90_000,
    allowExtraProviderRequests: true,
    responses: [
      [
        { delta: { role: 'assistant', reasoning_content: 'I will delegate the requested census reply. ' } },
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_surface_subagent',
                type: 'function',
                function: {
                  name: 'Agent',
                  arguments:
                    '{"prompt":"Reply with exactly SURFACE_KIMI_SUBAGENT and do not use tools.","description":"Census subagent reply"}',
                },
              },
            ],
          },
        },
        {
          delta: {},
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 49, completion_tokens: 14, total_tokens: 63 },
        },
      ],
      [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_KIMI_SUBAGENT' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 28, completion_tokens: 6, total_tokens: 34 },
        },
      ],
    ],
  },
  'interrupt-stream': {
    prompt: 'Wait for the controlled census interruption.',
    interrupt: 'sigint-after-provider',
    interruptDelayMs: 120,
    expectedExitCodes: [130],
    expectedProviderRequests: 1,
    responses: [
      {
        delayMs: 8_000,
        chunks: [
          { delta: { role: 'assistant' } },
          { delta: { content: 'SURFACE_KIMI_INTERRUPTED' } },
          {
            delta: {},
            finishReason: 'stop',
            usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
          },
        ],
      },
    ],
  },
};

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function safeName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(value)) {
    throw new Error(`${label} is not a safe name`);
  }
  return value;
}

async function collectHook(outputRoot, scenario) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  const event = safeName(payload?.hook_event_name, 'hook event');
  if (!KIMI_HOOK_EVENTS.includes(event)) throw new Error(`unexpected Kimi hook event ${event}`);
  const safeScenario = safeName(scenario, 'scenario');
  const directory = resolve(outputRoot, safeScenario, 'hooks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(join(directory, `${event}.jsonl`), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  const policyPath = join(outputRoot, safeScenario, 'hook-policy.json');
  const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, 'utf8')) : {};
  const spec = policy[event] ?? {};
  if (typeof spec.stdout === 'string' && spec.stdout.length > 0) process.stdout.write(spec.stdout);
  if (typeof spec.stderr === 'string' && spec.stderr.length > 0) process.stderr.write(spec.stderr);
  process.exit(Number.isInteger(spec.exitCode) ? spec.exitCode : 0);
}

export function hooksToml(outputRoot, scenario) {
  const command = [
    shellQuote(process.execPath),
    shellQuote(scriptPath),
    '--collect',
    shellQuote(outputRoot),
    '--scenario',
    shellQuote(scenario),
  ].join(' ');
  return `${KIMI_HOOK_EVENTS.map(
    (event) => `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = 10\n`,
  ).join('\n')}\n`;
}

export function versionOf(artifact) {
  const result = spawnSync(artifact, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(`Kimi version probe failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const output = result.stdout.trim();
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(output);
  if (!match) throw new Error(`Kimi version output is not understood: ${output}`);
  return { version: match[1], output };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function openAiChunk(responseIndex, chunkIndex, chunk) {
  return {
    id: `chatcmpl-chopsticks-kimi-census-${responseIndex + 1}`,
    object: 'chat.completion.chunk',
    created: 1_786_339_200 + responseIndex,
    model: 'chopsticks-kimi-census',
    choices: [
      {
        index: 0,
        delta: chunk.delta,
        finish_reason: chunk.finishReason ?? null,
      },
    ],
    ...(chunk.usage ? { usage: chunk.usage } : {}),
    system_fingerprint: `surface-${responseIndex}-${chunkIndex}`,
  };
}

async function startFakeProvider(scenario) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      let bodyJson;
      try {
        bodyJson = JSON.parse(body);
      } catch {
        bodyJson = null;
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: bodyJson ?? body,
      });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const responseIndex = requests.length - 1;
      const responseSpec = scenario.responses[responseIndex] ?? [
        { delta: { role: 'assistant' } },
        { delta: { content: 'SURFACE_KIMI_EXTRA_STEP' } },
        {
          delta: {},
          finishReason: 'stop',
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        },
      ];
      if (!Array.isArray(responseSpec) && responseSpec.malformed) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.end('data: {not-valid-json\n\n');
        return;
      }
      if (!Array.isArray(responseSpec) && responseSpec.status) {
        response.writeHead(responseSpec.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(responseSpec.body));
        return;
      }
      const chunks = Array.isArray(responseSpec) ? responseSpec : responseSpec.chunks;
      if (!Array.isArray(responseSpec) && responseSpec.delayMs) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, responseSpec.delayMs));
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const [chunkIndex, chunk] of chunks.entries()) {
        response.write(`data: ${JSON.stringify(openAiChunk(responseIndex, chunkIndex, chunk))}\n\n`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake provider did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

function copyNativeEvidence(home, destination) {
  const wanted = new Set(['session_index.jsonl', 'state.json', 'wire.jsonl']);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && wanted.has(entry.name)) {
        const target = join(destination, 'home', relative(home, path));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        copyFileSync(path, target);
      }
    }
  };
  visit(home);
}

function hasFiles(directory) {
  return existsSync(directory) && readdirSync(directory).length > 0;
}

function latestSessionId(home) {
  const index = join(home, 'session_index.jsonl');
  if (!existsSync(index)) throw new Error('Kimi did not create a session index before resume');
  const entries = readFileSync(index, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const id = entries.at(-1)?.sessionId;
  if (typeof id !== 'string' || id.length === 0) throw new Error('Kimi session index has no resumable id');
  return id;
}

function censusEnv(temporary, home, providerBaseUrl) {
  const inherited = {};
  for (const name of ['PATH', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  return {
    ...inherited,
    HOME: temporary,
    USERPROFILE: temporary,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(temporary, 'xdg-config'),
    XDG_CACHE_HOME: join(temporary, 'xdg-cache'),
    XDG_DATA_HOME: join(temporary, 'xdg-data'),
    KIMI_CODE_HOME: home,
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_CODE_NO_AUTO_UPDATE: '1',
    KIMI_CODE_BUILTIN_PRODUCT_SKILLS: '0',
    KIMI_MODEL_NAME: 'chopsticks-kimi-census',
    KIMI_MODEL_API_KEY: 'sk-not-a-real-key',
    KIMI_MODEL_PROVIDER_TYPE: 'openai',
    KIMI_MODEL_BASE_URL: providerBaseUrl,
    KIMI_MODEL_MAX_CONTEXT_SIZE: '32768',
    KIMI_MODEL_CAPABILITIES: 'thinking,tool_use',
    KIMI_MODEL_REASONING_KEY: 'reasoning_content',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startProcess(artifact, args, options) {
  const child = spawn(artifact, args, {
    cwd: options.cwd,
    stdio: options.stdio,
    env: options.env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs ?? 45_000);
  const done = new Promise((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (code, signal) => resolveClose({ code, signal, stdout, stderr, timedOut }));
  }).finally(() => clearTimeout(timer));
  return { child, done };
}

export async function runKimiCensus({ artifact, expectedVersion, outputRoot, names = Object.keys(SCENARIOS) }) {
  const identity = versionOf(artifact);
  if (identity.version !== expectedVersion) {
    throw new Error(`expected Kimi ${expectedVersion}, got ${identity.output}`);
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const artifactSha256 = existsSync(artifact) ? await sha256File(artifact) : null;

  const results = [];
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    const temporary = mkdtempSync(join(tmpdir(), 'chopsticks-kimi-census-'));
    const home = join(temporary, 'home');
    const workspace = join(temporary, 'workspace');
    const skills = join(temporary, 'skills');
    const destination = join(outputRoot, name);
    if (hasFiles(destination)) throw new Error(`refusing to append to existing raw census: ${destination}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(skills, { recursive: true });
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'config.toml'), hooksToml(outputRoot, name), { mode: 0o600 });
    writeFileSync(join(workspace, 'README.md'), 'Hermetic Kimi Surface census workspace.\n');
    if (scenario.hookPolicy) {
      writeFileSync(join(destination, 'hook-policy.json'), `${JSON.stringify(scenario.hookPolicy, null, 2)}\n`, {
        mode: 0o600,
      });
    }

    let provider;
    try {
      provider = await startFakeProvider(scenario);
      const prompts = scenario.prompts ?? [scenario.prompt];
      const invocations = [];
      let resumedSessionId;
      for (const [index, prompt] of prompts.entries()) {
        if (index > 0 && scenario.resumeAfterFirst && resumedSessionId === undefined) {
          resumedSessionId = latestSessionId(home);
        }
        const args = [
          ...(scenario.extraArgs ?? []),
          ...(index > 0 && scenario.resumeAfterFirst ? ['--session', resumedSessionId] : []),
          '--prompt',
          prompt,
          '--output-format',
          'stream-json',
          '--skills-dir',
          skills,
        ];
        const invocation = startProcess(artifact, args, {
          cwd: workspace,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: censusEnv(temporary, home, provider.baseUrl),
          timeoutMs: scenario.timeoutMs,
        });
        if (scenario.interrupt === 'sigint-after-provider') {
          await waitUntil(() => provider.requests.length > 0, 20_000, `${name} provider request`);
          await delay(scenario.interruptDelayMs ?? 100);
          invocation.child.kill('SIGINT');
        }
        const result = await invocation.done;
        invocations.push({ ...result, resumed: index > 0 && scenario.resumeAfterFirst });
      }
      const processResult = invocations.at(-1);
      writeFileSync(
        join(destination, 'process.json'),
        `${JSON.stringify(
          {
            identity,
            artifactSha256,
            args: ['--prompt', '<prompt>', '--output-format', 'stream-json', '--skills-dir', '<skills-dir>'],
            mode: 'native-print-hermetic',
            ...(scenario.hookPolicy ? { hookPolicy: scenario.hookPolicy } : {}),
            ...(scenario.interrupt ? { interrupt: scenario.interrupt } : {}),
            code: processResult.code,
            signal: processResult.signal,
            invocations: invocations.map((invocation) => ({
              resumed: invocation.resumed,
              code: invocation.code,
              signal: invocation.signal,
            })),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      writeFileSync(join(destination, 'stdout.log'), invocations.map((invocation) => invocation.stdout).join(''), {
        mode: 0o600,
      });
      writeFileSync(join(destination, 'stderr.log'), invocations.map((invocation) => invocation.stderr).join(''), {
        mode: 0o600,
      });
      writeFileSync(
        join(destination, 'provider-requests.jsonl'),
        `${provider.requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
        { mode: 0o600 },
      );
      copyNativeEvidence(home, destination);
      const wireFiles = [];
      const collectWire = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) collectWire(path);
          else if (entry.isFile() && entry.name === 'wire.jsonl') wireFiles.push(path);
        }
      };
      collectWire(join(destination, 'home'));
      const expectedRequests = scenario.expectedProviderRequests ?? scenario.responses.length;
      const requestCountOk = scenario.allowExtraProviderRequests
        ? provider.requests.length >= expectedRequests
        : provider.requests.length === expectedRequests;
      if (
        invocations.some((invocation) => invocation.timedOut) ||
        invocations.some((invocation, index) => {
          const allowed = scenario.allowedExitCodes ?? [scenario.expectedExitCodes?.[index] ?? 0];
          return !allowed.includes(invocation.code);
        }) ||
        ((scenario.requireWire ?? true) && wireFiles.length === 0) ||
        !requestCountOk
      ) {
        throw new Error(
          `Kimi census scenario ${name} failed; inspect ${destination} (requests=${provider.requests.length} expected=${expectedRequests} wires=${wireFiles.length} codes=${invocations.map((invocation) => invocation.code).join(',')} timedOut=${invocations.some((invocation) => invocation.timedOut)})`,
        );
      }
      results.push({
        name,
        process: processResult,
        providerRequests: provider.requests.length,
        wireFiles: wireFiles.map((path) => relative(destination, path)),
      });
    } finally {
      if (provider) await provider.close();
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return { identity, results };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly && process.argv.includes('--collect')) {
  await collectHook(flag('--collect'), flag('--scenario', 'basic-turn'));
} else if (invokedDirectly) {
  const artifactFlag = flag('--artifact', process.env.CHOPSTICKS_KIMI_BIN ?? 'kimi');
  const artifact = isAbsolute(artifactFlag) || artifactFlag.includes('/') ? resolve(artifactFlag) : artifactFlag;
  const expectedVersion = flag('--version', KIMI_CANDIDATE_VERSION);
  const outputRoot = resolve(flag('--output', join(vendorRoot, 'captures-raw', `kimi@${expectedVersion}`)));
  const only = flag('--scenario');
  const result = await runKimiCensus({
    artifact,
    expectedVersion,
    outputRoot,
    names: only ? [only] : Object.keys(SCENARIOS),
  });
  console.log(`captured ${result.identity.output} at ${outputRoot}`);
  for (const scenario of result.results) {
    console.log(
      `  ${scenario.name}: providerRequests=${scenario.providerRequests} wireFiles=${scenario.wireFiles.length}`,
    );
  }
  console.log('Raw captures are verbatim and gitignored; sanitize before committing.');
}
