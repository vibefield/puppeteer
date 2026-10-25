#!/usr/bin/env node
/**
 * Generate the evidence-bound Grok Agent Surface Model for one census-captured release.
 *
 * Inputs (all tracked, all digest-pinned by the evidence index):
 *   captures/grok@<v>/    type-preserving census captures (census/harness.mjs -> sanitize-captures.mjs)
 *   probes/grok@<v>/      exact-artifact version, help trees, completion grammar
 *   references/grok@<v>/  supplemental nearest public mirror + ACP schema + binary serde-run leads
 *
 * Evidence policy (binary-only): Grok's binary-reported revision is never a
 * public mirror commit, so every verified claim rests on runtime captures or
 * binary probes of the exact artifact. Mirror source and ACP schemas are
 * attributed separately as unverified leads; an exact ACP schema becomes
 * verified only where every captured carrier validates against it.
 *
 * The generator validates every captured payload, result, carrier, and
 * matching refinement against the schemas it writes, and refuses to write a
 * model the captures contradict. The Grok 1.0.0 model was produced by an
 * earlier revision of this script from legacy projections and is retained
 * unchanged; this revision only accepts schemaVersion 2 type-preserving captures.
 *
 * usage: node generate-model.mjs [--version 1.0.70]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDocumentPath, validateSanitizedPayload } from '@vibefield/puppeteer-surface';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';

const RELEASES = {
  '1.0.70': {
    generatedAt: '2026-10-25',
    // mtime of the bytes fetched by `pnpm surface:download` from the allowlisted x.ai URL.
    acquiredAt: '2026-10-25T02:25:00.000Z',
    binaryReportedRevision: 'f50904eaee6c',
    platform: 'darwin-arm64',
  },
};

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const VERSION = flag('--version', '1.0.70');
const release = RELEASES[VERSION];
if (!release) throw new Error(`generator has no census pin for grok ${VERSION}`);
const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(dirname(vendorRoot));
const repoRoot = dirname(dirname(packageRoot));
const capturesRoot = join(vendorRoot, 'captures', `grok@${VERSION}`);
const probesRoot = join(vendorRoot, 'probes', `grok@${VERSION}`);
const referencesRoot = join(vendorRoot, 'references', `grok@${VERSION}`);
const modelRoot = join(vendorRoot, 'model', `grok@${VERSION}`);
const eventsRoot = join(modelRoot, 'events');
const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readJsonLines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

// ---------------------------------------------------------------------------
// Inputs and their identity checks
// ---------------------------------------------------------------------------

const capture = readJson(join(capturesRoot, 'capture.json'));
const reference = readJson(join(referencesRoot, 'public-source-surface.json'));
const artifact = readJson(join(probesRoot, 'artifact.json'));
if (capture.schemaVersion !== 2 || capture.representation !== 'type-preserving-redaction') {
  throw new Error(`grok@${VERSION} captures are not schemaVersion 2 type-preserving redactions`);
}
if (capture.vendorVersion !== VERSION || artifact.version !== VERSION || reference.vendorVersion !== VERSION) {
  throw new Error(`grok@${VERSION} capture, probe, and reference identities disagree`);
}
if (capture.artifactSha256 !== artifact.sha256 || reference.binaryProbe?.artifactSha256 !== artifact.sha256) {
  throw new Error('census, probe, and reference were not produced from the same artifact bytes');
}
if (!artifact.versionOutput.includes(`(${release.binaryReportedRevision})`)) {
  throw new Error(`artifact version output does not report revision ${release.binaryReportedRevision}`);
}
if (reference.publicMirror.relationToBinary !== 'nearest-public-mirror-older-than-binary') {
  throw new Error('supplemental reference must declare its relation to the binary');
}
// The approval-ownership probe (harness --approval-probe) is a semantic digest
// beside the binary probes. Only the facts asserted here are modeled from it.
const approvalProbe = readJson(join(probesRoot, 'viewer-approvals.json'));
if (approvalProbe.version !== VERSION || approvalProbe.artifactSha256 !== artifact.sha256) {
  throw new Error('the approval probe was not produced from the probed artifact bytes');
}
const approvalCase = (scenario, label) => {
  const found = approvalProbe.probes?.[scenario]?.cases?.find((entry) => entry.label === label);
  if (!found) throw new Error(`approval probe has no ${scenario}/${label} case`);
  return found;
};
const hasShape = (entry, expected) =>
  (entry.framesFromPrompt ?? []).some((shape) =>
    Object.entries(expected).every(([key, value]) => shape[key] === value),
  );
const approvalFacts = {
  viewerAllow: approvalCase('viewer-answers', 'viewer-allow-once'),
  viewerReject: approvalCase('viewer-answers', 'viewer-reject-once'),
  controllerCancel: approvalCase('viewer-answers', 'controller-cancel'),
  viewerInterrupt: approvalCase('viewer-answers', 'viewer-interrupt'),
  viewerSpawn: approvalCase('viewer-answers-spawn', 'viewer-allow-spawn'),
  lateViewer: approvalCase('viewer-late-join', 'viewer-attaches-while-pending'),
};
for (const [name, entry] of Object.entries(approvalFacts)) {
  const contradictions = [];
  if (entry.fallbackControllerAnswer) contradictions.push('the controller had to answer');
  if (!entry.interactionResolved) contradictions.push('no interaction_resolved');
  if (entry.controllerCancelRequests !== 0) contradictions.push('the leader sent $/cancel_request');
  if (entry.permissionRuleFilesWritten !== 0) contradictions.push('a permission rule was persisted');
  for (const late of entry.lateControllerAnswers ?? []) {
    if (late.framesAfter.length > 0 || !late.leaderLoggedUnknownResponse) {
      contradictions.push(`a late ${late.decision} answer was not ignored`);
    }
  }
  if (!(entry.lateControllerAnswers ?? []).some((late) => late.decision === 'cancelled')) {
    contradictions.push('no late cancelled answer was probed');
  }
  if (contradictions.length > 0) throw new Error(`approval probe ${name}: ${contradictions.join('; ')}`);
}
const expectProbe = (ok, message) => {
  if (!ok) throw new Error(`approval probe contradicts the model: ${message}`);
};
expectProbe(
  approvalFacts.viewerAllow.toolRan &&
    approvalFacts.viewerAllow.stopReason === 'end_turn' &&
    hasShape(approvalFacts.viewerAllow, { sessionUpdate: 'tool_call_update', status: 'in_progress' }),
  'a viewer allow runs the tool',
);
expectProbe(
  !approvalFacts.viewerReject.toolRan &&
    hasShape(approvalFacts.viewerReject, { status: 'failed', toolNotRun: 'rejected' }) &&
    hasShape(approvalFacts.viewerReject, {
      sessionUpdate: 'turn_completed',
      cancellationCategory: 'PermissionRejected',
    }),
  'a viewer reject is toolNotRun rejected / PermissionRejected',
);
expectProbe(
  !approvalFacts.viewerInterrupt.toolRan &&
    hasShape(approvalFacts.viewerInterrupt, { status: 'failed', toolNotRun: 'cancelled' }) &&
    hasShape(approvalFacts.viewerInterrupt, {
      sessionUpdate: 'turn_completed',
      cancellationCategory: 'PermissionCancelled',
    }),
  'a viewer interrupt is toolNotRun cancelled / PermissionCancelled',
);
expectProbe(
  !approvalFacts.controllerCancel.toolRan &&
    !hasShape(approvalFacts.controllerCancel, { sessionUpdate: 'tool_call_update', status: 'failed' }) &&
    hasShape(approvalFacts.controllerCancel, { sessionUpdate: 'turn_completed', cancellationCategory: 'MidTurnAbort' }),
  'session/cancel resolves a pending request with no tool update (MidTurnAbort)',
);
expectProbe(
  approvalFacts.viewerSpawn.requestTool === 'spawn_subagent' && approvalFacts.viewerSpawn.subagentSpawned === true,
  'the viewer can approve spawn_subagent',
);
expectProbe(
  approvalFacts.lateViewer.viewerAttachedAfterRequest && approvalFacts.lateViewer.toolRan,
  'a viewer attaching while a request is pending can answer it',
);

const acp = reference.acpDependencyOfPublicMirror;
const mirrorVariants = reference.publicMirror.xaiSessionUpdate.variants;
const binaryLeads = reference.binaryProbe;
const capturedAt = `${capture.capturedOn}T00:00:00.000Z`;
const fixture = (scenario, file) => `captures/grok@${VERSION}/${scenario}/${file}`;

/** Every captured carrier, keeping scenario, file, and direction so results correlate. */
function loadCaptures() {
  const wire = [];
  const results = [];
  const durable = [];
  const state = [];
  const observations = {};
  for (const scenario of capture.scenarios) {
    const directory = join(capturesRoot, scenario);
    observations[scenario] = readJson(join(directory, 'observations.json'));
    for (const file of ['acp-controller.jsonl', 'acp-resume.jsonl']) {
      if (!existsSync(join(directory, file))) continue;
      const pending = new Map();
      readJsonLines(join(directory, file)).forEach((frame, index) => {
        const location = `${scenario}/${file}:${index + 1}`;
        const message = frame.message;
        if (typeof message.method === 'string') {
          wire.push({ scenario, file, location, direction: frame.direction, message });
          if (message.id !== undefined) pending.set(`${frame.direction}:${message.id}`, message.method);
          return;
        }
        const requestDirection = frame.direction === 'agent-to-client' ? 'client-to-agent' : 'agent-to-client';
        const method = pending.get(`${requestDirection}:${message.id}`);
        if (!method) throw new Error(`${location}: result without a captured request`);
        results.push({ scenario, location, method, direction: frame.direction, message });
      });
    }
    for (const file of ['updates.jsonl', 'updates-child-1.jsonl', 'updates-child-2.jsonl']) {
      if (!existsSync(join(directory, file))) continue;
      readJsonLines(join(directory, file)).forEach((record, index) =>
        durable.push({ scenario, file, location: `${scenario}/${file}:${index + 1}`, record }),
      );
    }
    readJsonLines(join(directory, 'state.jsonl')).forEach((record, index) =>
      state.push({ scenario, location: `${scenario}/state.jsonl:${index + 1}`, record }),
    );
  }
  return { wire, results, durable, state, observations };
}
const captured = loadCaptures();
const wireOf = (method) => captured.wire.filter((entry) => entry.message.method === method);
const resultsOf = (method) => captured.results.filter((entry) => entry.method === method && entry.message.result);
const durableOf = (method) => captured.durable.filter((entry) => entry.record.method === method);
const stateOf = (file) => captured.state.filter((entry) => entry.record.method === file);
const updateKind = (params) => params?.update?.sessionUpdate;
const isReplay = (params) => params?._meta?.isReplay === true;

