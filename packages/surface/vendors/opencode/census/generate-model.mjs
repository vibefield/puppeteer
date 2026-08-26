#!/usr/bin/env node
/**
 * Generate the OpenCode ASM from the pinned `/doc` OpenAPI document and the
 * sanitized census. Schema proves possible shape; only runtime observations
 * raise confidence above `unverified`.
 *
 * HTTP operations are named `http/<operationId>` because OpenCode uses some of
 * the same dotted strings for REST operation IDs and SSE event types. The
 * event document retains the exact method and templated route in its carrier.
 *
 * usage:
 *   node generate-model.mjs [--schema openapi.json] [--captures dir] [--out dir]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { writeGroundTruthArtifacts } from '../../../scripts/groundtruth.mjs';

const VERSION = '1.18.16';
const PLATFORM = 'darwin-arm64';
const ARTIFACT_ID = `opencode-${VERSION}-${PLATFORM}`;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const INTERACTIVE_SCENARIOS = new Set(['attach-exact-resume', 'attach-permission-always']);
const CAPTURED_AT = {
  'abort-stream': '2026-08-11T04:45:25.264Z',
  'abort-tool': '2026-08-11T04:45:34.390Z',
  'agent-part': '2026-08-11T06:51:18.359Z',
  'attach-exact-resume': '2026-08-11T07:18:00.868Z',
  'attach-permission-always': '2026-08-11T05:05:34.164Z',
  'auto-compaction': '2026-08-11T06:00:30.080Z',
  'background-task': '2026-08-11T06:45:27.498Z',
  'detach-task': '2026-08-11T06:45:16.713Z',
  'exact-resume': '2026-08-11T04:56:30.098Z',
  'file-delete': '2026-08-11T06:31:04.089Z',
  'file-edit': '2026-08-11T06:31:06.819Z',
  'file-part': '2026-08-11T07:01:18.440Z',
  'file-write': '2026-08-11T06:31:05.993Z',
  'manual-compaction': '2026-08-11T05:53:20.004Z',
  'overflow-compaction': '2026-08-11T06:37:52.297Z',
  'permission-accept': '2026-08-10T07:31:38.386Z',
  'permission-reject': '2026-08-10T07:33:01.938Z',
  'provider-error': '2026-08-11T04:45:54.406Z',
  'provider-retry': '2026-08-11T04:45:43.535Z',
  'question-reject': '2026-08-10T07:33:36.468Z',
  'question-reply': '2026-08-10T07:33:19.838Z',
  'reconnect-rehydrate': '2026-08-11T04:56:19.470Z',
  'session-lifecycle': '2026-08-11T07:10:18.767Z',
  'subtask-part': '2026-08-11T06:17:34.203Z',
  'task-child': '2026-08-11T06:14:05.678Z',
  turn: '2026-08-10T07:31:18.479Z',
  'unknown-context': '2026-08-11T06:55:14.225Z',
};
const VARIANT_PATHS = new Map([
  ['file.watcher.updated', ['event']],
  ['message.updated', ['info.role']],
  ['message.part.updated', ['part.type', 'part.state.status']],
  ['permission.replied', ['reply']],
  ['session.status', ['status.type']],
]);

const scriptPath = fileURLToPath(import.meta.url);
const vendorRoot = dirname(dirname(scriptPath));
const packageRoot = resolve(vendorRoot, '../..');
const repoRoot = resolve(packageRoot, '../..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const posixRelative = (path) => relative(repoRoot, path).split(sep).join('/');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

function refTarget(reference, root) {
  const prefix = '#/components/schemas/';
  return typeof reference === 'string' && reference.startsWith(prefix)
    ? root.components?.schemas?.[reference.slice(prefix.length)]
    : undefined;
}

function dereference(node, root) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string') return node;
  return refTarget(node.$ref, root) ?? {};
}

function mergeObjectSchemas(schemas) {
  const objects = schemas.filter((schema) => schema?.type === 'object');
  if (objects.length === 0) return {};
  const properties = Object.assign({}, ...objects.map((schema) => schema.properties ?? {}));
  const required = [...new Set(objects.flatMap((schema) => schema.required ?? []))].filter((name) =>
    Object.hasOwn(properties, name),
  );
  return {
    type: 'object',
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(required.length > 0 ? { required: required.sort() } : {}),
  };
}

/** Collapse OpenAPI into the recursive subset enforced by Surface. */
function schemaNode(node, root, options = {}) {
  const { path = '', enumPaths = new Set(), stack = new Set(), depth = 0 } = options;
  if (!node || typeof node !== 'object' || depth > 24) return {};
  if (typeof node.$ref === 'string') {
    if (stack.has(node.$ref)) return {};
    const target = refTarget(node.$ref, root);
    if (!target) return {};
    return schemaNode(target, root, {
      path,
      enumPaths,
      stack: new Set([...stack, node.$ref]),
      depth: depth + 1,
    });
  }

  const branchNodes = [...(node.anyOf ?? []), ...(node.oneOf ?? [])]
    .map((branch) => schemaNode(branch, root, { path, enumPaths, stack, depth: depth + 1 }))
    .filter((branch) => Object.keys(branch).length > 0);
  const uniqueBranches = [...new Map(branchNodes.map((branch) => [JSON.stringify(branch), branch])).values()];
  const allOf = (node.allOf ?? []).map((branch) =>
    schemaNode(branch, root, { path, enumPaths, stack, depth: depth + 1 }),
  );
  const allOfObject = mergeObjectSchemas(allOf);

  const declaredTypes = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const nonNullTypes = [...new Set(declaredTypes.filter((type) => type !== 'null'))];
  let type = nonNullTypes.length === 1 ? nonNullTypes[0] : undefined;
  if (!type && (node.properties || allOfObject.type === 'object')) type = 'object';
  if (!type && node.items) type = 'array';

  const result = {};
  if (type && ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(type)) {
    result.type = type;
  }
  // Surface deliberately bounds unions. A wider vendor union is left
  // unconstrained at that node instead of being truncated into a false claim.
  if (uniqueBranches.length > 0 && uniqueBranches.length <= 16) result.anyOf = uniqueBranches;
  if (declaredTypes.includes('null') && nonNullTypes.length === 1) {
    result.anyOf = [...(result.anyOf ?? []), { type: nonNullTypes[0] }, { type: 'null' }];
    delete result.type;
  }

  if (type === 'object') {
    const rawProperties = { ...(allOfObject.properties ?? {}), ...(node.properties ?? {}) };
    const properties = {};
    for (const name of Object.keys(rawProperties).sort()) {
      properties[name] = schemaNode(rawProperties[name], root, {
        path: path ? `${path}.${name}` : name,
        enumPaths,
        stack,
        depth: depth + 1,
      });
    }
    if (Object.keys(properties).length > 0) result.properties = properties;
    const required = [...new Set([...(allOfObject.required ?? []), ...(node.required ?? [])])]
      .filter((name) => Object.hasOwn(properties, name))
      .sort();
    if (required.length > 0) result.required = required;
  }
  if (type === 'array' && node.items) {
    result.items = schemaNode(node.items, root, { path, enumPaths, stack, depth: depth + 1 });
  }
  if (enumPaths.has(path) && Array.isArray(node.enum) && node.enum.length > 0) result.enum = node.enum;
  if (enumPaths.has(path) && Object.hasOwn(node, 'const')) result.enum = [node.const];
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
    if (typeof node[key] === 'number') result[key] = node[key];
  }
  return result;
}

