#!/usr/bin/env node
/**
 * Generate the evidence-bound Hermes Agent Surface Model for the census pin.
 *
 * From 0.21 the gateway wire is an upstream-generated OpenRPC contract (retained verbatim in
 * references/), so every method, server→client request, and event carries its exact declared
 * schema. The type-preserving tui_gateway census proves occurrence, order, and captured shape;
 * the contract alone never proves runtime reachability. Hook callback payloads are sampled from
 * the census because the contract does not describe them.
 *
 * The 0.20.0 authoring model predates the contract and type-preserving captures. It is retained
 * as history and was produced by this file's revision at that model's commit.
 *
 * usage: node generate-model.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDocumentPath, projectJsonSchema } from '@vibefield/puppeteer-surface';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { RELEASE_DATE, RELEASE_TAG, SOURCE_REVISION, TAG_OBJECT, VERSION } from './harness.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(dirname(vendorRoot));
const repoRoot = dirname(dirname(packageRoot));
const capturesRoot = join(vendorRoot, 'captures', `hermes@${VERSION}`);
const probesRoot = join(vendorRoot, 'probes', `hermes@${VERSION}`);
const referenceRoot = join(vendorRoot, 'references', `hermes@${VERSION}`);
const modelRoot = join(vendorRoot, 'model', `hermes@${VERSION}`);
const eventsRoot = join(modelRoot, 'events');
const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs');
const SCENARIOS = ['basic-turn', 'tool-success', 'permission-deny', 'interrupt', 'resume-turn'];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readJsonLines = (path) =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];

const source = readJson(join(probesRoot, 'source.json'));
const platforms = readdirSync(probesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'gate0')
  .map((entry) => entry.name)
  .sort();
if (platforms.length !== 1) throw new Error(`expected one executed probe platform, found ${platforms.join(', ')}`);
const PLATFORM = platforms[0];
const artifactProbe = readJson(join(probesRoot, PLATFORM, 'artifact.json'));
const flagProbe = readJson(join(probesRoot, PLATFORM, 'flags.json'));
const versionOutput = readFileSync(join(probesRoot, PLATFORM, 'version.txt'), 'utf8')
  .trim()
  .split('\n')[0];
const reference = readJson(join(referenceRoot, 'gateway-surface.json'));
const contract = readJson(join(referenceRoot, reference.contract.retained));

if (
  source.vendorVersion !== VERSION ||
  source.sourceRevision !== SOURCE_REVISION ||
  source.releaseTag !== RELEASE_TAG ||
  source.tagObject !== TAG_OBJECT
) {
  throw new Error('source.json drifted from the census pin');
}
if (
  reference.referenceVersion !== 3 ||
  reference.revision !== SOURCE_REVISION ||
  reference.tag !== RELEASE_TAG ||
  reference.vendorVersion !== VERSION ||
  reference.contract.registryCrossCheck?.agrees !== true
) {
  throw new Error('retained Hermes source reference drifted from the census pin');
}
if (versionOutput !== `Hermes Agent v${VERSION} (${RELEASE_DATE})`) throw new Error(`unexpected ${versionOutput}`);
for (const scenario of SCENARIOS) {
  const metadata = readJson(join(capturesRoot, scenario, 'capture.json'));
  if (metadata.schemaVersion !== 2 || metadata.representation !== 'type-preserving-redaction') {
    throw new Error(`hermes@${VERSION} ${scenario} is not a schemaVersion 2 type-preserving capture`);
  }
}

const RUNTIME = 'hermes-runtime-headless';
const PROBE = 'hermes-identity-probe';
const CONTRACT = 'hermes-generated-contract';
const SOURCE = 'hermes-exact-source';
const ARTIFACT = `hermes-${VERSION}-source-revision`;

// ---------------------------------------------------------------------------
// Runtime occurrence, from the type-preserving census.
// ---------------------------------------------------------------------------

const observed = new Map();
const observedResults = new Map();
const hookSamples = new Map();
const observe = (key, scenario, file) => {
  if (!observed.has(key)) observed.set(key, `captures/hermes@${VERSION}/${scenario}/${file}`);
};
for (const scenario of SCENARIOS) {
  const requests = new Map();
  for (const frame of readJsonLines(join(capturesRoot, scenario, 'rpc.jsonl'))) {
    if (frame.direction === 'client' && typeof frame.method === 'string') {
      observe(`method:${frame.method}`, scenario, 'rpc.jsonl');
      requests.set(frame.id, `method:${frame.method}`);
    } else if (frame.direction === 'client') {
      const request = requests.get(frame.id);
      if (request && frame.result !== undefined) observedResults.set(request, true);
    } else if (frame.method === 'event') {
      observe(`event:${frame.params?.type}`, scenario, 'rpc.jsonl');
    } else if (typeof frame.method === 'string') {
      observe(`request:${frame.method}`, scenario, 'rpc.jsonl');
      requests.set(frame.id, `request:${frame.method}`);
    } else if (frame.result !== undefined) {
      const request = requests.get(frame.id);
      if (request) observedResults.set(request, true);
    }
  }
  for (const record of readJsonLines(join(capturesRoot, scenario, 'plugin-hooks.jsonl'))) {
    observe(`hook:${record.hook_event_name}`, scenario, 'plugin-hooks.jsonl');
    const samples = hookSamples.get(record.hook_event_name) ?? [];
    samples.push(record.kwargs ?? {});
    hookSamples.set(record.hook_event_name, samples);
  }
}

// The census start: the earliest hook dump timestamp, normalized to whole seconds.
const CAPTURED_AT = (() => {
  const stamps = SCENARIOS.flatMap((scenario) =>
    readJsonLines(join(capturesRoot, scenario, 'plugin-hooks.jsonl')).map((record) => Date.parse(record.timestamp)),
  ).filter(Number.isFinite);
  if (stamps.length === 0) throw new Error('census captures carry no hook timestamps');
  return new Date(Math.floor(Math.min(...stamps) / 1000) * 1000).toISOString();
})();

// ---------------------------------------------------------------------------
// Schema helpers.
// ---------------------------------------------------------------------------

const string = (values) => ({ type: 'string', ...(values ? { enum: values } : {}) });
const object = (properties = {}, required = []) => ({
  type: 'object',
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
});
const evidence = (claim, extras = {}) => ({ existence: [claim], shape: [claim], ...extras });
const exact = (reference) => projectJsonSchema(reference, contract);

/** Embed a projected schema in a carrier: its closed-over $defs move to the carrier root. */
function carrier(build, schema) {
  const { $defs, $schema, ...embedded } = schema;
  void $schema;
  return { ...build(embedded), ...($defs ? { $defs } : {}) };
}

