#!/usr/bin/env node
/**
 * The codex census harness (docs/archive/EMULATOR.md §2, docs/archive/IMPOSTER.md §9; findings C1d, C8).
 *
 * Drives a real `codex app-server` against a FAKE local model provider and
 * records every app-server message. No account, no network, no tokens — so the
 * census is reproducible in CI rather than being a live-credential gamble.
 *
 * Four things had to be true for this to work, all established in C1d and none
 * of them guessable:
 *
 *  1. `response.completed` must carry `usage.total_tokens`, or codex drops the
 *     stream with "failed to parse ResponseCompleted".
 *  2. `exec` is a CUSTOM tool whose input is raw JavaScript, evaluated in a V8
 *     isolate. Nested tools hang off a global `tools` object.
 *  3. `exec_command`'s `cmd` is a STRING, not an argv array. An array fails with
 *     "invalid type: sequence, expected a string" — in the LOG only, never on
 *     the protocol, which is what made this invisible for two sessions.
 *  4. Trusted commands are auto-approved even under `approvalPolicy: untrusted`,
 *     so eliciting an approval needs a non-allowlisted command (`curl`) under a
 *     `read-only` sandbox.
 *
 * A fifth, found at 0.164.0 (C8): the `exec` isolate runs in a separate
 * executable, `codex-code-mode-host`, which the release PACKAGE ships beside
 * `bin/codex`. The standalone executable alone still answers every protocol
 * request, but every tool turn silently degrades to a plain assistant message
 * (the router logs "failed to spawn code-mode host"). So run the census against
 * an extracted package (`--package-root <dir>`), and every scenario declares
 * what it must observe: a missing item, server request or result, a router
 * error, or a `warning`/`error` notification fails the run and nothing is
 * written to the capture directory.
 *
 * Each run is hermetic: a throwaway HOME and CODEX_HOME, a throwaway working
 * directory, and an allowlisted environment — never the caller's whole
 * environment, which may hold credentials.
 *
 * usage: node harness.mjs [--version <semver>] [--package-root <dir> | --bin <codex>] [--out <dir>]
 *                         [--scenario <name>]
 *
 * The executable is `--bin`, else `<package-root>/bin/codex`, else
 * `$PUPPETEER_CODEX_BIN`; with none of them nothing runs. It is never looked up
 * on PATH, where the operator's own codex (usually signed in) lives. Its
 * `--version` must print `codex-cli <version>`; the version is
 * `$PUPPETEER_CODEX_VERSION`, else `--version`, else the support ledger's
 * active version.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentModel } from '../../../../../scripts/agent-model-selection.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
export const CODEX_VERSION =
  process.env.PUPPETEER_CODEX_VERSION ?? flag('--version') ?? resolveAgentModel({ vendor: 'codex' }).version;

const surfaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The release package's companion executables, which live beside `bin/codex`. */
export const CODEX_COMPANIONS = ['codex-code-mode-host'];

/**
 * One provider turn. `item` is what the fake provider streams as
 * `response.output_item.done`; `null` means a plain assistant message.
 */
const assistantMessage = (turn, text = 'done') => ({
  type: 'message',
  role: 'assistant',
  id: `msg_${turn}`,
  content: [{ type: 'output_text', text }],
});

const execCall = (turn, js) => ({
  type: 'custom_tool_call',
  id: `fc_${turn}`,
  call_id: `call_${turn}`,
  status: 'completed',
  name: 'exec',
  input: js,
});

/**
 * The patch the file-change scenario applies: one added file and one updated
 * file, so both kind-dependent meanings of `FileUpdateChange.diff` occur.
 */
export const FILE_CHANGE_PATCH =
  '*** Begin Patch\n*** Add File: added.txt\n+new file line\n*** Update File: hello.txt\n@@\n-hello\n+hello world\n*** End Patch\n';
export const FILE_CHANGE_SEED = { 'hello.txt': 'hello\n' };

/** The observer's own materializing item (packages/adapter-codex/src/observation/observer.ts). */
const MATERIALIZE_ITEMS = [{ type: 'text', text: '' }];

