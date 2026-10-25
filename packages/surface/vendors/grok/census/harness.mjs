#!/usr/bin/env node
/**
 * Controlled Grok Build census for one exact, caller-supplied artifact.
 *
 * Topology is the adapter's real composition, not a shadow process: one
 * `grok agent leader` per scenario, an ACP controller attached through
 * `grok agent --leader --leader-socket <sock> stdio`, and, where a scenario
 * needs it, the native terminal viewer (`grok --leader … --resume <id>`) in a
 * PTY. Every vendor process receives an explicit environment (nothing is
 * inherited), a disposable HOME/GROK_HOME/workspace, and a deterministic
 * loopback model provider. No credentials, account, or external model is used.
 *
 * Raw output is confined to the gitignored `captures-raw/grok@<version>/` tree.
 * It holds prompts, provider bodies, absolute paths, and terminal bytes, so it
 * is never committed; `sanitize-captures.mjs` derives the tracked capture set.
 * Persisted permission rules (`permission__*.toml`, whose names embed the
 * controller argv) are never copied, even into the raw tree.
 *
 * The terminal viewer's bytes are retained raw for human diagnosis only. No
 * census expectation or modeled claim is derived from terminal text.
 *
 * macOS limits Unix socket paths to 104 bytes, so run with a short TMPDIR
 * (for example TMPDIR=/private/tmp/<user>/pw-grok); the harness refuses a
 * socket path that would not fit.
 *
 * usage:
 *   node harness.mjs --artifact <grok> --version 1.0.70 [--output <raw dir>]
 *                    [--scenario name[,name…]] [--probes <dir>] [--probes-only]
 *                    [--source-url <url>] [--allow-failures]
 *   node harness.mjs --artifact <grok> --version 1.0.70 --approval-probe [--probes <dir>]
 *     runs only the approval-ownership probe (who answers a leader-routed
 *     permission request when the controller defers) and writes its sanitized
 *     digest to <probes>/viewer-approvals.json.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const repoRoot = resolve(vendorRoot, '..', '..', '..', '..');

export const GROK_CENSUS_MODEL = 'puppeteer-grok-live';
export const GROK_CENSUS_MARKER = 'SURFACE_GROK_TUI_OK';
/** A command Grok classifies as mutating (a redirect), so it must ask permission. */
export const GROK_MUTATING_COMMAND = 'echo SURFACE_TOOL_OK > surface-tool.txt';
/** A bare echo, which Grok 1.0.70 classifies as safe and runs without asking. */
export const GROK_SAFE_COMMAND = 'echo SURFACE_SAFE_OK';
const COMPACTION_SUMMARY = `## Summary\n${'The census session asked the assistant to reply with a fixed marker and it complied without using tools. '.repeat(12)}`;

