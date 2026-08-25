#!/usr/bin/env node
/**
 * Generate `packages/surface/vendors/codex/model/codex@<version>/` — the ASM.
 *
 * **Shape from the schema, confidence from the census** (docs/archive/IMPOSTER.md §9.2).
 * Codex emits its own protocol schema (`codex app-server generate-json-schema`),
 * so the payload shapes are the vendor's own statement about itself rather than
 * anything inferred from captures — which matters because the captures cover a
 * handful of the server-originated methods. ASM v2 also includes client
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
 * FIDELITY LIMIT, deliberate: `PayloadSchema` records top-level property types
 * and required-ness only, because that is exactly what `validatePayload`
 * enforces. The vendor's full JSON Schema is richer; the ASM is a validator for
 * the imposter, not a reproduction of the protocol.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_VERSION } from './harness.mjs';

const surfaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const JSON_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);

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

/**
 * Collapse a vendor JSON Schema node to the one ASM property type.
 *
 * The ASM has no nullable and no union concept, so anything it cannot state
 * exactly is left UNCONSTRAINED rather than approximated. Both cases were found
 * by the audit rejecting real captures on the first run:
 *
 *  - `environmentId: ["string","null"]` arrives as `null` on the wire. Dropping
 *    the null branch and asserting `string` makes the model reject a legal
 *    payload, and optionality does not save it — the field is PRESENT and null.
 *  - `requestId` resolves to the JSON-RPC `RequestId`, a string|integer union.
 *    `integer` is not one of the ASM's types, so it must widen to `number`
 *    before the union is judged, or the model asserts `string` and rejects the
 *    integer ids codex actually sends.
 */
function propertyType(node, root) {
  const resolved = deref(node, root);
  const candidates = [];
  const collect = (value) => {
    if (!value) return;
    if (Array.isArray(value.type)) candidates.push(...value.type);
    else if (typeof value.type === 'string') candidates.push(value.type);
    for (const branch of value.anyOf ?? value.oneOf ?? []) collect(deref(branch, root));
  };
  collect(resolved);
  if (candidates.includes('null')) return undefined;
  const usable = new Set(
    candidates.map((type) => (type === 'integer' ? 'number' : type)).filter((type) => JSON_TYPES.has(type)),
  );
  return usable.size === 1 ? [...usable][0] : undefined;
}

function payloadSchema(paramsRef, root, includeEmpty = false) {
  const params = deref(paramsRef, root);
  const properties = params.properties ?? {};
  const names = Object.keys(properties).sort();
  if (names.length === 0) return includeEmpty && params.type === 'object' ? { type: 'object' } : undefined;
  const required = (params.required ?? []).filter((name) => names.includes(name)).sort();
  const schema = { type: 'object', properties: {} };
  if (required.length > 0) schema.required = required;
  for (const name of names) {
    const type = propertyType(properties[name], root);
    schema.properties[name] = type === undefined ? {} : { type };
  }
  return schema;
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
  // `--experimental` is NOT merely additive — it also widens 25 shared
  // definitions. It is the right source anyway, because the runtime sends
  // fields the stable schema does not declare: `availableDecisions` is on
  // every approval request the census captured, yet stable declares 13
  // properties and experimental 15. A model built from stable would omit a
  // field the adapter is expected to read. Never mix the two variants (C1b).
  execFileSync(
    process.env.CHOPSTICKS_CODEX_BIN ?? 'codex',
    ['app-server', 'generate-json-schema', '--experimental', '--out', temporarySchema],
    { stdio: 'ignore' },
  );
  schemaDir = temporarySchema;
}
const capturesDir = flag('--captures') ?? join(surfaceRoot, 'captures', `codex@${CODEX_VERSION}`);
const out = flag('--out') ?? join(surfaceRoot, 'model', `codex@${CODEX_VERSION}`);
const behaviorSource = flag('--behavior') ?? join(out, 'behavior.json');

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

function recordSchemaFor(method, transport, direction, hasParams) {
  const properties = {
    method: { type: 'string', enum: [method] },
    ...(hasParams ? { params: { type: 'object' } } : {}),
    ...(transport === 'jsonrpc-request' ? { id: {} } : {}),
    ...(direction === 'agent-to-client' && transport === 'jsonrpc-notification'
      ? { emittedAtMs: { type: 'number', minimum: 1_000_000_000_000 } }
      : {}),
  };
  return {
    type: 'object',
    properties,
    required: [
      'method',
      ...(hasParams ? ['params'] : []),
      ...(transport === 'jsonrpc-request' ? ['id'] : []),
      ...(direction === 'agent-to-client' && transport === 'jsonrpc-notification' ? ['emittedAtMs'] : []),
    ],
  };
}
const evidencePath = join(out, 'evidence.json');
const existingEvidence = existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8') : undefined;
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
      asmVersion: 2,
      vendor: 'codex',
      vendorVersion: CODEX_VERSION,
      generatedAt: today,
      source:
        'GENERATED by packages/surface/vendors/codex/census/generate-model.mjs. Shapes are the vendor\'s own ' +
        '`codex app-server generate-json-schema` output; confidence is from the hermetic ' +
        'census in packages/surface/vendors/codex/census/harness.mjs ' +
        '(packages/surface/vendors/codex/findings.md C1d). ' +
        'Never hand-edit: regenerate.',
      ...(existingEvidence ? { evidence: 'evidence.json' } : {}),
    },
    null,
    2,
  )}\n`,
);
if (existingEvidence) writeFileSync(evidencePath, existingEvidence);
writeFileSync(join(out, 'behavior.json'), reviewedBehavior.endsWith('\n') ? reviewedBehavior : `${reviewedBehavior}\n`);

writeFileSync(
  join(out, 'detection.json'),
  `${JSON.stringify(
    {
      executables: ['codex'],
      envVar: 'CHOPSTICKS_CODEX_BIN',
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
const write = (method, meta, transport, direction, root) => {
  const fixture = observed.get(method);
  const schema = payloadSchema(meta.params, root);
  const resultSchema =
    transport === 'jsonrpc-request'
      ? direction === 'client-to-agent'
        ? clientResultSchemaFor(method)
        : serverResultSchemaFor(meta)
      : undefined;
  const recordSchema = recordSchemaFor(method, transport, direction, meta.params !== undefined);
  const resultFixture = observedResults.get(method);
  const evidenceId = fixture ? 'codex-runtime-headless' : 'codex-generated-schema';
  const resultEvidenceId = resultFixture ? 'codex-runtime-headless' : 'codex-generated-schema';
  const confidence = fixture && (!resultSchema || resultFixture) ? 'verified-headless' : 'unverified';
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
    evidence: {
      existence: [evidenceId],
      shape: [evidenceId],
      ...(resultSchema ? { result: [resultEvidenceId] } : {}),
      carrier: [
        direction === 'agent-to-client' && transport === 'jsonrpc-notification'
          ? 'codex-runtime-headless'
          : evidenceId,
      ],
    },
    confidence,
    ...(fixture ? { firstSeen: CODEX_VERSION, lastVerified: CODEX_VERSION, fixture } : {}),
  };
  if (confidence === 'verified-headless') verified += 1;
  const path = join(out, 'events', `${method}.json`);
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
