#!/usr/bin/env node
/** Generate the evidence-bound Kimi 2.4.1 Agent Surface Model. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDocumentPath } from '@vibefield/puppeteer-surface';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { projectJsonSchema } from '@vibefield/puppeteer-surface';

const VERSION = '2.4.1';

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
if (sourceReference.vendorVersion !== VERSION || sourceReference.wire.persistedOperationTypes !== 67) {
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
const supplementalSchemas = sourceReference.wire.supplemental.payloadSchemas;
const supplementalWireTypes = Object.keys(supplementalSchemas);
const hookEvents = sourceReference.hooks.events;
const hookSchemas = sourceReference.hooks.payloadSchemas;

// Scenario preference when several captures contain the same native record.
const fixturePreference = [
  'basic-turn',
  'tool-success',
  'tool-nonzero',
  'background-task',
  'resume-turn',
  'provider-error',
  'provider-retry',
  'malformed-stream',
  'interrupt-stream',
  'hook-block-prompt',
  'hook-deny-tool',
  'subagent-turn',
];

function scenarioDirectories() {
  const names = readdirSync(capturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const unknown = names.filter((name) => !fixturePreference.includes(name));
  if (unknown.length) throw new Error(`Kimi ${VERSION} captures contain unranked scenarios: ${unknown.join(', ')}`);
  return fixturePreference.filter((name) => names.includes(name));
}

function jsonLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Observed record/hook names, each with the first preferred fixture that contains it. */
function observedSurfaces() {
  const wire = new Map();
  const hooks = new Map();
  for (const scenario of scenarioDirectories()) {
    const root = join(capturesRoot, scenario);
    const journals = [join(root, 'wire.jsonl')];
    const agentsDir = join(root, 'agents');
    try {
      journals.push(
        ...readdirSync(agentsDir)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .map((name) => join(agentsDir, name)),
      );
    } catch {
      // Only subagent scenarios carry child journals.
    }
    for (const journal of journals) {
      for (const record of jsonLines(journal)) {
        if (record.type === 'metadata' || wire.has(record.type)) continue;
        wire.set(record.type, relative(vendorRoot, journal).split(sep).join('/'));
      }
    }
    for (const file of readdirSync(join(root, 'hooks')).sort()) {
      const event = file.replace(/\.jsonl$/, '');
      if (!hooks.has(event))
        hooks.set(
          event,
          relative(vendorRoot, join(root, 'hooks', file))
            .split(sep)
            .join('/'),
        );
    }
  }
  return { wire, hooks };
}

const observed = observedSurfaces();
const knownWireTypes = new Set([...persistedWireTypes, ...supplementalWireTypes]);
for (const type of observed.wire.keys()) {
  if (!knownWireTypes.has(type)) throw new Error(`captured Kimi record ${type} has no source contract`);
}
const observedWireTypes = new Set(observed.wire.keys());
const observedHooks = new Set(observed.hooks.keys());
const totalSurfaceCount = persistedWireTypes.length + supplementalWireTypes.length + hookEvents.length + 3;
const runtimeSurfaceCount = observedWireTypes.size + observedHooks.size + 3;

