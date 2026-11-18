#!/usr/bin/env node
/**
 * Generate the OpenCode 2.x authoring model `model/opencode@<2.x.y>` from one
 * sanitized census run (plan §4 B11; option (a), as ruled in its §3, so the 2.x model
 * sits beside `opencode@1.19.5` in the same vendor):
 *
 * - HTTP operations from the runtime OpenAPI 3.1 document the census kept
 *   (`references/opencode@V/openapi.json`, all `/api/*`), named
 *   `http/<operationId>` as on the 1.x line;
 * - SSE events from the exact-source event contract
 *   (`references/opencode@V/source/event-contract.json`, built by
 *   event-contract-v2.mjs), because the 2.x OpenAPI declares the stream's
 *   payload only as an encoded `V2EventEncoded` string; an event the census saw
 *   that the contract lacks gets a sampled schema, and without a contract every
 *   event is sampled (and the evidence says so);
 * - runtime confidence only from the sanitized captures
 *   (`captures/opencode@V`, with census-run.json), never from schema or source.
 *
 * It writes the model tree only. It never touches groundtruth.json: the
 * canonical file stays on 1.19.5 until the switch PR runs
 * `surface:groundtruth:write -- packages/surface/vendors/opencode/model/opencode@V`.
 *
 * usage:
 *   node generate-model-v2.mjs --version 2.2.5 [--behavior census/behavior-v2.seed.json] [--out dir]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  eventDocumentPath,
  exactSourceEventContractProblems,
  exactSourceEventSchemas,
  openApiHttpOperations,
} from '@vibefield/puppeteer-surface';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { displayPath, replaceableDestination } from './harness-common.mjs';

export const VERSION_2 = /^2\.\d+\.\d+$/;
export const HARNESS = 'packages/surface/vendors/opencode/census/harness-v2.mjs';
const OPENAPI_CLAIM = 'opencode-generated-openapi';
const SOURCE_CLAIM = 'opencode-exact-release-source';

/** A route with every parameter segment reduced to `:*`, so trace and OpenAPI names need not agree. */
export function routeShape(route) {
  return route.replaceAll(/\{[^}]+\}/g, ':*').replaceAll(/:[A-Za-z_][\w]*/g, ':*');
}

/** A 2.x record's payload, whichever form the wire used. */
export function recordPayload(record) {
  if (typeof record?.data !== 'string') return record?.data;
  try {
    return JSON.parse(record.data);
  } catch {
    return undefined;
  }
}

export function claimID(scenario) {
  return `opencode-runtime-${scenario}`;
}

const observe = (map, key, scenario, sample) => {
  const entry = map.get(key) ?? { scenarios: new Set(), samples: [] };
  entry.scenarios.add(scenario);
  entry.samples.push(sample);
  map.set(key, entry);
};

const successful = (status) => Number.isInteger(status) && status >= 200 && status < 300;

/**
 * Fold one scenario's records into the observation maps. 1.x seed traffic
 * (`line: "1.x"`) is not 2.x evidence. Only a 2xx answer verifies an
 * operation: the response itself, and the request it answers (the trace
 * writes each request just before its response). A non-2xx answer (the
 * census's deliberate 401, 400 and 404 probes) is kept apart in `refusals`,
 * with its status, so it can be cited as what it is and never upgrades an
 * operation or its result schema.
 */
export function observeScenario(observed, scenario, { events = [], http = [] }) {
  for (const record of events) {
    if (typeof record?.type !== 'string') continue;
    observe(observed.events, record.type, scenario, { scenario, payload: recordPayload(record), record });
  }
  let pending;
  for (const record of http) {
    if (record?.line === '1.x') continue;
    const request = record?.request;
    if (request && typeof request.route === 'string') {
      pending = { key: `${request.method} ${routeShape(request.route)}`, carrier: request, record };
      continue;
    }
    const response = record?.response;
    if (!response || typeof response.route !== 'string') continue;
    const key = `${response.method} ${routeShape(response.route)}`;
    if (successful(response.status)) {
      observe(observed.responses, key, scenario, { scenario, payload: response, record });
      if (pending?.key === key) {
        observe(observed.requests, key, scenario, { scenario, payload: pending.carrier, record: pending.record });
      }
    } else {
      observe(observed.refusals, key, scenario, { scenario, status: response.status, record });
    }
    pending = undefined;
  }
  if (!observed.scenarios.includes(scenario)) observed.scenarios.push(scenario);
  return observed;
}

export function emptyObservations() {
  return { events: new Map(), requests: new Map(), responses: new Map(), refusals: new Map(), scenarios: [] };
}