export const GROK_CENSUS_SCENARIOS = [
  'viewer-session',
  'viewer-prompt',
  'headless-compact',
  'subagent',
  'hooks',
  'approvals-remembered-off',
];

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse', 'PostToolUse', 'SessionEnd'];

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function appendJsonLine(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function freshDirectory(path) {
  if (existsSync(path) && readdirSync(path).length > 0) {
    throw new Error(`refusing to append to an existing raw capture: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** The only environment a vendor process ever receives. Nothing is inherited. */
export function isolatedGrokEnvironment(root, { baseUrl, extra = {} }) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    HOME: root.home,
    USERPROFILE: root.home,
    TMPDIR: root.tmp,
    XDG_CONFIG_HOME: join(root.home, '.config'),
    XDG_CACHE_HOME: join(root.home, '.cache'),
    XDG_DATA_HOME: join(root.home, '.local', 'share'),
    GROK_HOME: root.grokHome,
    // A syntactically plausible placeholder; the loopback provider ignores it.
    XAI_API_KEY: 'xai-not-a-real-key',
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_TELEMETRY_ENABLED: '0',
    GROK_MEMORY: '0',
    GROK_WORKFLOWS: '0',
    GROK_FEEDBACK_ENABLED: '0',
    GROK_WEB_FETCH: '0',
    GROK_MODELS_BASE_URL: baseUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...extra,
  };
}

export function grokCensusConfig(baseUrl, { subagents = false, hooks = false } = {}) {
  const lines = [
    '[cli]',
    'auto_update = false',
    '',
    '[features]',
    'telemetry = false',
    'feedback = false',
    'codebase_indexing = false',
    'remote_fetch = false',
    '',
    '[memory]',
    'enabled = false',
    '',
    '[workflows]',
    'enabled = false',
    '',
    '[subagents]',
    `enabled = ${subagents}`,
    '',
    '[models]',
    `default = "${GROK_CENSUS_MODEL}"`,
    '',
    `[model.${GROK_CENSUS_MODEL}]`,
    `model = "${GROK_CENSUS_MODEL}"`,
    `base_url = "${baseUrl}"`,
    'name = "Puppeteer Loopback"',
    'env_key = "XAI_API_KEY"',
    'api_backend = "chat_completions"',
    'context_window = 128000',
    '',
  ];
  if (hooks) {
    // A bare `true` resolves through PATH on 1.0.70 (1.0.0 resolved it beside GROK_HOME).
    for (const event of HOOK_EVENTS) {
      lines.push(`[[hooks.${event}]]`, 'hooks = [{ type = "command", command = "true", timeout = 5 }]', '');
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Deterministic loopback model provider
// ---------------------------------------------------------------------------

export function classifyProviderRequest(method, url, body) {
  if (method === 'GET' && (url === '/' || url === '')) return 'origin-probe';
  if (method === 'GET' && url?.startsWith('/v1/models')) return 'models';
  if (method === 'POST' && url?.startsWith('/v1/responses')) return 'responses';
  if (body && typeof body === 'object') {
    if (JSON.stringify(body.tool_choice ?? '').includes('session_title')) return 'session-title';
    if (JSON.stringify(body.messages ?? '').includes('ultra-short dashboard line')) return 'dashboard-summary';
    if (/produce a faithful, concise summary of the conversation/.test(lastUserText(body))) return 'compaction';
  }
  return 'turn';
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    }
  }
  return '';
}

function lastMessageIsToolResult(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages[messages.length - 1]?.role === 'tool';
}

function chooseTool(body, kind) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const name = (tool) => tool?.function?.name ?? tool?.name ?? '';
  const preferences =
    kind === 'subagent'
      ? [/^spawn_subagent$/, /subagent|delegate/i]
      : [/^run_terminal_command$/, /^bash$/i, /terminal|shell|command/i];
  let selected;
  for (const preference of preferences) {
    selected = tools.find((tool) => preference.test(name(tool)));
    if (selected) break;
  }
  if (!selected) return { names: tools.map(name) };
  const fn = selected.function ?? selected;
  const parameters = fn.parameters ?? {};
  const args = {};
  for (const key of parameters.required ?? []) {
    const property = parameters.properties?.[key] ?? {};
    if (/command|cmd/i.test(key)) args[key] = kind === 'safe' ? GROK_SAFE_COMMAND : GROK_MUTATING_COMMAND;
    else if (Array.isArray(property.enum) && property.enum.length) args[key] = property.enum[0];
    else if (property.type === 'boolean') args[key] = false;
    else if (property.type === 'integer' || property.type === 'number') args[key] = 10_000;
    else if (property.type === 'array') args[key] = [];
    else args[key] = 'surface census';
  }
  return { names: tools.map(name), name: fn.name, args };
}

function chatChunk(delta, finishReason) {
  return {
    id: 'chatcmpl-puppeteer-grok-census',
    object: 'chat.completion.chunk',
    created: 1_788_019_200,
    model: GROK_CENSUS_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const CHAT_USAGE = {
  prompt_tokens: 31,
  completion_tokens: 7,
  total_tokens: 38,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
};

async function writeChatCompletion(response, body, kind, onTool) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const finish = () => {
    send({ ...chatChunk({}, null), choices: [], usage: CHAT_USAGE });
    response.end('data: [DONE]\n\n');
  };
  const user = lastUserText(body);
  const afterTool = lastMessageIsToolResult(body);
  if (kind === 'turn' && /SURFACE_SLOW/.test(user) && !afterTool) {
    send(chatChunk({ role: 'assistant', content: '' }, null));
    for (let index = 0; index < 40 && !response.destroyed; index += 1) {
      await sleep(250);
      if (!response.destroyed) send(chatChunk({ content: '.' }, null));
    }
    if (!response.destroyed) {
      send(chatChunk({}, 'stop'));
      finish();
    }
    return;
  }
  const toolKind = /SURFACE_SUBAGENT/.test(user)
    ? 'subagent'
    : /SURFACE_SAFE/.test(user)
      ? 'safe'
      : /SURFACE_TOOL/.test(user)
        ? 'mutating'
        : undefined;
  if (kind === 'turn' && toolKind && !afterTool) {
    const plan = chooseTool(body, toolKind);
    onTool({ kind: toolKind, chosen: plan.name, toolNames: plan.names });
    if (plan.name) {
      const argsText = JSON.stringify(plan.args);
      send(chatChunk({ role: 'assistant', content: null, reasoning_content: 'Planning a tool call.' }, null));
      send(
        chatChunk(
          {
            tool_calls: [
              { index: 0, id: 'call_surface_1', type: 'function', function: { name: plan.name, arguments: '' } },
            ],
          },
          null,
        ),
      );
      send(chatChunk({ tool_calls: [{ index: 0, function: { arguments: argsText.slice(0, 10) } }] }, null));
      send(chatChunk({ tool_calls: [{ index: 0, function: { arguments: argsText.slice(10) } }] }, null));
      send(chatChunk({}, 'tool_calls'));
      finish();
      return;
    }
  }
  const text =
    kind === 'session-title'
      ? 'Pinned Grok census'
      : kind === 'dashboard-summary'
        ? 'Pinned Grok census complete'
        : kind === 'compaction'
          ? COMPACTION_SUMMARY
          : GROK_CENSUS_MARKER;
  const midpoint = Math.ceil(text.length / 2);
  send(
    chatChunk(
      {
        role: 'assistant',
        content: '',
        ...(kind === 'turn' ? { reasoning_content: 'Thinking about the reply.' } : {}),
      },
      null,
    ),
  );
  send(chatChunk({ content: text.slice(0, midpoint) }, null));
  send(chatChunk({ content: text.slice(midpoint) }, null));
  send(chatChunk({}, 'stop'));
  finish();
}

/** Responses-API stream; 1.0.70 rejects events without `sequence_number`. */
function writeResponses(response) {
  const text = 'Pinned Grok census';
  const item = {
    type: 'message',
    id: 'msg-puppeteer-grok-census',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], text }],
  };
  const completed = {
    id: 'resp-puppeteer-grok-census',
    object: 'response',
    status: 'completed',
    created_at: 1_788_019_200,
    model: GROK_CENSUS_MODEL,
    output: [item],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 26,
    },
  };
  const started = { ...completed, status: 'in_progress', output: [], usage: null };
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  let sequence = 0;
  const event = (name, value) =>
    response.write(`event: ${name}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`);
  event('response.created', { type: 'response.created', response: started });
  event('response.in_progress', { type: 'response.in_progress', response: started });
  event('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  event('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', annotations: [], text: '' },
  });
  event('response.output_text.delta', {
    type: 'response.output_text.delta',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  event('response.output_text.done', {
    type: 'response.output_text.done',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text,
  });
  event('response.content_part.done', {
    type: 'response.content_part.done',
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', annotations: [], text },
  });
  event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
  event('response.completed', { type: 'response.completed', response: completed });
  response.end();
}

export async function startLoopbackProvider({ now, log }) {
  const requests = [];
  const tools = [];
  const server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString('utf8');
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const kind = classifyProviderRequest(request.method, request.url, body);
      const entry = { t: now(), method: request.method, url: request.url, kind, body };
      requests.push(entry);
      log(entry);
      if (kind === 'origin-probe') {
        response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
        return response.end('ok');
      }
      if (kind === 'models') {
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        return response.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: GROK_CENSUS_MODEL, object: 'model', created: 0, owned_by: 'puppeteer' }],
          }),
        );
      }
      if (kind === 'responses') return writeResponses(response);
      if (request.method === 'POST' && request.url?.startsWith('/v1/chat/completions')) {
        return writeChatCompletion(response, body, kind, (plan) => tools.push({ t: now(), ...plan }));
      }
      response.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: { message: `unhandled census route ${request.url ?? ''}` } }));
    })().catch((error) => response.destroy(error));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    tools,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

// ---------------------------------------------------------------------------
// Native processes
// ---------------------------------------------------------------------------

function loadPty() {
  // The Surface package deliberately has no native dependency. The workspace
  // adapter that owns the native-TUI live lane declares node-pty, so resolve it
  // from there (or from an explicit --pty-module) without importing adapter code.
  const candidates = [
    flag('--pty-module'),
    import.meta.url,
    pathToFileURL(join(repoRoot, 'packages', 'adapter-grok', 'package.json')).href,
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      return createRequire(base)('node-pty');
    } catch {
      // try the next resolution root
    }
  }
  throw new Error('viewer scenarios need node-pty; install workspace dependencies or pass --pty-module <path>');
}

function createRun({ artifact, output, scenario, now }) {
  const dir = freshDirectory(join(output, scenario));
  // One short disposable root per scenario keeps the leader socket under the
  // 104-byte sun_path limit and isolates every native store from the others.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gk')));
  const root = {
    base,
    home: join(base, 'home'),
    grokHome: join(base, 'grok-home'),
    workspace: join(base, 'workspace'),
    tmp: join(base, 'tmp'),
    socketDir: join(base, 's'),
  };
  for (const path of [root.home, root.grokHome, root.workspace, root.tmp, root.socketDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(root.workspace, 'README.md'), '# census workspace\n');
  root.socket = join(root.socketDir, 'leader.sock');
  if (Buffer.byteLength(root.socket) >= 100) {
    throw new Error(`leader socket path is ${Buffer.byteLength(root.socket)} bytes; set a shorter TMPDIR`);
  }
  const children = [];
  const files = {
    processes: join(dir, 'processes.jsonl'),
    provider: join(dir, 'provider-requests.jsonl'),
    timeline: join(dir, 'timeline.jsonl'),
    state: join(dir, 'state-snapshots.jsonl'),
  };
  const note = (message) => {
    appendJsonLine(files.timeline, { t: now(), note: message });
    console.log(`[${scenario} ${now()}] ${message}`);
  };
  const run = {
    dir,
    root,
    files,
    note,
    children,
    expectations: [],
    observations: {},
    expect(id, ok, detail) {
      this.expectations.push({ id, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
      if (!ok) note(`EXPECTATION FAILED ${id}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    },
    spawn(label, args, env) {
      const child = spawn(artifact, args, { cwd: root.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      appendJsonLine(files.processes, { t: now(), label, role: label.replace(/-\d+$/, ''), args, pid: child.pid });
      child.stderr.on('data', (chunk) => appendFileSync(join(dir, `${label}.stderr.txt`), chunk));
      child.on('exit', (code, signal) => {
        appendJsonLine(files.processes, { t: now(), label, exit: code, signal });
        note(`${label} exited ${code} ${signal}`);
      });
      return child;
    },
  };
  return run;
}

function sessionDirectory(root, sessionId) {
  const sessions = join(root.grokHome, 'sessions');
  if (!existsSync(sessions)) return undefined;
  for (const bucket of readdirSync(sessions)) {
    const candidate = join(sessions, bucket, sessionId);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function snapshotState(run, sessionId, phase, now) {
  const directory = sessionId ? sessionDirectory(run.root, sessionId) : undefined;
  const snapshot = { t: now(), phase, sessionId, files: {} };
  for (const file of ['signals.json', 'summary.json', 'usage.json']) {
    const path = directory && join(directory, file);
    if (!path || !existsSync(path)) {
      snapshot.files[file] = { present: false };
      continue;
    }
    try {
      snapshot.files[file] = { present: true, content: JSON.parse(readFileSync(path, 'utf8')) };
    } catch {
      snapshot.files[file] = { present: true, unreadable: true };
    }
  }
  appendJsonLine(run.files.state, snapshot);
  return snapshot;
}

function startLeader(run, env, now) {
  const leader = run.spawn(
    'leader',
    ['agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--leader-socket', run.root.socket],
    env,
  );
  leader.stdout.on('data', (chunk) => appendFileSync(join(run.dir, 'leader.stdout.txt'), chunk));
  return (async () => {
    const started = now();
    for (let attempt = 0; attempt < 120 && !existsSync(run.root.socket); attempt += 1) await sleep(50);
    run.observations.leaderReadyMs = existsSync(run.root.socket) ? now() - started : null;
    run.expect('leader-socket-ready', existsSync(run.root.socket));
    return leader;
  })();
}

async function stopLeader(run, leader, now) {
  if (leader.exitCode !== null) return;
  const sent = now();
  const exited = new Promise((done) => leader.once('exit', (code, signal) => done({ code, signal })));
  leader.kill('SIGTERM');
  const result = await Promise.race([exited, sleep(8_000).then(() => undefined)]);
  run.observations.leaderShutdown = {
    signal: 'SIGTERM',
    exitedWithinMs: result ? now() - sent : null,
    exitCode: result?.code ?? null,
    exitSignal: result?.signal ?? null,
    socketRemainsAfterExit: existsSync(run.root.socket),
    lockRemainsAfterExit: existsSync(join(run.root.socketDir, 'leader.lock')),
    socketDirectoryEntries: existsSync(run.root.socketDir) ? readdirSync(run.root.socketDir).sort() : [],
  };
  if (!result) leader.kill('SIGKILL');
}

/** One ACP controller; every frame is logged with its direction before it is acted on. */
function acpController(run, label, env, now, { decide } = {}) {
  const child = run.spawn(label, ['agent', '--leader', '--leader-socket', run.root.socket, 'stdio'], env);
  const wire = join(run.dir, `acp-${label}.jsonl`);
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const frames = [];
  const deferred = [];
  let nextId = 1;
  const send = (message) => {
    const frame = { t: now(), direction: 'client-to-agent', message };
    frames.push(frame);
    appendJsonLine(wire, frame);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      appendFileSync(join(run.dir, `acp-${label}.non-json.txt`), `${line}\n`);
      return;
    }
    const frame = { t: now(), direction: 'agent-to-client', message };
    frames.push(frame);
    appendJsonLine(wire, frame);
    if (message.id !== undefined && message.method === undefined) {
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      if (message.method === 'session/request_permission') {
        const optionId = decide?.(message.params);
        // A deferring controller leaves the request open so another attached
        // client (the native viewer) can answer it; `respond` answers it later.
        if (optionId === DEFER_PERMISSION) {
          deferred.push({ id: message.id, params: message.params, frameIndex: frames.length - 1, t: frame.t });
          return;
        }
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
        });
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
    }
  });
  return {
    child,
    frames,
    deferred,
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    respond(id, result) {
      send({ jsonrpc: '2.0', id, result });
    },
    request(method, params, timeoutMs = 60_000) {
      const id = nextId++;
      const sentAt = now();
      return new Promise((done) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          done({ timeout: true, method, sentAt });
        }, timeoutMs);
        pending.set(id, (message) => {
          clearTimeout(timer);
          done({ ...message, sentAt, receivedAt: now() });
        });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    close: () =>
      new Promise((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.stdin.end();
        setTimeout(() => child.kill('SIGTERM'), 2_000);
        setTimeout(done, 5_000);
      }),
  };
}

/** A `decide` result that leaves a permission request unanswered by this controller. */
export const DEFER_PERMISSION = Symbol('defer-permission');

/** Exact `*_once` kinds first; an `*_always` choice would persist a native allow/deny rule. */
export function selectPermissionOption(options, decision) {
  const list = Array.isArray(options) ? options : [];
  const order = decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const option = list.find((entry) => entry?.kind === kind);
    if (option) return option.optionId;
  }
  return undefined;
}

function startViewer(run, env, sessionId, now) {
  const pty = loadPty();
  const args = [
    '--model',
    GROK_CENSUS_MODEL,
    '--permission-mode',
    'default',
    '--leader',
    '--leader-socket',
    run.root.socket,
    '--resume',
    sessionId,
  ];
  appendJsonLine(run.files.processes, { t: now(), label: 'viewer', role: 'viewer', args });
  const viewer = pty.spawn(run.artifact, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: run.root.workspace,
    env,
  });
  let bytes = 0;
  let text = '';
  viewer.onData((data) => {
    bytes += data.length;
    text += data;
    appendFileSync(join(run.dir, 'viewer.raw.txt'), data);
  });
  let exit;
  viewer.onExit((event) => {
    exit = event;
    appendJsonLine(run.files.processes, { t: now(), label: 'viewer', exit: event.exitCode, signal: event.signal });
    run.note(`viewer exited ${JSON.stringify(event)}`);
  });
  return {
    write: (data) => viewer.write(data),
    bytes: () => bytes,
    text: () => stripVTControlCharacters(text),
    exited: () => exit !== undefined,
    async stop() {
      if (exit === undefined) {
        try {
          viewer.kill('SIGTERM');
        } catch {
          // already gone
        }
        for (let attempt = 0; attempt < 40 && exit === undefined; attempt += 1) await sleep(100);
      }
      writeFileSync(join(run.dir, 'viewer.text.txt'), stripVTControlCharacters(text), { mode: 0o600 });
    },
  };
}