const clientRecord = (method, paramsSchema) =>
  object(
    {
      // The census marks its own outbound frames; it is not a native field.
      direction: string(['client']),
      jsonrpc: string(['2.0']),
      id: string(),
      method: string([method]),
      params: paramsSchema,
    },
    ['direction', 'jsonrpc', 'id', 'method', 'params'],
  );
const serverRequestRecord = (method, paramsSchema) =>
  object({ jsonrpc: string(['2.0']), id: string(), method: string([method]), params: paramsSchema }, [
    'jsonrpc',
    'id',
    'method',
    'params',
  ]);
const eventRecord = (type, payloadSchema) =>
  object(
    {
      jsonrpc: string(['2.0']),
      method: string(['event']),
      params: object(
        {
          type: string([type]),
          session_id: string(),
          // event_replay._stamp_event: per-session monotonic replay sequence on session-scoped events.
          seq: { type: 'integer', minimum: 1 },
          payload: payloadSchema,
        },
        ['type'],
      ),
    },
    ['method', 'params'],
  );

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Sampled hook kwargs: every encountered top-level field with its encountered JSON types. */
function sampledHookSchema(samples) {
  const fields = new Map();
  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample)) {
      const types = fields.get(key) ?? new Set();
      types.add(jsonType(value));
      fields.set(key, types);
    }
  }
  const properties = Object.fromEntries(
    [...fields]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, types]) => {
        const list = [...types].sort();
        if (list.includes('integer') && list.includes('number')) list.splice(list.indexOf('integer'), 1);
        return [key, list.length === 1 ? { type: list[0] } : { type: list }];
      }),
  );
  return object(properties);
}

