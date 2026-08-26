#!/usr/bin/env node
/**
 * Generate the evidence-bound Hermes 0.20.0 Agent Surface Model from the
 * sanitized tui_gateway census. Only observed methods and hook names are
 * verified. Unobserved source branches stay out of events/ rather than
 * pretending they were captured.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { RELEASE_TAG, SOURCE_REVISION, VERSION } from './harness.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(dirname(vendorRoot));
const repoRoot = dirname(dirname(packageRoot));
const capturesRoot = join(vendorRoot, 'captures', `hermes@${VERSION}`);
const probesRoot = join(vendorRoot, 'probes', `hermes@${VERSION}`);
const modelRoot = join(vendorRoot, 'model', `hermes@${VERSION}`);
const eventsRoot = join(modelRoot, 'events');
const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs');

const source = JSON.parse(readFileSync(join(probesRoot, 'source.json'), 'utf8'));
const artifactProbe = JSON.parse(readFileSync(join(probesRoot, 'darwin-arm64', 'artifact.json'), 'utf8'));
const flagProbe = JSON.parse(readFileSync(join(probesRoot, 'darwin-arm64', 'flags.json'), 'utf8'));
const versionOutput = readFileSync(join(probesRoot, 'darwin-arm64', 'version.txt'), 'utf8').trim().split('\n')[0];

if (source.sourceRevision !== SOURCE_REVISION || source.releaseTag !== RELEASE_TAG) {
  throw new Error('source.json drifted from the census pin');
}

const RUNTIME = 'hermes-runtime-headless';
const PROBE = 'hermes-identity-probe';
const SOURCE = 'hermes-exact-source';
const ARTIFACT = `hermes-${VERSION}-source-revision`;
const CAPTURED_AT = '2026-08-12T13:29:19.000Z';

const string = (values) => ({ type: 'string', ...(values ? { enum: values } : {}) });
const number = (bounds = {}) => ({ type: 'number', ...bounds });
const boolean = { type: 'boolean' };
const object = (properties = {}, required = []) => ({
  type: 'object',
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
});
const evidence = (claim, extras = {}) => ({
  existence: [claim],
  shape: [claim],
  ...extras,
});
const variant = (match, claim = RUNTIME) => ({
  match,
  evidence: evidence(claim),
  confidence: claim === RUNTIME || claim === PROBE ? 'verified-headless' : 'unverified',
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeEvent(name, document) {
  writeJson(join(eventsRoot, `${name}.json`), {
    surface: 'hermes',
    surfaceVersion: VERSION,
    event: name,
    firstSeen: VERSION,
    lastVerified: VERSION,
    ...document,
  });
}

function formatGenerated(path) {
  execFileSync(process.execPath, [prettierBin, '--write', path], { stdio: 'ignore' });
}

const clientRecord = (method, paramsSchema) =>
  object(
    {
      direction: string(['client']),
      jsonrpc: string(['2.0']),
      id: string(),
      method: string([method]),
      params: paramsSchema,
    },
    ['direction', 'jsonrpc', 'id', 'method', 'params'],
  );

const eventRecord = (type, payloadSchema) =>
  object(
    {
      jsonrpc: string(['2.0']),
      method: string(['event']),
      params: object(
        {
          type: string([type]),
          session_id: string(),
          payload: payloadSchema,
        },
        ['type', 'payload'],
      ),
    },
    ['method', 'params'],
  );

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const hookPayload = object(
  {
    hook_event_name: string(),
    session_id: nullableString,
    tool_name: nullableString,
    platform: nullableString,
    choice: nullableString,
    keys: { type: 'array', items: string() },
  },
  ['hook_event_name', 'keys'],
);

rmSync(modelRoot, { recursive: true, force: true });
mkdirSync(eventsRoot, { recursive: true });

writeJson(join(modelRoot, 'manifest.json'), {
  asmVersion: 2,
  vendor: 'hermes',
  vendorVersion: VERSION,
  generatedAt: '2026-08-12',
  source:
    'Hermes Agent 0.20.0 isolated-home stdio tui_gateway census plus identity/Gate 0 probes of the exact v2026.8.3 source revision. Unobserved source methods are omitted rather than marked verified.',
  evidence: 'evidence.json',
});

writeJson(join(modelRoot, 'detection.json'), {
  executables: ['hermes'],
  envVar: 'PUPPETEER_HERMES_BIN',
  versionFlag: '--version',
  versionOutput,
  versionPattern: '^Hermes Agent v(\\d+\\.\\d+\\.\\d+) \\((\\d{4}\\.\\d{1,2}\\.\\d{1,2})\\)$',
  helpFlag: '--help',
  isolatedHomeEnv: 'HERMES_HOME',
  probedFlags: Object.fromEntries(
    Object.entries(flagProbe.visibleHelpOptions).map(([name, visible]) => [name, visible ? name : '']),
  ),
  launchFlags: {
    tui: '--tui',
    cli: '--cli',
    resume: '--resume',
    continue: '--continue',
    worktree: '--worktree',
    yolo: '--yolo',
    ignoreUserConfig: '--ignore-user-config',
    ignoreRules: '--ignore-rules',
    safeMode: '--safe-mode',
    acp: 'acp',
  },
});

writeJson(join(modelRoot, 'channels.json'), {
  channels: {
    argv: { kind: 'argv-env', notes: 'hermes --tui launch, HERMES_HOME isolation, PUPPETEER_HERMES_BIN.' },
    terminal: {
      kind: 'terminal',
      notes: 'Native Node Ink TUI. Semantics are never derived from terminal text.',
    },
    'tui-gateway': {
      kind: 'jsonrpc-stdio',
      notes: 'JSON-RPC over stdio to tui_gateway.entry, or the same dispatcher over WebSocket handle_ws.',
    },
    'plugin-hook': {
      kind: 'hook-callback',
      notes: 'In-process plugin hooks. Default tui_gateway.entry does not load user plugins until discover_plugins runs.',
    },
    'outbound-webhook': {
      kind: 'webhook-http',
      notes: 'Notify-only hooks.outbound POSTs. Default tui_gateway.entry does not register them.',
    },
    'state-db': {
      kind: 'native-state',
      notes: 'HERMES_HOME/state.db is resume/replay only. Not a live event stream.',
    },
    acp: {
      kind: 'acp',
      notes: 'Separate hermes acp / hermes-acp host. Forbidden beside a native-TUI session.',
    },
  },
});

const requestEvidence = evidence(RUNTIME, { result: [RUNTIME], carrier: [RUNTIME] });
const eventEvidence = evidence(RUNTIME, { carrier: [RUNTIME] });
const hookEvidence = evidence(RUNTIME);

writeEvent('session.create', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-request',
  direction: 'client-to-agent',
  payloadSchema: object({ cwd: string(), source: string(), session_id: string(), text: string(), hasText: boolean }, [
    'cwd',
    'source',
  ]),
  resultSchema: object(
    {
      session_id: string(),
      stored_session_id: string(),
      message_count: number({ minimum: 0 }),
    },
    ['session_id', 'stored_session_id'],
  ),
  recordSchema: clientRecord(
    'session.create',
    object({ cwd: string(), source: string(), session_id: string(), hasText: boolean }, ['cwd', 'source']),
  ),
  recordChannel: 'tui-gateway',
  evidence: requestEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/basic-turn/rpc.jsonl`,
});

writeEvent('session.resume', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-request',
  direction: 'client-to-agent',
  payloadSchema: object({ session_id: string(), cwd: string(), source: string(), text: string(), hasText: boolean }, [
    'session_id',
    'cwd',
  ]),
  resultSchema: object(
    {
      session_id: string(),
      stored_session_id: string(),
      session_key: string(),
      resumed: string(),
      status: string(),
      message_count: number({ minimum: 0 }),
      running: boolean,
    },
    ['session_id', 'status'],
  ),
  recordSchema: clientRecord(
    'session.resume',
    object({ session_id: string(), cwd: string(), source: string(), hasText: boolean }, ['session_id', 'cwd']),
  ),
  recordChannel: 'tui-gateway',
  evidence: requestEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/resume-turn/rpc.jsonl`,
});

writeEvent('prompt.submit', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-request',
  direction: 'client-to-agent',
  payloadSchema: object({ session_id: string(), cwd: string(), source: string(), text: string(), hasText: boolean }, [
    'session_id',
  ]),
  resultSchema: object({ status: string(['streaming']) }, ['status']),
  recordSchema: clientRecord(
    'prompt.submit',
    object({ session_id: string(), cwd: string(), source: string(), text: string(), hasText: boolean }, ['session_id']),
  ),
  recordChannel: 'tui-gateway',
  evidence: requestEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/basic-turn/rpc.jsonl`,
  notes: 'Result is only { status: "streaming" }. There is no native prompt id.',
});

writeEvent('session.interrupt', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-request',
  direction: 'client-to-agent',
  payloadSchema: object({ session_id: string(), hasText: boolean }, ['session_id']),
  resultSchema: object({ status: string(['interrupted']) }, ['status']),
  recordSchema: clientRecord('session.interrupt', object({ session_id: string(), hasText: boolean }, ['session_id'])),
  recordChannel: 'tui-gateway',
  evidence: requestEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/interrupt/rpc.jsonl`,
  notes: 'RPC write is not the stop. Wait for message.complete status interrupted.',
});

writeEvent('approval.respond', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-request',
  direction: 'client-to-agent',
  payloadSchema: object({ session_id: string(), choice: string(), hasText: boolean }, ['session_id', 'choice']),
  resultSchema: object({ resolved: number({ minimum: 0 }) }, ['resolved']),
  recordSchema: clientRecord(
    'approval.respond',
    object({ session_id: string(), choice: string(), hasText: boolean }, ['session_id', 'choice']),
  ),
  recordChannel: 'tui-gateway',
  evidence: requestEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/permission-deny/rpc.jsonl`,
});

const emptyPayload = object({ hasText: boolean, hasContext: boolean });
const usage = object({ model: string(), calls: number({ minimum: 0 }), hasTotals: boolean });

writeEvent('gateway.ready', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: emptyPayload,
  recordSchema: eventRecord('gateway.ready', emptyPayload),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/basic-turn/rpc.jsonl`,
  notes: 'Native payload includes skin/branding; sanitized fixtures keep only presence flags.',
});

writeEvent('session.info', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: object(
    {
      model: string(),
      provider: string(),
      approval_mode: string(),
      version: string(),
      cwd: string(),
      stored_session_id: string(),
      running: boolean,
      toolNames: { type: 'array', items: string() },
      usage,
      hasText: boolean,
    },
    ['model', 'stored_session_id', 'running'],
  ),
  recordSchema: eventRecord(
    'session.info',
    object(
      {
        model: string(),
        provider: string(),
        approval_mode: string(),
        version: string(),
        cwd: string(),
        stored_session_id: string(),
        running: boolean,
        toolNames: { type: 'array', items: string() },
        usage,
        hasText: boolean,
      },
      ['model', 'stored_session_id', 'running'],
    ),
  ),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/basic-turn/rpc.jsonl`,
});

writeEvent('sessions.changed', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: emptyPayload,
  recordSchema: eventRecord('sessions.changed', emptyPayload),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/basic-turn/rpc.jsonl`,
});

for (const name of ['message.start', 'thinking.delta', 'message.delta', 'reasoning.available']) {
  writeEvent(name, {
    channel: 'tui-gateway',
    channels: ['tui-gateway'],
    transport: 'jsonrpc-notification',
    direction: 'agent-to-client',
    payloadSchema: emptyPayload,
    recordSchema: eventRecord(name, emptyPayload),
    recordChannel: 'tui-gateway',
    evidence: eventEvidence,
    confidence: 'verified-headless',
    fixture: `captures/hermes@${VERSION}/basic-turn/rpc.jsonl`,
    notes:
      name === 'thinking.delta'
        ? 'UI spinner text, not model reasoning.'
        : name === 'reasoning.available'
          ? 'In these captures this echoed the assistant text.'
          : undefined,
  });
}

const completePayload = object(
  {
    status: string(['complete', 'interrupted']),
    usage,
    hasText: boolean,
    hasContext: boolean,
  },
  ['status'],
);
writeEvent('message.complete', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: completePayload,
  recordSchema: eventRecord('message.complete', completePayload),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  variants: [variant({ status: 'complete' }), variant({ status: 'interrupted' })],
  fixture: `captures/hermes@${VERSION}/interrupt/rpc.jsonl`,
});

writeEvent('tool.generating', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: object({ name: string(), hasText: boolean, hasContext: boolean }, ['name']),
  recordSchema: eventRecord(
    'tool.generating',
    object({ name: string(), hasText: boolean, hasContext: boolean }, ['name']),
  ),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/tool-success/rpc.jsonl`,
});

const toolPayload = object(
  {
    name: string(),
    tool_id: string(),
    duration_s: number({ minimum: 0 }),
    result: object({
      exit_code: number(),
      status: string(),
      hasOutput: boolean,
      hasError: boolean,
    }),
    hasText: boolean,
    hasContext: boolean,
  },
  ['name', 'tool_id'],
);
writeEvent('tool.start', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: toolPayload,
  recordSchema: eventRecord('tool.start', toolPayload),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/tool-success/rpc.jsonl`,
});
writeEvent('tool.complete', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: toolPayload,
  recordSchema: eventRecord('tool.complete', toolPayload),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/tool-success/rpc.jsonl`,
});

const approvalPayload = object(
  {
    choices: { type: 'array', items: string() },
    pattern_key: string(),
    allow_permanent: boolean,
    allow_session: boolean,
    hasText: boolean,
    hasContext: boolean,
  },
  ['choices'],
);
writeEvent('approval.request', {
  channel: 'tui-gateway',
  channels: ['tui-gateway'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: approvalPayload,
  recordSchema: eventRecord('approval.request', approvalPayload),
  recordChannel: 'tui-gateway',
  evidence: eventEvidence,
  confidence: 'verified-headless',
  fixture: `captures/hermes@${VERSION}/permission-deny/rpc.jsonl`,
});

const hookFixtures = {
  on_session_start: 'basic-turn',
  on_session_end: 'basic-turn',
  on_session_finalize: 'basic-turn',
  pre_llm_call: 'basic-turn',
  post_llm_call: 'basic-turn',
  pre_api_request: 'basic-turn',
  post_api_request: 'basic-turn',
  pre_tool_call: 'tool-success',
  post_tool_call: 'tool-success',
  pre_approval_request: 'permission-deny',
  post_approval_response: 'permission-deny',
};

for (const [name, fixture] of Object.entries(hookFixtures)) {
  writeEvent(name, {
    channel: 'plugin-hook',
    channels: ['plugin-hook', 'outbound-webhook'],
    transport: 'hook-callback',
    direction: 'agent-local',
    payloadSchema: hookPayload,
    evidence: hookEvidence,
    confidence: 'verified-headless',
    fixture: `captures/hermes@${VERSION}/${fixture}/plugin-hooks.jsonl`,
    notes: 'Outbound webhook is a notify-only copy of the same hook name.',
  });
}

const node = (id, event, lane, order, extra = {}) => ({
  id,
  event,
  lane,
  order,
  confidence: 'verified-headless',
  evidence: evidence(RUNTIME),
  ...extra,
});
const relation = (from, to, kind = 'sequence', label) => ({
  from,
  to,
  kind,
  ...(label ? { label } : {}),
  confidence: 'verified-headless',
  evidence: { ...evidence(RUNTIME), ordering: [RUNTIME] },
});

writeJson(join(modelRoot, 'behavior.json'), {
  behaviorVersion: 1,
  title: 'Hermes Agent 0.20.0 native TUI-gateway lifecycle',
  description:
    'Partial order over stdio tui_gateway JSON-RPC and isolated-home hooks. Live Node TUI attach is the same dispatcher but is not itself a capture in this model.',
  source: 'Hermetic Hermes 0.20.0 turn census. Unobserved source methods are omitted.',
  lanes: [
    { id: 'session', label: 'Session' },
    { id: 'turn', label: 'Turn stream' },
    { id: 'tool', label: 'Tools and approvals' },
    { id: 'hook', label: 'Plugin hooks / webhooks' },
  ],
  nodes: [
    node('gateway-ready', 'gateway.ready', 'session', 0),
    node('session-create', 'session.create', 'session', 1),
    node('session-resume', 'session.resume', 'session', 1),
    node('session-info', 'session.info', 'session', 2),
    node('sessions-changed', 'sessions.changed', 'session', 3),
    node('prompt-submit', 'prompt.submit', 'turn', 4),
    node('message-start', 'message.start', 'turn', 5),
    node('thinking-delta', 'thinking.delta', 'turn', 6),
    node('message-delta', 'message.delta', 'turn', 7),
    node('reasoning-available', 'reasoning.available', 'turn', 8),
    node('message-complete', 'message.complete', 'turn', 9, { match: { status: 'complete' } }),
    node('message-interrupted', 'message.complete', 'turn', 9, { match: { status: 'interrupted' } }),
    node('session-interrupt', 'session.interrupt', 'turn', 8),
    node('tool-generating', 'tool.generating', 'tool', 6),
    node('tool-start', 'tool.start', 'tool', 7),
    node('approval-request', 'approval.request', 'tool', 8),
    node('approval-respond', 'approval.respond', 'tool', 8),
    node('tool-complete', 'tool.complete', 'tool', 9),
    node('hook-session-start', 'on_session_start', 'hook', 1),
    node('hook-pre-llm', 'pre_llm_call', 'hook', 4),
    node('hook-pre-api', 'pre_api_request', 'hook', 5),
    node('hook-post-api', 'post_api_request', 'hook', 8),
    node('hook-post-llm', 'post_llm_call', 'hook', 9),
    node('hook-pre-tool', 'pre_tool_call', 'hook', 7),
    node('hook-pre-approval', 'pre_approval_request', 'hook', 8),
    node('hook-post-approval', 'post_approval_response', 'hook', 8),
    node('hook-post-tool', 'post_tool_call', 'hook', 9),
    node('hook-session-end', 'on_session_end', 'hook', 10),
    node('hook-finalize', 'on_session_finalize', 'hook', 11),
  ],
  relations: [
    relation('gateway-ready', 'session-create'),
    relation('gateway-ready', 'session-resume', 'resume', 'resume of a stored id'),
    relation('session-create', 'session-info'),
    relation('session-resume', 'session-info'),
    relation('session-create', 'sessions-changed', 'async'),
    relation('session-create', 'hook-session-start', 'async'),
    relation('session-info', 'prompt-submit'),
    relation('prompt-submit', 'message-start'),
    relation('prompt-submit', 'hook-pre-llm', 'async'),
    relation('hook-pre-llm', 'hook-pre-api', 'sequence'),
    relation('message-start', 'thinking-delta'),
    relation('thinking-delta', 'message-delta', 'conditional', 'no-tool reply'),
    relation('thinking-delta', 'tool-generating', 'conditional', 'tool call'),
    relation('tool-generating', 'tool-start'),
    relation('tool-start', 'hook-pre-tool', 'async'),
    relation('tool-start', 'tool-complete', 'conditional', 'no approval'),
    relation('tool-start', 'approval-request', 'conditional', 'dangerous command'),
    relation('approval-request', 'hook-pre-approval', 'async'),
    relation('approval-request', 'approval-respond'),
    relation('approval-respond', 'hook-post-approval', 'async'),
    relation('approval-respond', 'tool-complete'),
    relation('tool-complete', 'hook-post-tool', 'async'),
    relation('tool-complete', 'message-delta', 'conditional', 'follow-up model call'),
    relation('message-delta', 'reasoning-available', 'conditional'),
    relation('message-delta', 'session-interrupt', 'conditional', 'barge-in'),
    relation('reasoning-available', 'message-complete'),
    relation('session-interrupt', 'message-interrupted'),
    relation('hook-pre-api', 'hook-post-api', 'conditional', 'provider finished'),
    relation('hook-post-api', 'hook-post-llm', 'conditional'),
    relation('message-complete', 'hook-session-end', 'async', 'gateway teardown'),
    relation('hook-session-end', 'hook-finalize'),
    relation('session-create', 'session-resume', 'resume', 'later process, same stored id'),
  ],
});

formatGenerated(modelRoot);

const posix = (path) => relative(repoRoot, path).split(sep).join('/');
writeJson(join(modelRoot, 'evidence.json'), {
  evidenceVersion: 2,
  vendor: 'hermes',
  vendorVersion: VERSION,
  artifacts: [
    {
      id: ARTIFACT,
      platform: artifactProbe.platform,
      channel: 'stable',
      acquiredAt: artifactProbe.probedAt,
      versionOutput: artifactProbe.versionOutput,
      identity: artifactProbe.identity,
      integrity: { status: 'verified', sha256: `sha256:${source.pyprojectSha256}` },
      notes: 'Source-revision pin. Integrity is pyproject.toml of the tagged checkout, not the console-script wrapper.',
      uvLockSha256: source.uvLockSha256,
    },
  ],
  sourceReferences: [
    {
      repository: 'https://github.com/NousResearch/hermes-agent',
      revision: SOURCE_REVISION,
      relation: 'exact-release',
      tag: RELEASE_TAG,
      tagObject: source.tagObject,
    },
  ],
  records: [
    {
      id: 'sanitized-captures',
      kind: 'capture-set',
      path: posix(capturesRoot),
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(capturesRoot),
    },
    {
      id: 'identity-probes',
      kind: 'probe-set',
      path: posix(probesRoot),
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(probesRoot),
    },
    {
      id: 'agent-surface-model',
      kind: 'model-tree',
      path: posix(modelRoot),
      exclude: ['evidence.json', 'groundtruth.json', 'groundtruth.html'],
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(modelRoot, ['evidence.json', 'groundtruth.json', 'groundtruth.html']),
    },
  ],
  claims: [
    {
      id: RUNTIME,
      kind: 'runtime-capture',
      confidence: 'verified-headless',
      record: 'sanitized-captures',
      artifact: ARTIFACT,
      platform: 'darwin-arm64',
      harness:
        'isolated HERMES_HOME, loopback OpenAI-compatible provider, stdio tui_gateway census sidecar, plugin-hook dump and outbound webhook collector',
      capturedAt: CAPTURED_AT,
    },
    {
      id: PROBE,
      kind: 'binary-probe',
      confidence: 'verified-headless',
      record: 'identity-probes',
      artifact: ARTIFACT,
      platform: 'darwin-arm64',
      harness: 'source pin, --version, --help, rejected option, hermes acp --version/--check, Gate 0 process trees',
      capturedAt: artifactProbe.probedAt,
    },
    {
      id: SOURCE,
      kind: 'exact-source',
      confidence: 'unverified',
      sourceReference: 0,
      notes: 'Pinned checkout lead for unobserved methods. It cannot promote a runtime claim.',
    },
  ],
  limitations: [
    'Only darwin-arm64 executed the source-revision checkout. Other platforms are declared execution environments, not separately captured binaries.',
    'Turn captures are stdio tui_gateway, not a live hermes --tui PTY with a Node viewer attached.',
    'Plugin hooks and outbound webhooks required the census sidecar. Default tui_gateway.entry does not register them.',
    'Unobserved source methods (session.compress, prompt.background, clarify.respond, subagent.*, allow-once/always) are omitted from events/.',
    'state.db was used for resume identity but was not snapshotted as a live event carrier.',
  ],
});

formatGenerated(join(modelRoot, 'evidence.json'));
writeGroundTruthArtifacts(modelRoot);
console.log(`wrote Hermes ${VERSION} ASM under ${posix(modelRoot)}`);
