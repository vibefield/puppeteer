// Native metadata probes; no inference requests. Only allowlisted metadata is persisted.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { rpc, command, modelsOnly, pick, clean, commonEnv, evidenceDir } from './probe.mjs';

async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const done = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await done; } finally { clearTimeout(timer); }
}

const safeOption = option => ({
  ...pick(option, ['id', 'name', 'category', 'description', 'type', 'currentValue']),
  ...(option.options ? { options: option.options.map(value => value.options
    ? { ...pick(value, ['group', 'name']), options: value.options.map(v => pick(v, ['value', 'name', 'description'])) }
    : pick(value, ['value', 'name', 'description'])) } : {}),
});

const probes = {
  async opencode(cwd) {
    const password = randomBytes(24).toString('hex');
    const child = spawn('opencode', ['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd, env: { ...commonEnv, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', diagnostics = '';
    child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-8000); });
    try {
      const origin = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OpenCode startup timeout: ' + clean(diagnostics))), 25000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`OpenCode startup exit ${code}: ${clean(diagnostics)}`)); });
        child.stdout.on('data', data => {
          output = (output + data).slice(-8000);
          const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (url) { clearTimeout(timer); resolve(url); }
        });
      });
      const response = await fetch(origin + '/provider', {
        headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') },
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) throw new Error('GET /provider HTTP ' + response.status);
      const result = await response.json();
      const connected = new Set(result.connected ?? []);
      const providers = (result.all ?? []).map(provider => ({
        ...pick(provider, ['id', 'name']), connected: connected.has(provider.id),
        models: Object.values(provider.models ?? {}).map(model => ({
          ...pick(model, ['id', 'name', 'providerID', 'capabilities', 'limit', 'status']),
          variantIds: Object.keys(model.variants ?? {}),
        })),
      }));
      const models = providers.filter(p => p.connected).flatMap(p => p.models.map(m => ({ ...m, providerID: p.id })));
      return { method: 'serve --pure: GET /provider', responseKeys: Object.keys(result), connected: [...connected], defaults: result.default,
        allCatalogModelCount: providers.reduce((n, p) => n + p.models.length, 0),
        providers: providers.map(p => ({ id: p.id, name: p.name, connected: p.connected, modelCount: p.models.length })), models, diagnostics: clean(diagnostics).slice(-1800) };
    } finally { await stop(child); }
  },

  async hermes(cwd) {
    const sourceRoot = join(homedir(), '.hermes', 'hermes-agent');
    // This is the exact helper called by native model.options, without starting
    // the gateway's MCP discovery or orphan-session maintenance.
    const script = `import json
from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv()
from hermes_cli.inventory import load_picker_context, build_model_options_payload
p = build_model_options_payload(load_picker_context(), explicit_only=False, include_unconfigured=False, refresh=False)
providers = []
models = []
for row in p.get('providers', []):
    providers.append({k: row[k] for k in ('slug','name','is_current','authenticated','total_models','catalog_source','catalog_stale') if k in row})
    for model in row.get('models', []):
        models.append({'id': model, 'provider': row.get('slug'), 'capabilities': row.get('capabilities', {}).get(model, {})})
print(json.dumps({'provider':p.get('provider'),'currentModel':p.get('model'),'providers':providers,'models':models}))
`;
    const response = await command(join(sourceRoot, 'venv', 'bin', 'python'), ['-c', script], cwd, { PYTHONPATH: sourceRoot, PYTHONDONTWRITEBYTECODE: '1' });
    if (response.code !== 0) throw new Error('Hermes helper failed: ' + clean(response.stderr));
    return { method: 'native inventory.build_model_options_payload (model.options implementation)', transport: 'installed Python helper; gateway transport not started', ...JSON.parse(response.stdout), diagnostics: clean(response.stderr).slice(-1800) };
  },

  async antigravity_json(cwd) {
    const response = await command('agy', ['--print', '/model', '--output-format', 'json'], cwd);
    let value;
    try { value = JSON.parse(response.stdout); } catch {}
    return {
      method: 'agy --print /model --output-format json', code: response.code,
      ...(value ? { response: pick(value, ['type', 'subtype', 'status', 'response', 'command', 'result', 'command_result', 'num_turns', 'usage', 'is_error']), keys: Object.keys(value) } : { output: clean(response.stdout).slice(0,18000) }),
      diagnostics: clean(response.stderr).slice(-1800),
    };
  },

  async pi_efforts(cwd) {
    const nativeHome = join(cwd, 'pi-home');
    await mkdir(nativeHome);
    const actualModels = JSON.parse(await readFile(join(evidenceDir, 'results', 'pi.json'), 'utf8')).models;
    const providers = {};
    for (const model of actualModels) {
      providers[model.provider] ??= { api: model.api, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'not-a-real-key', models: [] };
      providers[model.provider].models.push(pick(model, ['id', 'name', 'api', 'reasoning', 'thinkingLevelMap', 'contextWindow', 'maxTokens']));
    }
    await writeFile(join(nativeHome, 'models.json'), JSON.stringify({ providers }));
    const client = rpc('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-tools', '--offline'], cwd, { env: { PI_CODING_AGENT_DIR: nativeHome } });
    try {
      const models = [];
      for (const model of actualModels) {
        await client.request('set_model', { provider: model.provider, modelId: model.id }, 'pi');
        const levels = await client.request('get_available_thinking_levels', {}, 'pi');
        models.push({ id: model.id, provider: model.provider, supportedThinkingLevels: levels.data?.levels });
      }
      return { method: 'set_model + get_available_thinking_levels, temporary profile only', context: 'Metadata from the real catalog; dummy authentication, offline, no inference', models, diagnostics: client.diagnostics() };
    } finally { await client.close(); }
  },

  async hermes_rpc(cwd) {
    const sourceRoot = join(homedir(), '.hermes', 'hermes-agent');
    const nativeHome = join(cwd, 'hermes-home');
    await mkdir(nativeHome);
    await writeFile(join(nativeHome, 'config.yaml'), 'mcp_servers: {}\n');
    const client = rpc(join(sourceRoot, 'venv', 'bin', 'python'), ['-m', 'tui_gateway.entry'], cwd, {
      env: { PYTHONPATH: sourceRoot, PYTHONDONTWRITEBYTECODE: '1', HERMES_HOME: nativeHome },
    });
    try {
      const response = await client.request('model.options', { include_unconfigured: false, refresh: false });
      const rows = response.result?.providers ?? [];
      const models = rows.flatMap(row => (row.models ?? []).map(id => ({ id, provider: row.slug, capabilities: row.capabilities?.[id] })));
      return { method: 'native stdio gateway model.options', context: 'Temporary HERMES_HOME; no session created', responseKeys: Object.keys(response.result ?? {}), models, diagnostics: client.diagnostics() };
    } finally { await client.close(); }
  },

  async acp(cwd) {
    const nativeHome = join(cwd, 'kimi-home');
    await mkdir(nativeHome);
    const client = rpc('kimi', ['acp'], cwd, { env: {
      KIMI_CODE_HOME: nativeHome, KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_BUILTIN_PRODUCT_SKILLS: '0',
      KIMI_MODEL_NAME: 'catalog-probe', KIMI_MODEL_API_KEY: 'not-a-real-key', KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: 'http://127.0.0.1:1/v1', KIMI_MODEL_MAX_CONTEXT_SIZE: '32768', KIMI_MODEL_CAPABILITIES: 'thinking,tool_use',
    } });
    try {
      const initialized = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'puppeteer-metadata-probe', version: '0.1.0' } });
      const created = await client.request('session/new', { cwd, mcpServers: [] });
      return {
        method: 'ACP initialize + session/new, no session/prompt', server: 'Kimi 2.0.2, temporary home and synthetic configured model',
        protocolVersion: initialized.result?.protocolVersion, initializeKeys: Object.keys(initialized.result ?? {}),
        agentCapabilities: initialized.result?.agentCapabilities, sessionKeys: Object.keys(created.result ?? {}),
        models: modelsOnly(created.result?.models?.availableModels), currentModelId: created.result?.models?.currentModelId,
        configOptions: created.result?.configOptions?.map(safeOption), diagnostics: client.diagnostics(),
      };
    } finally { await client.close(); }
  },

  async grok_acp(cwd) {
    const client = rpc('grok', ['agent', '--no-leader', 'stdio'], cwd);
    try {
      const response = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'puppeteer-metadata-probe', version: '0.1.0' } });
      return { method: 'ACP initialize only; no session created', initializeKeys: Object.keys(response.result ?? {}), result: pick(response.result, ['protocolVersion', 'agentCapabilities', 'agentInfo']), diagnostics: client.diagnostics() };
    } finally { await client.close(); }
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(probes);
await mkdir(join(evidenceDir, 'results'), { recursive: true });
for (let offset = 0; offset < names.length; offset += 3) {
  await Promise.all(names.slice(offset, offset + 3).map(async name => {
    if (!probes[name]) throw new Error('Unknown probe: ' + name);
    const cwd = await mkdtemp(join(tmpdir(), 'puppeteer-models-' + name + '-'));
    const started = Date.now();
    let result;
    try { result = { probe: name, observedAt: new Date().toISOString(), ...(await probes[name](cwd)) }; }
    catch (error) { result = { probe: name, observedAt: new Date().toISOString(), error: clean(error.message) }; }
    finally { await rm(cwd, { recursive: true, force: true }); }
    result.durationMs = Date.now() - started;
    await writeFile(join(evidenceDir, 'results', name + '.json'), clean(JSON.stringify(result, null, 2)) + '\n');
    console.log(JSON.stringify({ ...pick(result, ['probe', 'method', 'error', 'code', 'durationMs', 'connected', 'currentModel', 'currentModelId', 'initializeKeys', 'sessionKeys', 'configOptions', 'diagnostics']), count: result.models?.length, providerCount: result.providers?.length, models: result.models?.slice(0,2), response: result.response, output: result.output?.slice(0,1500) }));
  }));
}