function hookResultSchema(name) {
  if (name === 'pre_tool_call') {
    return {
      anyOf: [
        object({ action: string(['block']), message: string() }, ['action', 'message']),
        object({ action: string(['approve']), message: string(), rule_key: string() }, ['action']),
        object({ action: string(['modify']), args: { type: 'object' } }, ['action', 'args']),
      ],
    };
  }
  if (name === 'pre_verify') {
    return {
      anyOf: [
        object({ action: string(['continue', 'block']), message: string() }, ['action', 'message']),
        object({ decision: string(['continue', 'block']), reason: string() }, ['decision', 'reason']),
      ],
    };
  }
  if (name === 'pre_llm_call') return { anyOf: [object({ context: string() }, ['context']), string()] };
  if (name.startsWith('transform_') && name !== 'transform_api_error_classification') return string();
  return undefined;
}

// ---------------------------------------------------------------------------
// Event documents.
// ---------------------------------------------------------------------------

const writtenEvents = new Set();
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function writeEvent(identity, document) {
  if (writtenEvents.has(identity)) throw new Error(`duplicate Hermes ASM identity ${identity}`);
  writtenEvents.add(identity);
  writeJson(join(eventsRoot, eventDocumentPath(identity)), {
    surface: 'hermes',
    surfaceVersion: VERSION,
    event: identity,
    ...document,
  });
}

const contractLimitations = reference.projection.limitations;
const contractFidelity = (fields) => ({
  ...Object.fromEntries(fields.map((field) => [field, 'exact'])),
  carrier: 'structural',
  limitations: [
    ...contractLimitations,
    'The carrier is the JSON-RPC frame as the stdio census records it; the census marks its own outbound frames with direction "client".',
  ],
});
const firstSeenFor = (fixture) => (fixture ? { firstSeen: VERSION, lastVerified: VERSION, fixture } : {});
const confidenceFor = (fixture) => (fixture ? 'verified-headless' : 'unverified');
const existence = (fixture) => (fixture ? [RUNTIME, CONTRACT] : [CONTRACT]);
const shape = (fixture) => (fixture ? [CONTRACT, RUNTIME] : [CONTRACT]);

const notificationNames = new Set(contract['x-notifications'].map((event) => event.name));
const methodNotes = {
  'session.resume':
    'The contract admits no cwd: unlike 0.20.0, which ignored an unread cwd, the dispatcher rejects any undeclared key with error 4000 (captured in resume-turn).',
  'prompt.submit':
    'Returns { status: "streaming", user_row_id }; there is no native prompt id. message.start confirms.',
  'session.interrupt': 'The RPC result is not the stop: wait for message.complete status interrupted.',
  'approval.respond':
    'Legacy answer path kept beside the server→client approval request; the native TUI answers the request itself.',
  'client.capabilities':
    'A WebSocket client that never advertises server_requests gets every server→client request failed fast for its sessions.',
};

// A name that is both a method and a notification keys the notification bare and the method as
// `gateway-method:<name>`. 0.20.0 did the reverse (`gateway-event:<name>`); findings.md declares the remap.
for (const method of contract.methods) {
  const identity = notificationNames.has(method.name) ? `gateway-method:${method.name}` : method.name;
  const fixture = observed.get(`method:${method.name}`);
  const payloadSchema = exact(method.params[0].schema);
  const resultSchema = exact(method.result.schema);
  const resultObserved = observedResults.has(`method:${method.name}`);
  writeEvent(identity, {
    ...(identity === method.name ? {} : { nativeName: method.name }),
    ...firstSeenFor(fixture),
    channel: 'tui-gateway',
    channels: ['tui-gateway'],
    transport: 'jsonrpc-request',
    direction: 'client-to-agent',
    ...(method.summary ? { trigger: method.summary } : {}),
    payloadSchema,
    resultSchema,
    recordSchema: carrier((schema) => clientRecord(method.name, schema), payloadSchema),
    recordChannel: 'tui-gateway',
    evidence: {
      existence: existence(fixture),
      shape: shape(fixture),
      result: resultObserved ? [CONTRACT, RUNTIME] : [CONTRACT],
      carrier: fixture ? [RUNTIME] : [CONTRACT],
    },
    schemaFidelity: contractFidelity(['payload', 'result']),
    confidence: fixture && resultObserved ? 'verified-headless' : 'unverified',
    ...(methodNotes[method.name] ? { notes: methodNotes[method.name] } : {}),
  });
}