function updatesFor(frames, method, sessionUpdate, since = 0) {
  return frames.filter(
    (frame, index) =>
      index >= since &&
      frame.direction === 'agent-to-client' &&
      frame.message.method === method &&
      (sessionUpdate === undefined || frame.message.params?.update?.sessionUpdate === sessionUpdate),
  );
}

async function prompt(run, controller, sessionId, label, text, now, { cancelAfterMs, settleMs = 2_000 } = {}) {
  const since = controller.frames.length;
  const pending = controller.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 90_000);
  if (cancelAfterMs !== undefined) {
    await sleep(cancelAfterMs);
    controller.notify('session/cancel', { sessionId });
    run.note(`${label}: session/cancel sent`);
  }
  const result = await pending;
  const atResult = snapshotState(run, sessionId, `${label}:result`, now);
  run.note(`${label}: ${JSON.stringify(result.result?.stopReason ?? result.error ?? result)}`);
  // signals.json is written asynchronously after the result on 1.0.70; sample
  // its appearance instead of assuming it is already current.
  let signalsAfterMs = atResult.files['signals.json'].present ? 0 : null;
  const resultAt = now();
  for (let attempt = 0; attempt < 30 && signalsAfterMs === null; attempt += 1) {
    await sleep(50);
    const directory = sessionDirectory(run.root, sessionId);
    if (directory && existsSync(join(directory, 'signals.json'))) signalsAfterMs = now() - resultAt;
  }
  await sleep(settleMs);
  const settled = snapshotState(run, sessionId, `${label}:settled`, now);
  const window = controller.frames.slice(since);
  const permissions = window.filter(
    (frame) => frame.direction === 'agent-to-client' && frame.message.method === 'session/request_permission',
  );
  const turn = {
    label,
    stopReason: result.result?.stopReason ?? null,
    error: result.error ? { code: result.error.code } : undefined,
    timedOut: Boolean(result.timeout),
    promptResultMs: result.receivedAt !== undefined ? result.receivedAt - result.sentAt : null,
    signalsPresentAtResult: atResult.files['signals.json'].present,
    signalsAppearedAfterResultMs: signalsAfterMs,
    // A replace-in-place file can be present but stale; its turn counter shows
    // whether the prompt result already reflected this turn.
    signalsTurnCountAtResult: atResult.files['signals.json'].content?.turnCount ?? null,
    signalsTurnCountSettled: settled.files['signals.json'].content?.turnCount ?? null,
    permissionRequests: permissions.map((frame) => ({
      tool: frame.message.params?.toolCall?._meta?.['x.ai/tool']?.name ?? null,
      options: (frame.message.params?.options ?? []).map((option) => `${option.optionId}/${option.kind}`),
    })),
    userMessageEchoes: updatesFor(window, 'session/update', 'user_message_chunk').filter(
      (frame) => frame.message.params?.sessionId === sessionId,
    ).length,
    childSessionFrames: window.filter(
      (frame) =>
        frame.direction === 'agent-to-client' &&
        typeof frame.message.params?.sessionId === 'string' &&
        frame.message.params.sessionId !== sessionId,
    ).length,
  };
  run.observations.turns = [...(run.observations.turns ?? []), turn];
  return { result, turn };
}