// ---------------------------------------------------------------------------
// Evidence claims
// ---------------------------------------------------------------------------

const runtimeClaim = 'grok-runtime-headless';
const observationClaim = 'grok-census-observations';
const probeClaim = 'grok-binary-probe';
const approvalProbeClaim = 'grok-approval-probe';
const serdeLeadClaim = 'grok-binary-serde-lead';
const mirrorClaim = 'grok-public-mirror-lead';
const acpClaim = 'grok-public-acp-lead';
const verifiedClaims = new Set([runtimeClaim, observationClaim, probeClaim, approvalProbeClaim]);
const confidenceOf = (claims) =>
  claims.some((claim) => verifiedClaims.has(claim)) ? 'verified-headless' : 'unverified';
const evidence = ({ existence, shape, result, carrier, trigger, ordering }) => ({
  existence,
  shape,
  ...(trigger ? { trigger } : {}),
  ...(ordering ? { ordering } : {}),
  ...(result ? { result } : {}),
  ...(carrier ? { carrier } : {}),
});
const minConfidence = (...groups) =>
  groups.filter(Boolean).every((group) => confidenceOf(group) === 'verified-headless')
    ? 'verified-headless'
    : 'unverified';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

const string = (values) => ({ type: 'string', ...(values ? { enum: values } : {}) });
const integer = (bounds = {}) => ({ type: 'integer', ...bounds });
const object = (properties = {}, required = [], extra = {}) => ({
  type: 'object',
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
  ...extra,
});

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * Objects whose keys are data, not field names: Grok keys `modelUsage` by the
 * model id, so the census model's name must not become a required property.
 */
const KEYED_MAPS = new Set(['modelUsage']);

function inferMapSchema(values) {
  const present = values.filter((value) => value !== undefined);
  const maps = present.filter((value) => value !== null && typeof value === 'object' && !Array.isArray(value));
  if (maps.length !== present.length) return inferSchema(values);
  const entries = maps.flatMap((value) => Object.values(value));
  return { type: 'object', ...(entries.length > 0 ? { additionalProperties: inferSchema(entries) } : {}) };
}

/**
 * Sampled schema: the union of observed JSON types per path, object keys as
 * properties, and `required` only for keys present in every observed object.
 * Sanitized strings keep their type, so string-valued fields stay unconstrained.
 */
export function inferSchema(values) {
  const present = values.filter((value) => value !== undefined);
  if (present.length === 0) return {};
  let types = [...new Set(present.map(jsonType))];
  if (types.includes('number')) types = types.filter((type) => type !== 'integer');
  types.sort();
  const schema = { type: types.length === 1 ? types[0] : types };
  const objects = present.filter((value) => value !== null && typeof value === 'object' && !Array.isArray(value));
  if (objects.length > 0) {
    const keys = [...new Set(objects.flatMap((value) => Object.keys(value)))].sort();
    if (keys.length > 0) {
      schema.properties = Object.fromEntries(
        keys.map((key) => [
          key,
          (KEYED_MAPS.has(key) ? inferMapSchema : inferSchema)(objects.map((value) => value[key])),
        ]),
      );
    }
    const required = keys.filter((key) => objects.every((value) => Object.hasOwn(value, key)));
    if (required.length > 0) schema.required = required;
  }
  const items = present.filter(Array.isArray).flat();
  if (items.length > 0) schema.items = inferSchema(items);
  return schema;
}

/** Pin an observed constant at a dotted path of a sampled object schema. */
function pinConst(schema, dottedPath, value) {
  let node = schema;
  for (const component of dottedPath.split('.')) {
    node = node?.properties?.[component];
    if (!node) throw new Error(`cannot pin ${dottedPath}: path absent from sampled schema`);
  }
  node.const = value;
}

/** allOf of an exact projected ACP schema and a sampled Grok schema, keeping $defs at the root. */
function exactWithSampled(exact, sampled) {
  const { $defs, $schema, ...rest } = exact;
  return { ...($schema ? { $schema } : {}), ...($defs ? { $defs } : {}), allOf: [rest, sampled] };
}

function withDiscriminator(schema, wireName) {
  const projected = structuredClone(schema);
  projected.type = projected.type ?? 'object';
  projected.properties = { ...(projected.properties ?? {}), sessionUpdate: { const: wireName, type: 'string' } };
  projected.required = [...new Set([...(projected.required ?? []), 'sessionUpdate'])];
  return projected;
}

function nullable(schema) {
  if (!schema.type) return {};
  const types = [...new Set([...(Array.isArray(schema.type) ? schema.type : [schema.type]), 'null'])];
  return { ...schema, type: types };
}

/** Primitive/container projection of one public Rust field type; custom types stay unconstrained. */
function rustSchema(rawType) {
  const type = rawType.trim();
  const option = /^Option<(.+)>$/.exec(type);
  if (option) return nullable(rustSchema(option[1]));
  const vector = /^Vec<(.+)>$/.exec(type);
  if (vector) return { type: 'array', items: rustSchema(vector[1]) };
  const boxed = /^Box<(.+)>$/.exec(type);
  if (boxed) return rustSchema(boxed[1]);
  if (/^(?:std::collections::)?(?:HashMap|BTreeMap|IndexMap)</.test(type)) return { type: 'object' };
  if (/^\(.*\)$/.test(type)) return { type: 'array' };
  if (type === 'String' || type === '&str' || type === 'PathBuf') return string();
  if (/^(?:u8|u16|u32|u64|usize)$/.test(type)) return integer({ minimum: 0 });
  if (/^(?:i8|i16|i32|i64|isize)$/.test(type)) return integer();
  if (type === 'f32' || type === 'f64') return { type: 'number' };
  if (type === 'bool') return { type: 'boolean' };
  return {};
}

function mirrorVariantSchema(entry) {
  const properties = Object.fromEntries(
    (entry.fields ?? []).map((field) => [field.wireName, rustSchema(field.rustType)]),
  );
  const required = (entry.fields ?? []).filter((field) => !field.optional).map((field) => field.wireName);
  return object({ sessionUpdate: string([entry.wireName]), ...properties }, ['sessionUpdate', ...required]);
}

function rpcCarrier(method, request) {
  return object(
    {
      jsonrpc: string(['2.0']),
      ...(request ? { id: { type: ['integer', 'string'] } } : {}),
      method: string([method]),
      params: object(),
    },
    ['jsonrpc', ...(request ? ['id'] : []), 'method', 'params'],
  );
}

/** Durable updates.jsonl carrier: `timestamp` is Unix SECONDS (the `_meta` clocks are milliseconds). */
function durableCarrier(method) {
  return object(
    {
      timestamp: integer({
        minimum: 1_000_000_000,
        maximum: 99_999_999_999,
        description: 'Unix seconds; params._meta.agentTimestampMs carries the millisecond clock.',
      }),
      method: string([method]),
      params: object(),
    },
    ['timestamp', 'method', 'params'],
  );
}

const SAMPLED_LIMITATION = `Sampled from the Grok ${VERSION} darwin-arm64 census: observed JSON types per field, with required fields present in every captured instance. Sanitized strings keep their type but not their value, so enumerations and formats are not inferred.`;
const CARRIER_LIMITATION =
  'The carrier fixes the JSON-RPC envelope and method; params are validated by the payload schema.';

// ---------------------------------------------------------------------------
// Self-validation: captures must satisfy every schema the generator writes
// ---------------------------------------------------------------------------

const violations = [];
function check(schema, value, location, label) {
  if (!schema) return;
  for (const violation of validateSanitizedPayload(schema, value))
    violations.push(`${location} ${label}: ${violation}`);
}
const valueAt = (value, dottedPath) =>
  dottedPath
    .split('.')
    .reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), value);
const matches = (payload, match) =>
  !match || Object.entries(match).every(([path, expected]) => Object.is(valueAt(payload, path), expected));
