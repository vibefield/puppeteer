/**
 * Does the Codex app-server start a resumed thread at a resume's model and effort?
 *
 * Hermetic: an empty CODEX_HOME (no account), stdio app-servers, no turn, so no
 * inference. One server starts a thread at the first listed model and
 * materializes it (empty inject_items, as the adapter does); a second, fresh
 * server resumes it with `model` and `config.model_reasoning_effort`, as the
 * adapter's observer now does; a third resumes it with nothing, to read what the
 * thread kept. Usage: node codex-resume-overrides.mjs <scratch-dir> [codex]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const scratch = realpathSync(process.argv[2] ?? '.');
const executable = process.argv[3] ?? 'codex';
const home = join(scratch, 'codex-home');
const cwd = join(scratch, 'workspace');
mkdirSync(home, { recursive: true });
mkdirSync(cwd, { recursive: true });

function server() {
  const child = spawn(executable, ['app-server'], {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let next = 1;
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const open = async () => {
    await request('initialize', { clientInfo: { name: 'resume-overrides-probe', version: '0' }, capabilities: {} });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
  };
  const close = () =>
    new Promise((resolve) => {
      child.once('exit', resolve);
      child.stdin.end();
      setTimeout(() => child.kill('SIGTERM'), 2_000).unref();
    });
  return { request, open, close };
}

const settings = (result) => {
  const { thread, ...rest } = result ?? {};
  return { ...rest, threadId: thread?.id };
};

const version = await new Promise((resolve) => {
  const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.on('exit', () => resolve(out.trim()));
});

const first = server();
await first.open();
const list = await first.request('model/list', {});
const models = (list?.data ?? []).filter((model) => (model.supportedReasoningEfforts ?? []).length > 0);
if (models.length < 2) throw new Error('need two listed models with reasoning efforts');
const [started, chosen] = models;
const chosenEffort = chosen.supportedReasoningEfforts.at(-1).reasoningEffort;
const start = await first.request('thread/start', { cwd, model: started.model });
const threadId = start.thread.id;
await first.request('thread/inject_items', { threadId, items: [{ type: 'text', text: '' }] });
await first.close();

const second = server();
await second.open();
const resumed = await second.request('thread/resume', {
  threadId,
  model: chosen.model,
  config: { model_reasoning_effort: chosenEffort },
});
await second.close();

const third = server();
await third.open();
const plain = await third.request('thread/resume', { threadId });
await third.close();

const record = {
  probedAt: new Date().toISOString(),
  codex: version,
  started: { model: started.model },
  asked: { model: chosen.model, effort: chosenEffort },
  'thread/start': settings(start),
  'thread/resume with overrides': settings(resumed),
  'thread/resume without overrides (fresh server)': settings(plain),
};
writeFileSync(join(scratch, 'codex-resume-overrides.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
