// Runtime evidence for the model-provider admission rust-v0.166.0 adds (findings C9): `thread/resume` of a
// thread saved on another provider, and input to a loaded thread whose configured provider changed.
//
//   node provider-mismatch-probe.mjs --version <semver> --package-root <extracted release package> [<results.json>]
//
// Source (rust-v0.166.0): `ConfigManager::load_for_resume` and `check_thread_model_provider_for_input`
// (app-server/src/config_manager.rs) refuse with a `ModelProviderError`, which `config_load_error`
// (request_processors/config_errors.rs) returns as JSON-RPC -32600 with the error serialized as `data`.
//
// Three cases, each in its own throwaway HOME and CODEX_HOME with the census's allowlisted environment and a
// loopback Responses endpoint (no account, no network model):
//   mismatch       — app-server A (`model_provider = "fake"`) runs one turn; app-server B on the same home
//                    selects `other` (also configured) and resumes the thread.
//   notConfigured  — the same, but B configures only `other`, so the saved `fake` is not configured at all.
//   inputMismatch  — one app-server reads `model_provider` from config.toml; after one turn the file selects
//                    `other`, and the same connection sends `turn/start` again.
// Every value recorded is the probe's own synthetic content (provider ids `fake` and `other`); paths and ids
// are not recorded.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_VERSION,
  censusEnvironment,
  codexArtifactIdentity,
  resolveCodexExecutable,
} from '../../census/harness.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const output = argv.find((value, index) => !value.startsWith('--') && !argv[index - 1]?.startsWith('--'));

const executable = resolveCodexExecutable({ bin: flag('--bin'), packageRoot: flag('--package-root') });
const identity = codexArtifactIdentity(executable);
if (identity.versionOutput !== `codex-cli ${CODEX_VERSION}`) {
  throw new Error(`${executable} reports "${identity.versionOutput}", not codex-cli ${CODEX_VERSION}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loopback() {
  let turn = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      turn += 1;
      const item = {
        type: 'message',
        role: 'assistant',
        id: `msg_${turn}`,
        content: [{ type: 'output_text', text: 'ok' }],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: `resp_${turn}`, output: [] } });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', {
        response: { id: `resp_${turn}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [item] },
      });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

const providerLines = (ids, url) =>
  ids.flatMap((id) => [
    `[model_providers.${id}]`,
    `name = "${id}"`,
    `base_url = "${url}"`,
    'wire_api = "responses"',
    'env_key = "FAKE_KEY"',
  ]);

function appServer(env, cwd, args = []) {
  const child = spawn(executable, ['app-server', ...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const messages = [];
  let buffer = '';
  let exited = false;
  child.on('exit', () => (exited = true));
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      try {
        if (line) messages.push(JSON.parse(line));
      } catch {
        // not protocol
      }
    }
  });
  let nextId = 1;
  const waitFor = async (predicate, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && !exited && Date.now() < deadline) await wait(50);
    return predicate();
  };
  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    await waitFor(() => messages.some((m) => m.id === id && m.method === undefined));
    return messages.find((m) => m.id === id && m.method === undefined);
  };
  const open = async () => {
    await request('initialize', { clientInfo: { name: 'puppeteer-census', version: '0.0.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    await wait(300);
  };
  const turn = async (threadId) => {
    const before = messages.filter((m) => m.method === 'turn/completed').length;
    const answer = await request('turn/start', { threadId, input: [{ type: 'text', text: 'say ok' }] });
    if (!answer?.error) await waitFor(() => messages.filter((m) => m.method === 'turn/completed').length > before);
    return answer;
  };
  const close = async () => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    await waitFor(() => exited, 5000);
  };
  return { open, request, turn, close, messages };
}

/**
 * What a JSON-RPC answer says, without paths or ids. The error text is a display string (the source's
 * `Display` for `ModelProviderError`), kept as a digest: the privacy rules treat `message` as free text.
 */
function answerOf(answer) {
  if (!answer) return { answered: false };
  if (answer.error) {
    const { code, message, data } = answer.error;
    const messageSha256 = createHash('sha256')
      .update(String(message ?? ''))
      .digest('hex')
      .slice(0, 16);
    return { answered: true, error: { code, messageSha256, data: data ?? null } };
  }
  return { answered: true, result: true };
}

async function inHome(run) {
  const root = mkdtempSync(join(tmpdir(), 'codex-provider-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const env = censusEnvironment(home, process.env, { executable });
  mkdirSync(env.CODEX_HOME, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(env.CODEX_HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-not-a-real-key' }));
  const provider = await loopback();
  try {
    return await run({ env, cwd, url: provider.url, config: join(env.CODEX_HOME, 'config.toml') });
  } finally {
    await provider.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** A resume on app-server B of a thread app-server A saved on provider `fake`. */
const coldResume = (secondProviders) =>
  inHome(async ({ env, cwd, url, config }) => {
    writeFileSync(config, `${['model_provider = "fake"', ...providerLines(['fake', 'other'], url)].join('\n')}\n`);
    const a = appServer(env, cwd);
    let threadId;
    let firstTurn;
    try {
      await a.open();
      const started = await a.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never' });
      threadId = started?.result?.thread?.id;
      firstTurn = answerOf(await a.turn(threadId));
    } finally {
      await a.close();
    }
    writeFileSync(config, `${['model_provider = "other"', ...providerLines(secondProviders, url)].join('\n')}\n`);
    const b = appServer(env, cwd);
    try {
      await b.open();
      const resumed = await b.request('thread/resume', { threadId, excludeTurns: true });
      return { firstTurn, resume: answerOf(resumed) };
    } finally {
      await b.close();
    }
  });

const inputMismatch = () =>
  inHome(async ({ env, cwd, url, config }) => {
    writeFileSync(config, `${['model_provider = "fake"', ...providerLines(['fake', 'other'], url)].join('\n')}\n`);
    const server = appServer(env, cwd);
    try {
      await server.open();
      const started = await server.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never' });
      const threadId = started?.result?.thread?.id;
      const firstTurn = answerOf(await server.turn(threadId));
      writeFileSync(config, `${['model_provider = "other"', ...providerLines(['fake', 'other'], url)].join('\n')}\n`);
      const secondTurn = answerOf(await server.turn(threadId));
      const loadedResume = answerOf(await server.request('thread/resume', { threadId, excludeTurns: true }));
      return { firstTurn, secondTurn, loadedResume };
    } finally {
      await server.close();
    }
  });

const results = {
  codex: CODEX_VERSION,
  probe: `probes/codex@${CODEX_VERSION}/provider-mismatch-probe.mjs`,
  artifact: { versionOutput: identity.versionOutput, executableSha256: identity.executable.sha256 },
  mismatch: await coldResume(['fake', 'other']),
  notConfigured: await coldResume(['other']),
  inputMismatch: await inputMismatch(),
};
const serialized = `${JSON.stringify(results, null, 2)}\n`;
if (output) writeFileSync(output, serialized);
process.stdout.write(serialized);