async function bootstrap(run, env, now, { decide } = {}) {
  const leader = await startLeader(run, env, now);
  const controller = acpController(run, 'controller', env, now, { decide });
  const initialized = await controller.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  run.expect('initialize-result', initialized.result?.protocolVersion !== undefined, initialized.error);
  await sleep(1_500);
  const created = await controller.request('session/new', { cwd: run.root.workspace, mcpServers: [] });
  const sessionId = created.result?.sessionId;
  run.expect('session-new-result', typeof sessionId === 'string', created.error ?? created.timeout);
  run.observations.sessionNewResultMs = created.receivedAt - created.sentAt;
  await sleep(1_500);
  return { leader, controller, sessionId, sessionNewSentAt: created.sentAt };
}

async function resume(run, env, sessionId, now) {
  const controller = acpController(run, 'resume', env, now);
  const initialized = await controller.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  run.expect('resume-initialize-result', initialized.result?.protocolVersion !== undefined);
  await sleep(1_000);
  const loaded = await controller.request('session/load', { sessionId, cwd: run.root.workspace, mcpServers: [] });
  run.expect('session-load-result', loaded.result !== undefined, loaded.error ?? loaded.timeout);
  await sleep(2_500);
  const replayed = controller.frames.filter(
    (frame) => frame.direction === 'agent-to-client' && frame.message.params?._meta?.isReplay === true,
  );
  run.observations.resume = {
    replayFrames: replayed.length,
    replayMethods: [...new Set(replayed.map((frame) => frame.message.method))].sort(),
    replayedXaiDurableSpelling: replayed.filter((frame) => frame.message.method === '_x.ai/session/update').length,
  };
  run.expect('session-load-replays-history', replayed.length > 0);
  await controller.close();
}

function originProbeTiming(run, provider, sessionNewSentAt) {
  const probe = provider.requests.find((entry) => entry.kind === 'origin-probe');
  run.observations.originProbe = probe
    ? { observed: true, afterSessionNewMs: probe.t - sessionNewSentAt }
    : { observed: false };
}

function copyStore(run) {
  const sessions = join(run.root.grokHome, 'sessions');
  const target = join(run.dir, 'store', 'sessions');
  const omitted = [];
  if (existsSync(sessions)) {
    cpSync(sessions, target, {
      recursive: true,
      filter: (source) => {
        const name = source.split('/').pop() ?? '';
        // Persisted allow rules embed the controller argv (absolute executable
        // and leader-socket paths); never copy them anywhere.
        if (/^permission__.*\.toml$/.test(name)) {
          omitted.push(relative(sessions, source));
          return false;
        }
        return true;
      },
    });
  }
  for (const file of ['models_cache.json']) {
    if (existsSync(join(run.root.grokHome, file))) cpSync(join(run.root.grokHome, file), join(run.dir, 'store', file));
  }
  run.observations.permissionRuleFiles = omitted.length;
  const listing = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else listing.push(relative(run.root.grokHome, path));
    }
  };
  if (existsSync(run.root.grokHome)) walk(run.root.grokHome);
  writeJson(join(run.dir, 'store-listing.json'), listing.sort());
}

async function finish(run, provider, children) {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await provider.close();
  copyStore(run);
  writeJson(join(run.dir, 'roots.json'), { ...run.root, artifact: run.artifact });
  writeJson(join(run.dir, 'provider-tools.json'), provider.tools);
  writeJson(join(run.dir, 'observations.json'), {
    scenario: run.scenario,
    providerRequests: provider.requests.map((entry) => ({ method: entry.method, path: entry.url, kind: entry.kind })),
    ...run.observations,
    expectations: run.expectations,
  });
  rmSync(run.root.base, { recursive: true, force: true });
}

const decideAllow = (params) => selectPermissionOption(params?.options, 'allow');