/** The non-2xx answers the census saw for an operation, as `401 (turn), 404 (resume)`; empty when none. */
export function refusalSummary(observation) {
  if (!observation) return '';
  const seen = new Map();
  for (const sample of observation.samples) {
    const scenarios = seen.get(sample.status) ?? new Set();
    scenarios.add(sample.scenario);
    seen.set(sample.status, scenarios);
  }
  return [...seen]
    .sort(([left], [right]) => left - right)
    .map(([status, scenarios]) => `${status} (${[...scenarios].sort().join(', ')})`)
    .join(', ');
}

function jsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function census(capturesDir) {
  const observed = emptyObservations();
  const scenarios = readdirSync(capturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const scenario of scenarios) {
    observeScenario(observed, scenario, {
      events: jsonLines(join(capturesDir, scenario, 'events.jsonl')),
      http: jsonLines(join(capturesDir, scenario, 'http-roundtrip.jsonl')),
    });
  }
  return observed;
}

/** Runtime evidence for one observation: the first scenario by name, else none. */
export function runtimeEvidence(observation) {
  const scenario = observation ? [...observation.scenarios].sort()[0] : undefined;
  return scenario
    ? { id: claimID(scenario), scenario, confidence: 'verified-headless' }
    : { id: undefined, scenario: undefined, confidence: 'unverified' };
}

const withRuntime = (base, runtime) => [...new Set([base, ...(runtime.id ? [runtime.id] : [])])];

/** The ASM document for one OpenAPI operation. */
export function httpEventDocument(operation, observed, version) {
  const key = `${operation.method} ${routeShape(operation.route)}`;
  const request = runtimeEvidence(observed.requests.get(key));
  const result = runtimeEvidence(observed.responses.get(key));
  const refusals = refusalSummary(observed.refusals?.get(key));
  const event = `http/${operation.operationId}`;
  return {
    surface: 'opencode',
    surfaceVersion: version,
    event,
    channel: 'http',
    channels: ['http'],
    transport: 'http',
    direction: 'client-to-agent',
    ...(operation.trigger ? { trigger: operation.trigger } : {}),
    payloadSchema: operation.payloadSchema,
    resultSchema: operation.resultSchema,
    recordSchema: operation.recordSchema,
    schemaFidelity: { payload: 'semantic', result: 'semantic', carrier: 'semantic' },
    evidence: {
      existence: withRuntime(OPENAPI_CLAIM, request),
      shape: withRuntime(OPENAPI_CLAIM, request),
      result: withRuntime(OPENAPI_CLAIM, result),
      carrier: withRuntime(OPENAPI_CLAIM, request),
    },
    confidence:
      request.confidence === 'verified-headless' && result.confidence === 'verified-headless'
        ? 'verified-headless'
        : 'unverified',
    ...(request.scenario
      ? {
          firstSeen: version,
          lastVerified: version,
          fixture: `captures/opencode@${version}/${request.scenario}/http-roundtrip.jsonl`,
        }
      : {}),
    notes:
      `OpenAPI operationId ${operation.operationId}; ${operation.method} ${operation.path}.` +
      (refusals ? ` Runtime non-2xx answers (not verification): ${refusals}.` : ''),
  };
}

/** The ASM document for one event of the exact-source contract. */
export function contractEventDocument(schemas, observation, version) {
  const runtime = runtimeEvidence(observation);
  return {
    surface: 'opencode',
    surfaceVersion: version,
    event: schemas.event,
    channel: 'sse',
    channels: ['sse'],
    transport: 'sse-event',
    direction: 'agent-to-client',
    trigger: 'Published on the native GET /api/event stream.',
    payloadSchema: schemas.payloadSchema,
    recordSchema: schemas.recordSchema,
    schemaFidelity: {
      payload: 'semantic',
      carrier: 'semantic',
      limitations: [
        'Projected from Effect Schema source expressions read as text at the exact tag; unresolved expressions are open schemas.',
      ],
    },
    evidence: {
      existence: withRuntime(SOURCE_CLAIM, runtime),
      shape: withRuntime(SOURCE_CLAIM, runtime),
      carrier: withRuntime(SOURCE_CLAIM, runtime),
    },
    confidence: runtime.confidence,
    ...(runtime.scenario
      ? {
          firstSeen: version,
          lastVerified: version,
          fixture: `captures/opencode@${version}/${runtime.scenario}/events.jsonl`,
        }
      : {}),
    ...(schemas.notes ? { notes: schemas.notes } : {}),
  };
}