function checkRefinements(document, payload, location) {
  for (const refinement of document.payloadRefinements ?? []) {
    // An absent optional path has nothing to refine.
    if (!matches(payload, refinement.match) || valueAt(payload, refinement.path) === undefined) continue;
    check(
      refinement.schema,
      valueAt(payload, refinement.path),
      location,
      `refinement ${JSON.stringify(refinement.match ?? {})}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Event documents
// ---------------------------------------------------------------------------

const documents = new Map();
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function writeEvent(name, document) {
  const value = { surface: 'grok', surfaceVersion: VERSION, event: name, ...document };
  documents.set(name, value);
  writeJson(join(eventsRoot, eventDocumentPath(name)), value);
}

rmSync(modelRoot, { recursive: true, force: true });
mkdirSync(eventsRoot, { recursive: true });

const acpFidelityNote = `Exact ACP schema ${acp.schemaVersion} (${acp.tag}, ${acp.revision.slice(0, 8)}), the dependency of the nearest public Grok mirror commit. The binary embeds agent-client-protocol-${acp.crateVersion} (binary probe), and every captured ${VERSION} carrier validates against it; the schema is not the binary's own source.`;

/** Standard ACP methods: exact ACP payloads, sampled Grok-specific result facts. */
const acpMethods = [
  {
    event: 'initialize',
    payload: 'InitializeRequest',
    result: 'InitializeResponse',
    direction: 'client-to-agent',
    resultConstants: {
      'agentCapabilities.loadSession': true,
      'agentCapabilities.promptCapabilities.image': true,
      'agentCapabilities.promptCapabilities.audio': false,
      'agentCapabilities.promptCapabilities.embeddedContext': true,
      'agentCapabilities.mcpCapabilities.http': true,
      'agentCapabilities.mcpCapabilities.sse': true,
    },
    notes:
      'Advertises loadSession, sessionCapabilities {list, resume, close}, mcpCapabilities {http, sse}, and promptCapabilities {image: true (false in 1.0.0), audio: false, embeddedContext: true}; authMethods are [xai.api_key, grok.com]. Grok-specific `_meta` carries the cwd, agentVersion, a stable machine-derived agentId (UUIDv5), a per-process agentInstanceId, hostname, modelState, availableCommands, and feature flags. sessionCapabilities.additionalDirectories is not advertised even though the CLI gained --add-dir.',
  },
  {
    event: 'session/new',
    payload: 'NewSessionRequest',
    result: 'NewSessionResponse',
    direction: 'client-to-agent',
    notes:
      'The result carries ACP configOptions [{id: model, category: model, type: select}] and models, plus `_meta` with x.ai/sessionConfig, x.ai/sessionDetail, and x.ai/facets. `_x.ai/session/setup` phases bracket the result.',
  },
  {
    event: 'session/load',
    payload: 'LoadSessionRequest',
    result: 'LoadSessionResponse',
    direction: 'client-to-agent',
    notes:
      'Before the result the leader replays history to the loading client as `_x.ai/session/update` and `session/update` frames with `_meta.isReplay: true` and `_meta["x.ai/leaderClientId"]`. The replay is a reconstruction, not a byte copy of updates.jsonl: tool calls replay as `tool_call` only.',
  },
  {
    event: 'session/list',
    payload: 'ListSessionsRequest',
    result: 'ListSessionsResponse',
    direction: 'client-to-agent',
    notes: 'Advertised through sessionCapabilities.list; sessions carry `_meta["x.ai/session"]` facets.',
  },
  {
    event: 'session/prompt',
    payload: 'PromptRequest',
    result: 'PromptResponse',
    direction: 'client-to-agent',
    notes:
      'The result `_meta` carries promptId, token counters, and (except on MidTurnAbort) a usage object; cancelled turns add cancellationCategory MidTurnAbort | PermissionRejected | PermissionCancelled (a permission prompt cancelled in the viewer) and, for PermissionRejected, cancellationContext {tool_name, reason}. turn_completed and `_x.ai/session/prompt_complete` precede the result; signals.json is rewritten asynchronously after it.',
  },
  {
    event: 'session/cancel',
    payload: 'CancelNotification',
    direction: 'client-to-agent',
    notification: true,
    notes:
      'Cancels the running turn: the prompt result reports stopReason cancelled with cancellationCategory MidTurnAbort. A permission request still pending is resolved by the cancel (interaction_resolved, no tool_call_update), and the leader sends its client no $/cancel_request.',
  },
  {
    event: 'session/request_permission',
    payload: 'RequestPermissionRequest',
    result: 'RequestPermissionResponse',
    direction: 'agent-to-client',
    sampledPayload: true,
    clientResult: true,
    notes:
      'Sent only for tools Grok classes as needing approval: a bare `echo` runs without a request (rawOutput.was_bare_echo), a redirecting command asks. The leader fans the request out to every attached client; the 1.0.70 native viewer renders it too (also one issued before the viewer attached) and the first answer wins. The other client receives only the broadcast interaction_resolved {tool_call_id} (no outcome) and the tool call’s own update: in_progress/completed when allowed, failed with `_meta.toolNotRun` rejected (reject) or cancelled (the viewer prompt cancelled); never a $/cancel_request. A later answer to the resolved request id, whatever its outcome, is ignored (the leader logs "received response for unknown request id"). With remembered approvals enabled (the default) the options are always-allow/allow_always, allow-once/allow_once, reject-once/reject_once, reject-always/reject_always in that order; choosing allow_always persists GROK_HOME/sessions/<cwd>/permission__<controller argv>.toml. spawn_subagent requests, and every request with GROK_REMEMBER_TOOL_APPROVALS=0, offer only allow-once/allow_once and reject-once/reject_once.',
  },
];

for (const method of acpMethods) {
  const requests = wireOf(method.event).filter((entry) => !isReplay(entry.message.params));
  if (requests.length === 0) throw new Error(`census captured no ${method.event} carrier`);
  const results = method.result ? resultsOf(method.event) : [];
  if (method.result && results.length === 0) throw new Error(`census captured no ${method.event} result`);
  const exactPayload = acp.schemas[method.payload];
  const payloadSchema = method.sampledPayload
    ? exactWithSampled(exactPayload, inferSchema(requests.map((entry) => entry.message.params)))
    : exactPayload;
  let resultSchema;
  if (method.result) {
    const sampled = inferSchema(results.map((entry) => entry.message.result));
    for (const [path, value] of Object.entries(method.resultConstants ?? {})) pinConst(sampled, path, value);
    resultSchema = method.clientResult
      ? acp.schemas[method.result]
      : exactWithSampled(acp.schemas[method.result], sampled);
  }
  const shape = [acpClaim, runtimeClaim];
  writeEvent(method.event, {
    channel: 'acp',
    channels: ['acp'],
    transport: method.notification ? 'jsonrpc-notification' : 'jsonrpc-request',
    direction: method.direction,
    payloadSchema,
    ...(resultSchema ? { resultSchema } : {}),
    recordSchema: rpcCarrier(method.event, !method.notification),
    recordChannel: 'acp',
    evidence: evidence({
      existence: [runtimeClaim],
      shape,
      ...(resultSchema ? { result: shape } : {}),
      carrier: [runtimeClaim],
    }),
    confidence: 'verified-headless',
    schemaFidelity: {
      payload: method.sampledPayload ? 'sampled' : 'exact',
      ...(resultSchema ? { result: method.clientResult ? 'exact' : 'sampled' } : {}),
      carrier: 'structural',
      limitations: [
        acpFidelityNote,
        ...(method.sampledPayload || (resultSchema && !method.clientResult)
          ? [
              `The ${method.sampledPayload ? 'payload' : 'result'} schema is allOf(exact ACP, sampled Grok ${VERSION} instance): the sampled branch records Grok's observed extension fields. ${SAMPLED_LIMITATION}`,
            ]
          : []),
        ...(method.clientResult
          ? [
              'The result is written by the ACP client (here the census controller); the exact ACP response schema is its contract.',
            ]
          : []),
        CARRIER_LIMITATION,
      ],
    },
    ...(method.event === 'session/request_permission'
      ? {
          variants: ['Bash', 'Task'].map((value) => ({
            match: { 'toolCall.rawInput.variant': value },
            evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim] }),
            confidence: 'verified-headless',
          })),
          payloadRefinements: [
            {
              match: { 'toolCall.rawInput.variant': 'Bash' },
              path: 'options',
              schema: {
                anyOf: [
                  permissionOptions(['allow_always', 'allow_once', 'reject_once', 'reject_always']),
                  permissionOptions(['allow_once', 'reject_once']),
                ],
              },
              evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim, observationClaim] }),
              confidence: 'verified-headless',
              fidelity: 'semantic',
              limitations: [
                'Ordered option kinds for a shell command: four with remembered approvals (the default), two when GROK_REMEMBER_TOOL_APPROVALS=0 or [ui] remember_tool_approvals=false. Captured optionIds are aliased; the census observations retain the literal ids always-allow, allow-once, reject-once, reject-always.',
              ],
            },
            {
              match: { 'toolCall.rawInput.variant': 'Task' },
              path: 'options',
              schema: permissionOptions(['allow_once', 'reject_once']),
              evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim, observationClaim] }),
              confidence: 'verified-headless',
              fidelity: 'semantic',
              limitations: [
                'spawn_subagent (1.0.70 asks before spawning; 1.0.0 did not) offers only allow-once/allow_once and reject-once/reject_once.',
              ],
            },
          ],
        }
      : {}),
    fixture: fixture(requests[0].scenario, requests[0].file),
    notes: method.notes,
  });
}

function permissionOptions(kinds) {
  return {
    type: 'array',
    minItems: kinds.length,
    maxItems: kinds.length,
    prefixItems: kinds.map((kind) =>
      object({ optionId: string(), name: string(), kind: { type: 'string', const: kind } }, [
        'optionId',
        'name',
        'kind',
      ]),
    ),
  };
}

// --- standard session/update (live ACP and durable updates.jsonl) -----------------------------

