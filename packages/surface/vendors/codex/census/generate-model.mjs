#!/usr/bin/env node
/**
 * Generate `packages/surface/vendors/codex/model/codex@<version>/` — the ASM.
 *
 * **Shape from the schema, confidence from the census** (docs/archive/IMPOSTER.md §9.2).
 * Codex emits its own protocol schema (`codex app-server generate-json-schema`),
 * so the payload shapes are the vendor's own statement about itself rather than
 * anything inferred from captures — which matters because the captures cover a
 * handful of the server-originated methods. ASM v3 also includes client
 * requests/notifications and the result schemas for every request the
 * Imposter serves; otherwise validating only server output leaves the adapter's
 * actual request contract invisible.
 * Confidence then comes from the
 * census: a method observed in a hermetic capture is `verified-headless`, and
 * everything else is `unverified` and says so.
 *
 * This is the rule docs/archive/EMULATOR.md §1 exists to protect. The model must never be
 * derived from `normalizer.ts` — the adapter and the model would then be wrong
 * together and no test could see it. That is not hypothetical: the audit found
 * four real adapter defects that a model built this way immediately exposes.
 *
 * Layer 0 retains the vendor schema recursively. Runtime fixture validation is
 * only one consumer of ground truth; collapsing nested unions, array items, or
 * constraints here would make every higher layer permanently less informed.
 *
 * The native behaviour graph is intentionally NOT inferred from the schema:
 * method existence cannot prove ordering. Generation preserves the graph
 * already present at --out, or takes an explicitly reviewed --behavior file.
 * A new baseline therefore cannot become valid until someone reviews native
 * behaviour for that version.
 *
 * usage: node generate-model.mjs [--version <semver>] [--schema <dir>] [--captures <dir>] [--out <dir>] [--behavior <file>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDocumentPath } from '@vibefield/puppeteer-surface';
import { projectJsonSchema } from '@vibefield/puppeteer-surface';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';
import { CODEX_VERSION, censusEnvironment } from './harness.mjs';

const vendorRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = dirname(dirname(vendorRoot));
const repositoryRoot = dirname(dirname(packageRoot));

/** Resolve a `#/definitions/Name` reference one level. */
function deref(schema, root) {
  let current = schema;
  const seen = new Set();
  while (current && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return {};
    seen.add(current.$ref);
    current = root.definitions?.[current.$ref.replace('#/definitions/', '')] ?? {};
  }
  return current ?? {};
}

function payloadSchema(paramsRef, root, includeEmpty = false) {
  const params = deref(paramsRef, root);
  const properties = params.properties ?? {};
  if (Object.keys(properties).length === 0 && !(includeEmpty && params.type === 'object')) return undefined;
  return projectJsonSchema(params, root);
}

/** Method name -> params schema, for one of the vendor's union documents. */
function methodsFrom(document) {
  const methods = new Map();
  for (const variant of document.oneOf ?? document.anyOf ?? []) {
    const method = variant.properties?.method?.enum?.[0];
    if (typeof method !== 'string') continue;
    methods.set(method, {
      params: variant.properties?.params,
      description: typeof variant.description === 'string' ? variant.description : undefined,
      record: variant,
    });
  }
  return methods;
}