/**
 * `expect` is what a scenario must observe for its capture to be evidence:
 * `items` — native item types on item/started|completed; `serverRequests` —
 * the exact server-request methods, in order; `methods` — notifications that
 * must occur; `results` — client requests that must have been sent (every
 * request must be answered with a result, not an error); `pagedItems` — item
 * types a `thread/turns/list` page must carry; `routerErrors` — the one router
 * error a scenario provokes on purpose. Anything else in the router log, and
 * any `warning` or `error` notification, is a failure.
 */
export const SCENARIOS = {
  /** The baseline arc: user message, assistant message, usage, rate limits. */
  turn: {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    prompt: 'say hello',
    items: [(turn) => assistantMessage(turn, 'hello from the fake provider')],
    expect: { items: ['agentMessage', 'userMessage'], serverRequests: [], methods: ['turn/completed'] },
  },
  /** A real command execution, auto-approved because `echo` is trusted. */
  'tool-exec': {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    prompt: 'echo something',
    items: [(turn) => execCall(turn, 'await tools.exec_command({cmd: "echo hello-from-codex"})')],
    expect: {
      items: ['agentMessage', 'commandExecution', 'userMessage'],
      serverRequests: [],
      methods: ['turn/completed'],
    },
  },
  /** The approval round-trip, accepted. C0 §6 #6, unobserved until 2026-08-08. */
  'approval-accept': {
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    prompt: 'fetch a page',
    reply: { decision: 'accept' },
    items: [(turn) => execCall(turn, 'await tools.exec_command({cmd: "curl -s https://example.com"})')],
    expect: {
      items: ['agentMessage', 'commandExecution', 'userMessage'],
      serverRequests: ['item/commandExecution/requestApproval'],
      methods: ['serverRequest/resolved', 'turn/completed'],
    },
  },
  /**
   * The same round-trip, denied. `decline` rather than `cancel`: both are
   * accepted, but `cancel` ends the turn while `decline` lets the agent carry
   * on, which is what "deny this command" should mean (C1d).
   */
  'approval-decline': {
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    prompt: 'fetch a page',
    reply: { decision: 'decline' },
    items: [(turn) => execCall(turn, 'await tools.exec_command({cmd: "curl -s https://example.com"})')],
    expect: {
      items: ['agentMessage', 'commandExecution', 'userMessage'],
      serverRequests: ['item/commandExecution/requestApproval'],
      methods: ['serverRequest/resolved', 'turn/completed'],
      // The declined command reaches the router as a rejected spawn.
      routerErrors: /Rejected\(\\?"rejected by user\\?"\)/,
    },
  },
  /**
   * A Codex-owned file change through the nested `tools.apply_patch`: one add
   * and one update in a seeded working directory (C8). No approval: the patch
   * stays inside the writable workspace.
   */
  'file-change': {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    prompt: 'patch the files',
    files: FILE_CHANGE_SEED,
    items: [(turn) => execCall(turn, `await tools.apply_patch(${JSON.stringify(FILE_CHANGE_PATCH)})`)],
    expect: {
      items: ['agentMessage', 'fileChange', 'userMessage'],
      serverRequests: [],
      methods: ['turn/diff/updated', 'turn/completed'],
    },
  },
  /**
   * The observer's controller-owned attach and its history read, then the
   * paginated replacement (C8). Codex 0.158.0+ answers full-history hydration
   * (`thread/resume` without `excludeTurns`, `thread/read` with `includeTurns`)
   * and also sends `deprecationNotice`; `excludeTurns` and `thread/turns/list`
   * need no experimental capability since 0.151.0. One connection throughout:
   * the thread stays loaded, as it does for the observer's own fresh attach.
   */
  'history-hydration': {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    prompt: 'say hello',
    items: [(turn) => assistantMessage(turn, 'hello from the fake provider')],
    beforeTurn: [
      { method: 'thread/inject_items', params: ({ threadId }) => ({ threadId, items: MATERIALIZE_ITEMS }) },
      { method: 'thread/resume', params: ({ threadId }) => ({ threadId }) },
    ],
    afterTurn: [
      { method: 'thread/read', params: ({ threadId }) => ({ threadId, includeTurns: true }) },
      { method: 'thread/resume', params: ({ threadId }) => ({ threadId, excludeTurns: true }) },
      {
        method: 'thread/turns/list',
        params: ({ threadId }) => ({ threadId, itemsView: 'full', sortDirection: 'asc' }),
      },
    ],
    expect: {
      items: ['agentMessage', 'userMessage'],
      serverRequests: [],
      methods: ['turn/completed'],
      results: ['thread/inject_items', 'thread/resume', 'thread/read', 'thread/turns/list'],
      pagedItems: ['agentMessage', 'userMessage'],
    },
  },
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Variables a hermetic codex child may inherit. Everything else is dropped. */
const INHERITED_ENV = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'];

const CODEX_EXECUTABLE_NAMES = ['codex', 'codex.exe'];

/**
 * The caller's PATH without the directories that provide some other `codex`.
 * The operator's own install is usually signed in and its managed daemon lives
 * in the real `~/.codex`, so nothing a hermetic child starts by name (a helper,
 * a model-chosen command) may reach it. The executable under review keeps its
 * own directory, which also holds its companions.
 */
export function hermeticPath(path, executable) {
  if (typeof path !== 'string') return undefined;
  const own = executable ? dirname(resolve(executable)) : undefined;
  return path
    .split(delimiter)
    .filter(
      (entry) =>
        entry !== '' &&
        (resolve(entry) === own || !CODEX_EXECUTABLE_NAMES.some((name) => existsSync(join(entry, name)))),
    )
    .join(delimiter);
}

export function censusEnvironment(home, source = process.env, { executable } = {}) {
  const env = {};
  for (const name of INHERITED_ENV) if (typeof source[name] === 'string') env[name] = source[name];
  if (env.PATH !== undefined) env.PATH = hermeticPath(env.PATH, executable);
  return {
    ...env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    FAKE_KEY: 'sk-not-a-real-key',
    RUST_LOG: 'codex_core=debug',
  };
}

/**
 * The executable a census, probe or drift check was told to run: `--bin`, the
 * package layout, or `$PUPPETEER_CODEX_BIN`, always as a path. `undefined` when
 * none is named, because PATH is never searched: `codex` there is the
 * operator's own install, not the artifact under review.
 */
export function explicitCodexExecutable({ bin, packageRoot, env = process.env } = {}) {
  if (bin) return resolve(bin);
  // The release package ships bin/codex.exe on Windows and bin/codex elsewhere.
  if (packageRoot) return resolve(packageRoot, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  if (env.PUPPETEER_CODEX_BIN) return resolve(env.PUPPETEER_CODEX_BIN);
  return undefined;
}

/** {@link explicitCodexExecutable}, for the tools that cannot run without one. */
export function resolveCodexExecutable(options = {}) {
  const executable = explicitCodexExecutable(options);
  if (!executable) {
    throw new Error(
      'name the codex executable under review with --bin <codex>, --package-root <dir> or PUPPETEER_CODEX_BIN; ' +
        'codex on PATH is never run',
    );
  }
  return executable;
}

/**
 * What a hand-driven probe runs: the named executable and the census
 * environment around a throwaway HOME and CODEX_HOME, removed at exit. A probe
 * that inherited the caller's environment would start threads in, and sign in
 * through, the operator's real profile.
 */
export function isolatedCodex(options = {}) {
  const executable = resolveCodexExecutable(options);
  const home = mkdtempSync(join(tmpdir(), 'codex-probe-home-'));
  const env = censusEnvironment(home, process.env, { executable });
  mkdirSync(env.CODEX_HOME, { recursive: true });
  process.once('exit', () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // A child still writing into it; it is a temp directory either way.
    }
  });
  return { executable, env, home };
}