const scenarios = {
  /** Shared leader + ACP controller + native viewer, then a second controller resumes. */
  async 'viewer-session'(run, provider, now) {
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '0' } });
    let decision = 'allow';
    const { leader, controller, sessionId, sessionNewSentAt } = await bootstrap(run, env, now, {
      decide: (params) => selectPermissionOption(params?.options, decision),
    });
    originProbeTiming(run, provider, sessionNewSentAt);
    const viewer = startViewer(run, env, sessionId, now);
    for (let attempt = 0; attempt < 60 && viewer.bytes() < 4_000; attempt += 1) await sleep(100);
    await sleep(4_000);
    run.expect('viewer-attached', viewer.bytes() > 0 && !viewer.exited());
    const plain = await prompt(run, controller, sessionId, 'plain', `Reply with exactly ${GROK_CENSUS_MARKER}.`, now);
    run.expect('plain-end-turn', plain.turn.stopReason === 'end_turn', plain.turn);
    run.expect('viewer-attached-echoes-user-chunk', plain.turn.userMessageEchoes > 0);
    const safe = await prompt(
      run,
      controller,
      sessionId,
      'safe-command',
      'SURFACE_SAFE run the read-only command.',
      now,
    );
    run.expect('safe-command-runs-without-permission', safe.turn.permissionRequests.length === 0, safe.turn);
    decision = 'allow';
    const allow = await prompt(run, controller, sessionId, 'mutating-allow', 'SURFACE_TOOL allow the command.', now);
    run.expect('mutating-allow-asks', allow.turn.permissionRequests.length > 0, allow.turn);
    run.expect('mutating-allow-end-turn', allow.turn.stopReason === 'end_turn', allow.turn);
    decision = 'deny';
    const deny = await prompt(run, controller, sessionId, 'mutating-deny', 'SURFACE_TOOL deny the command.', now);
    run.expect('mutating-deny-asks', deny.turn.permissionRequests.length > 0, deny.turn);
    run.expect('mutating-deny-cancelled', deny.turn.stopReason === 'cancelled', deny.turn);
    const cancel = await prompt(run, controller, sessionId, 'cancel', 'SURFACE_SLOW take your time.', now, {
      cancelAfterMs: 2_000,
    });
    run.expect('cancel-cancelled', cancel.turn.stopReason === 'cancelled', cancel.turn);
    const auth = await controller.request('_x.ai/auth/info', {}, 15_000);
    run.expect('auth-info-result', auth.result !== undefined, auth.error ?? auth.timeout);
    const listed = await controller.request('session/list', { cwd: run.root.workspace }, 15_000);
    run.expect('session-list-result', Array.isArray(listed.result?.sessions), listed.error ?? listed.timeout);
    await sleep(1_000);
    await controller.close();
    await resume(run, env, sessionId, now);
    const rendered = viewer.text();
    // Diagnostic only (terminal text is never modeled evidence): did the 1.0.70
    // viewer render the leader-routed permission choices too?
    run.observations.viewerDiagnostics = {
      bytes: viewer.bytes(),
      rendersPermissionChoices: /Yes, proceed/.test(rendered),
      rendersRememberChoice: /don't ask again/.test(rendered),
    };
    await viewer.stop();
    await stopLeader(run, leader, now);
  },

  /** A prompt typed in the native viewer still routes its permission request to the ACP controller. */
  async 'viewer-prompt'(run, provider, now) {
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '0' } });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: decideAllow });
    const viewer = startViewer(run, env, sessionId, now);
    for (let attempt = 0; attempt < 60 && viewer.bytes() < 4_000; attempt += 1) await sleep(100);
    await sleep(4_000);
    run.expect('viewer-attached', viewer.bytes() > 0 && !viewer.exited());
    const since = controller.frames.length;
    viewer.write('\u001b[200~SURFACE_TOOL typed in the viewer: run the command.\u001b[201~');
    await sleep(500);
    viewer.write('\r');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (updatesFor(controller.frames, '_x.ai/session_notification', 'turn_completed', since).length > 0) break;
      await sleep(100);
    }
    await sleep(2_000);
    snapshotState(run, sessionId, 'viewer-turn:settled', now);
    const window = controller.frames.slice(since);
    const permissions = window.filter((frame) => frame.message.method === 'session/request_permission');
    run.observations.viewerTurn = {
      permissionRequestsToController: permissions.length,
      controllerAnsweredPermission: window.some(
        (frame) => frame.direction === 'client-to-agent' && frame.message.result?.outcome !== undefined,
      ),
      turnCompletedNotifications: updatesFor(window, '_x.ai/session_notification', 'turn_completed').length,
      userMessageEchoes: updatesFor(window, 'session/update', 'user_message_chunk').length,
    };
    run.expect('viewer-prompt-permission-reaches-controller', permissions.length > 0, run.observations.viewerTurn);
    run.expect(
      'viewer-prompt-turn-completes',
      run.observations.viewerTurn.turnCompletedNotifications > 0,
      run.observations.viewerTurn,
    );
    await controller.close();
    await viewer.stop();
    await stopLeader(run, leader, now);
  },

  /** No viewer: plain turn, `/compact`, plain turn, then resume. */
  async 'headless-compact'(run, provider, now) {
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '0' } });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: decideAllow });
    const first = await prompt(run, controller, sessionId, 'plain', `Reply with exactly ${GROK_CENSUS_MARKER}.`, now);
    run.expect('plain-end-turn', first.turn.stopReason === 'end_turn', first.turn);
    const compact = await prompt(run, controller, sessionId, 'compact', '/compact', now, { settleMs: 3_000 });
    run.expect('compact-result', compact.result.result !== undefined, compact.turn);
    run.expect(
      'compact-completes',
      updatesFor(controller.frames, '_x.ai/session_notification', 'auto_compact_completed').length > 0,
    );
    const after = await prompt(
      run,
      controller,
      sessionId,
      'after-compact',
      `Reply with ${GROK_CENSUS_MARKER} again.`,
      now,
    );
    run.expect('after-compact-end-turn', after.turn.stopReason === 'end_turn', after.turn);
    run.observations.headlessUserMessageEchoes = first.turn.userMessageEchoes + after.turn.userMessageEchoes;
    await controller.close();
    await resume(run, env, sessionId, now);
    await stopLeader(run, leader, now);
  },

  /** Subagents enabled: the spawn asks permission, and the child's traffic reaches the parent controller. */
  async subagent(run, provider, now) {
    writeFileSync(join(run.root.grokHome, 'config.toml'), grokCensusConfig(provider.baseUrl, { subagents: true }));
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '1' } });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: decideAllow });
    const delegated = await prompt(run, controller, sessionId, 'delegate', 'SURFACE_SUBAGENT delegate this.', now, {
      settleMs: 6_000,
    });
    run.expect('subagent-spawn-asks', delegated.turn.permissionRequests.length > 0, delegated.turn);
    run.expect(
      'subagent-spawned',
      updatesFor(controller.frames, '_x.ai/session_notification', 'subagent_spawned').length > 0,
    );
    run.expect(
      'subagent-finished',
      updatesFor(controller.frames, '_x.ai/session_notification', 'subagent_finished').length > 0,
    );
    run.expect('child-session-traffic-on-parent', delegated.turn.childSessionFrames > 0, delegated.turn);
    await controller.close();
    await resume(run, env, sessionId, now);
    await stopLeader(run, leader, now);
  },

  /** Configured command hooks: live hook_run_started/hook_execution and durable hook records. */
  async hooks(run, provider, now) {
    writeFileSync(join(run.root.grokHome, 'config.toml'), grokCensusConfig(provider.baseUrl, { hooks: true }));
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '0' } });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: decideAllow });
    await prompt(run, controller, sessionId, 'plain', `Reply with exactly ${GROK_CENSUS_MARKER}.`, now);
    const tool = await prompt(run, controller, sessionId, 'mutating-allow', 'SURFACE_TOOL allow the command.', now);
    run.expect('hooks-mutating-allow-asks', tool.turn.permissionRequests.length > 0, tool.turn);
    run.expect(
      'hook-run-started-live',
      updatesFor(controller.frames, '_x.ai/session_notification', 'hook_run_started').length > 0,
    );
    run.expect(
      'hook-execution-live',
      updatesFor(controller.frames, '_x.ai/session_notification', 'hook_execution').length > 0,
    );
    await controller.close();
    await resume(run, env, sessionId, now);
    await stopLeader(run, leader, now);
  },

  /** GROK_REMEMBER_TOOL_APPROVALS=0 removes the persisting `*_always` choices. */
  async 'approvals-remembered-off'(run, provider, now) {
    const env = isolatedGrokEnvironment(run.root, {
      baseUrl: provider.baseUrl,
      extra: { GROK_SUBAGENTS: '0', GROK_REMEMBER_TOOL_APPROVALS: '0' },
    });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: decideAllow });
    const tool = await prompt(run, controller, sessionId, 'mutating-allow', 'SURFACE_TOOL allow the command.', now);
    const options = tool.turn.permissionRequests[0]?.options ?? [];
    run.expect('remembered-off-asks', tool.turn.permissionRequests.length > 0, tool.turn);
    run.expect(
      'remembered-off-has-no-always-choices',
      options.length > 0 && options.every((option) => !option.endsWith('_always')),
      options,
    );
    await controller.close();
    await stopLeader(run, leader, now);
  },
};

// ---------------------------------------------------------------------------
// Approval-ownership probe: who answers a leader-routed permission request
// ---------------------------------------------------------------------------

const LEADER_UNKNOWN_RESPONSE = /received response for unknown request id/;

function leaderUnknownResponses(run) {
  const path = join(run.dir, 'leader.stderr.txt');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => LEADER_UNKNOWN_RESPONSE.test(line)).length;
}

function permissionRuleEntries(root) {
  const sessions = join(root.grokHome, 'sessions');
  if (!existsSync(sessions)) return [];
  return readdirSync(sessions, { recursive: true, encoding: 'utf8' })
    .filter((entry) => /^permission__.*\.toml$/.test(entry.split('/').pop() ?? ''))
    .sort();
}

function permissionRuleCount(root) {
  return permissionRuleEntries(root).length;
}

/**
 * Where each persisted rule lives, and whose argv names it, without its name:
 * the directory relative to GROK_HOME/sessions as `<cwd>` (the workspace
 * bucket) or `<cwd>/<session>`, and the client whose launch argv the file name
 * embeds (`controller` for `… stdio`, `viewer` for `… --resume <id>`). The
 * file is never copied or read.
 */
function permissionRuleShapes(root, sessionId) {
  const sessionDir = sessionDirectory(root, sessionId);
  const sessionsRoot = join(root.grokHome, 'sessions');
  const bucket = sessionDir ? relative(sessionsRoot, dirname(sessionDir)) : undefined;
  const session = sessionDir ? relative(sessionsRoot, sessionDir) : undefined;
  return permissionRuleEntries(root).map((entry) => {
    const directory = dirname(entry);
    const name = entry.split('/').pop() ?? '';
    return {
      location:
        directory === bucket ? 'sessions/<cwd>' : directory === session ? 'sessions/<cwd>/<session>' : 'elsewhere',
      namedFor: /stdio/.test(name) ? 'controller' : /resume/.test(name) ? 'viewer' : 'unknown',
    };
  });
}

/**
 * Order-preserving, sanitized digest of controller frames: methods, update
 * kinds, and enum values only. Request ids become the role they play, option
 * ids become their ACP kind, and nothing user-, path-, or token-bearing is kept.
 */