function requestBodySchema(operation, root) {
  const requestBody = dereference(operation.requestBody, root);
  const content = requestBody?.content ?? {};
  const media = content['application/json'] ?? content['application/*+json'];
  return media?.schema ? schemaNode(media.schema, root) : undefined;
}

function operationRequestSchema(pathItem, operation, root, method, route) {
  const properties = { method: { type: 'string' }, route: { type: 'string' } };
  const required = ['method', 'route'];
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) => dereference(parameter, root));
  for (const [location, property] of [
    ['path', 'params'],
    ['query', 'query'],
  ]) {
    const selected = parameters.filter((parameter) => parameter?.in === location);
    if (selected.length === 0) continue;
    const parameterProperties = {};
    const parameterRequired = [];
    for (const parameter of selected.sort((left, right) => left.name.localeCompare(right.name))) {
      parameterProperties[parameter.name] = schemaNode(parameter.schema, root);
      if (parameter.required) parameterRequired.push(parameter.name);
    }
    properties[property] = {
      type: 'object',
      properties: parameterProperties,
      ...(parameterRequired.length > 0 ? { required: parameterRequired } : {}),
    };
    if (parameterRequired.length > 0) required.push(property);
  }
  const body = requestBodySchema(operation, root);
  if (body) {
    properties.body = body;
    const requestBody = dereference(operation.requestBody, root);
    if (requestBody?.required) required.push('body');
  }
  return { type: 'object', properties, required, _method: method, _route: route };
}