const selectedVariantPaths = {
  'agent.turn.ended': ['outcome'],
  'context.append_loop_event': ['event.type', 'event.part.type', 'event.providerFinishReason'],
  'context.append_message': ['message.role', 'message.origin.kind', 'message.origin.status'],
  'prompt.completed': ['reason'],
  'task.started': ['info.kind', 'info.status'],
  'task.terminated': ['info.kind', 'info.status'],
  'turn.cancel': ['target', 'reason'],
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
    'Kimi Code 2.4.1 controlled print-mode census plus a digest-pinned projection of the exact release source. The generated manifest lists 67 durable record types; three engine-journal records and two undo records outside it are inventory-checked against their producers. Unforced branches remain unverified.',
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

const wireSchemas = { ...schemas, ...supplementalSchemas };
for (const type of [...persistedWireTypes, ...supplementalWireTypes]) {
  const claim = observedWireTypes.has(type) ? runtimeClaim : sourceClaim;
  const eventVariants = variantsFor(type, wireSchemas[type]);
  const variantDiscriminants = Object.keys(selectedVariantValues[type] ?? {});
  writeEvent(type, {
    channel: 'wire',
    channels: ['wire'],
    transport: 'jsonl-record',
    direction: 'agent-local',
    payloadSchema: wireSchemas[type],
    recordSchema: recordSchema(type, wireSchemas[type]),
    recordChannel: 'wire',
    evidence: evidence(claim, true, true),
    confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
    ...(eventVariants.length ? { variants: eventVariants, variantDiscriminants } : {}),
    ...(type === 'context.append_loop_event' ? { payloadRefinements: toolCallRefinements } : {}),
    ...(observedWireTypes.has(type) ? { fixture: observed.wire.get(type) } : {}),
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
    ...(observedHooks.has(event) ? { fixture: observed.hooks.get(event) } : {}),
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
      isCustomTitle: boolean,
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
  title: 'Kimi Code 2.4.1 native wire and hook lifecycle',
  description:
    'Partial order over the durable v2 journal, its interleaved engine-journal records, and external hooks. Only hermetically captured print-mode branches are verified.',
  source: 'Controlled Kimi 2.4.1 census plus exact release source. Source-only branches remain unverified.',
  lanes: [
    { id: 'session', label: 'Session' },
    { id: 'turn', label: 'Turn / step' },
    { id: 'tool', label: 'Tool / interaction' },
    { id: 'compact', label: 'Compaction' },
    { id: 'task', label: 'Task / subagent / swarm' },
    { id: 'hook', label: 'External hooks' },
  ],
  nodes: [
    node('metadata', 'metadata', 'session', 0),
    node('runtime-binding', 'runtime.set_binding', 'session', 1),
    node('profile-bind', 'profile.bind', 'session', 2),
    node('change-snapshot', 'changeNotifier.snapshot', 'session', 3),
    node('permission-mode', 'permission.set_mode', 'session', 4),
    node('turn-prompt', 'turn.prompt', 'turn', 5),
    node('context-user', 'context.append_message', 'turn', 6, runtimeClaim, { match: { 'message.role': 'user' } }),
    node('context-hook-result', 'context.append_message', 'turn', 6, runtimeClaim, {
      match: { 'message.origin.kind': 'hook_result' },
    }),
    node('engine-turn-started', 'agent.turn.started', 'turn', 7),
    node('step-begin', 'context.append_loop_event', 'turn', 8, runtimeClaim, { match: { 'event.type': 'step.begin' } }),
    node('content-part', 'context.append_loop_event', 'turn', 9, runtimeClaim, {
      match: { 'event.type': 'content.part' },
    }),
    node('tool-call', 'context.append_loop_event', 'tool', 10, runtimeClaim, { match: { 'event.type': 'tool.call' } }),
    node('tool-result', 'context.append_loop_event', 'tool', 11, runtimeClaim, {
      match: { 'event.type': 'tool.result' },
    }),
    node('step-end', 'context.append_loop_event', 'turn', 12, runtimeClaim, { match: { 'event.type': 'step.end' } }),
    node('step-retrying', 'turn.step.retrying', 'turn', 13),
    node('step-interrupted', 'turn.step.interrupted', 'turn', 13),
    node('turn-cancel', 'turn.cancel', 'turn', 11),
    node('engine-turn-ended', 'agent.turn.ended', 'turn', 14),
    node('turn-ended', 'turn.ended', 'turn', 15),
    node('prompt-completed', 'prompt.completed', 'turn', 16),
    node('prompt-aborted', 'prompt.aborted', 'turn', 16),
    node('session-start-hook', 'SessionStart', 'hook', 0),
    node('prompt-hook', 'UserPromptSubmit', 'hook', 5),
    node('turn-start-hook', 'TurnStarted', 'hook', 7),
    node('pre-tool-hook', 'PreToolUse', 'hook', 10),
    node('post-tool-hook', 'PostToolUse', 'hook', 11),
    node('post-tool-failure-hook', 'PostToolUseFailure', 'hook', 11),
    node('task-started-hook', 'TaskStarted', 'hook', 10),
    node('notification-hook', 'Notification', 'hook', 13),
    node('interrupt-hook', 'Interrupt', 'hook', 15),
    node('stop-failure-hook', 'StopFailure', 'hook', 15),
    node('stop-hook', 'Stop', 'hook', 15),
    node('subagent-start-hook', 'SubagentStart', 'hook', 10),
    node('subagent-stop-hook', 'SubagentStop', 'hook', 11),
    node('interaction-request', 'interaction.request', 'tool', 10, sourceClaim),
    node('interaction-resolved', 'interaction.resolved', 'tool', 11, sourceClaim),
    node('turn-steer', 'turn.steer', 'turn', 9, sourceClaim),
    node('compact-begin', 'full_compaction.begin', 'compact', 8, sourceClaim),
    node('compact-apply', 'context.apply_compaction', 'compact', 9, sourceClaim),
    node('compact-complete', 'full_compaction.complete', 'compact', 10, sourceClaim),
    node('compact-cancel', 'full_compaction.cancel', 'compact', 10, sourceClaim),
    node('task-started', 'task.started', 'task', 10),
    node('task-terminated', 'task.terminated', 'task', 12),
    node('subagent-spawned', 'subagent.spawned', 'task', 10),
    node('subagent-started', 'subagent.started', 'task', 10),
    node('subagent-completed', 'subagent.completed', 'task', 11),
    node('subagent-failed', 'subagent.failed', 'task', 11, sourceClaim),
    node('subagent-cancelled', 'subagent.cancelled', 'task', 11, sourceClaim),
    node('swarm-enter', 'swarm_mode.enter', 'task', 6, sourceClaim),
    node('swarm-exit', 'swarm_mode.exit', 'task', 16, sourceClaim),
    node('undo-switched', 'agent.switched', 'turn', 17, sourceClaim),
    node('undo-legacy', 'context.undo', 'turn', 17, sourceClaim),
    node('undo-marker', 'context.undone', 'turn', 17, sourceClaim),
  ],
  relations: [
    relation('metadata', 'runtime-binding'),
    relation('runtime-binding', 'profile-bind'),
    relation('profile-bind', 'change-snapshot'),
    relation('change-snapshot', 'permission-mode'),
    relation('permission-mode', 'turn-prompt'),
    relation('permission-mode', 'context-hook-result', 'conditional', runtimeClaim, 'UserPromptSubmit block'),
    relation('turn-prompt', 'context-user'),
    relation('context-user', 'engine-turn-started'),
    relation('engine-turn-started', 'step-begin'),
    relation('step-begin', 'content-part', 'conditional', runtimeClaim, 'assistant content'),
    relation('step-begin', 'tool-call', 'conditional', runtimeClaim, 'tool step'),
    relation('tool-call', 'tool-result'),
    relation('content-part', 'step-end'),
    relation('tool-result', 'step-end'),
    relation('step-end', 'step-begin', 'loop', runtimeClaim, 'next model step after a tool'),
    relation('step-end', 'step-retrying', 'conditional', runtimeClaim, 'finishReason error, retryable'),
    relation('step-retrying', 'step-begin', 'loop', runtimeClaim, 'retried step'),
    relation('step-end', 'step-interrupted', 'conditional', runtimeClaim, 'finishReason error or interrupted'),
    relation('turn-cancel', 'step-end', 'conditional', runtimeClaim, 'cancelled active turn'),
    relation('step-interrupted', 'engine-turn-ended'),
    relation('step-end', 'engine-turn-ended', 'conditional', runtimeClaim, 'end_turn'),
    relation('engine-turn-ended', 'turn-ended'),
    relation('turn-ended', 'prompt-completed', 'conditional', runtimeClaim, 'completed or failed'),
    relation('turn-ended', 'prompt-aborted', 'conditional', runtimeClaim, 'cancelled'),
    relation('context-hook-result', 'prompt-completed', 'conditional', runtimeClaim, 'blocked'),
    relation('interaction-request', 'interaction-resolved', 'sequence', sourceClaim),
    relation('compact-begin', 'compact-apply', 'conditional', sourceClaim),
    relation('compact-apply', 'compact-complete', 'sequence', sourceClaim),
    relation('compact-begin', 'compact-cancel', 'conditional', sourceClaim),
    relation('task-started', 'task-terminated'),
    relation('subagent-spawned', 'subagent-started'),
    relation('subagent-started', 'subagent-completed', 'conditional', runtimeClaim, 'completed'),
    relation('subagent-started', 'subagent-failed', 'conditional', sourceClaim, 'failed'),
    relation('subagent-started', 'subagent-cancelled', 'conditional', sourceClaim, 'cancelled'),
    relation('subagent-start-hook', 'subagent-stop-hook'),
    relation('swarm-enter', 'swarm-exit', 'sequence', sourceClaim),
    relation('undo-switched', 'undo-legacy', 'sequence', sourceClaim),
    relation('undo-legacy', 'undo-marker', 'sequence', sourceClaim),
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
        'isolated KIMI_CODE_HOME with loopback OpenAI-compatible provider, command hooks, multi-invocation resume, detached process task, provider rejection, hook block/deny, HTTP 429 and malformed-SSE step retries, print-mode SIGINT cancellation, and a foreground subagent journal',
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
        'Digest-pinned exact release source establishes 67 durable record schemas from the generated manifest, 5 engine-journal/undo records outside it, 20 hook schemas, protocol 1.5, and CLI declarations; it does not promote unforced runtime behavior.',
    },
  ],
  limitations: [
    'The controlled census is native print mode, including multi-invocation resume, a detached process task, provider rejection, hook block/deny, HTTP 429 and malformed-SSE step retries, print-mode SIGINT cancellation, and a foreground subagent journal; it is not interactive PTY mode.',
    `Runtime evidence covers ${runtimeSurfaceCount} of ${totalSurfaceCount} modelled surfaces; the remaining ${totalSurfaceCount - runtimeSurfaceCount} are exact-source-only.`,
    'Interactive TUI permissions, questions, steer, queueing, Esc-cancel, compaction, undo/branch switching, swarm, tower mode, and non-success process-task or subagent outcomes remain unverified.',
    'Only the linux-x64 release artifact has runtime evidence; this is not a support promotion.',
  ],
});
formatGenerated(join(modelRoot, 'evidence.json'));
writeGroundTruthArtifacts(modelRoot);

console.log(`generated Kimi ASM: ${totalSurfaceCount} events at ${modelRoot}`);
