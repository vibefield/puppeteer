// Metadata-only native-agent probes. No prompt/turn API is called.
// Results retain model metadata, never authentication/configuration documents.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const evidenceDir = dirname(fileURLToPath(import.meta.url));
const commonEnv = { ...process.env, COPILOT_AUTO_UPDATE: 'false', AGY_CLI_DISABLE_AUTO_UPDATE: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', NO_COLOR: '1' };
const clean = value => String(value ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replaceAll(process.env.HOME ?? '/__none__', '<home>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/\b(?:sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]+/g, '<redacted>').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>');
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const modelKeys = ['id', 'value', 'model', 'modelId', 'provider', 'providerID', 'name', 'displayName', 'resolvedModel', 'description', 'reasoning', 'thinking', 'thinkingLevelMap', 'supportedEffortLevels', 'supportsEffort', 'supportsAdaptiveThinking', 'supportedReasoningEfforts', 'defaultReasoningEffort', 'reasoningEffort', 'isDefault', 'hidden', 'contextWindow', 'maxTokens', 'context_window', 'max_context_size', 'capabilities', 'limits', 'variants', 'supportedThinkingLevels', 'api'];
const modelsOnly = values => (Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? { id: value } : pick(value, modelKeys));

async function command(file, args, cwd, env = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, { cwd, env: { ...commonEnv, ...env }, timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, killed: error.killed, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
}

function rpc(file, args, cwd, { framing = 'lines', env = {} } = {}) {
  const child = spawn(file, args, { cwd, env: { ...commonEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0), stderr = '', nextId = 0, closed = false;
  const pending = new Map();
  const notifications = [];
  const done = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({code, signal}); }));
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.once('error', fail);
  child.once('close', () => fail(new Error('native process exited: ' + clean(stderr).slice(-1000))));
  child.stdin.on('error', () => {});
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
  function receive(message) {
    const id = message.id ?? message.response?.request_id;
    const wait = pending.get(id);
    if (wait) {
      pending.delete(id); clearTimeout(wait.timer);
      const error = message.error ?? (message.response?.subtype === 'error' ? message.response.error : undefined);
      if (error || message.success === false) wait.reject(new Error(clean(typeof error === 'object' ? error.message : error ?? 'unsuccessful response')));
      else wait.resolve(message);
    } else if (notifications.length < 40) notifications.push({ type: message.type, method: message.method, subtype: message.subtype });
  }
  child.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 16 * 1024 * 1024) { fail(new Error('output bound exceeded')); child.kill(); return; }
    while (buffer.length) {
      let body;
      if (framing === 'headers') {
        const index = buffer.indexOf('\r\n\r\n');
        if (index < 0) break;
        const length = Number(buffer.subarray(0, index).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
        if (!Number.isSafeInteger(length) || length < 0) { fail(new Error('invalid Content-Length')); child.kill(); break; }
        if (buffer.length < index + 4 + length) break;
        body = buffer.subarray(index + 4, index + 4 + length).toString(); buffer = buffer.subarray(index + 4 + length);
      } else {
        const index = buffer.indexOf('\n'); if (index < 0) break;
        body = buffer.subarray(0, index).toString(); buffer = buffer.subarray(index + 1);
      }
      try { receive(JSON.parse(body)); } catch {}
    }
  });
  function send(message) {
    const body = JSON.stringify(message);
    child.stdin.write(framing === 'headers' ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` : body + '\n');
  }
  return {
    notifications,
    notify: send,
    async request(method, params = {}, style = 'jsonrpc') {
      const id = ++nextId;
      const message = style === 'claude' ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } } : style === 'pi' ? { id, type: method, ...params } : { jsonrpc: '2.0', id, method, params };
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}; ${clean(stderr).slice(-800)}`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
      });
      send(message); return response;
    },
    diagnostics() { return clean(stderr).slice(-1800); },
    async close() {
      child.stdin.end();
      const soft = setTimeout(() => { if (!closed) child.kill('SIGTERM'); }, 500);
      const hard = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000);
      try { return await done; } finally { clearTimeout(soft); clearTimeout(hard); fail(new Error('probe closed')); }
    },
  };
}