const requestNotes = {
  approval:
    'Replaces the 0.20.0 approval.request event; the client answers with a JSON-RPC response frame, and the legacy approval.respond method remains beside it. The id is srq-<12 hex>. Per the release source (not captured), every attached client receives the frame and the first response settles it. Puppeteer never answers: the native TUI does.',
  clarify: 'Replaces the 0.20.0 clarify.request event; a cancelled or timed-out request emits request.cancel.',
};
for (const request of contract['x-server-requests']) {
  const fixture = observed.get(`request:${request.name}`);
  const payloadSchema = exact(request.params[0].schema);
  const resultSchema = exact(request.result.schema);
  writeEvent(request.name, {
    ...firstSeenFor(fixture),
    channel: 'tui-gateway',
    channels: ['tui-gateway'],
    transport: 'jsonrpc-request',
    direction: 'agent-to-client',
    ...(request.summary ? { trigger: request.summary } : {}),
    payloadSchema,
    resultSchema,
    recordSchema: carrier((schema) => serverRequestRecord(request.name, schema), payloadSchema),
    recordChannel: 'tui-gateway',
    evidence: {
      existence: existence(fixture),
      shape: shape(fixture),
      result: observedResults.has(`request:${request.name}`) ? [CONTRACT, RUNTIME] : [CONTRACT],
      carrier: fixture ? [RUNTIME] : [CONTRACT],
    },
    schemaFidelity: contractFidelity(['payload', 'result']),
    confidence: fixture && observedResults.has(`request:${request.name}`) ? 'verified-headless' : 'unverified',
    ...(requestNotes[request.name] ? { notes: requestNotes[request.name] } : {}),
  });
}

const workspaceMutation = reference.workspaceMutation;
const toolCompleteRefinements = workspaceMutation.singlePathTools.map(({ name, pathField }) => ({
  match: { name },
  path: 'args',
  schema: object({ [pathField]: string() }, [pathField]),
  evidence: evidence(SOURCE),
  confidence: 'unverified',
  fidelity: 'structural',
  limitations: [
    `Pinned source proves ${name}.${pathField} is the single local path used to build the diff preview, but does not establish the complete legal tool argument schema.`,
    'Previews are produced only for a local terminal backend.',
  ],
}));
const eventNotes = {
  'thinking.delta': 'UI spinner text, not model reasoning; an empty text clears the spinner.',
  'reasoning.available': 'In these captures this echoed the assistant text.',
  'tool.complete':
    'inline_diff is an ANSI-rendered, bounded preview (presentation text that may omit files or lines), not a raw unified patch.',
  'request.cancel': 'Withdraws one server→client request (timeout, interrupt, session close, or shutdown).',
  'sessions.changed': 'Session-less broadcast: it carries no seq.',
};
for (const event of contract['x-notifications']) {
  const fixture = observed.get(`event:${event.name}`);
  const payloadSchema = exact(event.params[0].schema);
  const variants =
    event.name === 'message.complete'
      ? ['complete', 'interrupted', 'error'].map((status) => {
          const seen = status !== 'error';
          return {
            match: { status },
            evidence: seen ? { existence: [RUNTIME], shape: [CONTRACT, RUNTIME] } : evidence(CONTRACT),
            confidence: seen ? 'verified-headless' : 'unverified',
          };
        })
      : undefined;
  writeEvent(event.name, {
    ...firstSeenFor(fixture),
    channel: 'tui-gateway',
    channels: ['tui-gateway'],
    transport: 'jsonrpc-notification',
    direction: 'agent-to-client',
    ...(event.summary ? { trigger: event.summary } : {}),
    payloadSchema,
    recordSchema: carrier((schema) => eventRecord(event.name, schema), payloadSchema),
    recordChannel: 'tui-gateway',
    evidence: {
      existence: existence(fixture),
      shape: shape(fixture),
      carrier: fixture ? [RUNTIME] : [CONTRACT],
    },
    schemaFidelity: {
      payload: 'exact',
      carrier: 'structural',
      limitations: [
        ...contractLimitations,
        'The carrier is the event_publisher frame; seq is stamped only on session-scoped events.',
      ],
    },
    ...(variants ? { variants, variantDiscriminants: ['status'] } : {}),
    ...(event.name === workspaceMutation.event ? { payloadRefinements: toolCompleteRefinements } : {}),
    confidence: confidenceFor(fixture),
    ...(eventNotes[event.name] ? { notes: eventNotes[event.name] } : {}),
  });
}