function frameShapes(frames, roles, options, rootSessionId) {
  const optionKind = new Map((options ?? []).map((option) => [option.optionId, option.kind]));
  const shapes = [];
  for (const frame of frames) {
    const message = frame.message;
    const params = message.params ?? {};
    // A subagent child's own traffic reaches the parent controller under the
    // child sessionId; it is summarized as one counted shape, not replayed.
    const foreign =
      rootSessionId !== undefined && typeof params.sessionId === 'string' && params.sessionId !== rootSessionId;
    if (foreign) {
      const previous = shapes[shapes.length - 1];
      if (previous?.childSessionFrames !== undefined) previous.childSessionFrames += 1;
      else shapes.push({ direction: frame.direction, childSessionFrames: 1 });
      continue;
    }
    const update = params.update ?? {};
    const initiator = typeof message.method === 'string' ? frame.direction : `reply:${frame.direction}`;
    const shape = { direction: frame.direction };
    if (typeof message.method === 'string') shape.method = message.method;
    if (message.id !== undefined) {
      const key =
        initiator === 'agent-to-client' || initiator === 'reply:client-to-agent'
          ? `agent:${message.id}`
          : `client:${message.id}`;
      shape.id = roles.get(key) ?? 'other';
      if (typeof message.method !== 'string') shape.reply = true;
    }
    if (typeof update.sessionUpdate === 'string') shape.sessionUpdate = update.sessionUpdate;
    if (typeof update.kind === 'string' && update.sessionUpdate === 'pending_interaction') shape.kind = update.kind;
    if (typeof update.status === 'string') shape.status = update.status;
    if (typeof update._meta?.toolNotRun === 'string') shape.toolNotRun = update._meta.toolNotRun;
    const stopReason = message.result?.stopReason ?? update.stop_reason;
    if (typeof stopReason === 'string') shape.stopReason = stopReason;
    const category = params._meta?.cancellationCategory ?? message.result?._meta?.cancellationCategory;
    if (typeof category === 'string') shape.cancellationCategory = category;
    const outcome = message.result?.outcome;
    if (outcome && typeof outcome.outcome === 'string') {
      shape.outcome = outcome.outcome;
      if (typeof outcome.optionId === 'string') shape.optionKind = optionKind.get(outcome.optionId) ?? 'unknown';
    }
    if (message.method === '$/cancel_request') {
      shape.cancels = roles.get(`agent:${params.requestId}`) ?? roles.get(`client:${params.requestId}`) ?? 'other';
    }
    if (message.error) shape.errorCode = message.error.code;
    const previous = shapes[shapes.length - 1];
    if (
      previous &&
      JSON.stringify({ ...previous, count: undefined }) === JSON.stringify({ ...shape, count: undefined })
    ) {
      previous.count = (previous.count ?? 1) + 1;
    } else {
      shapes.push(shape);
    }
  }
  return shapes;
}

function keyLabel(key) {
  return { '\r': 'Enter', '\u0003': 'Ctrl+C', '\u001b': 'Esc' }[key] ?? key;
}

/**
 * One deferred-permission case. The controller leaves the request open; the
 * viewer receives `keys` (control input only, sent one at a time until native
 * evidence shows the request resolved) or the controller acts (`cancel`). The
 * outcome is read from ACP frames and the workspace, never from terminal text.
 * Afterwards the controller answers the stale request (`lateDecision`) to see
 * whether the leader ignores a second answer.
 */