/** A JSON schema covering exactly the shapes present in `values` (the 1.x generator's sampler). */
export function inferredSchema(values) {
  const present = values.filter((value) => value !== undefined);
  if (present.length === 0) return {};
  const typeOf = (value) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value;
  };
  const types = [...new Set(present.map(typeOf))];
  if (types.length > 1) {
    const branches = types.map((type) => inferredSchema(present.filter((value) => typeOf(value) === type)));
    return branches.length <= 16 ? { anyOf: branches } : {};
  }
  const [type] = types;
  if (type === 'object') {
    const names = [...new Set(present.flatMap((value) => Object.keys(value)))].sort();
    const valuesOf = (name) => present.map((value) => value[name]).filter((value) => value !== undefined);
    const properties = Object.fromEntries(names.map((name) => [name, inferredSchema(valuesOf(name))]));
    const required = names.filter((name) => present.every((value) => Object.hasOwn(value, name)));
    return {
      type: 'object',
      ...(names.length > 0 ? { properties } : {}),
      ...(required.length > 0 ? { required } : {}),
    };
  }
  if (type === 'array') return { type: 'array', items: inferredSchema(present.flat()) };
  return ['string', 'integer', 'number', 'boolean', 'null'].includes(type) ? { type } : {};
}

/** The ASM document for an observed event the contract does not define (or every event, without a contract). */
export function sampledEventDocument(event, observation, version) {
  const runtime = runtimeEvidence(observation);
  const recordSchema = inferredSchema(observation.samples.map((sample) => sample.record));
  if (recordSchema.properties?.type) recordSchema.properties.type = { type: 'string', enum: [event] };
  return {
    surface: 'opencode',
    surfaceVersion: version,
    event,
    channel: 'sse',
    channels: ['sse'],
    transport: 'sse-event',
    direction: 'agent-to-client',
    trigger: 'Observed on the native GET /api/event stream.',
    payloadSchema: inferredSchema(observation.samples.map((sample) => sample.payload)),
    recordSchema,
    schemaFidelity: {
      payload: 'sampled',
      carrier: 'sampled',
      limitations: ['Schema includes only shapes present in the sanitized runtime samples.'],
    },
    evidence: { existence: [runtime.id], shape: [runtime.id], carrier: [runtime.id] },
    confidence: runtime.confidence,
    firstSeen: version,
    lastVerified: version,
    fixture: `captures/opencode@${version}/${runtime.scenario}/events.jsonl`,
    notes: 'Runtime-only event: absent from the exact-source event contract.',
  };
}

export function detectionDocument(version) {
  return {
    executables: ['opencode'],
    envVar: 'PUPPETEER_OPENCODE_BIN',
    versionFlag: '--version',
    versionOutput: `opencode v${version}`,
    versionPattern: '^opencode v(\\d+\\.\\d+\\.\\d+)$',
    helpFlag: '--help',
    probedFlags: { serve: 'serve --help', root: '--help' },
    launchFlags: {
      serve: 'serve',
      hostname: '--hostname',
      port: '--port',
      server: '--server',
      session: '--session',
    },
    passwordEnv: ['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'],
  };
}

export function channelsDocument() {
  return {
    channels: {
      argv: {
        kind: 'argv-env',
        notes:
          'Puppeteer launches one loopback `opencode serve --hostname 127.0.0.1 --port 0` backend with an environment-only Basic-auth password (OPENCODE_PASSWORD), and every CLI or TUI client with `--server <origin>`, never the background service.',
      },
      http: {
        kind: 'http',
        notes:
          'Authenticated loopback `/api/*` control and durable state. Event names use `http/<OpenAPI operationId>`; record schemas retain the exact HTTP method and templated route.',
      },
      sse: {
        kind: 'sse',
        notes:
          'GET /api/event emits `data:` records `{id, created, type, location?, data, durable?}`; `data` is an object on the wire though the OpenAPI declares an encoded string. No replay cursor: a per-aggregate `durable.seq` gap means rehydrate over REST.',
      },
      terminal: {
        kind: 'terminal',
        notes:
          'The OpenCode TUI attached with `--server <origin> --session <id>`; terminal pixels are not the semantic observation rail.',
      },
    },
  };
}