for (const name of reference.hooks.events) {
  const fixture = observed.get(`hook:${name}`);
  const resultSchema = hookResultSchema(name);
  writeEvent(name, {
    ...firstSeenFor(fixture),
    channel: 'plugin-hook',
    channels: ['plugin-hook', 'shell-hook', 'outbound-webhook'],
    transport: 'hook-callback',
    direction: 'agent-local',
    payloadSchema: sampledHookSchema(hookSamples.get(name) ?? []),
    ...(resultSchema ? { resultSchema } : {}),
    evidence: {
      existence: [fixture ? RUNTIME : SOURCE],
      shape: [fixture ? RUNTIME : SOURCE],
      ...(resultSchema ? { result: [SOURCE] } : {}),
    },
    schemaFidelity: {
      payload: fixture ? 'sampled' : 'unknown',
      ...(resultSchema ? { result: 'structural' } : {}),
      limitations: [
        'The payload is the in-process plugin callback kwargs object, sampled from the census; shell-hook and outbound-webhook envelopes are retained in the source reference.',
        'Arbitrary plugin return values and event-specific nested values remain unconstrained.',
      ],
    },
    // The result contract is source-only, so a hook with one stays unverified even when observed.
    confidence: fixture && !resultSchema ? 'verified-headless' : 'unverified',
    notes: fixture
      ? 'Outbound webhooks are a notify-only copy of the same hook name; the census sidecar registered them.'
      : 'Declared in VALID_HOOKS at the pinned revision; this hook was not encountered by the turn census.',
  });
}

// ---------------------------------------------------------------------------
// Manifest, detection, channels, behavior, evidence.
// ---------------------------------------------------------------------------