function successfulResponse(operation, root) {
  const entries = Object.entries(operation.responses ?? {})
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return undefined;
  const [status, raw] = entries[0];
  const response = dereference(raw, root);
  const content = response?.content ?? {};
  const media = content['application/json'] ?? content['application/*+json'];
  return { status: Number(status), body: media?.schema ? schemaNode(media.schema, root) : undefined };
}

function operationResultSchema(operation, root, requestSchema, method, route) {
  const success = successfulResponse(operation, root);
  const properties = {
    method: { type: 'string', enum: [method] },
    route: { type: 'string', enum: [route] },
    status: { type: 'integer', minimum: 200, maximum: 299 },
  };
  const required = ['method', 'route', 'status'];
  for (const property of ['params', 'query']) {
    if (!requestSchema.properties?.[property]) continue;
    properties[property] = structuredClone(requestSchema.properties[property]);
    if (requestSchema.required?.includes(property)) required.push(property);
  }
  if (success?.body) {
    properties.body = success.body;
    required.push('body');
  }
  return { type: 'object', properties, required };
}

function exactRequestSchema(schema, method, route) {
  const exact = structuredClone(schema);
  delete exact._method;
  delete exact._route;
  exact.properties.method.enum = [method];
  exact.properties.route.enum = [route];
  return exact;
}

function requestRecordSchema(requestSchema, method, route) {
  return {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['client-to-agent'] },
      request: exactRequestSchema(requestSchema, method, route),
    },
    required: ['direction', 'request'],
  };
}