function fileIdentity(path) {
  const bytes = readFileSync(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/**
 * Exact identity of what the census ran: version output, and the digests of the
 * executable and every companion found beside it. Paths are not recorded.
 */
export function codexArtifactIdentity(executable) {
  const scratch = mkdtempSync(join(tmpdir(), 'codex-census-version-'));
  let versionOutput;
  try {
    const env = censusEnvironment(scratch, process.env, { executable });
    mkdirSync(env.CODEX_HOME, { recursive: true });
    versionOutput = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      cwd: scratch,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const located = existsSync(executable) && statSync(executable).isFile();
  const companions = {};
  if (located) {
    for (const name of CODEX_COMPANIONS) {
      const path = join(dirname(executable), name);
      if (existsSync(path)) companions[name] = fileIdentity(path);
    }
  }
  return {
    versionOutput,
    executable: located ? { name: basename(executable), ...fileIdentity(executable) } : { name: basename(executable) },
    companions,
  };
}

/**
 * Run one scenario end to end. Returns every app-server message received, in
 * order, plus the provider request bodies (which carry the tool declarations).
 */
export async function runScenario(name, options = {}) {
  // A probe may run its own scenario through the same machinery; the census runs only SCENARIOS.
  const scenario = options.scenario ?? SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario ${name} (have: ${Object.keys(SCENARIOS).join(', ')})`);

  const executable = options.bin ?? resolveCodexExecutable();
  const root = mkdtempSync(join(tmpdir(), 'codex-census-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const env = censusEnvironment(home, process.env, { executable });
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-real-key' }));
  for (const [file, content] of Object.entries(scenario.files ?? {})) writeFileSync(join(cwd, file), content);

  const requestBodies = [];
  let turn = 0;
  const provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      turn += 1;
      try {
        requestBodies.push(JSON.parse(raw));
      } catch {
        // A body we cannot parse is still a turn; the census records the rest.
      }
      const item = scenario.items[turn - 1]?.(turn) ?? assistantMessage(turn);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: `resp_${turn}`, output: [] } });
      send('response.output_item.done', { output_index: 0, item });
      // total_tokens is REQUIRED — without it codex drops the whole stream.
      send('response.completed', {
        response: {
          id: `resp_${turn}`,
          usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
          output: [item],
        },
      });
      res.end();
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const { port } = provider.address();

  const child = spawn(
    executable,
    [
      'app-server',
      '-c',
      'model_provider="fake"',
      '-c',
      'model_providers.fake.name="fake"',
      '-c',
      `model_providers.fake.base_url="http://127.0.0.1:${port}/v1"`,
      '-c',
      'model_providers.fake.wire_api="responses"',
      '-c',
      'model_providers.fake.env_key="FAKE_KEY"',
    ],
    // Its own process group, so the helpers it spawns (the curated-plugin sync
    // among them) die with it instead of outliving the throwaway home.
    { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, detached: process.platform !== 'win32' },
  );

  const messages = [];
  // Bidirectional trace retained separately from `messages` so the legacy
  // server-output fixtures keep their shape while ASM v2 can prove the client
  // request and correlated result contracts too.
  const trace = [];
  const serverRequests = [];
  const responses = new Map();
  const send = (message) => {
    trace.push({ direction: 'client-to-agent', message });
    return child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a banner line, not protocol
      }
      messages.push(message);
      trace.push({ direction: 'agent-to-client', message });
      // A server-initiated request has BOTH id and method. Answering is the
      // whole point of the approval scenarios.
      if (message.id !== undefined && message.method) {
        serverRequests.push(message);
        const reply = scenario.reply ?? { decision: 'accept' };
        send({ id: message.id, result: reply });
      } else if (message.id !== undefined) {
        responses.set(message.id, message);
      }
    }
  });
  // A write after an early exit must surface as a failed expectation, not crash the census.
  child.stdin.on('error', () => undefined);
  let log = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (log += chunk));
  let exited = false;
  child.on('exit', () => (exited = true));

  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && !exited && Date.now() < deadline) await wait(50);
    return predicate();
  };
  let nextId = 1;
  const requested = [];
  const request = async (method, params, timeoutMs = 10_000) => {
    const id = nextId++;
    requested.push({ id, method });
    send({ id, method, params });
    await waitFor(() => responses.has(id), timeoutMs);
    return responses.get(id);
  };

  const files = {};
  try {
    await request('initialize', { clientInfo: { name: 'puppeteer-census', version: '0.0.0' } });
    send({ method: 'initialized' });
    await wait(300);
    const started = await request('thread/start', {
      cwd,
      sandbox: scenario.sandbox,
      approvalPolicy: scenario.approvalPolicy,
    });
    await waitFor(() => messages.some((message) => message.method === 'thread/started'), 3000);
    const threadId =
      started?.result?.thread?.id ??
      messages.find((message) => message.method === 'thread/started')?.params?.thread?.id;
    const context = { threadId };
    for (const entry of scenario.beforeTurn ?? []) await request(entry.method, entry.params(context));
    await request('turn/start', { threadId, input: [{ type: 'text', text: scenario.prompt }] });
    await waitFor(
      () => messages.some((message) => message.method === 'turn/completed'),
      options.turnTimeoutMs ?? 30_000,
    );
    // Usage and status notifications may trail the turn by a few milliseconds.
    await wait(750);
    for (const entry of scenario.afterTurn ?? []) await request(entry.method, entry.params(context));
    await wait(300);
    // Probes may compare what the protocol said against what landed on disk.
    for (const file of options.collectFiles ?? []) {
      const path = join(cwd, file);
      files[file] = existsSync(path) ? readFileSync(path, 'utf8') : null;
    }
  } finally {
    // The app-server syncs its curated plugins into CODEX_HOME/.tmp at startup,
    // and that sync may still be writing there: removing the home before the
    // whole group is gone races it (ENOTEMPTY), as the critic's 0.150.0 run showed.
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    await waitFor(() => exited, 5000);
    await new Promise((resolve) => provider.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return { name, messages, trace, serverRequests, requested, requestBodies, log, providerTurns: turn, files };
}

/** Item types observed, for the coverage check the ASM's confidence rests on. */
export function observedItemTypes(messages) {
  return [
    ...new Set(
      messages
        .filter((message) => message.method === 'item/started' || message.method === 'item/completed')
        .map((message) => message.params?.item?.type)
        .filter(Boolean),
    ),
  ].sort();
}

export function observedMethods(messages) {
  return [...new Set(messages.map((message) => message.method).filter(Boolean))].sort();
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Router log lines that report an error. Codex says nothing on the wire about these. */
export function routerErrors(log) {
  return stripAnsi(log)
    .split('\n')
    .filter((line) => line.includes('codex_core::tools::router') && /\bERROR\b|\berror=/.test(line))
    .map((line) => line.slice(line.indexOf('codex_core::tools::router')).trim());
}

/**
 * Everything that makes a scenario's capture unfit to be evidence. An empty
 * list is the only passing result; the CLI writes nothing when any is non-empty.
 */
export function scenarioFailures(name, result, scenario = SCENARIOS[name]) {
  const expected = scenario?.expect ?? {};
  const failures = [];
  const items = observedItemTypes(result.messages);
  for (const type of expected.items ?? []) {
    if (!items.includes(type)) failures.push(`missing ${type} item (observed: ${items.join(' ') || 'none'})`);
  }
  const methods = observedMethods(result.messages);
  for (const method of expected.methods ?? []) {
    if (!methods.includes(method)) failures.push(`missing ${method} notification`);
  }
  if (expected.serverRequests) {
    const observed = result.serverRequests.map((message) => message.method);
    if (JSON.stringify(observed) !== JSON.stringify(expected.serverRequests)) {
      failures.push(
        `server requests [${observed.join(', ')}] differ from the expected [${expected.serverRequests.join(', ')}]`,
      );
    }
  }
  const answers = new Map(
    result.messages
      .filter((message) => message.id !== undefined && message.method === undefined)
      .map((message) => [message.id, message]),
  );
  const requested = result.requested ?? [];
  for (const { id, method } of requested) {
    const answer = answers.get(id);
    if (!answer) failures.push(`${method} (id ${id}) was never answered`);
    else if (answer.error) failures.push(`${method} (id ${id}) failed: ${answer.error.message ?? 'error'}`);
  }
  for (const method of expected.results ?? []) {
    if (!requested.some((entry) => entry.method === method)) failures.push(`${method} was not sent`);
  }
  if (expected.pagedItems) {
    const page = requested
      .filter((entry) => entry.method === 'thread/turns/list')
      .map((entry) => answers.get(entry.id)?.result)
      .find(Boolean);
    const paged = new Set((page?.data ?? []).flatMap((entry) => (entry.items ?? []).map((item) => item.type)));
    for (const type of expected.pagedItems) {
      if (!paged.has(type)) failures.push(`thread/turns/list page lacks a ${type} item`);
    }
  }
  for (const message of result.messages) {
    if (message.method === 'warning' || message.method === 'error') {
      const detail = message.params?.message ?? message.params?.error?.message ?? '';
      failures.push(`${message.method} notification: ${String(detail).slice(0, 200)}`);
    }
  }
  for (const error of routerErrors(result.log)) {
    if (!expected.routerErrors?.test(error)) failures.push(`router: ${error.slice(0, 240)}`);
  }
  return failures;
}

export function scenarioSummary(result, failures) {
  return {
    messages: result.messages.length,
    serverRequests: result.serverRequests.map((message) => message.method),
    items: observedItemTypes(result.messages),
    methods: observedMethods(result.messages),
    providerTurns: result.providerTurns,
    deprecationNotices: result.messages.filter((message) => message.method === 'deprecationNotice').length,
    failures,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = flag('--scenario');
  const out = resolve(flag('--out') ?? join(surfaceRoot, 'captures-raw', `codex@${CODEX_VERSION}`));
  const executable = resolveCodexExecutable({ bin: flag('--bin'), packageRoot: flag('--package-root') });
  const identity = codexArtifactIdentity(executable);
  if (identity.versionOutput !== `codex-cli ${CODEX_VERSION}`) {
    console.error(`${executable} reports "${identity.versionOutput}", not codex-cli ${CODEX_VERSION}; nothing run.`);
    process.exit(1);
  }
  for (const name of CODEX_COMPANIONS) {
    if (!identity.companions[name]) {
      console.warn(`warning: no ${name} beside ${executable}; tool scenarios will fail (findings C8).`);
    }
  }

  const names = only ? [only] : Object.keys(SCENARIOS);
  const startedAt = new Date().toISOString();
  const results = [];
  const summaries = {};
  for (const name of names) {
    const result = await runScenario(name, { bin: executable });
    const failures = scenarioFailures(name, result);
    results.push(result);
    summaries[name] = scenarioSummary(result, failures);
    const notices = summaries[name].deprecationNotices;
    console.log(
      `${name.padEnd(18)} messages=${String(result.messages.length).padStart(3)} ` +
        `serverRequests=${result.serverRequests.length} items=[${observedItemTypes(result.messages).join(' ')}]` +
        (notices ? ` deprecationNotices=${notices}` : ''),
    );
    for (const failure of failures) console.log(`  FAIL ${failure}`);
  }

  const failed = names.filter((name) => summaries[name].failures.length > 0);
  // A degraded scenario must never reach the capture directory, where the
  // sanitizer would promote it to evidence. Its output goes beside it instead.
  const target = failed.length > 0 ? `${out}.failed` : out;
  mkdirSync(target, { recursive: true });
  for (const result of results) {
    writeFileSync(
      join(target, `${result.name}.jsonl`),
      `${result.messages.map((m) => JSON.stringify(m)).join('\n')}\n`,
    );
    writeFileSync(
      join(target, result.name === 'turn' ? 'protocol-roundtrip.jsonl' : `protocol-${result.name}.jsonl`),
      `${result.trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
  }
  // The run record stays raw: it names no path, but it is not a native capture.
  writeFileSync(
    join(target, 'census-run.json'),
    `${JSON.stringify(
      {
        vendor: 'codex',
        vendorVersion: CODEX_VERSION,
        platform: `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
        startedAt,
        harness: 'packages/surface/vendors/codex/census/harness.mjs',
        ...identity,
        status: failed.length > 0 ? 'failed' : 'passed',
        scenarios: summaries,
      },
      null,
      2,
    )}\n`,
  );
  if (failed.length > 0) {
    console.error(`\n${failed.length} scenario(s) failed: ${failed.join(', ')}. Diagnostics -> ${target}`);
    console.error('Nothing was written to the capture directory.');
    process.exit(1);
  }
  console.log(`\nraw captures -> ${out}`);
  console.log('These are VERBATIM and gitignored. Sanitize before committing (surface/census/sanitize.mjs).');
}
