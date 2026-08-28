#!/usr/bin/env node
/** Generate the evidence-bound Grok 1.0.0 Agent Surface Model. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';

const VERSION = '1.0.0';
const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(dirname(vendorRoot));
const repoRoot = dirname(dirname(packageRoot));
const capturesRoot = join(vendorRoot, 'captures', `grok@${VERSION}`);
const referencesRoot = join(vendorRoot, 'references', `grok@${VERSION}`);
const modelRoot = join(vendorRoot, 'model', `grok@${VERSION}`);
const eventsRoot = join(modelRoot, 'events');
const reference = JSON.parse(readFileSync(join(referencesRoot, 'public-source-surface.json'), 'utf8'));
const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs');
if (
  reference.vendorVersion !== VERSION ||
  reference.publicMirror.relationToBinary !== 'unverified-not-present-in-public-mirror'
) {
  throw new Error(`invalid Grok ${VERSION} supplemental reference`);
}

const runtimeClaim = 'grok-runtime-headless';
const mirrorClaim = 'grok-public-mirror-lead';
const acpClaim = 'grok-public-acp-lead';
const acp = reference.acpDependencyOfPublicMirror;
const string = (values) => ({ type: 'string', ...(values ? { enum: values } : {}) });
const integer = (bounds = {}) => ({ type: 'integer', ...bounds });
const number = (bounds = {}) => ({ type: 'number', ...bounds });
const boolean = { type: 'boolean' };
const object = (properties = {}, required = [], extra = {}) => ({
  type: 'object',
  ...(Object.keys(properties).length ? { properties } : {}),
  ...(required.length ? { required } : {}),
  ...extra,
});
const array = (items = {}) => ({ type: 'array', items });
const runtimeEvidence = (carrier = false) => ({
  existence: [runtimeClaim],
  shape: [runtimeClaim],
  ...(carrier ? { carrier: [runtimeClaim] } : {}),
});
const sourceEvidence = (claim, carrier = false, result = false, observed = false) => ({
  existence: [observed ? runtimeClaim : claim],
  shape: [claim],
  ...(carrier ? { carrier: [observed ? runtimeClaim : claim] } : {}),
  ...(result ? { result: [claim] } : {}),
});
const variant = (match, claim) => ({
  match,
  evidence: claim === runtimeClaim ? runtimeEvidence() : sourceEvidence(claim),
  confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeEvent(name, document) {
  writeJson(join(eventsRoot, `${name}.json`), {
    surface: 'grok',
    surfaceVersion: VERSION,
    event: name,
    ...document,
  });
}

function formatGenerated(...paths) {
  execFileSync(process.execPath, [prettierBin, '--write', ...paths], { stdio: 'ignore' });
}

function rpcCarrier(method, payloadSchema, request = false) {
  // A projected payload closes local references inside its own $defs. Embedding
  // that schema below params would make JSON-Schema `#/$defs/*` references
  // resolve against the carrier root instead. Carrier fidelity is structural,
  // so keep params open when the payload owns local definitions.
  const carrierPayload = payloadSchema.$defs ? object() : payloadSchema;
  return object(
    {
      jsonrpc: string(['2.0']),
      ...(request ? { id: { anyOf: [integer(), string()] } } : {}),
      method: string([method]),
      params: carrierPayload,
    },
    ['jsonrpc', ...(request ? ['id'] : []), 'method', 'params'],
  );
}

function sourceSchemaFidelity(result = false) {
  return {
    payload: 'exact',
    ...(result ? { result: 'exact' } : {}),
    carrier: 'structural',
    limitations: [
      `The retained schema is exact for ACP schema ${acp.schemaVersion} at ${acp.revision}, the dependency of a supplemental public Grok source commit. The installed binary's reported revision is absent from that mirror, so binary equivalence is unverified.`,
    ],
  };
}

function sampledFidelity(carrier = false, extra = []) {
  return {
    payload: 'sampled',
    ...(carrier ? { carrier: 'sampled' } : {}),
    limitations: [
      'The retained Grok 1.0.0 runtime fixtures are legacy privacy projections; schemas describe retained native fields and observed types, not a complete legal payload contract.',
      ...extra,
    ],
  };
}

function structuralFidelity(carrier = false, extra = []) {
  return {
    payload: 'structural',
    ...(carrier ? { carrier: 'structural' } : {}),
    limitations: [
      'The base schema preserves the stable envelope and observed fields while leaving variant-specific values open. Exact or supplemental branch schemas are separately evidence-bound as payload refinements.',
      ...extra,
    ],
  };
}

rmSync(modelRoot, { recursive: true, force: true });
mkdirSync(eventsRoot, { recursive: true });

writeJson(join(modelRoot, 'manifest.json'), {
  asmVersion: 3,
  vendor: 'grok',
  vendorVersion: VERSION,
  generatedAt: '2026-08-28',
  source:
    'Controlled installed-artifact census plus a digest-pinned supplemental public-source inventory and its exact ACP schema dependency. Public source cannot promote binary claims because the binary-reported revision is absent from the mirror.',
  evidence: 'evidence.json',
});
writeJson(join(modelRoot, 'detection.json'), {
  executables: ['grok'],
  envVar: 'PUPPETEER_GROK_BIN',
  versionFlag: '--version',
  versionOutput: 'grok 1.0.0 (3cd0d0cbcebe) [stable]',
  versionPattern: '^grok (\\d+\\.\\d+\\.\\d+) \\(([0-9a-f]+)\\) \\[(stable|alpha)\\]$',
  helpFlag: '--help',
  launchFlags: {
    leader: 'leader',
    leaderSocket: '--leader-socket',
    sessionId: '--session-id',
    resume: '--resume',
    model: '--model',
    permissionMode: '--permission-mode',
    sandbox: '--sandbox',
  },
});
writeJson(join(modelRoot, 'channels.json'), {
  channels: {
    argv: {
      kind: 'argv-env',
      notes: 'The native composition is one long-lived leader plus a leader-attached ACP controller and TUI.',
    },
    acp: {
      kind: 'acp',
      notes:
        'Strict JSON-RPC 2.0 NDJSON over stdio. Standard session/update and xAI extension methods remain distinct.',
    },
    'session-log': {
      kind: 'native-log',
      notes: 'Append-only GROK_HOME session updates.jsonl records with timestamp, method, and params.',
    },
    'session-state': {
      kind: 'native-state',
      notes: 'Replace-in-place signals.json and summary.json beside updates.jsonl.',
    },
    leader: {
      kind: 'unix-socket',
      notes: 'Coordination socket owned by grok agent leader; topology, not a semantic event source.',
    },
    terminal: {
      kind: 'terminal',
      notes: 'Native leader-attached TUI. Semantics come from ACP and persisted state, never terminal text.',
    },
  },
});

const standardMethods = [
  {
    event: 'initialize',
    payload: 'InitializeRequest',
    result: 'InitializeResponse',
    direction: 'client-to-agent',
    captured: true,
    fixture: 'handshake.jsonl',
  },
  {
    event: 'session/new',
    payload: 'NewSessionRequest',
    result: 'NewSessionResponse',
    direction: 'client-to-agent',
    captured: true,
    fixture: 'handshake.jsonl',
  },
  {
    event: 'session/load',
    payload: 'LoadSessionRequest',
    result: 'LoadSessionResponse',
    direction: 'client-to-agent',
    captured: false,
  },
  {
    event: 'session/prompt',
    payload: 'PromptRequest',
    result: 'PromptResponse',
    direction: 'client-to-agent',
    captured: true,
    fixture: 'turn.jsonl',
  },
  {
    event: 'session/cancel',
    payload: 'CancelNotification',
    direction: 'client-to-agent',
    captured: false,
    notification: true,
  },
  {
    event: 'session/request_permission',
    payload: 'RequestPermissionRequest',
    result: 'RequestPermissionResponse',
    direction: 'agent-to-client',
    captured: false,
  },
];
for (const method of standardMethods) {
  const payloadSchema = acp.schemas[method.payload];
  const resultSchema = method.result ? acp.schemas[method.result] : undefined;
  const claim = acpClaim;
  writeEvent(method.event, {
    channel: 'acp',
    channels: ['acp'],
    transport: method.notification ? 'jsonrpc-notification' : 'jsonrpc-request',
    direction: method.direction,
    payloadSchema,
    ...(resultSchema ? { resultSchema } : {}),
    recordSchema: rpcCarrier(method.event, payloadSchema, !method.notification),
    recordChannel: 'acp',
    evidence: sourceEvidence(claim, true, Boolean(resultSchema), method.captured),
    confidence: 'unverified',
    schemaFidelity: sourceSchemaFidelity(Boolean(resultSchema)),
    ...(method.fixture ? { fixture: `captures/grok@${VERSION}/${method.fixture}` } : {}),
    notes: method.captured
      ? 'The installed artifact accepted/emitted this request payload, but matching result carriers were not retained. Exact optional fields and result shape remain supplemental ACP-source evidence.'
      : 'Supplemental ACP dependency surface; not exercised against the installed artifact.',
  });
}

const ambient = {
  '_x.ai/mcp/servers_updated': object({ servers: array() }, ['servers']),
  '_x.ai/models/update': object({ models: array(), currentModelId: string() }, ['models', 'currentModelId']),
  '_x.ai/settings/update': object({ settings: object() }, ['settings']),
  '_x.ai/announcements/update': object({ announcements: array() }, ['announcements']),
  '_x.ai/mcp/init_progress': object({ completed: integer({ minimum: 0 }), total: integer({ minimum: 0 }) }, [
    'completed',
    'total',
  ]),
};
for (const [name, payloadSchema] of Object.entries(ambient)) {
  writeEvent(name, {
    channel: 'acp',
    channels: ['acp'],
    transport: 'jsonrpc-notification',
    direction: 'agent-to-client',
    payloadSchema,
    recordSchema: rpcCarrier(name, payloadSchema),
    recordChannel: 'acp',
    evidence: runtimeEvidence(true),
    confidence: 'verified-headless',
    schemaFidelity: sampledFidelity(true),
    fixture: `captures/grok@${VERSION}/handshake.jsonl`,
  });
}

const textContent = object({ type: string(['text']), text: string() }, ['type', 'text']);
const standardUpdate = object(
  {
    sessionUpdate: string(),
    content: textContent,
    messageId: string(),
    availableCommands: array(),
  },
  ['sessionUpdate'],
);
const standardPayload = object({ sessionId: string(), update: standardUpdate, _meta: object() }, [
  'sessionId',
  'update',
]);
const observedStandard = new Set([
  'available_commands_update',
  'user_message_chunk',
  'agent_thought_chunk',
  'agent_message_chunk',
]);
function withDiscriminator(schema, wireName) {
  const projected = structuredClone(schema);
  projected.type = projected.type ?? 'object';
  projected.properties = {
    ...(projected.properties ?? {}),
    sessionUpdate: { const: wireName, type: 'string' },
  };
  projected.required = [...new Set([...(projected.required ?? []), 'sessionUpdate'])];
  return projected;
}
const toolRefinement = (wireName, schemaName) => ({
  match: { 'update.sessionUpdate': wireName },
  path: 'update',
  schema: withDiscriminator(acp.schemas[schemaName], wireName),
  evidence: sourceEvidence(acpClaim),
  confidence: 'unverified',
  fidelity: 'exact',
  limitations: [
    `Exact ACP ${acp.schemaVersion} ${schemaName} schema from the supplemental public mirror dependency; the installed binary did not emit this branch in the retained census.`,
  ],
});
writeEvent('session/update', {
  channel: 'acp',
  channels: ['acp', 'session-log'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: standardPayload,
  recordSchema: object(
    { timestamp: integer({ minimum: 1_000_000_000_000 }), method: string(['session/update']), params: standardPayload },
    ['timestamp', 'method', 'params'],
  ),
  recordChannel: 'session-log',
  evidence: runtimeEvidence(true),
  confidence: 'verified-headless',
  variants: acp.sessionUpdateValues.map((value) =>
    variant({ 'update.sessionUpdate': value }, observedStandard.has(value) ? runtimeClaim : acpClaim),
  ),
  payloadRefinements: [toolRefinement('tool_call', 'ToolCall'), toolRefinement('tool_call_update', 'ToolCallUpdate')],
  schemaFidelity: structuralFidelity(true, [
    'One carrier schema describes the durable session-log rail. The same native event is live over JSON-RPC on ACP; ASM currently permits only one recordSchema per event.',
  ]),
  fixture: `captures/grok@${VERSION}/turn.jsonl`,
  notes:
    'The complete 11-branch ACP dependency inventory is retained. Four branches are runtime-observed; the others, including exact tool/diff schemas, remain unverified public-source leads.',
});

const usageSchema = object({ inputTokens: integer({ minimum: 0 }), outputTokens: integer({ minimum: 0 }) }, [
  'inputTokens',
  'outputTokens',
]);
const extensionUpdate = object(
  {
    sessionUpdate: string(),
    event_name: string(),
    tool_name: string(),
    prompt_id: string(),
    runs: array(),
    signature: string(),
    usage: usageSchema,
    stop_reason: string(),
  },
  ['sessionUpdate'],
);
const extensionPayload = object({ sessionId: string(), update: extensionUpdate, _meta: object() }, [
  'sessionId',
  'update',
]);
const observedExtension = new Set(['hook_execution', 'response_completed', 'turn_completed']);
const observedExtensionSchemas = {
  hook_execution: object(
    {
      sessionUpdate: string(['hook_execution']),
      event_name: string(),
      tool_name: string(),
      prompt_id: string(),
      runs: array(),
    },
    ['sessionUpdate', 'event_name', 'runs'],
  ),
  response_completed: object(
    { sessionUpdate: string(['response_completed']), signature: string(), usage: usageSchema },
    ['sessionUpdate', 'signature', 'usage'],
  ),
  turn_completed: object(
    { sessionUpdate: string(['turn_completed']), prompt_id: string(), stop_reason: string(), usage: usageSchema },
    ['sessionUpdate', 'prompt_id', 'stop_reason', 'usage'],
  ),
};

function rustSchema(rawType) {
  const type = rawType.trim();
  const option = /^Option<(.+)>$/.exec(type);
  if (option) return rustSchema(option[1]);
  const vector = /^Vec<(.+)>$/.exec(type);
  if (vector) return array(rustSchema(vector[1]));
  const boxed = /^Box<(.+)>$/.exec(type);
  if (boxed) return rustSchema(boxed[1]);
  if (type === 'String' || type === '&str') return string();
  if (/^(?:u8|u16|u32|u64|usize)$/.test(type)) return integer({ minimum: 0 });
  if (/^(?:i8|i16|i32|i64|isize)$/.test(type)) return integer();
  if (type === 'f32' || type === 'f64') return number();
  if (type === 'bool') return boolean;
  return {};
}

const diffContentSchema = (() => {
  const schema = structuredClone(acp.schemas.Diff);
  schema.properties = { ...(schema.properties ?? {}), type: { const: 'diff', type: 'string' } };
  schema.required = [...new Set([...(schema.required ?? []), 'type'])];
  return schema;
})();
const sourceExtensionRefinements = reference.publicMirror.xaiSessionUpdate.variants
  .filter((entry) => !observedExtension.has(entry.wireName))
  .map((entry) => {
    const properties = Object.fromEntries(
      (entry.fields ?? []).map((field) => [field.name, rustSchema(field.rustType)]),
    );
    if (entry.wireName === 'diff_review') properties.content = array(diffContentSchema);
    return {
      match: { 'update.sessionUpdate': entry.wireName },
      path: 'update',
      schema: object({ sessionUpdate: string([entry.wireName]), ...properties }, ['sessionUpdate']),
      evidence: sourceEvidence(mirrorClaim),
      confidence: 'unverified',
      fidelity: 'structural',
      limitations: [
        'Field names and primitive/container types come from the digest-pinned supplemental Rust enum. Custom nested Rust types and serde default/optionality rules remain unconstrained unless separately projected.',
        'The public enum does not prove this branch exists in the installed binary or whether it is live, durable, or enabled.',
      ],
    };
  });
const runtimeExtensionRefinements = Object.entries(observedExtensionSchemas).map(([wireName, schema]) => ({
  match: { 'update.sessionUpdate': wireName },
  path: 'update',
  schema,
  evidence: runtimeEvidence(),
  confidence: 'verified-headless',
  fidelity: 'sampled',
  limitations: ['Requiredness and optional fields describe retained Grok 1.0.0 samples, not every legal instance.'],
}));
const extensionVariants = reference.publicMirror.xaiSessionUpdate.variants.map((entry) =>
  variant(
    { 'update.sessionUpdate': entry.wireName },
    observedExtension.has(entry.wireName) ? runtimeClaim : mirrorClaim,
  ),
);
writeEvent('_x.ai/session_notification', {
  channel: 'acp',
  channels: ['acp'],
  transport: 'jsonrpc-notification',
  direction: 'agent-to-client',
  payloadSchema: extensionPayload,
  recordSchema: rpcCarrier('_x.ai/session_notification', extensionPayload),
  recordChannel: 'acp',
  evidence: runtimeEvidence(true),
  confidence: 'verified-headless',
  variants: extensionVariants,
  payloadRefinements: [...runtimeExtensionRefinements, ...sourceExtensionRefinements],
  schemaFidelity: structuralFidelity(true, [
    'Three xAI branches are runtime-observed. The remaining 47 refinements inventory a supplemental public Rust enum and cannot be treated as installed-binary contracts.',
  ]),
  fixture: `captures/grok@${VERSION}/turn.jsonl`,
  notes: 'Installed-artifact spelling for live xAI extensions. It is distinct from persisted _x.ai/session/update.',
});

const persistedObserved = new Set(['hook_execution', 'turn_completed']);
const persistedVariants = ['hook_execution', 'turn_completed', 'compaction_checkpoint'];
writeEvent('_x.ai/session/update', {
  channel: 'session-log',
  channels: ['session-log'],
  transport: 'jsonl-record',
  direction: 'agent-local',
  payloadSchema: extensionPayload,
  recordSchema: object(
    {
      timestamp: integer({ minimum: 1_000_000_000_000 }),
      method: string(['_x.ai/session/update']),
      params: extensionPayload,
    },
    ['timestamp', 'method', 'params'],
  ),
  recordChannel: 'session-log',
  evidence: runtimeEvidence(true),
  confidence: 'verified-headless',
  variants: persistedVariants.map((value) =>
    variant({ 'update.sessionUpdate': value }, persistedObserved.has(value) ? runtimeClaim : mirrorClaim),
  ),
  payloadRefinements: [
    ...runtimeExtensionRefinements.filter((entry) => persistedObserved.has(entry.match['update.sessionUpdate'])),
    ...sourceExtensionRefinements.filter((entry) => entry.match['update.sessionUpdate'] === 'compaction_checkpoint'),
  ],
  schemaFidelity: structuralFidelity(true, [
    'Only hook_execution and turn_completed were captured on this durable spelling. compaction_checkpoint is a supplemental source-only persist lead.',
  ]),
  fixture: `captures/grok@${VERSION}/persisted.jsonl`,
});

writeEvent('signals.json', {
  channel: 'session-state',
  channels: ['session-state'],
  transport: 'json-file-replace',
  direction: 'agent-local',
  payloadSchema: object(
    {
      contextTokensUsed: integer({ minimum: 0 }),
      contextWindowTokens: integer({ minimum: 0 }),
      contextWindowUsage: number({ minimum: 0 }),
      primaryModelId: string(),
      compactionCount: integer({ minimum: 0 }),
      turnCount: integer({ minimum: 0 }),
      toolCallCount: integer({ minimum: 0 }),
    },
    [
      'contextTokensUsed',
      'contextWindowTokens',
      'contextWindowUsage',
      'primaryModelId',
      'compactionCount',
      'turnCount',
      'toolCallCount',
    ],
  ),
  evidence: runtimeEvidence(),
  confidence: 'verified-headless',
  schemaFidelity: sampledFidelity(),
  fixture: `captures/grok@${VERSION}/state.jsonl`,
});
writeEvent('summary.json', {
  channel: 'session-state',
  channels: ['session-state'],
  transport: 'json-file-replace',
  direction: 'agent-local',
  payloadSchema: object(
    {
      info: object({ id: string(), cwd: string() }, ['id', 'cwd']),
      current_model_id: string(),
      created_at: string(),
      updated_at: string(),
      num_messages: integer({ minimum: 0 }),
      num_chat_messages: integer({ minimum: 0 }),
      agent_name: string(),
    },
    ['info', 'current_model_id', 'created_at', 'updated_at', 'num_messages', 'num_chat_messages', 'agent_name'],
  ),
  evidence: runtimeEvidence(),
  confidence: 'verified-headless',
  schemaFidelity: sampledFidelity(),
  fixture: `captures/grok@${VERSION}/state.jsonl`,
});

const behaviorNode = (id, event, lane, order, claim = runtimeClaim, extra = {}) => ({
  id,
  event,
  lane,
  order,
  confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
  evidence: claim === runtimeClaim ? runtimeEvidence() : sourceEvidence(claim),
  ...extra,
});
const behaviorRelation = (from, to, kind = 'sequence', claim = runtimeClaim, label) => ({
  from,
  to,
  kind,
  ...(label ? { label } : {}),
  confidence: claim === runtimeClaim ? 'verified-headless' : 'unverified',
  evidence: {
    ...(claim === runtimeClaim ? runtimeEvidence() : sourceEvidence(claim)),
    ordering: [claim],
  },
});
writeJson(join(modelRoot, 'behavior.json'), {
  behaviorVersion: 1,
  title: 'Grok 1.0.0 native ACP and durable-session lifecycle',
  description:
    'Partial order over captured installed-artifact rails. Tool, compaction, team, workflow, and goal branches are supplemental source leads and remain unverified.',
  source:
    'Installed-artifact controlled census plus separately attributed public Grok and ACP sources whose relation to the binary is unverified.',
  lanes: [
    { id: 'session', label: 'ACP session' },
    { id: 'turn', label: 'Turn stream' },
    { id: 'tool', label: 'Tools / permission' },
    { id: 'team', label: 'Subagents / workflow' },
    { id: 'compact', label: 'Compaction' },
    { id: 'durable', label: 'Persisted truth' },
    { id: 'ambient', label: 'Ambient extensions' },
  ],
  nodes: [
    behaviorNode('initialize', 'initialize', 'session', 0),
    behaviorNode('session-new', 'session/new', 'session', 1),
    behaviorNode('session-load', 'session/load', 'session', 1, acpClaim),
    behaviorNode('available-commands', 'session/update', 'session', 2, runtimeClaim, {
      match: { 'update.sessionUpdate': 'available_commands_update' },
    }),
    behaviorNode('session-start-hook', '_x.ai/session_notification', 'session', 3, runtimeClaim, {
      match: { 'update.sessionUpdate': 'hook_execution', 'update.event_name': 'session_start' },
    }),
    behaviorNode('prompt', 'session/prompt', 'turn', 4),
    behaviorNode('user-message', 'session/update', 'turn', 5, runtimeClaim, {
      match: { 'update.sessionUpdate': 'user_message_chunk' },
    }),
    behaviorNode('prompt-hook', '_x.ai/session_notification', 'turn', 5, runtimeClaim, {
      match: { 'update.sessionUpdate': 'hook_execution', 'update.event_name': 'user_prompt_submit' },
    }),
    behaviorNode('thought', 'session/update', 'turn', 6, runtimeClaim, {
      match: { 'update.sessionUpdate': 'agent_thought_chunk' },
    }),
    behaviorNode('assistant', 'session/update', 'turn', 9, runtimeClaim, {
      match: { 'update.sessionUpdate': 'agent_message_chunk' },
    }),
    behaviorNode('response-complete', '_x.ai/session_notification', 'turn', 10, runtimeClaim, {
      match: { 'update.sessionUpdate': 'response_completed' },
    }),
    behaviorNode('stop-hook', '_x.ai/session_notification', 'turn', 11, runtimeClaim, {
      match: { 'update.sessionUpdate': 'hook_execution', 'update.event_name': 'stop' },
    }),
    behaviorNode('turn-complete', '_x.ai/session_notification', 'turn', 12, runtimeClaim, {
      match: { 'update.sessionUpdate': 'turn_completed' },
    }),
    behaviorNode('tool-start', 'session/update', 'tool', 7, acpClaim, {
      match: { 'update.sessionUpdate': 'tool_call' },
    }),
    behaviorNode('permission', 'session/request_permission', 'tool', 8, acpClaim),
    behaviorNode('tool-finish', 'session/update', 'tool', 9, acpClaim, {
      match: { 'update.sessionUpdate': 'tool_call_update' },
    }),
    behaviorNode('subagent-spawned', '_x.ai/session_notification', 'team', 7, mirrorClaim, {
      match: { 'update.sessionUpdate': 'subagent_spawned' },
    }),
    behaviorNode('subagent-progress', '_x.ai/session_notification', 'team', 8, mirrorClaim, {
      match: { 'update.sessionUpdate': 'subagent_progress' },
    }),
    behaviorNode('subagent-finished', '_x.ai/session_notification', 'team', 9, mirrorClaim, {
      match: { 'update.sessionUpdate': 'subagent_finished' },
    }),
    behaviorNode('workflow-updated', '_x.ai/session_notification', 'team', 8, mirrorClaim, {
      match: { 'update.sessionUpdate': 'workflow_updated' },
    }),
    behaviorNode('goal-updated', '_x.ai/session_notification', 'team', 8, mirrorClaim, {
      match: { 'update.sessionUpdate': 'goal_updated' },
    }),
    behaviorNode('compact-start', '_x.ai/session_notification', 'compact', 6, mirrorClaim, {
      match: { 'update.sessionUpdate': 'auto_compact_started' },
    }),
    behaviorNode('compact-checkpoint', '_x.ai/session/update', 'compact', 7, mirrorClaim, {
      match: { 'update.sessionUpdate': 'compaction_checkpoint' },
    }),
    behaviorNode('compact-complete', '_x.ai/session_notification', 'compact', 8, mirrorClaim, {
      match: { 'update.sessionUpdate': 'auto_compact_completed' },
    }),
    behaviorNode('persisted-update', '_x.ai/session/update', 'durable', 5),
    behaviorNode('signals', 'signals.json', 'durable', 11),
    behaviorNode('summary', 'summary.json', 'durable', 11),
    behaviorNode('models', '_x.ai/models/update', 'ambient', 1),
    behaviorNode('settings', '_x.ai/settings/update', 'ambient', 1),
    behaviorNode('announcements', '_x.ai/announcements/update', 'ambient', 1),
    behaviorNode('mcp-servers', '_x.ai/mcp/servers_updated', 'ambient', 1),
    behaviorNode('mcp-progress', '_x.ai/mcp/init_progress', 'ambient', 2),
  ],
  relations: [
    behaviorRelation('initialize', 'models', 'async'),
    behaviorRelation('initialize', 'settings', 'async'),
    behaviorRelation('initialize', 'announcements', 'async'),
    behaviorRelation('initialize', 'mcp-servers', 'async'),
    behaviorRelation('mcp-servers', 'mcp-progress', 'async'),
    behaviorRelation('initialize', 'session-new'),
    behaviorRelation('initialize', 'session-load', 'resume', acpClaim),
    behaviorRelation('session-new', 'available-commands'),
    behaviorRelation('available-commands', 'session-start-hook'),
    behaviorRelation('session-start-hook', 'persisted-update', 'concurrent'),
    behaviorRelation('session-start-hook', 'prompt'),
    behaviorRelation('prompt', 'user-message'),
    behaviorRelation('prompt', 'prompt-hook'),
    behaviorRelation('user-message', 'thought', 'conditional'),
    behaviorRelation('thought', 'thought', 'loop'),
    behaviorRelation('thought', 'assistant', 'conditional'),
    behaviorRelation('assistant', 'assistant', 'loop'),
    behaviorRelation('assistant', 'response-complete'),
    behaviorRelation('response-complete', 'stop-hook'),
    behaviorRelation('stop-hook', 'turn-complete'),
    behaviorRelation('turn-complete', 'signals', 'concurrent'),
    behaviorRelation('turn-complete', 'summary', 'concurrent'),
    behaviorRelation('turn-complete', 'prompt', 'loop', runtimeClaim, 'next turn'),
    behaviorRelation('thought', 'tool-start', 'conditional', acpClaim),
    behaviorRelation('tool-start', 'permission', 'conditional', acpClaim),
    behaviorRelation('permission', 'tool-finish', 'sequence', acpClaim),
    behaviorRelation('tool-start', 'tool-finish', 'conditional', acpClaim, 'no permission request'),
    behaviorRelation('tool-finish', 'assistant', 'sequence', acpClaim),
    behaviorRelation('thought', 'subagent-spawned', 'conditional', mirrorClaim),
    behaviorRelation('subagent-spawned', 'subagent-progress', 'sequence', mirrorClaim),
    behaviorRelation('subagent-progress', 'subagent-progress', 'loop', mirrorClaim),
    behaviorRelation('subagent-progress', 'subagent-finished', 'sequence', mirrorClaim),
    behaviorRelation('subagent-spawned', 'workflow-updated', 'async', mirrorClaim),
    behaviorRelation('workflow-updated', 'goal-updated', 'async', mirrorClaim),
    behaviorRelation('thought', 'compact-start', 'conditional', mirrorClaim),
    behaviorRelation('compact-start', 'compact-checkpoint', 'sequence', mirrorClaim),
    behaviorRelation('compact-checkpoint', 'compact-complete', 'conditional', mirrorClaim),
  ],
});

formatGenerated(modelRoot);

const captureRecord = relative(repoRoot, capturesRoot).split(sep).join('/');
const referenceRecord = relative(repoRoot, referencesRoot).split(sep).join('/');
const modelRecord = relative(repoRoot, modelRoot).split(sep).join('/');
writeJson(join(modelRoot, 'evidence.json'), {
  evidenceVersion: 2,
  vendor: 'grok',
  vendorVersion: VERSION,
  artifacts: [
    {
      id: 'installed-grok-1.0.0-darwin-arm64',
      platform: 'darwin-arm64',
      channel: 'stable',
      acquiredAt: '2026-08-08T00:00:00.000Z',
      versionOutput: 'grok 1.0.0 (3cd0d0cbcebe) [stable]',
      integrity: {
        status: 'verified',
        sha256: 'sha256:13c7f4f0b9abb00bf38216302ea4bab31f03e13555e3576620eca1de572a8d21',
      },
    },
  ],
  sourceReferences: [
    {
      repository: 'https://github.com/xai-org/grok-build',
      revision: '3cd0d0cbcebe',
      relation: 'binary-reported-revision-not-present-in-public-mirror',
    },
    {
      repository: reference.publicMirror.repository,
      revision: reference.publicMirror.revision,
      relation: 'public-mirror-commit',
      sourceRevision: reference.publicMirror.sourceRevision,
      contract: `${referenceRecord}/public-source-surface.json`,
    },
    {
      repository: acp.repository,
      revision: acp.revision,
      relation: 'exact-release',
      scope: 'dependency-of-supplemental-public-mirror-only',
      tag: acp.tag,
      schemaVersion: acp.schemaVersion,
      contract: `${referenceRecord}/public-source-surface.json`,
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
      id: 'supplemental-public-reference',
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
      artifact: 'installed-grok-1.0.0-darwin-arm64',
      platform: 'darwin-arm64',
      harness: 'controlled ACP, PTY, leader, and native-store census documented in findings.md',
      capturedAt: '2026-08-08T00:00:00.000Z',
      notes:
        'The retained fixtures are legacy privacy projections. This claim proves occurrence, ordering, joins, and explicitly retained fields, not complete native payload shape.',
    },
    {
      id: mirrorClaim,
      kind: 'exact-source',
      confidence: 'unverified',
      record: 'supplemental-public-reference',
      sourceReference: 1,
      notes:
        'Digest-pinned public Grok source inventory. Its revision is not the installed artifact binary-reported revision and cannot promote binary claims.',
    },
    {
      id: acpClaim,
      kind: 'generated-schema',
      confidence: 'unverified',
      record: 'supplemental-public-reference',
      sourceReference: 2,
      notes: `Exact generated ACP schema ${acp.schemaVersion}, dependency of the pinned supplemental public Grok commit only.`,
    },
  ],
  limitations: [
    'The exact binary-reported source revision is absent from the public source mirror, so source-to-artifact equivalence is unverified.',
    'The retained runtime capture is a schemaVersion 1 legacy projection. Future schemaVersion 2 sanitization preserves every native JSON key, container, and type.',
    `The supplemental public xAI enum has ${reference.publicMirror.xaiSessionUpdate.variants.length} branches and ACP has ${acp.sessionUpdateValues.length}; only captured branches are verified for the installed artifact.`,
    'No installed-artifact tool call was captured. ACP exposes path/oldText/newText diffs, but Grok file-edit observability remains an unverified source lead for this version.',
    'Compaction, subagent, workflow, and goal branches were not forced in the installed-artifact census.',
    'Only darwin-arm64 has artifact integrity and controlled-census evidence for this candidate.',
  ],
});
formatGenerated(join(modelRoot, 'evidence.json'));
writeGroundTruthArtifacts(modelRoot);

console.log(`generated Grok ASM: ${standardMethods.length + Object.keys(ambient).length + 5} events at ${modelRoot}`);