/** Every reason the census run, artifact and references cannot produce a model; empty when they can. */
export function inputProblems({ version, artifact, run, openapi, contract }) {
  const problems = [];
  if (!VERSION_2.test(version ?? '')) problems.push(`version ${String(version)} is not a 2.x release`);
  if (artifact?.version !== version) problems.push(`artifact.json is for ${String(artifact?.version)}`);
  if (!/^[0-9a-f]{64}$/.test(artifact?.sha256 ?? '')) problems.push('artifact.json has no binary sha256');
  if (!/^[0-9a-f]{40}$/.test(artifact?.sourceRevision ?? '')) {
    problems.push(`artifact.json needs the commit of tag v${version} as sourceRevision (a reviewer records it)`);
  }
  if (run?.vendorVersion !== version) problems.push(`census-run.json is for ${String(run?.vendorVersion)}`);
  if (run?.platform !== artifact?.platform) {
    problems.push(`census platform ${String(run?.platform)} is not the artifact's ${String(artifact?.platform)}`);
  }
  if (openapi?.openapi !== '3.1.0') problems.push(`expected OpenAPI 3.1.0, got ${String(openapi?.openapi)}`);
  if (contract) {
    problems.push(...exactSourceEventContractProblems(contract).map((problem) => `event contract: ${problem}`));
    if (contract.vendorVersion !== version) problems.push(`event contract is for ${String(contract.vendorVersion)}`);
    if (contract.sourceRevision !== artifact?.sourceRevision) {
      problems.push('event contract and artifact name different source revisions');
    }
  }
  return problems;
}