function traceRoute(path) {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

function eventPath(out, event) {
  const components = event.split('/');
  const name = components.pop();
  return join(out, 'events', ...components, `${name}.json`);
}

function records(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function claimID(scenario) {
  return `opencode-runtime-${scenario}`;
}

function scenarioConfidence(scenario) {
  return INTERACTIVE_SCENARIOS.has(scenario) ? 'verified-interactive' : 'verified-headless';
}

function bestScenario(scenarios) {
  return [...scenarios].sort((left, right) => {
    const confidence = (scenario) => (INTERACTIVE_SCENARIOS.has(scenario) ? 1 : 2);
    return confidence(right) - confidence(left) || left.localeCompare(right);
  })[0];
}

function census(capturesDir) {
  const events = new Map();
  const requests = new Map();
  const responses = new Map();
  const scenarios = existsSync(capturesDir)
    ? readdirSync(capturesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  for (const scenario of scenarios) {
    const scenarioRoot = join(capturesDir, scenario);
    for (const event of records(join(scenarioRoot, 'events.jsonl'))) {
      if (typeof event.type !== 'string') continue;
      const observation = events.get(event.type) ?? { scenarios: new Set(), samples: [] };
      observation.scenarios.add(scenario);
      observation.samples.push({ scenario, payload: event.properties, record: event });
      events.set(event.type, observation);
    }
    for (const record of records(join(scenarioRoot, 'http-roundtrip.jsonl'))) {
      if (record.request) {
        const key = `${record.request.method} ${record.request.route}`;
        const observation = requests.get(key) ?? { scenarios: new Set(), samples: [] };
        observation.scenarios.add(scenario);
        observation.samples.push({ scenario, payload: record.request, record });
        requests.set(key, observation);
      }
      if (record.response) {
        const key = `${record.response.method} ${record.response.route}`;
        const observation = responses.get(key) ?? { scenarios: new Set(), samples: [] };
        observation.scenarios.add(scenario);
        observation.samples.push({ scenario, payload: record.response, record });
        responses.set(key, observation);
      }
    }
  }
  return { events, requests, responses, scenarios };
}

function valueAt(value, dottedPath) {
  return dottedPath.split('.').reduce((current, component) => current?.[component], value);
}

function enumClaims(schema, prefix = '') {
  const found = [];
  if (Array.isArray(schema?.enum) && prefix) found.push({ path: prefix, values: schema.enum });
  for (const branch of schema?.anyOf ?? []) found.push(...enumClaims(branch, prefix));
  for (const [name, child] of Object.entries(schema?.properties ?? {})) {
    found.push(...enumClaims(child, prefix ? `${prefix}.${name}` : name));
  }
  return found;
}

function evidenceFor(observation, fallback = 'opencode-generated-openapi') {
  const scenario = observation && bestScenario(observation.scenarios);
  const id = scenario ? claimID(scenario) : fallback;
  return { id, scenario, confidence: scenario ? scenarioConfidence(scenario) : 'unverified' };
}

function variantsFor(schema, observation) {
  const variants = [];
  for (const claim of enumClaims(schema)) {
    for (const expected of claim.values) {
      const matching =
        observation?.samples.filter((sample) => Object.is(valueAt(sample.payload, claim.path), expected)) ?? [];
      const scenario = matching.length > 0 ? bestScenario(matching.map((sample) => sample.scenario)) : undefined;
      const evidence = scenario ? claimID(scenario) : 'opencode-generated-openapi';
      variants.push({
        match: { [claim.path]: expected },
        evidence: { existence: [evidence], shape: [evidence] },
        confidence: scenario ? scenarioConfidence(scenario) : 'unverified',
      });
    }
  }
  return variants;
}

function eventType(schema) {
  return schema?.properties?.type?.enum?.[0] ?? schema?.properties?.type?.const;
}

function inferredSchema(values) {
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
  const type = types[0];
  if (type === 'object') {
    const objects = present;
    const names = [...new Set(objects.flatMap((value) => Object.keys(value)))].sort();
    const properties = Object.fromEntries(
      names.map((name) => [
        name,
        inferredSchema(objects.map((value) => value[name]).filter((value) => value !== undefined)),
      ]),
    );
    const required = names.filter((name) => objects.every((value) => Object.hasOwn(value, name)));
    return {
      type: 'object',
      ...(names.length > 0 ? { properties } : {}),
      ...(required.length > 0 ? { required } : {}),
    };
  }
  if (type === 'array') {
    return { type: 'array', items: inferredSchema(present.flat()) };
  }
  return ['string', 'number', 'integer', 'boolean', 'null'].includes(type) ? { type } : {};
}

function description(operation) {
  return [operation.summary, operation.description]
    .filter((value, index, values) => typeof value === 'string' && value.length > 0 && values.indexOf(value) === index)
    .join(' — ');
}

const expectedVersion = flag('--version') ?? VERSION;
if (expectedVersion !== VERSION) throw new Error(`generator is pinned to OpenCode ${VERSION}, got ${expectedVersion}`);
const capturesDir = resolve(flag('--captures') ?? join(vendorRoot, 'captures', `opencode@${VERSION}`));
const probesDir = resolve(flag('--probes') ?? join(vendorRoot, 'probes', `opencode@${VERSION}`));
const schemaPath = resolve(
  flag('--schema') ?? join(vendorRoot, 'captures-raw', `opencode@${VERSION}`, 'turn', 'openapi.json'),
);
const out = resolve(flag('--out') ?? join(vendorRoot, 'model', `opencode@${VERSION}`));
const behaviorPath = resolve(flag('--behavior') ?? join(vendorRoot, 'census', 'behavior.seed.json'));
const includeEvidence = !argv.includes('--no-evidence');
if (!existsSync(schemaPath)) throw new Error(`OpenCode OpenAPI document not found: ${schemaPath}`);
if (!existsSync(behaviorPath)) throw new Error(`reviewed behavior seed not found: ${behaviorPath}`);

const openapi = readJson(schemaPath);
if (openapi.openapi !== '3.1.0') throw new Error(`expected OpenAPI 3.1.0, got ${String(openapi.openapi)}`);
const artifact = readJson(join(probesDir, 'artifact.json'));
if (artifact.version !== VERSION || artifact.platform !== PLATFORM)
  throw new Error('artifact probe does not match generator pin');
const observed = census(capturesDir);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'events'), { recursive: true });

writeJson(join(out, 'manifest.json'), {
  asmVersion: 2,
  vendor: 'opencode',
  vendorVersion: VERSION,
  generatedAt: artifact.capturedAt.slice(0, 10),
  source:
    'Generated by packages/surface/vendors/opencode/census/generate-model.mjs from the pinned OpenCode /doc OpenAPI document and sanitized hermetic HTTP/SSE captures. Schema-only branches remain unverified.',
  ...(includeEvidence ? { evidence: 'evidence.json' } : {}),
});

writeJson(join(out, 'detection.json'), {
  executables: ['opencode'],
  envVar: 'PUPPETEER_OPENCODE_BIN',
  versionFlag: '--version',
  versionOutput: VERSION,
  versionPattern: '^(\\d+\\.\\d+\\.\\d+)$',
  helpFlag: '--help',
  probedFlags: { serve: 'serve --help', attach: 'attach --help' },
  launchFlags: {
    serve: 'serve',
    hostname: '--hostname',
    port: '--port',
    attach: 'attach',
    directory: '--dir',
    session: '--session',
    pure: '--pure',
  },
});

writeJson(join(out, 'channels.json'), {
  channels: {
    argv: {
      kind: 'argv-env',
      notes:
        'Puppeteer launches one loopback `opencode serve` backend with an environment-only Basic-auth password, then launches `opencode attach` for the exact native session ID.',
    },
    http: {
      kind: 'http',
      notes:
        'Authenticated loopback REST control and durable state. Event names use `http/<OpenAPI operationId>`; record schemas retain exact HTTP method and templated route.',
    },
    sse: {
      kind: 'sse',
      notes:
        'GET /event emits native `{id,type,properties}` records. No replay cursor was observed; reconnect requires durable HTTP rehydration and entity reconciliation.',
    },
    terminal: {
      kind: 'terminal',
      notes:
        'The real OpenCode TUI attached to the shared backend and exact session. It can be the blocker controller; terminal pixels are not the semantic observation rail.',
    },
  },
});

let httpCount = 0;
for (const path of Object.keys(openapi.paths ?? {}).sort()) {
  const pathItem = openapi.paths[path];
  for (const method of Object.keys(pathItem)
    .filter((name) => HTTP_METHODS.has(name))
    .sort()) {
    const operation = pathItem[method];
    if (typeof operation.operationId !== 'string') continue;
    const route = traceRoute(path);
    const key = `${method.toUpperCase()} ${route}`;
    const requestObservation = observed.requests.get(key);
    const responseObservation = observed.responses.get(key);
    const requestEvidence = evidenceFor(requestObservation);
    const resultEvidence = evidenceFor(responseObservation);
    const requestSchema = operationRequestSchema(pathItem, operation, openapi, method.toUpperCase(), route);
    delete requestSchema._method;
    delete requestSchema._route;
    const event = `http/${operation.operationId}`;
    const evidence = {
      existence: [requestEvidence.id],
      shape: [requestEvidence.id],
      result: [resultEvidence.id],
      carrier: [requestEvidence.id],
    };
    const confidence =
      requestEvidence.confidence === 'verified-headless' && resultEvidence.confidence === 'verified-headless'
        ? 'verified-headless'
        : requestEvidence.confidence === 'unverified' || resultEvidence.confidence === 'unverified'
          ? 'unverified'
          : 'verified-interactive';
    writeJson(eventPath(out, event), {
      surface: 'opencode',
      surfaceVersion: VERSION,
      event,
      channel: 'http',
      channels: ['http'],
      transport: 'http',
      direction: 'client-to-agent',
      ...(description(operation) ? { trigger: description(operation) } : {}),
      payloadSchema: requestSchema,
      resultSchema: operationResultSchema(operation, openapi, requestSchema, method.toUpperCase(), route),
      recordSchema: requestRecordSchema(requestSchema, method.toUpperCase(), route),
      evidence,
      confidence,
      ...(requestEvidence.scenario
        ? {
            firstSeen: VERSION,
            lastVerified: VERSION,
            fixture: `captures/opencode@${VERSION}/${requestEvidence.scenario}/http-roundtrip.jsonl`,
          }
        : {}),
      notes: `OpenAPI operationId ${operation.operationId}; ${method.toUpperCase()} ${path}.`,
    });
    httpCount += 1;
  }
}

let sseCount = 0;
const generatedSse = new Set();
const eventUnion = openapi.components?.schemas?.Event;
for (const branch of eventUnion?.anyOf ?? []) {
  const schema = dereference(branch, openapi);
  const event = eventType(schema);
  if (typeof event !== 'string') continue;
  const observation = observed.events.get(event);
  const runtime = evidenceFor(observation);
  const enumPaths = new Set(VARIANT_PATHS.get(event) ?? []);
  const payloadSchema = schemaNode(schema.properties?.properties, openapi, { enumPaths });
  const recordSchema = schemaNode(schema, openapi);
  recordSchema.properties.type.enum = [event];
  const variants = variantsFor(payloadSchema, observation);
  writeJson(eventPath(out, event), {
    surface: 'opencode',
    surfaceVersion: VERSION,
    event,
    channel: 'sse',
    channels: ['sse'],
    transport: 'sse-event',
    direction: 'agent-to-client',
    trigger: 'Published on the native GET /event stream.',
    payloadSchema,
    recordSchema,
    evidence: {
      existence: [runtime.id],
      shape: [runtime.id],
      carrier: [runtime.id],
    },
    ...(variants.length > 0 ? { variants } : {}),
    confidence: runtime.confidence,
    ...(runtime.scenario
      ? {
          firstSeen: VERSION,
          lastVerified: VERSION,
          fixture: `captures/opencode@${VERSION}/${runtime.scenario}/events.jsonl`,
        }
      : {}),
  });
  generatedSse.add(event);
  sseCount += 1;
}

for (const [event, observation] of [...observed.events].sort(([left], [right]) => left.localeCompare(right))) {
  if (generatedSse.has(event)) continue;
  const runtime = evidenceFor(observation);
  const payloadSchema = inferredSchema(observation.samples.map((sample) => sample.payload));
  const recordSchema = inferredSchema(observation.samples.map((sample) => sample.record));
  recordSchema.properties.type.enum = [event];
  writeJson(eventPath(out, event), {
    surface: 'opencode',
    surfaceVersion: VERSION,
    event,
    channel: 'sse',
    channels: ['sse'],
    transport: 'sse-event',
    direction: 'agent-to-client',
    trigger: 'Observed on the native GET /event stream.',
    payloadSchema,
    recordSchema,
    evidence: {
      existence: [runtime.id],
      shape: [runtime.id],
      carrier: [runtime.id],
    },
    confidence: runtime.confidence,
    firstSeen: VERSION,
    lastVerified: VERSION,
    fixture: `captures/opencode@${VERSION}/${runtime.scenario}/events.jsonl`,
    notes: 'Runtime-only event absent from the pinned /doc Event union.',
  });
  sseCount += 1;
}

writeFileSync(join(out, 'behavior.json'), readFileSync(behaviorPath));

if (includeEvidence) {
  const scenarioRecords = observed.scenarios.map((scenario) => ({
    id: `capture-${scenario}`,
    kind: 'capture-set',
    path: posixRelative(join(capturesDir, scenario)),
    digestAlgorithm: 'sha256-path-content-v1',
    sha256: digestTree(join(capturesDir, scenario)),
  }));
  const scenarioClaims = observed.scenarios.map((scenario) => ({
    id: claimID(scenario),
    kind: 'runtime-capture',
    confidence: scenarioConfidence(scenario),
    record: `capture-${scenario}`,
    artifact: ARTIFACT_ID,
    platform: PLATFORM,
    harness: 'packages/surface/vendors/opencode/census/harness.mjs',
    capturedAt: CAPTURED_AT[scenario] ?? artifact.capturedAt,
    notes: INTERACTIVE_SCENARIOS.has(scenario)
      ? 'Native attach TUI interaction on the shared backend.'
      : `Hermetic headless census scenario: ${scenario}.`,
  }));
  const modelRecord = {
    id: 'agent-surface-model',
    kind: 'model-tree',
    path: posixRelative(out),
    exclude: ['evidence.json'],
    digestAlgorithm: 'sha256-path-content-v1',
    sha256: digestTree(out, ['evidence.json']),
  };
  writeJson(join(out, 'evidence.json'), {
    evidenceVersion: 2,
    vendor: 'opencode',
    vendorVersion: VERSION,
    artifacts: [
      {
        id: ARTIFACT_ID,
        platform: PLATFORM,
        channel: 'stable',
        acquiredAt: artifact.capturedAt,
        versionOutput: VERSION,
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
      ...scenarioRecords,
      {
        id: 'binary-probes',
        kind: 'probe-set',
        path: posixRelative(probesDir),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(probesDir),
      },
      modelRecord,
    ],
    claims: [
      {
        id: 'opencode-binary-probe',
        kind: 'binary-probe',
        confidence: 'verified-headless',
        record: 'binary-probes',
        artifact: ARTIFACT_ID,
        sourceReference: 0,
        platform: PLATFORM,
        harness: 'opencode --version/--help; opencode serve --help; opencode attach --help',
        capturedAt: artifact.capturedAt,
      },
      {
        id: 'opencode-generated-openapi',
        kind: 'generated-schema',
        confidence: 'unverified',
        artifact: ARTIFACT_ID,
        sourceReference: 0,
        harness: 'GET /doc from the pinned private opencode serve backend',
        notes: 'The generated schema proves possible names and shapes, not runtime occurrence or ordering.',
      },
      ...scenarioClaims,
      {
        id: 'opencode-topology-inference',
        kind: 'inference',
        confidence: 'unverified',
        notes: 'Reserved for explicitly unverified behavior relations; never upgrades runtime confidence.',
      },
    ],
    limitations: [
      'Artifact integrity and runtime probes are pinned only for darwin-arm64.',
      'OpenAPI/source-only branches remain unverified until a controlled runtime capture exercises them.',
      'The SSE carrier exposes no observed replay cursor; durable REST rehydration is required after a gap.',
      'Native attach was captured on an exact fresh session, but not yet combined with a backend-restart resume.',
    ],
  });
}

console.log(`opencode@${VERSION}: ${httpCount} HTTP operation(s), ${sseCount} SSE event type(s)`);
console.log(`  observed: ${observed.requests.size} HTTP request route(s), ${observed.events.size} SSE event type(s)`);
console.log(`  -> ${out}`);
writeGroundTruthArtifacts(out);