async function deferredPermissionCase(
  run,
  controller,
  viewer,
  sessionId,
  now,
  { label, text, keys = [], beforeInput, cancel = false, lateDecisions = [], fallbackMs = 20_000 },
) {
  const toolFile = join(run.root.workspace, 'surface-tool.txt');
  rmSync(toolFile, { force: true });
  const since = controller.frames.length;
  const deferredBefore = controller.deferred.length;
  const rulesBefore = permissionRuleCount(run.root);
  const promptId = controller.frames.length;
  const pending = controller.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 90_000);
  for (let attempt = 0; attempt < 400 && controller.deferred.length === deferredBefore; attempt += 1) await sleep(50);
  const request = controller.deferred[deferredBefore];
  run.expect(`${label}-request-reaches-controller`, request !== undefined);
  const outcome = { label, input: cancel ? 'controller session/cancel' : keys.map(keyLabel) };
  if (!request) {
    await pending;
    run.observations.approvalProbe = [...(run.observations.approvalProbe ?? []), outcome];
    return outcome;
  }
  const toolCallId = request.params?.toolCall?.toolCallId;
  const resolved = () =>
    updatesFor(controller.frames, '_x.ai/session_notification', 'interaction_resolved', request.frameIndex).some(
      (frame) => frame.message.params?.update?.tool_call_id === toolCallId,
    );
  const settled = { done: false };
  void pending.then(() => (settled.done = true));
  if (beforeInput) Object.assign(outcome, await beforeInput());
  // Timing only: give the viewer time to render its prompt before any input.
  await sleep(1_500);
  outcome.resolvedBeforeInput = resolved();
  const sentKeys = [];
  if (cancel) {
    controller.notify('session/cancel', { sessionId });
  } else {
    for (const key of keys) {
      if (resolved() || settled.done) break;
      viewer.write(key);
      sentKeys.push(keyLabel(key));
      for (let attempt = 0; attempt < 40 && !resolved() && !settled.done; attempt += 1) await sleep(50);
    }
  }
  outcome.keysSent = sentKeys;
  const deadline = now() + fallbackMs;
  while (!settled.done && now() < deadline) await sleep(100);
  outcome.fallbackControllerAnswer = !settled.done;
  if (!settled.done) {
    // Nothing native resolved the request: unblock the turn from the controller.
    const optionId = selectPermissionOption(request.params.options, 'deny');
    controller.respond(request.id, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
  }
  const result = await pending;
  await sleep(1_000);
  const roles = new Map([
    [`agent:${request.id}`, 'permission-request'],
    [`client:${controller.frames[promptId]?.message?.id}`, 'prompt'],
  ]);
  outcome.requestOptions = (request.params.options ?? []).map((option) => option.kind);
  outcome.requestTool = request.params.toolCall?._meta?.['x.ai/tool']?.name ?? null;
  outcome.framesFromPrompt = frameShapes(controller.frames.slice(since), roles, request.params.options, sessionId);
  outcome.stopReason = result.result?.stopReason ?? null;
  outcome.interactionResolved = resolved();
  outcome.toolRan = existsSync(toolFile);
  outcome.permissionRuleFilesWritten = permissionRuleCount(run.root) - rulesBefore;
  if (outcome.permissionRuleFilesWritten > 0) outcome.permissionRules = permissionRuleShapes(run.root, sessionId);
  outcome.controllerCancelRequests = controller.frames
    .slice(since)
    .filter((frame) => frame.direction === 'agent-to-client' && frame.message.method === '$/cancel_request').length;
  // The stale request is answered after the native resolution: first the
  // `cancelled` outcome a deferring adapter sends, then an opposite decision.
  outcome.lateControllerAnswers = [];
  for (const decision of outcome.fallbackControllerAnswer ? [] : lateDecisions) {
    const unknownBefore = leaderUnknownResponses(run);
    const lateIndex = controller.frames.length;
    const optionId = decision === 'cancelled' ? undefined : selectPermissionOption(request.params.options, decision);
    controller.respond(request.id, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
    await sleep(2_000);
    outcome.lateControllerAnswers.push({
      decision,
      framesAfter: frameShapes(controller.frames.slice(lateIndex + 1), roles, request.params.options, sessionId),
      leaderLoggedUnknownResponse: leaderUnknownResponses(run) > unknownBefore,
      toolRanAfter: existsSync(toolFile),
    });
  }
  run.observations.approvalProbe = [...(run.observations.approvalProbe ?? []), outcome];
  return outcome;
}

const DEFER = () => DEFER_PERMISSION;

export const GROK_APPROVAL_PROBES = {
  /** The viewer answers (allow, reject), the controller cancels, and the viewer interrupts a pending request. */
  async 'viewer-answers'(run, provider, now) {
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '0' } });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: DEFER });
    const viewer = startViewer(run, env, sessionId, now);
    for (let attempt = 0; attempt < 60 && viewer.bytes() < 4_000; attempt += 1) await sleep(100);
    await sleep(4_000);
    run.expect('viewer-attached', viewer.bytes() > 0 && !viewer.exited());
    const common = { run, controller, viewer, sessionId, now };
    const go = (options) =>
      deferredPermissionCase(common.run, common.controller, common.viewer, common.sessionId, common.now, options);
    const late = (decision) => ['cancelled', decision];
    await go({
      label: 'viewer-allow-once',
      text: 'SURFACE_TOOL allow it.',
      keys: ['2', '\r'],
      lateDecisions: late('deny'),
    });
    await go({
      label: 'viewer-reject-once',
      text: 'SURFACE_TOOL reject it.',
      keys: ['3', '\r'],
      lateDecisions: late('allow'),
    });
    await go({
      label: 'controller-cancel',
      text: 'SURFACE_TOOL cancel it.',
      cancel: true,
      lateDecisions: late('allow'),
    });
    await go({
      label: 'viewer-interrupt',
      text: 'SURFACE_TOOL interrupt it.',
      keys: ['\u0003'],
      lateDecisions: late('allow'),
    });
    const healthy = await prompt(run, controller, sessionId, 'after-probes', `Reply with ${GROK_CENSUS_MARKER}.`, now);
    run.expect('session-usable-after-probes', healthy.turn.stopReason === 'end_turn', healthy.turn);
    await controller.close();
    await viewer.stop();
    await stopLeader(run, leader, now);
  },

  /** Subagents enabled: the person approves the 1.0.70 spawn_subagent request in the viewer. */
  async 'viewer-answers-spawn'(run, provider, now) {
    writeFileSync(join(run.root.grokHome, 'config.toml'), grokCensusConfig(provider.baseUrl, { subagents: true }));
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '1' } });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: DEFER });
    const viewer = startViewer(run, env, sessionId, now);
    for (let attempt = 0; attempt < 60 && viewer.bytes() < 4_000; attempt += 1) await sleep(100);
    await sleep(4_000);
    run.expect('viewer-attached', viewer.bytes() > 0 && !viewer.exited());
    const spawn = await deferredPermissionCase(run, controller, viewer, sessionId, now, {
      label: 'viewer-allow-spawn',
      text: 'SURFACE_SUBAGENT delegate this.',
      keys: ['1', '\r'],
      lateDecisions: ['cancelled'],
    });
    await sleep(4_000);
    spawn.subagentSpawned = updatesFor(controller.frames, '_x.ai/session_notification', 'subagent_spawned').length > 0;
    await controller.close();
    await viewer.stop();
    await stopLeader(run, leader, now);
  },

  /**
   * The person chooses "don't ask again" (allow_always) in the viewer: one
   * persisted rule, which then answers the next matching request before any
   * client is asked. Its own session, so the standing rule touches no other case.
   */
  async 'viewer-answers-always'(run, provider, now) {
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '0' } });
    let deferring = true;
    // Only the first request is left to the viewer; any later one is a rule
    // that did not apply, and the controller denies it so the turn ends.
    const { leader, controller, sessionId } = await bootstrap(run, env, now, {
      decide: (params) => (deferring ? DEFER_PERMISSION : selectPermissionOption(params?.options, 'deny')),
    });
    const viewer = startViewer(run, env, sessionId, now);
    for (let attempt = 0; attempt < 60 && viewer.bytes() < 4_000; attempt += 1) await sleep(100);
    await sleep(4_000);
    run.expect('viewer-attached', viewer.bytes() > 0 && !viewer.exited());
    const always = await deferredPermissionCase(run, controller, viewer, sessionId, now, {
      label: 'viewer-allow-always',
      text: 'SURFACE_TOOL allow it from now on.',
      keys: ['1', '\r'],
      lateDecisions: ['cancelled'],
    });
    deferring = false;
    const toolFile = join(run.root.workspace, 'surface-tool.txt');
    rmSync(toolFile, { force: true });
    const rulesBefore = permissionRuleCount(run.root);
    const again = await prompt(run, controller, sessionId, 'after-allow-always', 'SURFACE_TOOL run it again.', now);
    always.followUp = {
      permissionRequests: again.turn.permissionRequests.length,
      toolRan: existsSync(toolFile),
      stopReason: again.turn.stopReason,
      permissionRuleFilesWritten: permissionRuleCount(run.root) - rulesBefore,
    };
    run.expect('allow-always-persists-one-rule', always.permissionRuleFilesWritten === 1, always.permissionRules);
    run.expect(
      'allow-always-answers-the-next-request',
      always.followUp.permissionRequests === 0 && always.followUp.toolRan,
      always.followUp,
    );
    await controller.close();
    await viewer.stop();
    await stopLeader(run, leader, now);
  },

  /** No viewer when the request is issued; the viewer attaches while it is pending. */
  async 'viewer-late-join'(run, provider, now) {
    const env = isolatedGrokEnvironment(run.root, { baseUrl: provider.baseUrl, extra: { GROK_SUBAGENTS: '0' } });
    const { leader, controller, sessionId } = await bootstrap(run, env, now, { decide: DEFER });
    let viewer;
    const lateViewer = {
      write: (data) => viewer?.write(data),
    };
    await deferredPermissionCase(run, controller, lateViewer, sessionId, now, {
      label: 'viewer-attaches-while-pending',
      text: 'SURFACE_TOOL allow it once the viewer joins.',
      keys: ['2', '\r'],
      lateDecisions: ['cancelled', 'deny'],
      fallbackMs: 10_000,
      beforeInput: async () => {
        const before = controller.frames.length;
        viewer = startViewer(run, env, sessionId, now);
        for (let attempt = 0; attempt < 60 && viewer.bytes() < 4_000; attempt += 1) await sleep(100);
        await sleep(3_000);
        return {
          viewerAttachedAfterRequest: viewer.bytes() > 0 && !viewer.exited(),
          framesOnViewerAttach: frameShapes(controller.frames.slice(before), new Map(), [], sessionId),
        };
      },
    });
    await controller.close();
    await viewer?.stop();
    await stopLeader(run, leader, now);
  },
};

async function runScenario(name, { artifact, output, table = scenarios }) {
  const started = Date.now();
  const now = () => Date.now() - started;
  const run = createRun({ artifact, output, scenario: name, now });
  run.artifact = artifact;
  run.scenario = name;
  const provider = await startLoopbackProvider({ now, log: (entry) => appendJsonLine(run.files.provider, entry) });
  writeFileSync(join(run.root.grokHome, 'config.toml'), grokCensusConfig(provider.baseUrl));
  run.note(`provider ${provider.baseUrl}`);
  try {
    await table[name](run, provider, now);
  } catch (error) {
    run.expect('scenario-completed', false, error instanceof Error ? error.message : String(error));
  } finally {
    await finish(run, provider, run.children);
  }
  return run.expectations;
}

// ---------------------------------------------------------------------------
// Binary probes: version, help trees, completion grammar
// ---------------------------------------------------------------------------

const HELP_PROBES = [
  ['help-long.txt', ['help']],
  ['help-short.txt', ['--help']],
  ['agent-help.txt', ['help', 'agent']],
  ['agent-leader-help.txt', ['help', 'agent', 'leader']],
  ['agent-stdio-help.txt', ['help', 'agent', 'stdio']],
  ['leader-help.txt', ['leader', '--help']],
  ['sessions-help.txt', ['sessions', '--help']],
  ['worktree-help.txt', ['worktree', '--help']],
  ['worker-help.txt', ['worker', '--help']],
  ['memory-help.txt', ['memory', '--help']],
  ['update-help.txt', ['update', '--help']],
  ['hidden-cursor-worker-help.txt', ['cursor-worker', '--help']],
  ['hidden-workspace-help.txt', ['workspace', '--help']],
  ['leader-worker-help.txt', ['leader', 'worker', '--help']],
  ['removed-share-help.txt', ['share', '--help']],
];

// clap names the canonical option in its parse error, so a value-less (or, for
// a flag, valued) use of an alias the help does not list proves which option it
// belongs to, and its arity, without starting a session.
const PARSE_PROBES = [
  ['--print'],
  ['--effort'],
  ['--yolo=x'],
  ['--dangerously-skip-permissions=x'],
  ['--append-system-prompt'],
  ['--allowed-tools'],
  ['--allowedTools'],
  ['--disallowedTools'],
  ['--system-prompt'],
  ['--mode'],
  ['--mode', 'x'],
  ['--add-dir'],
];