const scriptPath = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1] && scriptPath === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendorRoot = dirname(dirname(scriptPath));
  const repoRoot = resolve(vendorRoot, '../../../..');
  const posixRelative = (path) => relative(repoRoot, path).split(sep).join('/');
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const writeJson = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const version = flag('--version') ?? process.env.PUPPETEER_OPENCODE_VERSION;
  if (!version || !VERSION_2.test(version)) throw new Error('--version <2.x.y> is required');
  const capturesDir = resolve(flag('--captures') ?? join(vendorRoot, 'captures', `opencode@${version}`));
  const probesDir = resolve(flag('--probes') ?? join(vendorRoot, 'probes', `opencode@${version}`));
  const referencesDir = resolve(flag('--references') ?? join(vendorRoot, 'references', `opencode@${version}`));
  const contractPath = join(referencesDir, 'source', 'event-contract.json');
  const behaviorPath = resolve(flag('--behavior') ?? join(vendorRoot, 'census', 'behavior-v2.seed.json'));
  // Replaced whole below: an existing destination must be model/opencode@<2.x.y>.
  const out = replaceableDestination(
    flag('--out') ?? join(vendorRoot, 'model', `opencode@${version}`),
    join(vendorRoot, 'model'),
  );
  if (!existsSync(behaviorPath)) {
    throw new Error(
      `reviewed 2.x behavior seed not found: ${displayPath(behaviorPath, repoRoot)}. ` +
        'Author it from the census event order (C5) first.',
    );
  }

  const artifact = readJson(join(probesDir, 'artifact.json'));
  const run = readJson(join(capturesDir, 'census-run.json'));
  const openapi = readJson(join(referencesDir, 'openapi.json'));
  const contract = existsSync(contractPath) ? readJson(contractPath) : undefined;
  const problems = inputProblems({ version, artifact, run, openapi, contract });
  if (problems.length > 0) throw new Error(`cannot generate opencode@${version}:\n${problems.join('\n')}`);
  const observed = census(capturesDir);
  const artifactID = `opencode-${version}-${artifact.platform}`;

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'events'), { recursive: true });
  writeJson(join(out, 'manifest.json'), {
    asmVersion: 3,
    vendor: 'opencode',
    vendorVersion: version,
    generatedAt: artifact.capturedAt.slice(0, 10),
    source:
      'Generated by packages/surface/vendors/opencode/census/generate-model-v2.mjs from the runtime /openapi.json, the exact-source event contract and the sanitized hermetic 2.x HTTP/SSE census. Schema- and source-only branches remain unverified.',
    evidence: 'evidence.json',
  });
  writeJson(join(out, 'detection.json'), detectionDocument(version));
  writeJson(join(out, 'channels.json'), channelsDocument());

  let httpCount = 0;
  for (const operation of openApiHttpOperations(openapi)) {
    const document = httpEventDocument(operation, observed, version);
    writeJson(join(out, 'events', eventDocumentPath(document.event)), document);
    httpCount += 1;
  }
  const generated = new Set();
  for (const schemas of contract ? exactSourceEventSchemas(contract) : []) {
    const document = contractEventDocument(schemas, observed.events.get(schemas.event), version);
    writeJson(join(out, 'events', eventDocumentPath(schemas.event)), document);
    generated.add(schemas.event);
  }
  for (const [event, observation] of [...observed.events].sort(([left], [right]) => left.localeCompare(right))) {
    if (generated.has(event)) continue;
    writeJson(join(out, 'events', eventDocumentPath(event)), sampledEventDocument(event, observation, version));
    generated.add(event);
  }
  writeFileSync(join(out, 'behavior.json'), readFileSync(behaviorPath));

  const scenarioClaims = observed.scenarios.map((scenario) => ({
    id: claimID(scenario),
    kind: 'runtime-capture',
    confidence: 'verified-headless',
    record: `capture-${scenario}`,
    artifact: artifactID,
    platform: artifact.platform,
    harness: HARNESS,
    capturedAt: run.scenarios?.[scenario]?.capturedAt ?? artifact.capturedAt,
    notes: `Hermetic headless 2.x census scenario: ${scenario}.`,
  }));
  writeJson(join(out, 'evidence.json'), {
    evidenceVersion: 2,
    vendor: 'opencode',
    vendorVersion: version,
    artifacts: [
      {
        id: artifactID,
        platform: artifact.platform,
        channel: 'stable',
        acquiredAt: artifact.capturedAt,
        versionOutput: `opencode v${version}`,
        sourceUrl: artifact.sourceUrl,
        sourceTag: artifact.sourceTag,
        sourceRevision: artifact.sourceRevision,
        integrity: { status: 'verified', sha256: `sha256:${artifact.sha256}` },
      },
    ],
    sourceReferences: [
      {
        repository: 'https://github.com/anomalyco/opencode',
        revision: artifact.sourceRevision,
        tag: artifact.sourceTag,
        relation: 'exact-release',
      },
    ],
    records: [
      ...observed.scenarios.map((scenario) => ({
        id: `capture-${scenario}`,
        kind: 'capture-set',
        path: posixRelative(join(capturesDir, scenario)),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(join(capturesDir, scenario)),
      })),
      {
        id: 'binary-probes',
        kind: 'probe-set',
        path: posixRelative(probesDir),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(probesDir),
      },
      {
        id: 'runtime-openapi',
        kind: 'generated-schema',
        path: posixRelative(referencesDir),
        exclude: ['source/event-contract.json'],
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(referencesDir, ['source/event-contract.json']),
      },
      ...(contract
        ? [
            {
              id: 'source-event-contract',
              kind: 'source-contract',
              path: posixRelative(dirname(contractPath)),
              digestAlgorithm: 'sha256-path-content-v1',
              sha256: digestTree(dirname(contractPath)),
            },
          ]
        : []),
      {
        id: 'agent-surface-model',
        kind: 'model-tree',
        path: posixRelative(out),
        exclude: ['evidence.json'],
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(out, ['evidence.json']),
      },
    ],
    claims: [
      {
        id: 'opencode-binary-probe',
        kind: 'binary-probe',
        confidence: 'verified-headless',
        record: 'binary-probes',
        artifact: artifactID,
        sourceReference: 0,
        platform: artifact.platform,
        harness: 'opencode --version; opencode <command> --help for every command of the help tree',
        capturedAt: artifact.capturedAt,
      },
      {
        id: OPENAPI_CLAIM,
        kind: 'generated-schema',
        confidence: 'unverified',
        record: 'runtime-openapi',
        artifact: artifactID,
        sourceReference: 0,
        harness: 'GET /openapi.json from the pinned private opencode serve backend',
        notes: 'The served schema proves possible names and shapes, not runtime occurrence or ordering.',
      },
      ...(contract
        ? [
            {
              id: SOURCE_CLAIM,
              kind: 'exact-source',
              confidence: 'unverified',
              record: 'source-event-contract',
              sourceReference: 0,
              notes:
                'Digest-pinned exact-release source establishes the public event inventory, durability and payload fields; source alone does not prove runtime occurrence.',
            },
          ]
        : []),
      ...scenarioClaims,
      {
        id: 'opencode-topology-inference',
        kind: 'inference',
        confidence: 'unverified',
        notes: 'Reserved for explicitly unverified behavior relations; never upgrades runtime confidence.',
      },
    ],
    limitations: [
      `Artifact integrity and runtime probes are pinned only for ${artifact.platform}; the other platforms' ${version} artifacts were not executed by the census.`,
      'OpenAPI- and source-only branches remain unverified until a controlled runtime capture exercises them.',
      'The SSE carrier has no replay cursor; a per-aggregate durable seq gap requires REST rehydration.',
      ...(contract
        ? []
        : ['No exact-source event contract was supplied: every SSE event schema is sampled from the census alone.']),
    ],
  });

  console.log(`opencode@${version}: ${httpCount} HTTP operation(s), ${generated.size} SSE event type(s)`);
  console.log(`  observed: ${observed.requests.size} HTTP request route(s), ${observed.events.size} SSE event type(s)`);
  console.log(`  -> ${displayPath(out, repoRoot)}`);
  console.log('groundtruth.json is unchanged: it flips only in the switch PR.');
}