const standardLive = wireOf('session/update');
const standardDurable = durableOf('session/update');
const standardPayloads = [
  ...standardLive.map((entry) => entry.message.params),
  ...standardDurable.map((entry) => entry.record.params),
];
const observedStandard = new Set(standardPayloads.map(updateKind));
for (const kind of observedStandard) {
  if (!acp.sessionUpdateValues.includes(kind)) throw new Error(`observed session/update ${kind} is not an ACP value`);
}
const sampledUpdateRefinement = (kind, payloads, extra = []) => ({
  match: { 'update.sessionUpdate': kind },
  path: 'update',
  schema: inferSchema(payloads.filter((params) => updateKind(params) === kind).map((params) => params.update)),
  evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim] }),
  confidence: 'verified-headless',
  fidelity: 'sampled',
  limitations: [SAMPLED_LIMITATION, ...extra],
});
const metaRefinement = (payloads, extra) => ({
  path: '_meta',
  schema: inferSchema(payloads.map((params) => params._meta)),
  evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim] }),
  confidence: 'verified-headless',
  fidelity: 'sampled',
  limitations: [SAMPLED_LIMITATION, extra],
});
const toolRefinement = (wireName, schemaName) => ({
  match: { 'update.sessionUpdate': wireName },
  path: 'update',
  schema: withDiscriminator(acp.schemas[schemaName], wireName),
  evidence: evidence({ existence: [runtimeClaim], shape: [acpClaim, runtimeClaim] }),
  confidence: 'verified-headless',
  fidelity: 'exact',
  limitations: [acpFidelityNote],
});
const standardSpecific = {
  tool_call: [
    'Grok streams `rawInput` ({variant, command, description, …}), `_meta["x.ai/tool"]` {name, kind, namespace, label, read_only}, and, for tools that never ran, `_meta.toolNotRun`: "rejected" after a reject, "cancelled" after a permission prompt was cancelled.',
  ],
  tool_call_update: [
    'Live updates progress null -> in_progress -> completed | failed; the durable log keeps only null and terminal statuses. rawOutput can carry the command output as a byte array and `was_bare_echo` for commands that skipped approval.',
  ],
  user_message_chunk: [
    'Live echo to the prompting controller only while another client (the native viewer) is attached; the durable log always keeps it.',
  ],
};
writeEvent('session/update', {
  channel: 'acp',
  channels: ['acp', 'session-log'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: acp.schemas.SessionNotification,
  recordSchema: durableCarrier('session/update'),
  recordChannel: 'session-log',
  evidence: evidence({ existence: [runtimeClaim], shape: [acpClaim, runtimeClaim], carrier: [runtimeClaim] }),
  confidence: 'verified-headless',
  variantDiscriminants: ['update.sessionUpdate'],
  variants: acp.sessionUpdateValues.map((value) => {
    const claims = observedStandard.has(value) ? [runtimeClaim] : [acpClaim];
    return {
      match: { 'update.sessionUpdate': value },
      evidence: evidence({
        existence: claims,
        shape: observedStandard.has(value) ? [acpClaim, runtimeClaim] : [acpClaim],
      }),
      confidence: confidenceOf(claims),
    };
  }),
  payloadRefinements: [
    toolRefinement('tool_call', 'ToolCall'),
    toolRefinement('tool_call_update', 'ToolCallUpdate'),
    ...[...observedStandard]
      .sort()
      .map((kind) => sampledUpdateRefinement(kind, standardPayloads, standardSpecific[kind] ?? [])),
    metaRefinement(
      standardPayloads,
      'Grok params-level `_meta`: eventId (`<sessionId>-<n>`, shared by a live notification and its durable copy), agentTimestampMs, promptId, totalTokens, requestTrimmedTokens, streamStartMs, turnStartMs, updateType, updateParams, chunkId, and on session/load replay isReplay plus x.ai/leaderClientId.',
    ),
  ],
  schemaFidelity: {
    payload: 'exact',
    carrier: 'sampled',
    limitations: [
      acpFidelityNote,
      'One carrier schema describes the durable session-log rail ({timestamp: Unix seconds, method, params}); the same event is live over JSON-RPC on ACP, where only params are validated.',
    ],
  },
  fixture: fixture('viewer-session', 'updates.jsonl'),
  notes: `The complete ${acp.sessionUpdateValues.length}-branch ACP inventory is retained. ${observedStandard.size} branches are runtime-captured on ${VERSION}; plan, current_mode_update, and usage_update remain unverified ACP leads.`,
});

// --- xAI extension updates --------------------------------------------------------------------

const liveExtension = wireOf('_x.ai/session_notification');
const durableExtension = durableOf('_x.ai/session/update');
const replayExtension = wireOf('_x.ai/session/update');
for (const entry of replayExtension) {
  if (!isReplay(entry.message.params)) throw new Error(`${entry.location}: live _x.ai/session/update outside replay`);
}
const livePayloads = liveExtension.map((entry) => entry.message.params);
const persistedPayloads = [
  ...durableExtension.map((entry) => entry.record.params),
  ...replayExtension.map((entry) => entry.message.params),
];
const observedLive = new Set(livePayloads.map(updateKind));
const observedPersisted = new Set(persistedPayloads.map(updateKind));
const mirrorByName = new Map(mirrorVariants.map((entry) => [entry.wireName, entry]));
const leadVariants = binaryLeads.binaryOnlyVariantLeads;
for (const kind of [...observedLive, ...observedPersisted]) {
  if (!mirrorByName.has(kind)) throw new Error(`observed xAI kind ${kind} is absent from the public inventory`);
}
const extensionInventory = [...mirrorVariants.map((entry) => entry.wireName), ...leadVariants];

const extensionBase = (payloads) =>
  object(
    {
      sessionId: string(),
      update: object({ sessionUpdate: string() }, ['sessionUpdate']),
      _meta: inferSchema(payloads.map((params) => params._meta)),
    },
    ['sessionId', 'update'],
  );
const extensionSpecific = {
  response_completed: [
    'On the loopback chat_completions backend the live payload is only {usage} with snake_case ResponseUsage (input_tokens excludes cache reads; output_tokens includes reasoning_tokens) and no signature or `_meta.eventId`; the public enum keeps message_id, stop_reason, signature, and stop_sequence optional.',
  ],
  turn_completed: [
    'usage (camelCase PromptUsage totals, including cache reads) is absent only on MidTurnAbort; PermissionRejected turns keep it. 1.0.70 adds elapsed_ms and `_meta.cancellationCategory` (MidTurnAbort | PermissionRejected | PermissionCancelled) / `_meta.cancellationContext`.',
  ],
  subagent_spawned: [
    'agentAddress (aa1.…) is live-only and omitted from updates.jsonl; attempt_id (at1.…) is new in 1.0.70.',
  ],
  hook_execution: ['Only with configured hooks. runs[] carries {name, status {status, elapsed_ms, error?}}.'],
  hook_run_started: ['Only with configured hooks; emitted before each hook_execution. It is not a completion.'],
  background_tasks: ['New in 1.0.70: sent when a client attaches to or loads the session, and at session end.'],
};

function mirrorRefinement(entry, observedPayloads) {
  const schema = mirrorVariantSchema(entry);
  // An observed branch keeps the public projection only where every capture satisfies it.
  const contradicted = observedPayloads.some(
    (params) => updateKind(params) === entry.wireName && validateSanitizedPayload(schema, params.update).length > 0,
  );
  if (contradicted) return undefined;
  return {
    match: { 'update.sessionUpdate': entry.wireName },
    path: 'update',
    schema,
    evidence: evidence({ existence: [mirrorClaim], shape: [mirrorClaim] }),
    confidence: 'unverified',
    fidelity: 'structural',
    limitations: [
      `Field names, optionality, and primitive/container types come from the public crate ${reference.publicMirror.crateVersion} enum (mirror ${reference.publicMirror.revision.slice(0, 8)}), older than the ${VERSION} binary. Custom nested Rust types stay unconstrained.`,
      ...(entry.payloadUnresolved ? [`Newtype payload ${entry.newtype} is declared outside the extracted file.`] : []),
    ],
  };
}
const leadRefinements = leadVariants.map((wireName) => ({
  match: { 'update.sessionUpdate': wireName },
  path: 'update',
  schema: object({ sessionUpdate: string([wireName]) }, ['sessionUpdate']),
  evidence: evidence({ existence: [serdeLeadClaim], shape: [serdeLeadClaim] }),
  confidence: 'unverified',
  fidelity: 'unknown',
  limitations: [
    `Binary-only name from the ${VERSION} serde variant-name run (absent from the public enum). Adjacent field-name leads ${binaryLeads.binaryOnlyFieldLeads.join(', ')} are not attributable to a variant; no payload shape is claimed.`,
  ],
}));

function extensionDocument(payloads, observed, { persisted }) {
  const inventory = persisted ? [...observed].sort() : extensionInventory;
  return {
    variants: inventory.map((wireName) => {
      const claims = observed.has(wireName)
        ? [runtimeClaim]
        : leadVariants.includes(wireName)
          ? [serdeLeadClaim]
          : [mirrorClaim];
      return {
        match: { 'update.sessionUpdate': wireName },
        evidence: evidence({ existence: claims, shape: claims }),
        confidence: confidenceOf(claims),
      };
    }),
    payloadRefinements: [
      ...[...observed].sort().map((kind) => sampledUpdateRefinement(kind, payloads, extensionSpecific[kind] ?? [])),
      ...inventory
        .filter((wireName) => mirrorByName.has(wireName))
        .map((wireName) => mirrorRefinement(mirrorByName.get(wireName), payloads))
        .filter(Boolean),
      ...(persisted ? [] : leadRefinements),
    ],
  };
}

const liveDocument = extensionDocument(livePayloads, observedLive, { persisted: false });
writeEvent('_x.ai/session_notification', {
  channel: 'acp',
  channels: ['acp'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: extensionBase(livePayloads),
  recordSchema: rpcCarrier('_x.ai/session_notification', false),
  recordChannel: 'acp',
  evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim], carrier: [runtimeClaim] }),
  confidence: 'verified-headless',
  ...liveDocument,
  schemaFidelity: {
    payload: 'structural',
    carrier: 'structural',
    limitations: [
      'The base schema fixes the envelope; branch schemas are evidence-bound refinements.',
      `${observedLive.size} xAI branches are runtime-captured live on ${VERSION}. The other ${mirrorVariants.length - observedLive.size} public-enum branches are unverified source leads, and ${leadVariants.length} names are binary-only serde-run leads with no claimed shape.`,
      CARRIER_LIMITATION,
    ],
  },
  fixture: fixture('viewer-session', 'acp-controller.jsonl'),
  notes:
    'Live spelling of xAI session updates. The leader also forwards a subagent child session’s notifications to the parent controller under the CHILD sessionId.',
});

