#!/usr/bin/env node
/** Generate the evidence-bound Kimi 0.34.0 Agent Surface Model. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDocumentPath } from '@vibefield/puppeteer-surface';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { projectJsonSchema } from '@vibefield/puppeteer-surface';

const VERSION = '0.34.0';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(dirname(vendorRoot));
const repoRoot = dirname(dirname(packageRoot));
const capturesRoot = join(vendorRoot, 'captures', `kimi@${VERSION}`);
const probesRoot = join(vendorRoot, 'probes', `kimi@${VERSION}`);
const referencesRoot = join(vendorRoot, 'references', `kimi@${VERSION}`);
const modelRoot = join(vendorRoot, 'model', `kimi@${VERSION}`);
const eventsRoot = join(modelRoot, 'events');
const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs');

const sourceReference = JSON.parse(readFileSync(join(referencesRoot, 'source-contract.json'), 'utf8'));
const artifactProbe = JSON.parse(readFileSync(join(probesRoot, 'artifact.json'), 'utf8'));
const flagProbe = JSON.parse(readFileSync(join(probesRoot, 'flags.json'), 'utf8'));
const rawCaptureAttestation = JSON.parse(readFileSync(join(probesRoot, 'raw-capture-attestation.json'), 'utf8'));
if (sourceReference.vendorVersion !== VERSION || sourceReference.wire.persistedOperationTypes !== 40) {
  throw new Error(`invalid Kimi ${VERSION} source reference`);
}
if (artifactProbe.vendorVersion !== VERSION || !/^[0-9a-f]{64}$/.test(artifactProbe.sha256)) {
  throw new Error(`invalid Kimi ${VERSION} artifact probe`);
}
const SOURCE_COMMIT = sourceReference.revision;
const ARTIFACT_SHA256 = artifactProbe.sha256;
const CAPTURED_AT = rawCaptureAttestation.captureStartedAt;

const runtimeClaim = 'kimi-runtime-headless';
const sourceClaim = 'kimi-exact-release-source';

const string = (values) => ({ type: 'string', ...(values ? { enum: values } : {}) });
const number = (bounds = {}) => ({ type: 'number', ...bounds });
const boolean = { type: 'boolean' };
const object = (properties = {}, required = [], extra = {}) => ({
  type: 'object',
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
  ...extra,
});
const evidence = (claim, carrier = false, sourceBacked = false) => ({
  existence: [claim],
  shape: claim === runtimeClaim && sourceBacked ? [runtimeClaim, sourceClaim] : [claim],
  ...(carrier ? { carrier: claim === runtimeClaim && sourceBacked ? [runtimeClaim, sourceClaim] : [claim] } : {}),
});
const variant = (match, claim) => ({
  match,
  evidence: evidence(claim, false, true),
  confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
});

const schemas = sourceReference.wire.payloadSchemas;
const persistedWireTypes = sourceReference.wire.persisted.map((entry) => entry.type);
const hookEvents = sourceReference.hooks.events;
const hookSchemas = sourceReference.hooks.payloadSchemas;
const observedWireTypes = new Set([
  'context.append_loop_event',
  'context.append_message',
  'llm.request',
  'llm.tools_snapshot',
  'permission.set_mode',
  'profile.bind',
  'task.started',
  'task.terminated',
  'turn.ended',
  'turn.prompt',
  'usage.record',
]);
const observedHooks = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'StopFailure',
  'TaskStarted',
  'UserPromptSubmit',
  'TurnStarted',
  'Stop',
  'SessionStart',
  'SubagentStart',
  'SubagentStop',
]);
const totalSurfaceCount = persistedWireTypes.length + hookEvents.length + 3;
const runtimeSurfaceCount = observedWireTypes.size + observedHooks.size + 3;

const selectedVariantPaths = {
  'context.append_loop_event': ['event.type', 'event.part.type', 'event.providerFinishReason'],
  'context.append_message': ['message.role', 'message.origin.kind', 'message.origin.status'],
  'task.started': ['info.kind', 'info.status'],
  'task.terminated': ['info.kind', 'info.status'],
  'turn.ended': ['reason'],
  Notification: ['sink', 'severity'],
  SessionStart: ['source'],
  TaskStarted: ['kind', 'status'],
  TurnStarted: ['origin_kind'],
};

function valueAt(value, dottedPath) {
  return dottedPath
    .split('.')
    .reduce(
      (current, component) => (current !== null && typeof current === 'object' ? current[component] : undefined),
      value,
    );
}

function collectRuntimeVariantValues() {
  const selected = Object.fromEntries(
    Object.entries(selectedVariantPaths).map(([event, paths]) => [
      event,
      Object.fromEntries(paths.map((path) => [path, new Set()])),
    ]),
  );
  const journals = walkFiles(capturesRoot)
    .filter((path) => path.endsWith('.jsonl'))
    .filter((path) => {
      const artifact = relative(capturesRoot, path).split(sep).join('/');
      return basename(path) === 'wire.jsonl' || artifact.includes('/agents/') || artifact.includes('/hooks/');
    })
    .sort();
  for (const path of journals) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      const event = typeof record.hook_event_name === 'string' ? record.hook_event_name : record.type;
      const paths = selected[event];
      if (!paths) continue;
      for (const [dottedPath, values] of Object.entries(paths)) {
        const value = valueAt(record, dottedPath);
        if (value !== undefined) values.add(value);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(selected).map(([event, paths]) => [
      event,
      Object.fromEntries(Object.entries(paths).map(([path, values]) => [path, [...values]])),
    ]),
  );
}

const selectedVariantValues = collectRuntimeVariantValues();

function enumClaims(schema, prefix = '') {
  const claims = [];
  if (schema.enum !== undefined && prefix) claims.push({ path: prefix, values: schema.enum });
  for (const branch of schema.anyOf ?? []) claims.push(...enumClaims(branch, prefix));
  for (const [field, child] of Object.entries(schema.properties ?? {})) {
    claims.push(...enumClaims(child, prefix ? `${prefix}.${field}` : field));
  }
  return claims;
}

function variantsFor(event, schema) {
  const seen = new Set();
  const result = [];
  const selectedPaths = new Set(Object.keys(selectedVariantValues[event] ?? {}));
  for (const claim of enumClaims(schema).filter((candidate) => selectedPaths.has(candidate.path))) {
    for (const value of claim.values) {
      const key = `${claim.path}\0${JSON.stringify(value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const observed = selectedVariantValues[event]?.[claim.path]?.some((candidate) => Object.is(candidate, value));
      result.push(variant({ [claim.path]: value }, observed ? runtimeClaim : sourceClaim));
    }
  }
  return result;
}

function walkFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walkFiles(path) : statSync(path).isFile() ? [path] : [];
  });
}

function stripSchemaAnnotations(value, isNamedSchemaMap = false) {
  if (Array.isArray(value)) return value.map((child) => stripSchemaAnnotations(child));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => isNamedSchemaMap || !['description', 'title', 'examples', '$comment'].includes(key))
      .map(([key, child]) => [
        key,
        stripSchemaAnnotations(child, ['properties', 'patternProperties', '$defs', 'definitions'].includes(key)),
      ]),
  );
}

function loadRuntimeToolSchemas() {
  const catalogs = new Map();
  for (const path of walkFiles(capturesRoot).filter((candidate) => candidate.endsWith('wire.jsonl'))) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.type !== 'llm.tools_snapshot' || !Array.isArray(record.tools)) continue;
      const catalog = record.tools
        .map((tool) => ({ name: tool.name, schema: projectJsonSchema(stripSchemaAnnotations(tool.parameters)) }))
        .sort((left, right) => left.name.localeCompare(right.name));
      catalogs.set(JSON.stringify(catalog), catalog);
    }
  }
  if (catalogs.size !== 1) {
    throw new Error(`Kimi ${VERSION} captures contain ${catalogs.size} distinct runtime tool catalogs`);
  }
  return catalogs.values().next().value;
}

const runtimeToolSchemas = loadRuntimeToolSchemas();
const toolCallRefinements = runtimeToolSchemas.map((tool) => ({
  match: { 'event.type': 'tool.call', 'event.name': tool.name },
  path: 'event.args',
  schema: tool.schema,
  evidence: evidence(runtimeClaim),
  confidence: 'verified-headless',
  fidelity: 'exact',
}));

const wireFixtures = {
  'context.append_loop_event': 'tool-success',
  'context.append_message': 'basic-turn',
  'llm.request': 'basic-turn',
  'llm.tools_snapshot': 'basic-turn',
  'permission.set_mode': 'basic-turn',
  'profile.bind': 'basic-turn',
  'task.started': 'background-task',
  'task.terminated': 'background-task',
  'turn.ended': 'basic-turn',
  'turn.prompt': 'basic-turn',
  'usage.record': 'basic-turn',
};
const hookFixtures = {
  PreToolUse: 'tool-success',
  PostToolUse: 'tool-success',
  PostToolUseFailure: 'tool-nonzero',
  Notification: 'background-task',
  StopFailure: 'provider-error',
  TaskStarted: 'background-task',
  UserPromptSubmit: 'basic-turn',
  TurnStarted: 'basic-turn',
  Stop: 'basic-turn',
  SessionStart: 'basic-turn',
  SubagentStart: 'subagent-turn',
  SubagentStop: 'subagent-turn',
};

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function recordSchema(type, payloadSchema) {
  return object(
    { type: string([type]), ...(payloadSchema.properties ?? {}), time: number({ minimum: 0 }) },
    ['type', ...(payloadSchema.required ?? []), 'time'],
    payloadSchema.anyOf ? { anyOf: payloadSchema.anyOf } : {},
  );
}

function writeEvent(name, document) {
  const schemaFidelity = document.schemaFidelity ?? {
    ...(document.payloadSchema ? { payload: 'structural' } : {}),
    ...(document.resultSchema ? { result: 'structural' } : {}),
    ...(document.recordSchema ? { carrier: 'structural' } : {}),
    limitations: [
      'The release source projection preserves recursive declared structure but intentionally leaves custom/unknown values unconstrained; runtime-only file schemas describe captured instances.',
    ],
  };
  writeJson(join(eventsRoot, eventDocumentPath(name)), {
    surface: 'kimi',
    surfaceVersion: VERSION,
    event: name,
    ...((document.payloadSchema || document.resultSchema || document.recordSchema) && { schemaFidelity }),
    ...document,
  });
}

function formatGenerated(...paths) {
  execFileSync(process.execPath, [prettierBin, '--write', ...paths], { stdio: 'ignore' });
}

rmSync(modelRoot, { recursive: true, force: true });
mkdirSync(eventsRoot, { recursive: true });

writeJson(join(modelRoot, 'manifest.json'), {
  asmVersion: 3,
  vendor: 'kimi',
  vendorVersion: VERSION,
  generatedAt: artifactProbe.probedAt.slice(0, 10),
  source:
    'Kimi Code 0.34.0 controlled print-mode census plus a digest-pinned projection of the exact release source. The source inventory contains 40 persisted and 8 transient operation types; unforced branches remain unverified.',
  evidence: 'evidence.json',
});
writeJson(join(modelRoot, 'detection.json'), {
  executables: ['kimi'],
  envVar: 'PUPPETEER_KIMI_BIN',
  versionFlag: '--version',
  versionOutput: VERSION,
  versionPattern: '^(\\d+\\.\\d+\\.\\d+)$',
  helpFlag: '--help',
  probedFlags: Object.fromEntries(
    Object.entries(flagProbe.visibleHelpOptions).map(([name, flags]) => [name, flags.join(', ')]),
  ),
  launchFlags: {
    session: sourceReference.cli.options.session.join(', '),
    sessionId: sourceReference.cli.options.session.join(', '),
    resume: sourceReference.cli.options.session.join(', '),
    ...Object.fromEntries(
      Object.entries(sourceReference.cli.options)
        .filter(([name]) => name !== 'session')
        .map(([name, flags]) => [name, flags.join(', ')]),
    ),
  },
});
writeJson(join(modelRoot, 'channels.json'), {
  channels: {
    argv: { kind: 'argv-env', notes: 'Native Kimi process launch and KIMI_CODE_HOME selection.' },
    terminal: {
      kind: 'terminal',
      notes: 'Native TUI presentation and guarded input; terminal text is not semantic truth.',
    },
    wire: {
      kind: 'native-log',
      notes: `Append-only sessions/<workspace>/<session>/agents/<agent>/wire.jsonl protocol ${sourceReference.wire.protocolVersion}.`,
    },
    'session-state': { kind: 'native-state', notes: 'Replace-in-place state.json session metadata.' },
    'session-index': { kind: 'native-index', notes: 'Append-only session_index.jsonl beneath KIMI_CODE_HOME.' },
    'hook-command': { kind: 'hook-command', notes: 'Configured external hooks receive one JSON document on stdin.' },
  },
});

writeEvent('metadata', {
  channel: 'wire',
  channels: ['wire'],
  transport: 'jsonl-header',
  direction: 'agent-local',
  payloadSchema: object(
    { protocol_version: string([sourceReference.wire.protocolVersion]), created_at: number({ minimum: 0 }) },
    ['protocol_version', 'created_at'],
  ),
  recordSchema: object(
    {
      type: string(['metadata']),
      protocol_version: string([sourceReference.wire.protocolVersion]),
      created_at: number({ minimum: 0 }),
    },
    ['type', 'protocol_version', 'created_at'],
  ),
  recordChannel: 'wire',
  evidence: evidence(runtimeClaim, true, true),
  confidence: 'verified-headless',
  fixture: `captures/kimi@${VERSION}/basic-turn/wire.jsonl`,
});

for (const type of persistedWireTypes) {
  const claim = observedWireTypes.has(type) ? runtimeClaim : sourceClaim;
  const eventVariants = variantsFor(type, schemas[type]);
  const variantDiscriminants = Object.keys(selectedVariantValues[type] ?? {});
  writeEvent(type, {
    channel: 'wire',
    channels: ['wire'],
    transport: 'jsonl-record',
    direction: 'agent-local',
    payloadSchema: schemas[type],
    recordSchema: recordSchema(type, schemas[type]),
    recordChannel: 'wire',
    evidence: evidence(claim, true, true),
    confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
    ...(eventVariants.length ? { variants: eventVariants, variantDiscriminants } : {}),
    ...(type === 'context.append_loop_event' ? { payloadRefinements: toolCallRefinements } : {}),
    ...(observedWireTypes.has(type)
      ? {
          fixture: `captures/kimi@${VERSION}/${wireFixtures[type]}/wire.jsonl`,
        }
      : {}),
  });
}

for (const event of hookEvents) {
  const claim = observedHooks.has(event) ? runtimeClaim : sourceClaim;
  const payloadSchema = hookSchemas[event];
  const eventVariants = variantsFor(event, payloadSchema);
  writeEvent(event, {
    channel: 'hook-command',
    channels: ['hook-command'],
    transport: 'command-stdin',
    direction: 'agent-local',
    payloadSchema,
    evidence: evidence(claim, false, true),
    confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
    ...(eventVariants.length
      ? { variants: eventVariants, variantDiscriminants: Object.keys(selectedVariantValues[event] ?? {}) }
      : {}),
    ...(observedHooks.has(event)
      ? { fixture: `captures/kimi@${VERSION}/${hookFixtures[event]}/hooks/${event}.jsonl` }
      : {}),
  });
}

writeEvent('state.json', {
  channel: 'session-state',
  channels: ['session-state'],
  transport: 'json-file',
  direction: 'agent-local',
  payloadSchema: object(
    {
      id: string(),
      version: number(),
      cwd: string(),
      createdAt: number(),
      updatedAt: number(),
      archived: boolean,
      agents: object(),
      custom: object(),
      lastTurnReason: { anyOf: [string(), { type: 'null' }] },
    },
    ['id', 'version', 'cwd', 'createdAt', 'updatedAt', 'archived', 'agents', 'custom'],
  ),
  evidence: evidence(runtimeClaim),
  confidence: 'verified-headless',
  fixture: `captures/kimi@${VERSION}/basic-turn/state.json`,
});
writeEvent('session_index.entry', {
  channel: 'session-index',
  channels: ['session-index'],
  transport: 'jsonl-record',
  direction: 'agent-local',
  payloadSchema: object({ sessionId: string(), sessionDir: string(), workDir: string() }, [
    'sessionId',
    'sessionDir',
    'workDir',
  ]),
  evidence: evidence(runtimeClaim),
  confidence: 'verified-headless',
  fixture: `captures/kimi@${VERSION}/basic-turn/session-index.jsonl`,
});

const node = (id, event, lane, order, claim = runtimeClaim, extra = {}) => ({
  id,
  event,
  lane,
  order,
  confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
  evidence: evidence(claim, false, true),
  ...extra,
});
const relation = (from, to, kind = 'sequence', claim = runtimeClaim, label) => ({
  from,
  to,
  kind,
  ...(label ? { label } : {}),
  confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
  evidence: { ...evidence(claim, false, true), ordering: [claim] },
});
writeJson(join(modelRoot, 'behavior.json'), {
  behaviorVersion: 1,
  title: 'Kimi Code 0.34.0 native wire and hook lifecycle',
  description:
    'Partial order over the durable v2 journal and external hooks. Only hermetically captured print-mode branches are verified.',
  source: 'Controlled Kimi 0.34.0 census plus exact release source. Source-only branches remain unverified.',
  lanes: [
    { id: 'session', label: 'Session' },
    { id: 'turn', label: 'Turn / step' },
    { id: 'tool', label: 'Tool / interaction' },
    { id: 'compact', label: 'Compaction' },
    { id: 'task', label: 'Task / swarm' },
    { id: 'hook', label: 'External hooks' },
  ],
  nodes: [
    node('metadata', 'metadata', 'session', 0),
    node('profile-bind', 'profile.bind', 'session', 1),
    node('permission-mode', 'permission.set_mode', 'session', 2),
    node('turn-prompt', 'turn.prompt', 'turn', 3),
    node('context-user', 'context.append_message', 'turn', 4, runtimeClaim, { match: { 'message.role': 'user' } }),
    node('context-hook-result', 'context.append_message', 'turn', 4, runtimeClaim, {
      match: { 'message.origin.kind': 'hook_result' },
    }),
    node('step-begin', 'context.append_loop_event', 'turn', 5, runtimeClaim, { match: { 'event.type': 'step.begin' } }),
    node('content-part', 'context.append_loop_event', 'turn', 6, runtimeClaim, {
      match: { 'event.type': 'content.part' },
    }),
    node('tool-call', 'context.append_loop_event', 'tool', 7, runtimeClaim, { match: { 'event.type': 'tool.call' } }),
    node('tool-result', 'context.append_loop_event', 'tool', 8, runtimeClaim, {
      match: { 'event.type': 'tool.result' },
    }),
    node('step-end', 'context.append_loop_event', 'turn', 9, runtimeClaim, { match: { 'event.type': 'step.end' } }),
    node('turn-ended', 'turn.ended', 'turn', 10),
    node('session-start-hook', 'SessionStart', 'hook', 0),
    node('prompt-hook', 'UserPromptSubmit', 'hook', 3),
    node('turn-start-hook', 'TurnStarted', 'hook', 4),
    node('pre-tool-hook', 'PreToolUse', 'hook', 7),
    node('post-tool-hook', 'PostToolUse', 'hook', 8),
    node('post-tool-failure-hook', 'PostToolUseFailure', 'hook', 8),
    node('task-started-hook', 'TaskStarted', 'hook', 5),
    node('notification-hook', 'Notification', 'hook', 9),
    node('stop-failure-hook', 'StopFailure', 'hook', 10),
    node('stop-hook', 'Stop', 'hook', 10),
    node('subagent-start-hook', 'SubagentStart', 'hook', 5),
    node('subagent-stop-hook', 'SubagentStop', 'hook', 9),
    node('interaction-request', 'interaction.request', 'tool', 7, sourceClaim),
    node('interaction-resolved', 'interaction.resolved', 'tool', 8, sourceClaim),
    node('turn-cancel', 'turn.cancel', 'turn', 9, sourceClaim),
    node('turn-steer', 'turn.steer', 'turn', 4, sourceClaim),
    node('compact-begin', 'full_compaction.begin', 'compact', 5, sourceClaim),
    node('compact-apply', 'context.apply_compaction', 'compact', 6, sourceClaim),
    node('compact-complete', 'full_compaction.complete', 'compact', 7, sourceClaim),
    node('compact-cancel', 'full_compaction.cancel', 'compact', 7, sourceClaim),
    node('task-started', 'task.started', 'task', 5),
    node('task-terminated', 'task.terminated', 'task', 9),
    node('swarm-enter', 'swarm_mode.enter', 'task', 4, sourceClaim),
    node('swarm-exit', 'swarm_mode.exit', 'task', 10, sourceClaim),
  ],
  relations: [
    relation('metadata', 'profile-bind'),
    relation('profile-bind', 'permission-mode'),
    relation('permission-mode', 'turn-prompt'),
    relation('turn-prompt', 'context-user'),
    relation('context-user', 'step-begin'),
    relation('step-begin', 'content-part', 'conditional', runtimeClaim, 'assistant content'),
    relation('step-begin', 'tool-call', 'conditional', runtimeClaim, 'tool step'),
    relation('tool-call', 'tool-result'),
    relation('content-part', 'step-end'),
    relation('tool-result', 'step-end'),
    relation('step-end', 'step-begin', 'loop', runtimeClaim, 'next model step after a tool'),
    relation('step-end', 'turn-ended', 'conditional', runtimeClaim, 'end_turn'),
    relation('interaction-request', 'interaction-resolved', 'sequence', sourceClaim),
    relation('compact-begin', 'compact-apply', 'conditional', sourceClaim),
    relation('compact-apply', 'compact-complete', 'sequence', sourceClaim),
    relation('compact-begin', 'compact-cancel', 'conditional', sourceClaim),
    relation('task-started', 'task-terminated'),
    relation('subagent-start-hook', 'subagent-stop-hook'),
    relation('swarm-enter', 'swarm-exit', 'sequence', sourceClaim),
  ],
});

// Evidence binds the bytes users review, so format the generated tree before
// computing its digest. The index itself is excluded from that digest.
formatGenerated(modelRoot);

const captureRecord = relative(repoRoot, capturesRoot).split(sep).join('/');
const probeRecord = relative(repoRoot, probesRoot).split(sep).join('/');
const referenceRecord = relative(repoRoot, referencesRoot).split(sep).join('/');
const modelRecord = relative(repoRoot, modelRoot).split(sep).join('/');
writeJson(join(modelRoot, 'evidence.json'), {
  evidenceVersion: 2,
  vendor: 'kimi',
  vendorVersion: VERSION,
  artifacts: [
    {
      id: `installed-kimi-${VERSION}-${artifactProbe.platform}`,
      platform: artifactProbe.platform,
      channel: 'stable',
      acquiredAt: artifactProbe.probedAt,
      versionOutput: artifactProbe.versionOutput,
      fileDescription: artifactProbe.fileDescription,
      bytes: artifactProbe.bytes,
      integrity: { status: 'verified', sha256: `sha256:${ARTIFACT_SHA256}` },
    },
  ],
  sourceReferences: [
    {
      repository: 'https://github.com/moonshotai/kimi-code',
      revision: SOURCE_COMMIT,
      relation: 'exact-release',
      tag: sourceReference.tag,
      contract: `${referenceRecord}/source-contract.json`,
    },
  ],
  records: [
    {
      id: 'sanitized-captures',
      kind: 'capture-set',
      path: captureRecord,
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(capturesRoot),
    },
    {
      id: 'binary-probes',
      kind: 'probe-set',
      path: probeRecord,
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(probesRoot),
    },
    {
      id: 'exact-source-reference',
      kind: 'reference-snapshot',
      path: referenceRecord,
      digestAlgorithm: 'sha256-path-content-v1',
      sha256: digestTree(referencesRoot),
    },
    {
      id: 'agent-surface-model',
      kind: 'model-tree',
      path: modelRecord,
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
      artifact: `installed-kimi-${VERSION}-${artifactProbe.platform}`,
      platform: artifactProbe.platform,
      harness:
        'isolated KIMI_CODE_HOME with loopback OpenAI-compatible provider, command hooks, multi-invocation resume, detached process task, provider rejection, hook block/deny, HTTP retry, print-mode SIGINT abort, and a foreground subagent journal',
      capturedAt: CAPTURED_AT,
    },
    {
      id: 'kimi-binary-probe',
      kind: 'binary-probe',
      confidence: 'verified-headless',
      record: 'binary-probes',
      artifact: `installed-kimi-${VERSION}-${artifactProbe.platform}`,
      platform: artifactProbe.platform,
      harness: 'SHA-256, file identity, --version, --help, rejected-option, and raw-capture tree probes',
      capturedAt: artifactProbe.probedAt,
    },
    {
      id: sourceClaim,
      kind: 'exact-source',
      confidence: 'unverified',
      record: 'exact-source-reference',
      sourceReference: 0,
      notes:
        'Digest-pinned exact release source establishes 40 persisted operation schemas, 8 transient types, 20 hook schemas, protocol 1.5, and CLI declarations; it does not promote unforced runtime behavior.',
    },
  ],
  limitations: [
    'The controlled census is native print mode, including multi-invocation resume, a detached process task, provider rejection, hook block/deny, HTTP retry, print-mode SIGINT abort, and a foreground subagent journal; it is not interactive PTY mode.',
    `Runtime evidence covers ${runtimeSurfaceCount} of ${totalSurfaceCount} modelled surfaces; the remaining ${totalSurfaceCount - runtimeSurfaceCount} are exact-source-only.`,
    'Interactive TUI permissions, questions, steer, queueing, Esc-cancel with durable turn.ended(cancelled), compaction, swarm, and non-success process-task outcomes remain unverified.',
    'Only the locally installed darwin-arm64 artifact has runtime evidence; this is not a support promotion.',
  ],
});
formatGenerated(join(modelRoot, 'evidence.json'));
writeGroundTruthArtifacts(modelRoot);

console.log(`generated Kimi ASM: ${totalSurfaceCount} events at ${modelRoot}`);
