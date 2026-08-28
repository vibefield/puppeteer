#!/usr/bin/env node
/** Generate the evidence-bound Antigravity CLI 1.1.12 Agent Surface Model. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { VERSION } from './harness.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(dirname(vendorRoot));
const repoRoot = dirname(dirname(packageRoot));
const capturesRoot = join(vendorRoot, 'captures', `antigravity@${VERSION}`);
const probesRoot = join(vendorRoot, 'probes', `antigravity@${VERSION}`);
const referencesRoot = join(vendorRoot, 'references', `antigravity@${VERSION}`);
const modelRoot = join(vendorRoot, 'model', `antigravity@${VERSION}`);
const eventsRoot = join(modelRoot, 'events');
const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs');

const release = JSON.parse(readFileSync(join(referencesRoot, 'release.json'), 'utf8'));
const docs = JSON.parse(readFileSync(join(referencesRoot, 'docs.json'), 'utf8'));
const artifact = JSON.parse(readFileSync(join(probesRoot, 'darwin-arm64', 'artifact.json'), 'utf8'));
if (release.vendorVersion !== VERSION || docs.vendorVersion !== VERSION || artifact.vendorVersion !== VERSION) {
  throw new Error(`Antigravity evidence does not describe ${VERSION}`);
}

const runtimeClaim = 'antigravity-runtime-headless';
const docsClaim = 'antigravity-official-docs';
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
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const runtimeEvidence = (carrier = false) => ({
  existence: [runtimeClaim],
  shape: [runtimeClaim],
  ...(carrier ? { carrier: [runtimeClaim] } : {}),
});
const documentedHookEvidence = (result = false) => ({
  existence: [runtimeClaim],
  shape: [docsClaim],
  ...(result ? { result: [docsClaim] } : {}),
  carrier: [docsClaim],
});
const runtimeVariant = (match) => ({
  match,
  evidence: runtimeEvidence(),
  confidence: 'verified-headless',
});

const usageSchema = object(
  {
    input_tokens: integer({ minimum: 0 }),
    output_tokens: integer({ minimum: 0 }),
    thinking_tokens: integer({ minimum: 0 }),
    cache_read_tokens: integer({ minimum: 0 }),
    total_tokens: integer({ minimum: 0 }),
  },
  ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'],
);
const commandSchema = object({ name: string(), data: object() }, ['name', 'data']);
const resultBodySchema = object(
  {
    conversation_id: string(),
    status: string(),
    num_turns: integer({ minimum: 0 }),
    duration_seconds: number({ minimum: 0 }),
    usage: usageSchema,
    response: string(),
    command: commandSchema,
  },
  ['conversation_id', 'status', 'num_turns', 'duration_seconds', 'usage'],
);

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeEvent(name, document) {
  const hasSchemas = document.payloadSchema || document.resultSchema || document.recordSchema;
  writeJson(join(eventsRoot, `${name}.json`), {
    surface: 'antigravity',
    surfaceVersion: VERSION,
    event: name,
    ...(hasSchemas
      ? {
          schemaFidelity: document.schemaFidelity ?? {
            ...(document.payloadSchema ? { payload: 'structural' } : {}),
            ...(document.resultSchema ? { result: 'structural' } : {}),
            ...(document.recordSchema ? { carrier: 'structural' } : {}),
            limitations: [
              'The retained 1.1.12 runtime records are legacy privacy projections. Schemas retain only fields whose native names and types survive that transform or are stated by official documentation; additional native fields may exist.',
            ],
          },
        }
      : {}),
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
  vendor: 'antigravity',
  vendorVersion: VERSION,
  generatedAt: '2026-08-28',
  source:
    'Exact Antigravity CLI 1.1.12 release and executable identities, authorized print-mode/hook captures, and official documentation. Existing captures are legacy projections; their shape limitations are explicit.',
  evidence: 'evidence.json',
});
writeJson(join(modelRoot, 'detection.json'), {
  executables: ['agy', 'antigravity'],
  envVar: 'PUPPETEER_ANTIGRAVITY_BIN',
  versionFlag: '--version',
  versionOutput: VERSION,
  versionPattern: '^(\\d+\\.\\d+\\.\\d+)$',
  helpFlag: '--help',
  launchFlags: {
    print: '--print, -p',
    outputFormat: '--output-format',
    session: '--conversation',
    resume: '--continue, -c',
    addDirectory: '--add-dir',
    model: '--model',
    mode: '--mode',
    agent: '--agent',
    sandbox: '--sandbox',
  },
});
writeJson(join(modelRoot, 'channels.json'), {
  channels: {
    argv: { kind: 'argv-env', notes: 'Native process launch and session/resume selection.' },
    'print-stream': {
      kind: 'stdout-jsonl',
      notes: 'Native --print --output-format stream-json records; a survey oracle, not the native TUI rail.',
    },
    'print-json': {
      kind: 'stdout-json',
      notes: 'Native --print --output-format json terminal result or local slash-command response.',
    },
    'hook-command': {
      kind: 'hook-command',
      notes: 'Configured command hook receives one JSON document on stdin and returns one JSON document on stdout.',
    },
    'transcript-jsonl': {
      kind: 'native-state',
      notes:
        'Observed transcript.jsonl durable record rail; SQLite and transcript_full remain distinct unmodelled candidates.',
    },
  },
});

const initPayload = object(
  {
    conversation_id: string(),
    init: object({ permission_mode: string(), tools: array(string()) }, ['permission_mode', 'tools']),
  },
  ['conversation_id', 'init'],
);
writeEvent('init', {
  channel: 'print-stream',
  channels: ['print-stream'],
  transport: 'jsonl-record',
  direction: 'agent-to-client',
  payloadSchema: initPayload,
  recordSchema: object({ event: string(['init']), ...initPayload.properties }, ['event', ...initPayload.required]),
  recordChannel: 'print-stream',
  evidence: runtimeEvidence(true),
  confidence: 'verified-headless',
  fixture: `captures/antigravity@${VERSION}/add-dir-turn/print.stream-json.json`,
  notes:
    'The runtime projection retained the exact 56-entry tool-name catalog but replaced cwd with a synthetic cwdRedacted flag; cwd is therefore not required by this schema.',
});

const stepPayload = object(
  {
    step_update: object(
      {
        conversation_id: string(),
        step_index: integer({ minimum: 0 }),
        state: string(),
        step_type: string(),
        duration_seconds: number({ minimum: 0 }),
        usage: usageSchema,
        tool_name: string(),
        text_delta: string(),
        tool_info: object({ name: string(), parameters: object(), output: string() }),
      },
      ['conversation_id', 'step_index', 'state', 'step_type'],
    ),
  },
  ['step_update'],
);
const stepTypes = ['agent_response', 'checkpoint', 'error_message', 'system_message', 'tool', 'unknown', 'user_input'];
writeEvent('step_update', {
  channel: 'print-stream',
  channels: ['print-stream'],
  transport: 'jsonl-record',
  direction: 'agent-to-client',
  payloadSchema: stepPayload,
  recordSchema: object({ event: string(['step_update']), ...stepPayload.properties }, [
    'event',
    ...stepPayload.required,
  ]),
  recordChannel: 'print-stream',
  evidence: runtimeEvidence(true),
  confidence: 'verified-headless',
  variants: [
    ...stepTypes.map((value) => runtimeVariant({ 'step_update.step_type': value })),
    ...['ACTIVE', 'DONE'].map((value) => runtimeVariant({ 'step_update.state': value })),
  ],
  fixture: `captures/antigravity@${VERSION}/tool-success/print.stream-json.json`,
  notes:
    'The legacy projection synthesized hasTextDelta, parameterKeys, and hasOutput. The model restores only the corresponding native field names/types proven by that transform; it does not treat the synthetic fields as vendor payload.',
});

const commandResultPayload = object({ command: commandSchema }, ['command']);
writeEvent('command_result', {
  channel: 'print-stream',
  channels: ['print-stream'],
  transport: 'jsonl-record',
  direction: 'agent-to-client',
  payloadSchema: commandResultPayload,
  recordSchema: object({ event: string(['command_result']), ...commandResultPayload.properties }, [
    'event',
    ...commandResultPayload.required,
  ]),
  recordChannel: 'print-stream',
  evidence: runtimeEvidence(true),
  confidence: 'verified-headless',
  fixture: `captures/antigravity@${VERSION}/readonly-print/hooks.stream-json.json`,
});

const resultPayload = object({ result: resultBodySchema }, ['result']);
writeEvent('result', {
  channel: 'print-stream',
  channels: ['print-stream', 'print-json'],
  transport: 'jsonl-record',
  direction: 'agent-to-client',
  payloadSchema: resultPayload,
  recordSchema: object({ event: string(['result']), ...resultPayload.properties }, [
    'event',
    ...resultPayload.required,
  ]),
  recordChannel: 'print-stream',
  evidence: runtimeEvidence(true),
  confidence: 'verified-headless',
  variants: [runtimeVariant({ 'result.status': 'SUCCESS' })],
  fixture: `captures/antigravity@${VERSION}/add-dir-turn/print.stream-json.json`,
  notes:
    'Plain JSON mode emits the result body without the stream wrapper. The legacy sanitizer replaced response with hasResponse; hasResponse is intentionally absent from the native schema.',
});

const commonHookProperties = {
  conversationId: string(),
  workspacePaths: array(string()),
  transcriptPath: string(),
  artifactDirectoryPath: string(),
  modelName: string(),
};
const toolCallSchema = object({ name: string(), args: object() }, ['name', 'args']);
const hookDefinitions = {
  PreToolUse: {
    payload: object({ ...commonHookProperties, toolCall: toolCallSchema, stepIdx: integer({ minimum: 0 }) }, [
      'conversationId',
      'workspacePaths',
      'modelName',
      'toolCall',
      'stepIdx',
    ]),
    result: object({
      decision: string(['allow', 'deny', 'ask', 'force_ask', 'deny_unless_prior_grant']),
      reason: string(),
    }),
    fixture: 'tool-success',
  },
  PostToolUse: {
    payload: object(
      { ...commonHookProperties, toolCall: toolCallSchema, stepIdx: integer({ minimum: 0 }), error: string() },
      ['conversationId', 'workspacePaths', 'modelName', 'toolCall', 'stepIdx'],
    ),
    result: object(),
    fixture: 'tool-success',
  },
  PreInvocation: {
    payload: object(
      { ...commonHookProperties, invocationNum: integer({ minimum: 0 }), initialNumSteps: integer({ minimum: 0 }) },
      ['conversationId', 'workspacePaths', 'modelName', 'invocationNum', 'initialNumSteps'],
    ),
    result: object({
      injectSteps: array(object()),
      terminationBehavior: string(['force_continue', 'terminate', '']),
    }),
    fixture: 'add-dir-turn',
  },
  PostInvocation: {
    payload: object(
      { ...commonHookProperties, invocationNum: integer({ minimum: 0 }), initialNumSteps: integer({ minimum: 0 }) },
      ['conversationId', 'workspacePaths', 'modelName', 'invocationNum', 'initialNumSteps'],
    ),
    result: object({
      injectSteps: array(object()),
      terminationBehavior: string(['force_continue', 'terminate', '']),
    }),
    fixture: 'add-dir-turn',
  },
  Stop: {
    payload: object(
      {
        ...commonHookProperties,
        executionNum: integer({ minimum: 0 }),
        terminationReason: string(),
        error: string(),
        fullyIdle: boolean,
      },
      ['conversationId', 'workspacePaths', 'modelName', 'terminationReason', 'fullyIdle'],
    ),
    result: object({ decision: string(['continue']) }),
    fixture: 'add-dir-turn',
  },
};
for (const [name, definition] of Object.entries(hookDefinitions)) {
  writeEvent(name, {
    channel: 'hook-command',
    channels: ['hook-command'],
    transport: 'hook-callback',
    direction: 'agent-local',
    payloadSchema: definition.payload,
    resultSchema: definition.result,
    evidence: documentedHookEvidence(true),
    confidence: 'unverified',
    fixture: `captures/antigravity@${VERSION}/${definition.fixture}/hooks.jsonl`,
    observationMode: name === 'PreToolUse' || name === 'PostToolUse' ? 'matcher-required' : 'passive',
    notes:
      'Runtime evidence verifies this hook family and its ordering. Complete stdin/stdout shape is documentation-backed because the retained runtime fixture is a legacy projection.',
  });
}

const transcriptTypes = [
  'CHECKPOINT',
  'CONVERSATION_HISTORY',
  'ERROR_MESSAGE',
  'LIST_DIRECTORY',
  'PLANNER_RESPONSE',
  'SYSTEM_MESSAGE',
  'USER_INPUT',
  'VIEW_FILE',
];
writeEvent('transcript.jsonl', {
  channel: 'transcript-jsonl',
  channels: ['transcript-jsonl'],
  transport: 'jsonl-record',
  direction: 'agent-local',
  payloadSchema: object(
    {
      type: string(),
      source: string(),
      status: string(),
      step_index: integer({ minimum: 0 }),
      created_at: string(),
      content: {},
    },
    ['type', 'source', 'status', 'step_index', 'created_at'],
  ),
  evidence: runtimeEvidence(),
  confidence: 'verified-headless',
  variants: transcriptTypes.map((value) => runtimeVariant({ type: value })),
  schemaFidelity: {
    payload: 'sampled',
    limitations: [
      'The legacy projection copied type/source/status/step_index/created_at but replaced content with hasContent/contentChars. Content is retained only as an unconstrained optional native field.',
      'Only transcript.jsonl was sampled; transcript_full.jsonl and the SQLite store are separate unresolved durable rails.',
    ],
  },
  fixture: `captures/antigravity@${VERSION}/tool-success/transcript.jsonl`,
});

const node = (id, event, lane, order, extra = {}) => ({
  id,
  event,
  lane,
  order,
  confidence: 'verified-headless',
  evidence: runtimeEvidence(),
  ...extra,
});
const relation = (from, to, kind = 'sequence', label) => ({
  from,
  to,
  kind,
  ...(label ? { label } : {}),
  confidence: 'verified-headless',
  evidence: { ...runtimeEvidence(), ordering: [runtimeClaim] },
});
writeJson(join(modelRoot, 'behavior.json'), {
  behaviorVersion: 1,
  title: `Antigravity CLI ${VERSION} print, hook, and durable lifecycle`,
  description:
    'Partial order observed in authorized print-mode turns. Hook invocations and transcript records are concurrent observation rails; this is not a claim about native TUI rendering.',
  source: 'Exact 1.1.12 artifact captures; legacy projection limits shape, not observed order or joins.',
  lanes: [
    { id: 'print', label: 'Print stream' },
    { id: 'hook', label: 'Command hooks' },
    { id: 'durable', label: 'Durable transcript' },
  ],
  nodes: [
    node('init', 'init', 'print', 0),
    node('step-user', 'step_update', 'print', 1, { match: { 'step_update.step_type': 'user_input' } }),
    node('step-agent', 'step_update', 'print', 2, { match: { 'step_update.step_type': 'agent_response' } }),
    node('step-tool', 'step_update', 'print', 3, { match: { 'step_update.step_type': 'tool' } }),
    node('result', 'result', 'print', 4),
    node('pre-invocation', 'PreInvocation', 'hook', 1),
    node('pre-tool', 'PreToolUse', 'hook', 2),
    node('post-tool', 'PostToolUse', 'hook', 3),
    node('post-invocation', 'PostInvocation', 'hook', 4),
    node('stop', 'Stop', 'hook', 5),
    node('transcript', 'transcript.jsonl', 'durable', 2),
  ],
  relations: [
    relation('init', 'step-user'),
    relation('step-user', 'step-agent'),
    relation('step-agent', 'step-tool', 'conditional', 'model requests a tool'),
    relation('step-tool', 'step-agent', 'loop', 'tool result returns to model'),
    relation('step-agent', 'result', 'conditional', 'turn completes without another tool'),
    relation('pre-invocation', 'pre-tool', 'conditional', 'invocation requests a tool'),
    relation('pre-tool', 'post-tool'),
    relation('post-tool', 'post-invocation'),
    relation('pre-invocation', 'post-invocation', 'conditional', 'invocation has no tool'),
    relation('post-invocation', 'stop', 'conditional', 'agent becomes fully idle'),
    relation('step-user', 'transcript', 'async', 'durable records share conversation and step identities'),
  ],
});

formatGenerated(modelRoot);

const captureRecord = relative(repoRoot, capturesRoot).split(sep).join('/');
const probeRecord = relative(repoRoot, probesRoot).split(sep).join('/');
const referenceRecord = relative(repoRoot, referencesRoot).split(sep).join('/');
const modelRecord = relative(repoRoot, modelRoot).split(sep).join('/');
const archiveArtifacts = release.assets.map((asset) => ({
  id: `release-archive-${VERSION}-${asset.platform}`,
  platform: asset.platform,
  channel: 'stable',
  acquiredAt: release.retrievedAt,
  versionOutput: VERSION,
  bytes: asset.size,
  integrity: { status: 'verified', sha256: `sha256:${asset.sha256}` },
  sourceUrl: asset.url,
}));
writeJson(join(modelRoot, 'evidence.json'), {
  evidenceVersion: 2,
  vendor: 'antigravity',
  vendorVersion: VERSION,
  artifacts: [
    ...archiveArtifacts,
    {
      id: `installed-antigravity-${VERSION}-${artifact.platform}`,
      platform: artifact.platform,
      channel: 'stable',
      acquiredAt: artifact.probedAt,
      versionOutput: artifact.versionOutput,
      fileDescription: artifact.fileDescription,
      bytes: artifact.bytes,
      integrity: { status: 'verified', sha256: `sha256:${artifact.sha256}` },
      signature: artifact.signature,
    },
  ],
  sourceReferences: [
    {
      repository: release.repository,
      revision: release.release.revision,
      relation: 'release-tag',
      sourceEquivalence: 'unverified',
      tag: release.release.tag,
      contract: `${referenceRecord}/release.json`,
    },
    {
      repository: release.repository,
      revision: release.release.revision,
      relation: 'release-tag',
      referenceKind: 'official-documentation-bundle',
      contract: `${referenceRecord}/docs.json`,
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
      id: 'official-references',
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
      artifact: `installed-antigravity-${VERSION}-${artifact.platform}`,
      platform: artifact.platform,
      harness:
        'authorized --print json/stream-json survey with launch-scoped workspace command hooks, add-dir discovery, same-conversation resume, read-only slash commands, and successful read tools',
      capturedAt: '2026-08-12T21:44:01.000Z',
      notes:
        'The retained fixtures are legacy privacy projections. This claim proves occurrence, ordering, joins, and explicitly retained scalar/type observations, not complete native payload shape.',
    },
    {
      id: 'antigravity-binary-probe',
      kind: 'binary-probe',
      confidence: 'verified-headless',
      record: 'binary-probes',
      artifact: `installed-antigravity-${VERSION}-${artifact.platform}`,
      platform: artifact.platform,
      harness:
        'release archive identity, executable SHA-256, --version, --help, rejected-option, and static-string probes',
      capturedAt: artifact.probedAt,
    },
    {
      id: docsClaim,
      kind: 'official-doc',
      confidence: 'unverified',
      record: 'official-references',
      sourceReference: 1,
      notes:
        'Official documentation and changelog projection establish declared hook fields, callbacks, flags, and durable-path leads but are not exact source or runtime evidence.',
    },
  ],
  limitations: [
    'All retained runtime fixtures are schemaVersion 1 legacy privacy projections. Their raw inputs are unavailable; future schemaVersion 2 captures preserve native JSON keys, containers, and types.',
    'The census covers print mode and command hooks, not the native interactive TUI transport.',
    'No file-mutating tool was forced. The tool catalog proves edit-capable tool names exist, but file paths, before/after content, and diffs are not currently observable with verified Antigravity evidence.',
    'Transcript JSONL, transcript_full JSONL, and SQLite were observed as distinct durable candidates; only selected transcript.jsonl fields are modelled.',
    'The public release repository does not expose binary-equivalent implementation source. The release tag is provenance only.',
    'Only the darwin-arm64 executable has runtime evidence. Other platform records identify official archives, not executed behavior.',
  ],
});
formatGenerated(join(modelRoot, 'evidence.json'));
writeGroundTruthArtifacts(modelRoot);

console.log(`generated Antigravity ASM: ${Object.keys(hookDefinitions).length + 5} events at ${modelRoot}`);