const persistedDocument = extensionDocument(persistedPayloads, observedPersisted, { persisted: true });
writeEvent('_x.ai/session/update', {
  channel: 'acp',
  channels: ['acp', 'session-log'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: extensionBase(persistedPayloads),
  recordSchema: durableCarrier('_x.ai/session/update'),
  recordChannel: 'session-log',
  evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim], carrier: [runtimeClaim] }),
  confidence: 'verified-headless',
  ...persistedDocument,
  schemaFidelity: {
    payload: 'structural',
    carrier: 'sampled',
    limitations: [
      'The base schema fixes the envelope; branch schemas are evidence-bound refinements.',
      `Durable spelling of xAI updates in updates.jsonl. Over ACP it appears only while session/load replays history (_meta.isReplay). Only the ${observedPersisted.size} captured persisted branches are listed; other xAI kinds may also persist but were not observed.`,
    ],
  },
  fixture: fixture('hooks', 'updates.jsonl'),
  notes:
    'Distinct from the live `_x.ai/session_notification` spelling. hook_execution session_end then stop are written on every controller close; background_tasks is written on attach and at session end.',
});

// --- other xAI methods (sampled) --------------------------------------------------------------

const sampledNotifications = {
  '_x.ai/session/setup': {
    notes:
      'New in 1.0.70 and emitted only for session/new: phases auth, resolve_workspace, folder_trust, plugin_registry, mcp_merge (sessionId null) precede the result; response_ready (sessionId set) follows it, preceded by finalize_response and tool_overrides when subagents are enabled.',
    variants: 'phase',
  },
  '_x.ai/queue/changed': {
    notes: 'Prompt queue snapshots: two after each prompt is accepted and one before turn completion.',
  },
  '_x.ai/sessions/changed': {
    notes: 'Session-list upserts (cwd, activity working|idle, lastChangeUnixMs) around each turn.',
  },
  '_x.ai/session/prompt_complete': {
    notes:
      'Precedes the session/prompt result; carries stopReason, agentResult, and the cancellation fields of cancelled turns.',
  },
  '_x.ai/mcp_initialized': {
    notes:
      'Sent when the leader (re)initializes a session’s MCP servers: on session/load of an unloaded session and for a subagent child session.',
  },
  '_x.ai/mcp/servers_updated': {
    notes:
      'Carries `mcpServers` (the 1.0.0 model’s `servers` was a projection defect); sent after initialize and when a client attaches.',
  },
};
for (const [name, spec] of Object.entries(sampledNotifications)) {
  const entries = wireOf(name);
  if (entries.length === 0) throw new Error(`census captured no ${name}`);
  const payloads = entries.map((entry) => entry.message.params);
  const payloadSchema = inferSchema(payloads);
  const variantValues = spec.variants ? [...new Set(payloads.map((params) => params[spec.variants]))].sort() : [];
  writeEvent(name, {
    channel: 'acp',
    channels: ['acp'],
    transport: 'jsonrpc-notification',
    direction: 'agent-to-client',
    payloadSchema,
    recordSchema: rpcCarrier(name, false),
    recordChannel: 'acp',
    evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim], carrier: [runtimeClaim] }),
    confidence: 'verified-headless',
    ...(variantValues.length
      ? {
          variants: variantValues.map((value) => ({
            match: { [spec.variants]: value },
            evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim] }),
            confidence: 'verified-headless',
          })),
        }
      : {}),
    schemaFidelity: {
      payload: 'sampled',
      carrier: 'structural',
      limitations: [SAMPLED_LIMITATION, CARRIER_LIMITATION],
    },
    fixture: fixture(entries[0].scenario, entries[0].file),
    notes: spec.notes,
  });
}

{
  const entries = wireOf('_x.ai/auth/info');
  const results = resultsOf('_x.ai/auth/info');
  if (entries.length === 0 || results.length === 0) throw new Error('census captured no _x.ai/auth/info round trip');
  writeEvent('_x.ai/auth/info', {
    channel: 'acp',
    channels: ['acp'],
    transport: 'jsonrpc-request',
    direction: 'client-to-agent',
    payloadSchema: inferSchema(entries.map((entry) => entry.message.params)),
    resultSchema: inferSchema(results.map((entry) => entry.message.result)),
    recordSchema: rpcCarrier('_x.ai/auth/info', true),
    recordChannel: 'acp',
    evidence: evidence({
      existence: [runtimeClaim],
      shape: [runtimeClaim],
      result: [runtimeClaim],
      carrier: [runtimeClaim],
    }),
    confidence: 'verified-headless',
    schemaFidelity: {
      payload: 'sampled',
      result: 'sampled',
      carrier: 'structural',
      limitations: [
        SAMPLED_LIMITATION,
        'Captured with the xai.api_key method and a placeholder key; account fields are null. A grok.com sign-in populates them (unverified).',
        CARRIER_LIMITATION,
      ],
    },
    fixture: fixture(entries[0].scenario, entries[0].file),
    notes: 'Client-to-agent extension request (adapter profiles read it). The result shape matches 1.0.0.',
  });
}

// --- ambient extensions not reachable hermetically ---------------------------------------------

const ambient = {
  '_x.ai/models/update': object({ models: { type: 'array' }, currentModelId: string() }, ['models', 'currentModelId']),
  '_x.ai/settings/update': object({ settings: object() }, ['settings']),
  '_x.ai/announcements/update': object({ announcements: { type: 'array' } }, ['announcements']),
  '_x.ai/mcp/init_progress': object({ completed: integer({ minimum: 0 }), total: integer({ minimum: 0 }) }, [
    'completed',
    'total',
  ]),
};
for (const [name, payloadSchema] of Object.entries(ambient)) {
  if (wireOf(name).length > 0) throw new Error(`${name} was captured; model it from the capture`);
  if (binaryLeads.methodLiterals?.[name.slice(1)] !== true) throw new Error(`${name} literal absent from the binary`);
  writeEvent(name, {
    channel: 'acp',
    channels: ['acp'],
    transport: 'jsonrpc-notification',
    direction: 'agent-to-client',
    payloadSchema,
    recordSchema: rpcCarrier(name, false),
    recordChannel: 'acp',
    evidence: evidence({
      existence: [serdeLeadClaim, mirrorClaim],
      shape: [mirrorClaim],
      carrier: [mirrorClaim],
    }),
    confidence: 'unverified',
    schemaFidelity: {
      payload: 'unknown',
      carrier: 'structural',
      limitations: [
        `Not emitted in the hermetic ${VERSION} census (remote settings, announcements, the model catalog, and MCP servers are disabled). The method literal is present in the binary and the public pager dispatches it; the payload shape is carried over from the 1.0.0 census projection and is not ${VERSION} evidence.`,
      ],
    },
    notes:
      'Conditional ambient extension: depends on remote settings/announcements fetch, model-catalog refresh, or MCP server initialization.',
  });
}

// --- durable session state files --------------------------------------------------------------

const stateNotes = {
  'signals.json':
    'Rewritten asynchronously after each turn (absent or stale at the session/prompt result, current ≤500 ms later); cancelled turns count toward turnCount and cancellationCount on 1.0.70.',
  'summary.json':
    'Session summary; child (subagent) sessions add session_kind: "subagent" and share the cwd bucket. 1.0.70 adds agent_id (ag1.…) and attempt_id (at1.…).',
  'usage.json': 'New in 1.0.70: session and per-turn camelCase token totals with modelUsage per model.',
};
for (const [file, notes] of Object.entries(stateNotes)) {
  const entries = stateOf(file);
  if (entries.length === 0) throw new Error(`census captured no ${file}`);
  writeEvent(file, {
    channel: 'session-state',
    channels: ['session-state'],
    transport: 'json-file-replace',
    direction: 'agent-local',
    payloadSchema: inferSchema(entries.map((entry) => entry.record.params)),
    evidence: evidence({ existence: [runtimeClaim], shape: [runtimeClaim] }),
    confidence: 'verified-headless',
    schemaFidelity: { payload: 'sampled', limitations: [SAMPLED_LIMITATION] },
    fixture: fixture(entries[0].scenario, 'state.jsonl'),
    notes,
  });
}

// ---------------------------------------------------------------------------
// Validate every capture against the written documents
// ---------------------------------------------------------------------------