writeJson(join(modelRoot, 'manifest.json'), {
  asmVersion: 3,
  vendor: 'hermes',
  vendorVersion: VERSION,
  generatedAt: '2026-11-03',
  source: `Upstream-generated OpenRPC gateway contract and VALID_HOOKS of the exact ${RELEASE_TAG} source revision, joined to isolated-home type-preserving stdio tui_gateway runtime evidence.`,
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
      notes:
        'Peer-to-peer JSON-RPC over stdio to tui_gateway.entry, or the same dispatcher over WebSocket handle_ws: client methods, server→client requests (srq- ids), and event notifications. Resuming a live session attaches the caller beside its existing clients.',
    },
    'plugin-hook': {
      kind: 'hook-callback',
      notes:
        'In-process plugin hooks. Default tui_gateway.entry does not load user plugins until discover_plugins runs.',
    },
    'shell-hook': {
      kind: 'json-stdio-callback',
      notes: 'Configured shell scripts receive a serialized projection of plugin-hook kwargs and may return JSON.',
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
      notes:
        'Separate hermes acp / hermes-acp host behind the optional acp extra. Forbidden beside a native-TUI session.',
    },
  },
});

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
  title: `Hermes Agent ${VERSION} native TUI-gateway lifecycle`,
  description:
    'Partial order over stdio tui_gateway JSON-RPC, server→client requests, and isolated-home hooks. Live Node TUI attach is the same dispatcher but is not itself a capture in this model.',
  source: `Hermetic Hermes ${VERSION} turn census for the observed partial order; the contract-only inventory remains outside this behavior graph.`,
  lanes: [
    { id: 'session', label: 'Session' },
    { id: 'turn', label: 'Turn stream' },
    { id: 'tool', label: 'Tools and approvals' },
    { id: 'hook', label: 'Plugin hooks / webhooks' },
  ],
  nodes: [
    node('gateway-ready', 'gateway.ready', 'session', 0),
    node('client-capabilities', 'client.capabilities', 'session', 1),
    node('session-create', 'session.create', 'session', 2),
    node('session-resume', 'session.resume', 'session', 2),
    node('session-info', 'session.info', 'session', 3),
    node('prompt-submit', 'prompt.submit', 'turn', 4),
    node('message-start', 'message.start', 'turn', 5),
    node('sessions-changed', 'sessions.changed', 'session', 6),
    node('session-title', 'session.title', 'session', 6),
    node('thinking-delta', 'thinking.delta', 'turn', 6),
    node('message-delta', 'message.delta', 'turn', 7),
    node('reasoning-available', 'reasoning.available', 'turn', 8),
    node('session-usage', 'session.usage', 'turn', 9),
    node('message-complete', 'message.complete', 'turn', 10, { match: { status: 'complete' } }),
    node('message-interrupted', 'message.complete', 'turn', 10, { match: { status: 'interrupted' } }),
    node('session-interrupt', 'session.interrupt', 'turn', 8),
    node('tool-generating', 'tool.generating', 'tool', 6),
    node('tool-start', 'tool.start', 'tool', 7),
    node('approval-request', 'approval', 'tool', 8),
    node('tool-complete', 'tool.complete', 'tool', 9),
    node('hook-session-start', 'on_session_start', 'hook', 2),
    node('hook-pre-llm', 'pre_llm_call', 'hook', 4),
    node('hook-pre-api', 'pre_api_request', 'hook', 5),
    node('hook-post-api', 'post_api_request', 'hook', 8),
    node('hook-post-llm', 'post_llm_call', 'hook', 10),
    node('hook-pre-tool', 'pre_tool_call', 'hook', 7),
    node('hook-pre-approval', 'pre_approval_request', 'hook', 8),
    node('hook-post-approval', 'post_approval_response', 'hook', 8),
    node('hook-post-tool', 'post_tool_call', 'hook', 9),
    node('hook-session-end', 'on_session_end', 'hook', 11),
    node('hook-finalize', 'on_session_finalize', 'hook', 12),
  ],
  relations: [
    relation('gateway-ready', 'client-capabilities'),
    relation('client-capabilities', 'session-create'),
    relation('client-capabilities', 'session-resume', 'resume', 'resume of a stored id'),
    relation('session-create', 'session-info'),
    relation('session-resume', 'session-info'),
    relation('session-create', 'hook-session-start', 'async'),
    relation('session-info', 'prompt-submit'),
    relation('prompt-submit', 'message-start'),
    relation('prompt-submit', 'hook-pre-llm', 'async'),
    relation('hook-pre-llm', 'hook-pre-api', 'sequence'),
    relation('message-start', 'sessions-changed', 'async'),
    relation('message-start', 'session-title', 'conditional', 'first turn of a new session'),
    relation('message-start', 'thinking-delta'),
    relation('thinking-delta', 'message-delta', 'conditional', 'no-tool reply'),
    relation('thinking-delta', 'tool-generating', 'conditional', 'tool call'),
    relation('tool-generating', 'tool-start'),
    relation('tool-start', 'hook-pre-tool', 'async'),
    relation('tool-start', 'tool-complete', 'conditional', 'no approval'),
    relation('tool-start', 'approval-request', 'conditional', 'dangerous command'),
    relation('approval-request', 'hook-pre-approval', 'async'),
    relation('approval-request', 'hook-post-approval', 'async', 'client response'),
    relation('approval-request', 'tool-complete', 'sequence', 'client response'),
    relation('tool-complete', 'hook-post-tool', 'async'),
    relation('tool-complete', 'message-delta', 'conditional', 'follow-up model call'),
    relation('message-delta', 'reasoning-available', 'conditional'),
    relation('message-delta', 'session-interrupt', 'conditional', 'barge-in'),
    relation('reasoning-available', 'session-usage', 'conditional'),
    relation('session-usage', 'message-complete'),
    relation('reasoning-available', 'message-complete'),
    relation('session-interrupt', 'message-interrupted'),
    relation('hook-pre-api', 'hook-post-api', 'conditional', 'provider finished'),
    relation('hook-post-api', 'hook-post-llm', 'conditional'),
    relation('message-complete', 'hook-session-end', 'async', 'gateway teardown'),
    relation('hook-session-end', 'hook-finalize'),
    relation('session-create', 'session-resume', 'resume', 'later process, same stored id'),
  ],
});