/** Every method/result seen in a capture, and which file proves it. */
function census(capturesDir) {
  const observed = new Map();
  const results = new Map();
  const pending = new Map();
  let files = [];
  try {
    files = readdirSync(capturesDir).filter((file) => file.endsWith('.jsonl'));
  } catch {
    return { observed, results }; // no captures yet: everything lands as unverified
  }
  for (const file of files) {
    for (const line of readFileSync(join(capturesDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const direction = message?.direction;
      const wire = message?.message && typeof message.message === 'object' ? message.message : message;
      const fixture = `captures/codex@${CODEX_VERSION}/${file}`;
      if (typeof wire.method === 'string' && !observed.has(wire.method)) {
        observed.set(wire.method, fixture);
      }
      if (direction && wire.id !== undefined && typeof wire.method === 'string') {
        pending.set(`${direction}:${String(wire.id)}`, wire.method);
      } else if (direction && wire.id !== undefined && wire.result !== undefined) {
        const requestDirection = direction === 'agent-to-client' ? 'client-to-agent' : 'agent-to-client';
        const method = pending.get(`${requestDirection}:${String(wire.id)}`);
        if (method && !results.has(method)) results.set(method, fixture);
      }
    }
  }
  return { observed, results };
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

let schemaDir = flag('--schema');
let temporarySchema;
if (!schemaDir) {
  // Generation is a pure function of (version, --experimental), verified in
  // C1b — so regenerating here rather than committing the vendor's 285 files
  // costs nothing in reproducibility.
  temporarySchema = mkdtempSync(join(tmpdir(), 'codex-schema-'));
  // The binary runs with a throwaway HOME and CODEX_HOME (codex creates
  // $CODEX_HOME/tmp at every start) and an allowlisted environment, never the
  // caller's own: generation must not read or write anyone's real profile.
  const scratchHome = mkdtempSync(join(tmpdir(), 'codex-schema-home-'));
  const env = censusEnvironment(scratchHome);
  mkdirSync(env.CODEX_HOME, { recursive: true });
  // `--experimental` is NOT merely additive — it also widens 25 shared
  // definitions. It is the right source anyway, because the runtime sends
  // fields the stable schema does not declare: `availableDecisions` is on
  // every approval request the census captured, yet stable declares 13
  // properties and experimental 15. A model built from stable would omit a
  // field the adapter is expected to read. Never mix the two variants (C1b).
  try {
    execFileSync(
      process.env.PUPPETEER_CODEX_BIN ?? 'codex',
      ['app-server', 'generate-json-schema', '--experimental', '--out', temporarySchema],
      { stdio: 'ignore', cwd: scratchHome, env },
    );
  } finally {
    rmSync(scratchHome, { recursive: true, force: true });
  }
  schemaDir = temporarySchema;
}
const capturesDir = flag('--captures') ?? join(vendorRoot, 'captures', `codex@${CODEX_VERSION}`);
const out = flag('--out') ?? join(vendorRoot, 'model', `codex@${CODEX_VERSION}`);
const behaviorSource = flag('--behavior') ?? join(out, 'behavior.json');
const sourceContractPath =
  flag('--source-contract') ?? join(vendorRoot, 'references', `codex@${CODEX_VERSION}`, 'source', 'file-changes.json');
if (!existsSync(sourceContractPath)) {
  throw new Error(`Codex exact source contract not found: ${sourceContractPath}`);
}
const sourceContract = JSON.parse(readFileSync(sourceContractPath, 'utf8'));
if (sourceContract.vendorVersion !== CODEX_VERSION || sourceContract.sourceRevision !== `rust-v${CODEX_VERSION}`) {
  throw new Error('Codex exact source contract does not match the generator release pin');
}

const read = (file) => JSON.parse(readFileSync(join(schemaDir, file), 'utf8'));
const serverNotificationRoot = read('ServerNotification.json');
const serverRequestRoot = read('ServerRequest.json');
const clientNotificationRoot = read('ClientNotification.json');
const clientRequestRoot = read('ClientRequest.json');
const serverNotifications = methodsFrom(serverNotificationRoot);
const serverRequests = methodsFrom(serverRequestRoot);
const clientNotifications = methodsFrom(clientNotificationRoot);
const clientRequests = methodsFrom(clientRequestRoot);
const { observed, results: observedResults } = census(capturesDir);

// JSON-RPC itself does not encode request -> result types. Codex publishes
// separate response documents, so the methods the Imposter actually serves
// are bound explicitly and reviewed here. A new served method without an entry
// gets no resultSchema and its conformance test must fail before promotion.
const servedResponseFiles = new Map(
  Object.entries({
    initialize: 'v1/InitializeResponse.json',
    'model/list': 'v2/ModelListResponse.json',
    'account/rateLimits/read': 'v2/GetAccountRateLimitsResponse.json',
    'thread/start': 'v2/ThreadStartResponse.json',
    'thread/resume': 'v2/ThreadResumeResponse.json',
    'thread/read': 'v2/ThreadReadResponse.json',
    // The paginated history the history-hydration census reads (C8); the
    // replacement for full-history hydration on thread/resume and thread/read.
    'thread/turns/list': 'v2/ThreadTurnsListResponse.json',
    'thread/inject_items': 'v2/ThreadInjectItemsResponse.json',
    'turn/start': 'v2/TurnStartResponse.json',
  }),
);
const clientResultSchemaFor = (method) => {
  const file = servedResponseFiles.get(method);
  if (!file) return undefined;
  const root = read(file);
  return payloadSchema(root, root, true);
};

const serverResultSchemaFor = (meta) => {
  const reference = meta.params?.$ref;
  if (typeof reference !== 'string') return undefined;
  const definition = reference.replace('#/definitions/', '');
  if (!definition.endsWith('Params')) return undefined;
  const file = `${definition.slice(0, -'Params'.length)}Response.json`;
  if (!existsSync(join(schemaDir, file))) return undefined;
  const root = read(file);
  return payloadSchema(root, root, true);
};

const evidencePath = join(out, 'evidence.json');
const existingEvidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : undefined;
if (existingEvidence) {
  if (existingEvidence.sourceReferences?.[0]?.revision !== sourceContract.sourceRevision) {
    throw new Error('Codex evidence source reference does not match the exact source contract');
  }
  const sourceRecord = {
    id: 'source-file-changes',
    kind: 'source-contract',
    path: relative(repositoryRoot, dirname(sourceContractPath)).split(sep).join('/'),
    digestAlgorithm: 'sha256-path-content-v1',
    sha256: digestTree(dirname(sourceContractPath)),
  };
  existingEvidence.records = [
    ...(existingEvidence.records ?? []).filter((record) => record.id !== sourceRecord.id),
    sourceRecord,
  ];
  const sourceClaim = {
    id: 'codex-file-change-source',
    kind: 'exact-source',
    confidence: 'unverified',
    record: sourceRecord.id,
    sourceReference: 0,
    notes:
      'Digest-pinned exact-release source establishes the kind-dependent meaning of FileUpdateChange.diff, move suffix encoding, and deterministic path ordering; source alone does not prove runtime occurrence.',
  };
  existingEvidence.claims = [
    ...(existingEvidence.claims ?? []).filter((claim) => claim.id !== sourceClaim.id),
    sourceClaim,
  ];
}
if (!existsSync(behaviorSource)) {
  throw new Error(
    `native behavior graph not found at ${behaviorSource}; seed the new baseline with --behavior <reviewed behavior.json>`,
  );
}
const reviewedBehavior = readFileSync(behaviorSource, 'utf8');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'events'), { recursive: true });

const today = new Date().toISOString().slice(0, 10);

writeFileSync(
  join(out, 'manifest.json'),
  `${JSON.stringify(
    {
      asmVersion: 3,
      vendor: 'codex',
      vendorVersion: CODEX_VERSION,
      generatedAt: today,
      source:
        "GENERATED by packages/surface/vendors/codex/census/generate-model.mjs. Shapes are the vendor's own " +
        '`codex app-server generate-json-schema` output; confidence is from the hermetic ' +
        'census in packages/surface/vendors/codex/census/harness.mjs; kind-dependent file-change semantics ' +
        'come from the digest-pinned exact-release source contract ' +
        '(packages/surface/vendors/codex/findings.md C1d). ' +
        'Never hand-edit: regenerate.',
      ...(existingEvidence ? { evidence: 'evidence.json' } : {}),
    },
    null,
    2,
  )}\n`,
);
if (existingEvidence) writeFileSync(evidencePath, `${JSON.stringify(existingEvidence, null, 2)}\n`);
writeFileSync(join(out, 'behavior.json'), reviewedBehavior.endsWith('\n') ? reviewedBehavior : `${reviewedBehavior}\n`);

writeFileSync(
  join(out, 'detection.json'),
  `${JSON.stringify(
    {
      executables: ['codex'],
      envVar: 'PUPPETEER_CODEX_BIN',
      versionFlag: '--version',
      versionOutput: `codex-cli ${CODEX_VERSION}`,
      versionPattern: '^codex-cli (\\d+\\.\\d+\\.\\d+)$',
      helpFlag: '--help',
      launchFlags: { appServer: 'app-server', config: '-c', remote: '--remote' },
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(out, 'channels.json'),
  `${JSON.stringify(
    {
      channels: {
        argv: {
          kind: 'argv-env',
          notes:
            'The adapter launches `codex app-server` and configures it with repeated `-c key=value`. ' +
            'There is no session id at spawn: the thread id arrives on thread/started (C0 §3).',
        },
        appserver: {
          kind: 'app-server',
          notes:
            'NDJSON over stdio, JSON-RPC-2.0-SHAPED but not conformant: `jsonrpc` is omitted on ' +
            'server output and merely tolerated on input, and the generated JSONRPCRequest requires ' +
            'only id+method. A strict JSON-RPC library will not work unmodified (C1b finding 5).',
        },
        terminal: {
          kind: 'terminal',
          notes:
            'The native ratatui TUI, attached over `--remote` (C0 §8). Semantics are never derived ' +
            'from it (ADR-003); it exists so a human can watch.',
        },
      },
    },
    null,
    2,
  )}\n`,
);

let verified = 0;
const FILE_CHANGE_ITEM_METHODS = new Set(['item/started', 'item/completed']);
function fileChangePayloadRefinements(method) {
  if (method === 'item/fileChange/patchUpdated') {
    return [
      {
        path: 'changes',
        schema: structuredClone(sourceContract.schemas.fileUpdateChanges),
        evidence: {
          existence: ['codex-file-change-source'],
          shape: ['codex-file-change-source'],
        },
        confidence: 'unverified',
        fidelity: 'exact',
      },
    ];
  }
  if (!FILE_CHANGE_ITEM_METHODS.has(method)) return [];
  return [
    {
      match: { 'item.type': 'fileChange' },
      path: 'item',
      schema: structuredClone(sourceContract.schemas.fileChangeThreadItem),
      evidence: {
        existence: ['codex-file-change-source'],
        shape: ['codex-file-change-source'],
      },
      confidence: 'unverified',
      fidelity: 'exact',
    },
  ];
}

const write = (method, meta, transport, direction, root) => {
  const fixture = observed.get(method);
  const schema = payloadSchema(meta.params, root);
  const resultSchema =
    transport === 'jsonrpc-request'
      ? direction === 'client-to-agent'
        ? clientResultSchemaFor(method)
        : serverResultSchemaFor(meta)
      : undefined;
  const generatedRecordSchema = projectJsonSchema(meta.record, root);
  // emittedAtMs is a native app-server field present on every captured server
  // notification but absent from the generated union. Keep both statements:
  // the exact generated carrier and the captured runtime refinement. Do not
  // extrapolate the refinement to methods the census has never observed.
  const recordSchema = structuredClone(generatedRecordSchema);
  if (fixture && direction === 'agent-to-client' && transport === 'jsonrpc-notification') {
    recordSchema.properties = {
      ...(recordSchema.properties ?? {}),
      emittedAtMs: { type: 'number', minimum: 1_000_000_000_000 },
    };
    recordSchema.required = [...new Set([...(recordSchema.required ?? []), 'emittedAtMs'])];
  }
  const resultFixture = observedResults.get(method);
  const existenceEvidence = fixture ? ['codex-runtime-headless', 'codex-generated-schema'] : ['codex-generated-schema'];
  const shapeEvidence = fixture ? ['codex-generated-schema', 'codex-runtime-headless'] : ['codex-generated-schema'];
  const resultEvidence = resultFixture
    ? ['codex-generated-schema', 'codex-runtime-headless']
    : ['codex-generated-schema'];
  const confidence = fixture && (!resultSchema || resultFixture) ? 'verified-headless' : 'unverified';
  const payloadRefinements = fileChangePayloadRefinements(method);
  const document = {
    surface: 'codex',
    surfaceVersion: CODEX_VERSION,
    event: method,
    channel: 'appserver',
    transport,
    direction,
    ...(meta.description ? { trigger: meta.description } : {}),
    ...(schema ? { payloadSchema: schema } : {}),
    ...(resultSchema ? { resultSchema } : {}),
    recordSchema,
    schemaFidelity: {
      ...(schema ? { payload: 'exact' } : {}),
      ...(resultSchema ? { result: 'exact' } : {}),
      carrier:
        fixture && direction === 'agent-to-client' && transport === 'jsonrpc-notification' ? 'semantic' : 'exact',
    },
    evidence: {
      existence: existenceEvidence,
      shape: shapeEvidence,
      ...(resultSchema ? { result: resultEvidence } : {}),
      carrier: shapeEvidence,
    },
    ...(payloadRefinements.length > 0 ? { payloadRefinements } : {}),
    confidence,
    ...(fixture ? { firstSeen: CODEX_VERSION, lastVerified: CODEX_VERSION, fixture } : {}),
    ...(payloadRefinements.length > 0
      ? {
          notes:
            'Exact-release source: add/delete `diff` values are complete file content; update is a unified diff; a move appends `\\n\\nMoved to: <move_path>`.',
        }
      : {}),
  };
  if (confidence === 'verified-headless') verified += 1;
  const path = join(out, 'events', eventDocumentPath(method));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
};

for (const [method, meta] of serverNotifications)
  write(method, meta, 'jsonrpc-notification', 'agent-to-client', serverNotificationRoot);
for (const [method, meta] of serverRequests)
  write(method, meta, 'jsonrpc-request', 'agent-to-client', serverRequestRoot);
for (const [method, meta] of clientNotifications)
  write(method, meta, 'jsonrpc-notification', 'client-to-agent', clientNotificationRoot);
for (const [method, meta] of clientRequests)
  write(method, meta, 'jsonrpc-request', 'client-to-agent', clientRequestRoot);

if (temporarySchema) rmSync(temporarySchema, { recursive: true, force: true });

const total = serverNotifications.size + serverRequests.size + clientNotifications.size + clientRequests.size;
console.log(
  `codex@${CODEX_VERSION}: ${total} events ` +
    `(${serverNotifications.size + serverRequests.size} agent->client, ` +
    `${clientNotifications.size + clientRequests.size} client->agent)`,
);
console.log(`  verified-headless: ${verified}   unverified: ${total - verified}`);
console.log(`  -> ${out}`);
if (existingEvidence) {
  if (!existingEvidence.records?.some((record) => record.id === 'agent-surface-model')) {
    throw new Error('Codex evidence index is missing the agent-surface-model record');
  }
  for (const record of existingEvidence.records) {
    const path = resolve(repositoryRoot, record.path);
    if (!path.startsWith(`${repositoryRoot}${sep}`)) {
      throw new Error(`Codex evidence record escapes the repository: ${record.path}`);
    }
    record.sha256 = digestTree(path, record.exclude ?? []);
  }
  writeFileSync(evidencePath, `${JSON.stringify(existingEvidence, null, 2)}\n`);
}
writeGroundTruthArtifacts(out);