function disposableProbeRoot() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'gp')));
  const root = {
    home: join(base, 'home'),
    grokHome: join(base, 'grok-home'),
    workspace: join(base, 'workspace'),
    tmp: join(base, 'tmp'),
  };
  for (const path of Object.values(root)) mkdirSync(path, { recursive: true, mode: 0o700 });
  return { base, root };
}

/** `grok --version` in a disposable home; refuses any artifact that is not the requested release. */
export function probeVersion(artifact, version) {
  const { base, root } = disposableProbeRoot();
  try {
    const env = isolatedGrokEnvironment(root, { baseUrl: 'http://127.0.0.1:9/v1' });
    const result = spawnSync(artifact, ['--version'], { cwd: root.workspace, env, encoding: 'utf8', timeout: 30_000 });
    const versionOutput = result.stdout?.trim() ?? '';
    if (!versionOutput.startsWith(`grok ${version} (`)) {
      throw new Error(`artifact reports "${versionOutput}", expected grok ${version}`);
    }
    return versionOutput;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export function runProbes({ artifact, version, probes, sourceUrl }) {
  freshDirectory(probes);
  const { base, root } = disposableProbeRoot();
  const env = isolatedGrokEnvironment(root, { baseUrl: 'http://127.0.0.1:9/v1', extra: { NO_COLOR: '1' } });
  const scrub = (text) => text.split(base).join('<disposable-root>');
  const exec = (args) => {
    const result = spawnSync(artifact, args, { cwd: root.workspace, env, encoding: 'utf8', timeout: 30_000 });
    return { status: result.status, stdout: scrub(result.stdout ?? ''), stderr: scrub(result.stderr ?? '') };
  };
  try {
    const versionResult = exec(['--version']);
    const versionOutput = versionResult.stdout.trim();
    if (!versionOutput.startsWith(`grok ${version} (`)) {
      throw new Error(`artifact reports "${versionOutput}", expected grok ${version}`);
    }
    writeFileSync(join(probes, 'version.txt'), `${versionOutput}\n`);
    const index = [];
    for (const [file, args] of HELP_PROBES) {
      const result = exec(args);
      writeFileSync(join(probes, file), result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''));
      index.push({ file, argv: args, exitCode: result.status });
    }
    const parse = [];
    for (const args of PARSE_PROBES) {
      const result = exec(args);
      const diagnostic = result.stderr
        .split('\n')
        .filter((line) => line.startsWith('error:') || line.trimStart().startsWith('[possible values'));
      parse.push([`$ grok ${args.join(' ')}`, ...diagnostic, `[exit ${result.status}]`].join('\n'));
      index.push({ file: 'parse-probes.txt', argv: args, exitCode: result.status });
    }
    writeFileSync(join(probes, 'parse-probes.txt'), `${parse.join('\n\n')}\n`);
    const completions = exec(['completions', 'fish']);
    if (completions.status !== 0 || !completions.stdout.includes('__fish_grok_global_optspecs')) {
      throw new Error('grok completions fish did not produce the fish grammar');
    }
    writeFileSync(join(probes, 'completions.fish'), completions.stdout);
    index.push({ file: 'completions.fish', argv: ['completions', 'fish'], exitCode: completions.status });
    const stat = statSync(artifact);
    writeJson(join(probes, 'artifact.json'), {
      vendor: 'grok',
      version,
      platform: `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
      artifactKind: 'standalone-executable',
      sha256: sha256File(artifact),
      bytes: stat.size,
      versionOutput,
      ...(sourceUrl ? { sourceUrl } : {}),
      probedAt: new Date().toISOString(),
      environment: 'disposable HOME/GROK_HOME, explicit environment, no network model',
      probes: index,
    });
    return { versionOutput };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/**
 * Runs the approval-ownership probe into its own gitignored raw tree and writes
 * only the sanitized semantic digest (`viewer-approvals.json`) beside the other
 * binary probes. No frame payload, id, path, or terminal byte is retained there.
 */
async function runApprovalProbe({ artifact, version, versionOutput, probes }) {
  const target = join(probes, 'viewer-approvals.json');
  if (existsSync(target)) throw new Error(`refusing to overwrite ${target}; remove it to re-probe`);
  const output = resolve(flag('--output', join(vendorRoot, 'captures-raw', `grok@${version}-approval-probe`)));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const capturedAt = new Date().toISOString();
  const results = {};
  const failures = [];
  for (const name of Object.keys(GROK_APPROVAL_PROBES)) {
    const expectations = await runScenario(name, { artifact, output, table: GROK_APPROVAL_PROBES });
    const observations = JSON.parse(readFileSync(join(output, name, 'observations.json'), 'utf8'));
    results[name] = { cases: observations.approvalProbe ?? [], expectations };
    failures.push(...expectations.filter((entry) => !entry.ok).map((entry) => `${name}: ${entry.id}`));
  }
  writeJson(target, {
    probe: 'viewer-approvals',
    vendor: 'grok',
    version,
    versionOutput,
    artifactSha256: sha256File(artifact),
    harness: 'packages/surface/vendors/grok/census/harness.mjs --approval-probe',
    capturedAt,
    topology:
      'one leader, one ACP controller that leaves session/request_permission unanswered, and the native viewer (grok --leader --resume) in a PTY; loopback model provider; disposable HOME/GROK_HOME',
    method:
      'Viewer keystrokes are control input only. Each outcome is read from the controller’s ACP frames, the workspace file the mutating command writes, and the persisted-rule count and location; terminal text is never consulted, and no rule file is copied or read.',
    probes: results,
  });
  if (failures.length > 0) {
    console.error(`${failures.length} approval-probe expectation(s) failed:\n  ${failures.join('\n  ')}`);
    if (!process.argv.includes('--allow-failures')) process.exitCode = 1;
  } else {
    console.log(`approval probe complete -> ${target}`);
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const artifact = resolve(flag('--artifact') ?? '');
  const version = flag('--version');
  if (!flag('--artifact') || !version) throw new Error('--artifact and --version are required');
  if (!existsSync(artifact)) throw new Error(`artifact does not exist: ${artifact}`);
  const probes = resolve(flag('--probes', join(vendorRoot, 'probes', `grok@${version}`)));
  const output = resolve(flag('--output', join(vendorRoot, 'captures-raw', `grok@${version}`)));
  const selected = (flag('--scenario') ?? GROK_CENSUS_SCENARIOS.join(',')).split(',').filter(Boolean);
  for (const name of selected) if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);

  const versionOutput = probeVersion(artifact, version);
  if (process.argv.includes('--approval-probe')) {
    await runApprovalProbe({ artifact, version, versionOutput, probes });
  } else if (!process.argv.includes('--skip-probes')) {
    runProbes({ artifact, version, probes, sourceUrl: flag('--source-url') });
    console.log(`wrote probes to ${probes}`);
  }
  if (!process.argv.includes('--probes-only') && !process.argv.includes('--approval-probe')) {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const failures = [];
    const report = {
      vendor: 'grok',
      version,
      versionOutput,
      artifactSha256: sha256File(artifact),
      platform: `${process.platform}-${process.arch}`,
      harness: 'packages/surface/vendors/grok/census/harness.mjs',
      capturedAt: new Date().toISOString(),
      scenarios: {},
    };
    for (const name of selected) {
      const expectations = await runScenario(name, { artifact, output });
      report.scenarios[name] = expectations;
      failures.push(...expectations.filter((entry) => !entry.ok).map((entry) => `${name}: ${entry.id}`));
    }
    writeJson(join(output, 'harness.json'), report);
    if (failures.length > 0) {
      console.error(`${failures.length} census expectation(s) failed:\n  ${failures.join('\n  ')}`);
      if (!process.argv.includes('--allow-failures')) process.exitCode = 1;
    } else {
      console.log(`census complete: ${selected.length} scenario(s) -> ${output}`);
    }
  }
}