const probes = {
  async claude(cwd) {
    const client = rpc('claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--tools', ''], cwd);
    try {
      const response = await client.request('initialize', { hooks: {} }, 'claude');
      return { method: 'stream-json initialize', models: modelsOnly(response.response?.response?.models), nativeVersion: response.response?.response?.claude_code_version, notifications: client.notifications };
    } finally { await client.close(); }
  },
  async codex(cwd) {
    const client = rpc('codex', ['app-server'], cwd);
    try {
      await client.request('initialize', { clientInfo: { name: 'puppeteer-model-discovery', version: '0.1.0' }, capabilities: {} });
      client.notify({ jsonrpc: '2.0', method: 'initialized' });
      let cursor, pages = 0; const models = [];
      do {
        const response = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        models.push(...modelsOnly(response.result?.data)); cursor = response.result?.nextCursor; pages++;
      } while (cursor && pages < 20);
      return { method: 'app-server model/list', pages, complete: !cursor, models, diagnostics: client.diagnostics() };
    } finally { await client.close(); }
  },
  async copilot(cwd) {
    const client = rpc('copilot', ['--headless', '--stdio', '--no-auto-update'], cwd, { framing: 'headers' });
    try {
      const ping = await client.request('ping', {});
      const response = await client.request('models.list', {});
      return { method: 'SDK models.list', protocol: pick(ping.result, ['protocolVersion']), models: modelsOnly(response.result?.models), responseKeys: Object.keys(response.result ?? {}), diagnostics: client.diagnostics() };
    } finally { await client.close(); }
  },
  async pi(cwd) {
    const client = rpc('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-tools', '--offline'], cwd);
    try {
      const response = await client.request('get_available_models', {}, 'pi');
      const thinking = await client.request('get_available_thinking_levels', {}, 'pi');
      return { method: 'RPC get_available_models', models: modelsOnly(response.data?.models), currentModelThinkingLevels: thinking.data?.levels, diagnostics: client.diagnostics() };
    } finally { await client.close(); }
  },
  async grok(cwd) {
    const response = await command('grok', ['models'], cwd);
    return { method: 'models command', code: response.code, output: clean(response.stdout).slice(0,18000), diagnostics: clean(response.stderr).slice(-1800) };
  },
  async antigravity(cwd) {
    const response = await command('agy', ['models'], cwd);
    return { method: 'models command', code: response.code, output: clean(response.stdout).slice(0,18000), diagnostics: clean(response.stderr).slice(-1800) };
  },
  async kimi(cwd) {
    const response = await command('kimi', ['provider', 'list', '--json'], cwd);
    if (response.code !== 0) return { method: 'provider list --json', code: response.code, diagnostics: clean(response.stderr).slice(-1500) };
    const value = JSON.parse(response.stdout);
    const models = Array.isArray(value.models) ? modelsOnly(value.models) : Object.entries(value.models ?? {}).map(([id, model]) => ({ id, ...pick(model, modelKeys) }));
    return { method: 'provider list --json', keys: Object.keys(value), models, defaultModel: value.default_model, providerCount: Object.keys(value.providers ?? {}).length };
  },
};

export { rpc, command, modelsOnly, pick, clean, commonEnv, evidenceDir };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : Object.keys(probes);
  await mkdir(join(evidenceDir, 'results'), { recursive: true });
  for (let offset = 0; offset < names.length; offset += 3) {
    await Promise.all(names.slice(offset, offset + 3).map(async name => {
      if (!probes[name]) throw new Error('Unknown probe: ' + name);
      const cwd = await mkdtemp(join(tmpdir(), 'puppeteer-models-' + name + '-'));
      const started = Date.now();
      let result;
      try { result = { provider: name, observedAt: new Date().toISOString(), ...(await probes[name](cwd)) }; }
      catch (error) { result = { provider: name, observedAt: new Date().toISOString(), error: clean(error.message) }; }
      finally { await rm(cwd, { recursive: true, force: true }); }
      result.durationMs = Date.now() - started;
      await writeFile(join(evidenceDir, 'results', name + '.json'), JSON.stringify(result, null, 2) + '\n');
      console.log(JSON.stringify({ provider: name, count: result.models?.length, error: result.error, code: result.code, durationMs: result.durationMs, diagnostics: result.diagnostics, output: result.output?.slice(0,1000), models: result.models?.slice(0,2) }));
    }));
  }
}