for (const nodeEvent of ['client.capabilities', 'session.title', 'session.usage', 'approval']) {
  if (
    !observed.has(`method:${nodeEvent}`) &&
    !observed.has(`event:${nodeEvent}`) &&
    !observed.has(`request:${nodeEvent}`)
  ) {
    throw new Error(`behavior node ${nodeEvent} was not observed by the census`);
  }
}

execFileSync(process.execPath, [prettierBin, '--write', modelRoot], { stdio: 'ignore' });

const posix = (path) => relative(repoRoot, path).split(sep).join('/');
writeJson(join(modelRoot, 'evidence.json'), {
  evidenceVersion: 2,
  vendor: 'hermes',
  vendorVersion: VERSION,
  artifacts: [
    {
      id: ARTIFACT,
      // A reviewed source pin, not an executable or installed-console identity: acquisition
      // replaces it with the attested installed-console manifests rather than comparing bytes.
      kind: 'source-revision-pin',
      platform: PLATFORM,
      channel: 'stable',
      acquiredAt: artifactProbe.probedAt,
      versionOutput: artifactProbe.versionOutput,
      identity: artifactProbe.identity,
      integrity: { status: 'verified', sha256: `sha256:${source.pyprojectSha256}` },
      notes:
        'Integrity is pyproject.toml of the tagged checkout, not a source-archive or installed-console digest; the census ran in an unattested survey environment.',
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
      id: 'exact-source-surface',
      kind: 'source-projection',
      path: posix(referenceRoot),
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(referenceRoot),
    },
    {
      id: 'agent-surface-model',
      kind: 'model-tree',
      path: posix(modelRoot),
      exclude: ['evidence.json'],
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(modelRoot, ['evidence.json']),
    },
  ],
  claims: [
    {
      id: RUNTIME,
      kind: 'runtime-capture',
      confidence: 'verified-headless',
      record: 'sanitized-captures',
      artifact: ARTIFACT,
      platform: PLATFORM,
      harness:
        'isolated HERMES_HOME, loopback OpenAI-compatible provider, stdio tui_gateway census sidecar answering server→client requests, plugin-hook dump and outbound webhook collector',
      capturedAt: CAPTURED_AT,
    },
    {
      id: PROBE,
      kind: 'binary-probe',
      confidence: 'verified-headless',
      record: 'identity-probes',
      artifact: ARTIFACT,
      platform: PLATFORM,
      harness: 'source pin, --version, --help, rejected option, hermes acp --version/--check',
      capturedAt: artifactProbe.probedAt,
    },
    {
      id: CONTRACT,
      kind: 'generated-schema',
      confidence: 'unverified',
      record: 'exact-source-surface',
      sourceReference: 0,
      harness: `${reference.contract.path} (upstream ${reference.contract.generator}), sha256 ${reference.contract.sha256}`,
      notes:
        'Names equal the contract registry and registered handler table of the same checkout. The contract establishes declared shape, not runtime reachability.',
    },
    {
      id: SOURCE,
      kind: 'exact-source',
      confidence: 'unverified',
      record: 'exact-source-surface',
      sourceReference: 0,
      notes: 'Digest-pinned VALID_HOOKS, hook envelopes, hook result handling, and the inline-diff preview projection.',
    },
  ],
  limitations: [
    `Only ${PLATFORM} executed the source-revision checkout, in an unattested survey environment (Python ${artifactProbe.probeEnvironment?.pythonVersion ?? 'unknown'}, not the reviewed recipe's pinned toolchain). Other platforms are declared execution environments.`,
    'Turn captures are stdio tui_gateway, not a live hermes --tui PTY with a Node viewer attached.',
    'Plugin hooks and outbound webhooks required the census sidecar. Default tui_gateway.entry does not register them.',
    'Hook payload schemas are sampled from the census; unencountered hooks have no payload schema.',
    'state.db was used for resume identity but was not snapshotted as a live event carrier.',
  ],
});

execFileSync(process.execPath, [prettierBin, '--write', join(modelRoot, 'evidence.json')], { stdio: 'ignore' });
writeGroundTruthArtifacts(modelRoot);
console.log(`wrote Hermes ${VERSION} ASM under ${posix(modelRoot)} (${writtenEvents.size} events)`);