for (const entry of captured.wire) {
  const document = documents.get(entry.message.method);
  if (!document) {
    violations.push(`${entry.location}: method ${entry.message.method} has no event document`);
    continue;
  }
  if (document.direction !== entry.direction) violations.push(`${entry.location}: direction ${entry.direction}`);
  check(document.payloadSchema, entry.message.params, entry.location, 'payload');
  if (document.recordChannel === 'acp') check(document.recordSchema, entry.message, entry.location, 'carrier');
  checkRefinements(document, entry.message.params, entry.location);
}
for (const entry of captured.results) {
  check(documents.get(entry.method)?.resultSchema, entry.message.result, entry.location, `${entry.method} result`);
}
for (const entry of captured.durable) {
  const document = documents.get(entry.record.method);
  if (!document) {
    violations.push(`${entry.location}: durable method ${entry.record.method} has no event document`);
    continue;
  }
  check(document.payloadSchema, entry.record.params, entry.location, 'payload');
  if (document.recordChannel !== 'session-log')
    violations.push(`${entry.location}: durable record on a live-only event`);
  else check(document.recordSchema, entry.record, entry.location, 'durable carrier');
  checkRefinements(document, entry.record.params, entry.location);
}
for (const entry of captured.state) {
  check(documents.get(entry.record.method)?.payloadSchema, entry.record.params, entry.location, 'state');
}
if (violations.length > 0) {
  throw new Error(`captures contradict the generated model:\n  ${violations.slice(0, 40).join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// Detection, channels, manifest
// ---------------------------------------------------------------------------

const helpLong = readFileSync(join(probesRoot, 'help-long.txt'), 'utf8');
const leaderHelp = readFileSync(join(probesRoot, 'agent-leader-help.txt'), 'utf8');
const launchFlags = {
  leader: 'leader',
  leaderSocket: '--leader-socket',
  sessionId: '--session-id',
  resume: '--resume',
  model: '--model',
  permissionMode: '--permission-mode',
  sandbox: '--sandbox',
};
for (const value of Object.values(launchFlags)) {
  if (!helpLong.includes(value) && !leaderHelp.includes(value))
    throw new Error(`launch flag ${value} absent from help`);
}
const versionPattern = '^grok (\\d+\\.\\d+\\.\\d+) \\(([0-9a-f]+)\\)(?: \\[(stable|alpha)\\])?$';
if (!new RegExp(versionPattern).test(artifact.versionOutput)) throw new Error('version pattern rejects the artifact');
writeJson(join(modelRoot, 'manifest.json'), {
  asmVersion: 3,
  vendor: 'grok',
  vendorVersion: VERSION,
  generatedAt: release.generatedAt,
  source: `Controlled darwin-arm64 census of the exact ${VERSION} artifact (shared leader, ACP controllers, native viewer, durable store) plus binary probes, under a binary-only evidence policy. A digest-pinned nearest public mirror and its exact ACP schema are retained as separately attributed, unverified leads.`,
  evidence: 'evidence.json',
});
writeJson(join(modelRoot, 'detection.json'), {
  executables: ['grok'],
  envVar: 'PUPPETEER_GROK_BIN',
  versionFlag: '--version',
  versionOutput: artifact.versionOutput,
  versionPattern,
  helpFlag: '--help',
  launchFlags,
});
writeJson(join(modelRoot, 'channels.json'), {
  channels: {
    argv: {
      kind: 'argv-env',
      notes:
        'One long-lived `grok agent leader` plus leader-attached ACP controllers (`grok agent --leader --leader-socket <sock> stdio`) and the native viewer (`grok --leader --leader-socket <sock> --resume <id>`).',
    },
    acp: {
      kind: 'acp',
      notes:
        'Strict JSON-RPC 2.0 NDJSON over stdio. Standard session/update and the xAI extension methods remain distinct; the leader fans session traffic out to every attached client.',
    },
    'session-log': {
      kind: 'native-log',
      notes:
        'Append-only GROK_HOME/sessions/<encoded cwd>/<session>/updates.jsonl records {timestamp (Unix seconds), method, params}.',
    },
    'session-state': {
      kind: 'native-state',
      notes: 'Replace-in-place signals.json, summary.json, and usage.json beside updates.jsonl.',
    },
    leader: {
      kind: 'unix-socket',
      notes:
        'Coordination socket owned by `grok agent leader`; topology, not an event source. On SIGTERM 1.0.70 drains for about 2 s, exits 143, and unlinks the socket; leader.lock remains.',
    },
    terminal: {
      kind: 'terminal',
      notes:
        'Native leader-attached viewer. In 1.0.70 it renders and can answer leader-routed permission requests, including one issued before it attached; the first answer from any client wins. Semantics come from ACP and the durable store, never terminal text.',
    },
  },
});

// ---------------------------------------------------------------------------
// Behavior graph
// ---------------------------------------------------------------------------

const node = (id, event, lane, order, claims, extra = {}) => ({
  id,
  event,
  lane,
  order,
  confidence: confidenceOf(claims),
  evidence: evidence({ existence: claims, shape: claims }),
  ...extra,
});
const relation = (from, to, kind, claims, label) => ({
  from,
  to,
  kind,
  ...(label ? { label } : {}),
  confidence: minConfidence(claims),
  evidence: evidence({ existence: claims, shape: claims, ordering: claims }),
});
const R = [runtimeClaim];
const M = [mirrorClaim];
const xai = (kind, extra = {}) => ({ match: { 'update.sessionUpdate': kind, ...extra } });

writeJson(join(modelRoot, 'behavior.json'), {
  behaviorVersion: 1,
  title: `Grok ${VERSION} native leader, ACP, and durable-session lifecycle`,
  description:
    'Partial order over the captured rails of the exact artifact. Conditional relations name their trigger (viewer attached, hooks configured, command classification, subagents enabled); unverified nodes are public-source leads.',
  source: `darwin-arm64 census (census/harness.mjs) of grok ${VERSION}; ordering from directional ACP captures and updates.jsonl, timing from census observations.`,
  lanes: [
    { id: 'session', label: 'ACP session' },
    { id: 'setup', label: 'session/new setup' },
    { id: 'turn', label: 'Turn stream' },
    { id: 'tool', label: 'Tools / permission' },
    { id: 'team', label: 'Subagents / workflow' },
    { id: 'compact', label: 'Compaction' },
    { id: 'durable', label: 'Persisted truth' },
    { id: 'ambient', label: 'Ambient extensions' },
  ],
  nodes: [
    node('initialize', 'initialize', 'session', 0, R),
    node('mcp-servers', '_x.ai/mcp/servers_updated', 'session', 1, R),
    node('session-new', 'session/new', 'session', 2, R),
    node('setup-auth', '_x.ai/session/setup', 'setup', 0, R, { match: { phase: 'auth' } }),
    node('setup-resolve-workspace', '_x.ai/session/setup', 'setup', 1, R, { match: { phase: 'resolve_workspace' } }),
    node('setup-folder-trust', '_x.ai/session/setup', 'setup', 2, R, { match: { phase: 'folder_trust' } }),
    node('setup-plugin-registry', '_x.ai/session/setup', 'setup', 3, R, { match: { phase: 'plugin_registry' } }),
    node('setup-mcp-merge', '_x.ai/session/setup', 'setup', 4, R, { match: { phase: 'mcp_merge' } }),
    node('setup-finalize-response', '_x.ai/session/setup', 'setup', 5, R, { match: { phase: 'finalize_response' } }),
    node('setup-tool-overrides', '_x.ai/session/setup', 'setup', 6, R, { match: { phase: 'tool_overrides' } }),
    node('setup-response-ready', '_x.ai/session/setup', 'setup', 7, R, { match: { phase: 'response_ready' } }),
    node('background-tasks', '_x.ai/session_notification', 'session', 3, R, xai('background_tasks')),
    node('model-changed', '_x.ai/session_notification', 'session', 4, R, xai('model_changed')),
    node('available-commands', 'session/update', 'session', 5, R, xai('available_commands_update')),
    node('config-option', 'session/update', 'session', 6, R, xai('config_option_update')),
    node(
      'session-start-hook',
      '_x.ai/session_notification',
      'session',
      7,
      R,
      xai('hook_execution', { 'update.event_name': 'session_start' }),
    ),
    node('session-load', 'session/load', 'session', 8, R),
    node('replay-persisted', '_x.ai/session/update', 'session', 9, R, { match: { '_meta.isReplay': true } }),
    node('replay-standard', 'session/update', 'session', 9, R),
    node('mcp-initialized', '_x.ai/mcp_initialized', 'session', 10, R),
    node('session-list', 'session/list', 'session', 11, R),
    node('auth-info', '_x.ai/auth/info', 'session', 11, R),
    node('prompt', 'session/prompt', 'turn', 0, R),
    node('sessions-changed', '_x.ai/sessions/changed', 'turn', 1, R),
    node('queue-changed', '_x.ai/queue/changed', 'turn', 1, R),
    node('user-message-echo', 'session/update', 'turn', 2, R, xai('user_message_chunk')),
    node(
      'prompt-hook-started',
      '_x.ai/session_notification',
      'turn',
      2,
      R,
      xai('hook_run_started', { 'update.event_name': 'user_prompt_submit' }),
    ),
    node(
      'prompt-hook',
      '_x.ai/session_notification',
      'turn',
      3,
      R,
      xai('hook_execution', { 'update.event_name': 'user_prompt_submit' }),
    ),
    node('summary-generated', '_x.ai/session_notification', 'turn', 3, R, xai('session_summary_generated')),
    node('session-info', 'session/update', 'turn', 4, R, xai('session_info_update')),
    node('thought', 'session/update', 'turn', 5, R, xai('agent_thought_chunk')),
    node('assistant', 'session/update', 'turn', 8, R, xai('agent_message_chunk')),
    node('response-complete', '_x.ai/session_notification', 'turn', 9, R, xai('response_completed')),
    node(
      'stop-hook',
      '_x.ai/session_notification',
      'turn',
      10,
      R,
      xai('hook_execution', { 'update.event_name': 'stop' }),
    ),
    node('turn-complete', '_x.ai/session_notification', 'turn', 11, R, xai('turn_completed')),
    node('prompt-complete', '_x.ai/session/prompt_complete', 'turn', 12, R),
    node('last-turn-summary', '_x.ai/session_notification', 'turn', 13, R, xai('last_turn_summary')),
    node('cancel', 'session/cancel', 'turn', 6, R),
    node('tool-delta', '_x.ai/session_notification', 'tool', 5, R, xai('tool_call_delta_chunk')),
    node('tool-start', 'session/update', 'tool', 6, R, xai('tool_call')),
    node(
      'pre-tool-hook',
      '_x.ai/session_notification',
      'tool',
      7,
      R,
      xai('hook_execution', { 'update.event_name': 'pre_tool_use' }),
    ),
    node('pending-interaction', '_x.ai/session_notification', 'tool', 7, R, xai('pending_interaction')),
    node('permission', 'session/request_permission', 'tool', 8, R),
    node('interaction-resolved', '_x.ai/session_notification', 'tool', 9, R, xai('interaction_resolved')),
    node('tool-progress', 'session/update', 'tool', 10, R, xai('tool_call_update', { 'update.status': 'in_progress' })),
    node(
      'post-tool-hook',
      '_x.ai/session_notification',
      'tool',
      10,
      R,
      xai('hook_execution', { 'update.event_name': 'post_tool_use' }),
    ),
    node('tool-finish', 'session/update', 'tool', 11, R, xai('tool_call_update', { 'update.status': 'completed' })),
    node('tool-rejected', 'session/update', 'tool', 11, R, xai('tool_call_update', { 'update.status': 'failed' })),
    node(
      'tool-permission-cancelled',
      'session/update',
      'tool',
      11,
      [approvalProbeClaim],
      xai('tool_call_update', { 'update.status': 'failed', 'update._meta.toolNotRun': 'cancelled' }),
    ),
    node('subagent-spawned', '_x.ai/session_notification', 'team', 7, R, xai('subagent_spawned')),
    node('subagent-progress', '_x.ai/session_notification', 'team', 8, M, xai('subagent_progress')),
    node('subagent-finished', '_x.ai/session_notification', 'team', 9, R, xai('subagent_finished')),
    node('workflow-updated', '_x.ai/session_notification', 'team', 8, M, xai('workflow_updated')),
    node('goal-updated', '_x.ai/session_notification', 'team', 8, M, xai('goal_updated')),
    node('compact-start', '_x.ai/session_notification', 'compact', 6, M, xai('auto_compact_started')),
    node('compact-complete', '_x.ai/session_notification', 'compact', 8, R, xai('auto_compact_completed')),
    node('compact-failed', '_x.ai/session_notification', 'compact', 8, M, xai('auto_compact_failed')),
    node('compact-cancelled', '_x.ai/session_notification', 'compact', 8, M, xai('auto_compact_cancelled')),
    node('compact-checkpoint', '_x.ai/session/update', 'compact', 7, R, xai('compaction_checkpoint')),
    node('durable-user', 'session/update', 'durable', 2, R, xai('user_message_chunk')),
    node('durable-tool-call', 'session/update', 'durable', 6, R, xai('tool_call')),
    node(
      'durable-pre-tool-hook',
      '_x.ai/session/update',
      'durable',
      7,
      R,
      xai('hook_execution', { 'update.event_name': 'pre_tool_use' }),
    ),
    node('durable-final-chunk', 'session/update', 'durable', 8, R, xai('agent_message_chunk')),
    node(
      'durable-stop-hook',
      '_x.ai/session/update',
      'durable',
      9,
      R,
      xai('hook_execution', { 'update.event_name': 'stop' }),
    ),
    node('durable-turn', '_x.ai/session/update', 'durable', 10, R, xai('turn_completed')),
    node('durable-subagent-spawned', '_x.ai/session/update', 'durable', 7, R, xai('subagent_spawned')),
    node(
      'durable-session-end-hook',
      '_x.ai/session/update',
      'durable',
      12,
      R,
      xai('hook_execution', { 'update.event_name': 'session_end' }),
    ),
    node('durable-background-tasks', '_x.ai/session/update', 'durable', 13, R, xai('background_tasks')),
    node('signals', 'signals.json', 'durable', 11, R),
    node('summary', 'summary.json', 'durable', 11, R),
    node('usage', 'usage.json', 'durable', 11, R),
    node('models', '_x.ai/models/update', 'ambient', 1, [serdeLeadClaim, mirrorClaim]),
    node('settings', '_x.ai/settings/update', 'ambient', 1, [serdeLeadClaim, mirrorClaim]),
    node('announcements', '_x.ai/announcements/update', 'ambient', 1, [serdeLeadClaim, mirrorClaim]),
    node('mcp-progress', '_x.ai/mcp/init_progress', 'ambient', 2, [serdeLeadClaim, mirrorClaim]),
  ],
  relations: [
    relation('initialize', 'mcp-servers', 'async', R),
    relation('initialize', 'session-new', 'sequence', R),
    relation('session-new', 'setup-auth', 'sequence', R, 'phases before the result carry sessionId null'),
    relation('setup-auth', 'setup-resolve-workspace', 'sequence', R),
    relation('setup-resolve-workspace', 'setup-folder-trust', 'sequence', R),
    relation('setup-folder-trust', 'setup-plugin-registry', 'sequence', R),
    relation('setup-plugin-registry', 'setup-mcp-merge', 'sequence', R),
    relation('setup-mcp-merge', 'setup-response-ready', 'sequence', R, 'after the session/new result'),
    relation('setup-mcp-merge', 'setup-finalize-response', 'conditional', R, 'after the result, subagents enabled'),
    relation('setup-finalize-response', 'setup-tool-overrides', 'sequence', R),
    relation('setup-tool-overrides', 'setup-response-ready', 'sequence', R),
    relation('setup-response-ready', 'session-start-hook', 'conditional', R, 'hooks configured'),
    relation(
      'setup-response-ready',
      'background-tasks',
      'conditional',
      R,
      'another client (the native viewer) attaches',
    ),
    relation('background-tasks', 'model-changed', 'sequence', R),
    relation('model-changed', 'available-commands', 'sequence', R),
    relation('available-commands', 'config-option', 'sequence', R),
    relation('setup-response-ready', 'prompt', 'sequence', R),
    relation('prompt', 'sessions-changed', 'sequence', R),
    relation('sessions-changed', 'queue-changed', 'sequence', R),
    relation('queue-changed', 'user-message-echo', 'conditional', R, 'live echo only while another client is attached'),
    relation('queue-changed', 'prompt-hook-started', 'conditional', R, 'hooks configured'),
    relation('prompt-hook-started', 'prompt-hook', 'sequence', R),
    relation('queue-changed', 'summary-generated', 'conditional', R, 'first turn, or a retitled session'),
    relation('summary-generated', 'session-info', 'sequence', R),
    relation('queue-changed', 'thought', 'sequence', R),
    relation('thought', 'thought', 'loop', R),
    relation('thought', 'assistant', 'sequence', R),
    relation('assistant', 'assistant', 'loop', R),
    relation('assistant', 'response-complete', 'sequence', R),
    relation('response-complete', 'stop-hook', 'conditional', R, 'hooks configured'),
    relation('response-complete', 'turn-complete', 'sequence', R),
    relation('stop-hook', 'turn-complete', 'sequence', R),
    relation('turn-complete', 'prompt-complete', 'sequence', R, 'both precede the session/prompt result'),
    relation('prompt-complete', 'last-turn-summary', 'async', R, 'after the result'),
    relation(
      'turn-complete',
      'signals',
      'async',
      [runtimeClaim, observationClaim],
      'rewritten after the prompt result',
    ),
    relation('turn-complete', 'usage', 'async', R),
    relation('turn-complete', 'summary', 'async', R),
    relation('turn-complete', 'prompt', 'loop', R, 'next turn'),
    relation('cancel', 'turn-complete', 'sequence', R, 'stopReason cancelled, MidTurnAbort, no usage'),
    relation('thought', 'tool-delta', 'conditional', R),
    relation('tool-delta', 'tool-start', 'sequence', R),
    relation('tool-start', 'pre-tool-hook', 'conditional', R, 'hooks configured'),
    relation('tool-start', 'pending-interaction', 'sequence', R),
    relation('pending-interaction', 'permission', 'conditional', R, 'mutating command or subagent spawn'),
    relation(
      'pending-interaction',
      'interaction-resolved',
      'conditional',
      R,
      'command classed safe: no permission request',
    ),
    relation(
      'permission',
      'interaction-resolved',
      'sequence',
      [runtimeClaim, approvalProbeClaim],
      'first answer from any attached client (controller or 1.0.70 viewer) wins; a later answer is ignored',
    ),
    relation('interaction-resolved', 'tool-progress', 'sequence', R, 'allowed'),
    relation('tool-progress', 'post-tool-hook', 'conditional', R, 'hooks configured'),
    relation('tool-progress', 'tool-finish', 'sequence', R),
    relation('interaction-resolved', 'tool-rejected', 'conditional', R, 'rejected: toolNotRun, PermissionRejected'),
    relation('tool-rejected', 'turn-complete', 'sequence', R),
    relation(
      'interaction-resolved',
      'tool-permission-cancelled',
      'conditional',
      [approvalProbeClaim],
      'permission prompt cancelled in the viewer: toolNotRun cancelled, PermissionCancelled',
    ),
    relation('tool-permission-cancelled', 'turn-complete', 'sequence', [approvalProbeClaim]),
    relation(
      'cancel',
      'interaction-resolved',
      'conditional',
      [approvalProbeClaim],
      'a pending request is resolved by session/cancel with no tool_call_update (MidTurnAbort)',
    ),
    relation('tool-finish', 'thought', 'sequence', R),
    relation('tool-finish', 'subagent-spawned', 'conditional', R, 'spawn_subagent approved'),
    relation(
      'subagent-spawned',
      'mcp-initialized',
      'concurrent',
      R,
      'child session traffic reaches the parent controller under the child sessionId',
    ),
    relation('subagent-spawned', 'subagent-progress', 'sequence', M),
    relation('subagent-progress', 'subagent-finished', 'sequence', M),
    relation('subagent-spawned', 'subagent-finished', 'async', R),
    relation(
      'subagent-finished',
      'thought',
      'async',
      R,
      'will_wake: the parent runs a host turn without session/prompt',
    ),
    relation('subagent-spawned', 'workflow-updated', 'async', M),
    relation('workflow-updated', 'goal-updated', 'async', M),
    relation('thought', 'compact-start', 'conditional', M, 'automatic compaction'),
    relation('compact-start', 'compact-complete', 'sequence', M),
    relation('compact-start', 'compact-failed', 'conditional', M),
    relation('compact-start', 'compact-cancelled', 'conditional', M),
    relation('queue-changed', 'compact-complete', 'conditional', R, '/compact host turn'),
    relation('compact-checkpoint', 'compact-complete', 'sequence', R, 'durable checkpoint is written first'),
    relation('compact-complete', 'turn-complete', 'sequence', R),
    relation('prompt', 'durable-user', 'concurrent', R),
    relation('durable-tool-call', 'durable-pre-tool-hook', 'sequence', R, '1.0.70 writes pre_tool_use after tool_call'),
    relation('durable-final-chunk', 'durable-stop-hook', 'sequence', R, '1.0.70 writes stop after the final chunk'),
    relation('durable-stop-hook', 'durable-turn', 'sequence', R),
    relation(
      'durable-final-chunk',
      'durable-turn',
      'sequence',
      R,
      'a cancelled turn’s final chunk precedes turn_completed',
    ),
    relation(
      'durable-tool-call',
      'durable-subagent-spawned',
      'concurrent',
      R,
      'position relative to the spawn tool’s completion varies',
    ),
    relation(
      'durable-turn',
      'durable-session-end-hook',
      'conditional',
      R,
      'controller closes with hooks configured: session_end then stop',
    ),
    relation('durable-turn', 'durable-background-tasks', 'sequence', R, 'session end'),
    relation('initialize', 'session-load', 'resume', R),
    relation('session-load', 'replay-persisted', 'sequence', R, 'replayed before the session/load result'),
    relation('session-load', 'replay-standard', 'sequence', R),
    relation('replay-persisted', 'mcp-initialized', 'conditional', R, 'session was not loaded in the leader'),
    relation('replay-persisted', 'available-commands', 'sequence', R, 'after the session/load result'),
    relation('replay-persisted', 'background-tasks', 'sequence', R),
    relation(
      'replay-persisted',
      'session-start-hook',
      'conditional',
      R,
      'hooks configured: session_start fires again on load',
    ),
    relation('initialize', 'session-list', 'sequence', R),
    relation('initialize', 'auth-info', 'sequence', R),
    relation('initialize', 'models', 'conditional', [serdeLeadClaim, mirrorClaim], 'model catalog refresh'),
    relation('initialize', 'settings', 'conditional', [serdeLeadClaim, mirrorClaim], 'remote settings'),
    relation('initialize', 'announcements', 'conditional', [serdeLeadClaim, mirrorClaim], 'remote announcements'),
    relation('mcp-servers', 'mcp-progress', 'conditional', [serdeLeadClaim, mirrorClaim], 'MCP servers configured'),
  ],
});

formatGenerated(modelRoot);

// ---------------------------------------------------------------------------
// Evidence index
// ---------------------------------------------------------------------------

const record = (path) => relative(repoRoot, path).split(sep).join('/');
const artifactId = `installed-grok-${VERSION}-${release.platform}`;
const harness =
  'packages/surface/vendors/grok/census/harness.mjs (shared leader, ACP controllers, native viewer in a PTY, loopback model provider, disposable GROK_HOME)';
writeJson(join(modelRoot, 'evidence.json'), {
  evidenceVersion: 2,
  vendor: 'grok',
  vendorVersion: VERSION,
  evidencePolicy: {
    kind: 'binary-only',
    statement: `Grok ${VERSION} has no public source: its binary-reported revision ${release.binaryReportedRevision} is absent from the public source mirror, whose newest commit is crate ${reference.publicMirror.crateVersion}. Every verified claim therefore rests on runtime captures and binary probes of the exact artifact. Public mirror source and the ACP schema dependency are retained as unverified, separately attributed leads; an exact ACP schema is treated as verified only where every captured carrier validates against it. Binary serde-run names are low-confidence leads and never establish a shape.`,
  },
  artifacts: [
    {
      id: artifactId,
      platform: release.platform,
      channel: 'stable',
      acquiredAt: release.acquiredAt,
      sourceUrl: artifact.sourceUrl,
      versionOutput: artifact.versionOutput,
      integrity: { status: 'verified', sha256: `sha256:${artifact.sha256}` },
    },
  ],
  sourceReferences: [
    {
      repository: 'https://github.com/xai-org/grok-build',
      revision: release.binaryReportedRevision,
      relation: 'binary-reported-revision-not-present-in-public-mirror',
    },
    {
      repository: reference.publicMirror.repository,
      revision: reference.publicMirror.revision,
      relation: 'public-mirror-commit',
      sourceRevision: reference.publicMirror.sourceRevision,
      scope: 'nearest-public-mirror-older-than-binary',
      crateVersion: reference.publicMirror.crateVersion,
      contract: `${record(referencesRoot)}/public-source-surface.json`,
    },
    {
      repository: acp.repository,
      revision: acp.revision,
      relation: 'exact-release',
      scope: 'dependency-of-supplemental-public-mirror-only',
      tag: acp.tag,
      schemaVersion: acp.schemaVersion,
      contract: `${record(referencesRoot)}/public-source-surface.json`,
    },
  ],
  records: [
    {
      id: 'sanitized-captures',
      kind: 'capture-set',
      path: record(capturesRoot),
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(capturesRoot),
    },
    {
      id: 'binary-probes',
      kind: 'probe-set',
      path: record(probesRoot),
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(probesRoot),
    },
    {
      id: 'supplemental-public-reference',
      kind: 'reference-snapshot',
      path: record(referencesRoot),
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(referencesRoot),
    },
    {
      id: 'agent-surface-model',
      kind: 'model-tree',
      path: record(modelRoot),
      exclude: ['evidence.json'],
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(modelRoot, ['evidence.json']),
    },
  ],
  claims: [
    {
      id: runtimeClaim,
      kind: 'runtime-capture',
      confidence: 'verified-headless',
      record: 'sanitized-captures',
      artifact: artifactId,
      platform: release.platform,
      harness,
      capturedAt,
      notes: `Type-preserving native carriers from scenarios ${capture.scenarios.join(', ')}: directional ACP frames, updates.jsonl, and signals/summary/usage.json.`,
    },
    {
      id: observationClaim,
      kind: 'runtime-capture',
      confidence: 'verified-headless',
      record: 'sanitized-captures',
      artifact: artifactId,
      platform: release.platform,
      harness,
      capturedAt,
      notes:
        'Harness-computed semantic projections (observations.json, topology.json, store-layout.json): timing, counts, literal permission option inventories, and process topology. Admissible for occurrence, ordering, timing, and retained literals only, never for a schema.',
    },
    {
      id: probeClaim,
      kind: 'binary-probe',
      confidence: 'verified-headless',
      record: 'binary-probes',
      artifact: artifactId,
      platform: release.platform,
      harness: 'packages/surface/vendors/grok/census/harness.mjs --probes-only (disposable home, explicit environment)',
      capturedAt,
      notes:
        '`--version`, long/short help, subcommand help trees, and the `grok completions fish` grammar of the exact artifact.',
    },
    {
      id: approvalProbeClaim,
      kind: 'runtime-capture',
      confidence: 'verified-headless',
      record: 'binary-probes',
      artifact: artifactId,
      platform: release.platform,
      harness:
        'packages/surface/vendors/grok/census/harness.mjs --approval-probe (deferring ACP controller, native viewer in a PTY, loopback model provider, disposable GROK_HOME)',
      capturedAt,
      notes:
        'Semantic digest viewer-approvals.json: who answers a leader-routed session/request_permission when the controller leaves it open. Viewer keystrokes are control input only; outcomes come from controller ACP frames, the workspace, and the persisted-rule count. Admissible for occurrence, ordering, and outcomes only, never for a schema.',
    },
    {
      id: serdeLeadClaim,
      kind: 'binary-probe',
      confidence: 'unverified',
      record: 'supplemental-public-reference',
      artifact: artifactId,
      platform: release.platform,
      harness: 'packages/surface/vendors/grok/census/extract-public-reference.mjs (printable-run scan)',
      capturedAt,
      notes:
        'Low-confidence leads from a strings heuristic over the exact bytes: serde variant names absent from the public enum and xAI method literals. Rust string pooling makes absence meaningless and presence weak.',
    },
    {
      id: mirrorClaim,
      kind: 'exact-source',
      confidence: 'unverified',
      record: 'supplemental-public-reference',
      sourceReference: 1,
      notes: `Digest-pinned nearest public mirror (crate ${reference.publicMirror.crateVersion}), older than the binary. It cannot promote binary claims.`,
    },
    {
      id: acpClaim,
      kind: 'generated-schema',
      confidence: 'unverified',
      record: 'supplemental-public-reference',
      sourceReference: 2,
      notes: `Exact generated ACP schema ${acp.schemaVersion}, the dependency of the nearest public mirror commit.`,
    },
  ],
  limitations: [
    `The binary-reported source revision ${release.binaryReportedRevision} is absent from the public source mirror, so source-to-artifact equivalence is unverified; this model follows the binary-only evidence policy above.`,
    `Only ${release.platform} has artifact integrity and census evidence; darwin-x64, linux-x64, and windows-x64 (named-pipe leader) are unverified for ${VERSION}.`,
    'The hermetic census disables remote settings, announcements, the model catalog, MCP servers, memory, workflows, and the Responses-API model backend, so _x.ai/models|settings|announcements/update, _x.ai/mcp/init_progress, models_cache.json, _x.ai/billing, the memory socket, and response_completed signatures remain unverified.',
    'subagent_progress, workflow_updated, goal_updated, plan_*, auto_compact_started/failed/cancelled, session_status, served_model, turn_usage, memory_*, and the binary-only login_refused/backend_responsive/session_ended leads were not exercised.',
    'Captured values under id-shaped keys are aliases (permission optionIds, model ids, config option ids, auth method ids, xAI ag1./at1./aa1. ids); literal option ids are retained only in the census observations.',
  ],
});
formatGenerated(join(modelRoot, 'evidence.json'));
writeGroundTruthArtifacts(modelRoot);

function formatGenerated(...paths) {
  execFileSync(process.execPath, [prettierBin, '--write', ...paths], { stdio: 'ignore' });
}

console.log(`generated Grok ${VERSION} ASM: ${documents.size} events at ${modelRoot}`);
