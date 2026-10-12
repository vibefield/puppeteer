#!/usr/bin/env node
/** Generate a complete Surface authoring model from committed Rosetta evidence. */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDocumentPath } from '@vibefield/puppeteer-surface';
import { digestTree } from './check-evidence.mjs';
import { writeGroundTruthArtifacts } from './groundtruth.mjs';
import { rosettaAgentConfig, rosettaArtifactIdentity, rosettaEventIdentity } from './rosetta-agents.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    })
    .sort();
}

export function rosettaShapeToJsonSchema(shape) {
  if (!shape || typeof shape !== 'object') return {};
  switch (shape.kind) {
    case 'string': {
      const values = shape.values && typeof shape.values === 'object' ? Object.keys(shape.values) : [];
      return { type: 'string', ...(values.length > 0 && values.length <= 128 ? { enum: values } : {}) };
    }
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case 'array':
      return { type: 'array', ...(shape.items ? { items: rosettaShapeToJsonSchema(shape.items) } : {}) };
    case 'any_of':
      return { anyOf: (shape.variants ?? []).map(rosettaShapeToJsonSchema) };
    case 'object': {
      const fields = shape.fields && typeof shape.fields === 'object' ? shape.fields : {};
      const properties = Object.fromEntries(
        Object.entries(fields)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, field]) => [name, rosettaShapeToJsonSchema(field?.shape)]),
      );
      const required = Object.entries(fields)
        .filter(([, field]) => field?.required === true)
        .map(([name]) => name)
        .sort();
      return {
        type: 'object',
        ...(Object.keys(properties).length ? { properties } : {}),
        ...(required.length ? { required } : {}),
        additionalProperties: true,
      };
    }
    default:
      return {};
  }
}

export function rosettaEventInventory(canonical, primaryStream) {
  const inventory = [];
  for (const stream of canonical.streams) {
    const recordTypes = stream.record_types && typeof stream.record_types === 'object' ? stream.record_types : {};
    if (Object.keys(recordTypes).length === 0) {
      inventory.push({ event: rosettaArtifactIdentity(stream), nativeName: stream.glob, stream, record: undefined });
      continue;
    }
    for (const [nativeName, record] of Object.entries(recordTypes).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      inventory.push(
        nativeName.length > 0
          ? { event: rosettaEventIdentity(stream, nativeName, primaryStream), nativeName, stream, record }
          : { event: `${stream.id}:document`, nativeName: stream.glob, stream, record },
      );
    }
  }
  return inventory;
}

function captureFacts(capturesRoot) {
  const fixtures = new Map();
  const sequences = [];
  for (const path of filesUnder(capturesRoot).filter((candidate) => candidate.endsWith('.jsonl'))) {
    const sequence = [];
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.type === 'string') {
        sequence.push(value.type);
        if (!fixtures.has(value.type))
          fixtures.set(value.type, relative(dirname(dirname(capturesRoot)), path).replaceAll('\\', '/'));
      }
    }
    if (sequence.length) sequences.push(sequence);
  }
  return { fixtures, sequences };
}

function transportFor(stream) {
  if (stream.file_format === 'jsonl') return 'jsonl-record';
  if (stream.file_format === 'json') return 'json-document';
  if (stream.file_format === 'sqlite') return 'sqlite-row';
  return 'file-artifact';
}

function claimEvidence(claim, ordering = false, carrier = false) {
  return {
    existence: [claim],
    shape: [claim],
    ...(ordering ? { ordering: [claim] } : {}),
    ...(carrier ? { carrier: [claim] } : {}),
  };
}

function omitSchemaProperties(schema, names) {
  if (schema?.type !== 'object') return schema;
  const omitted = new Set(names);
  return {
    ...schema,
    ...(schema.properties
      ? { properties: Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !omitted.has(name))) }
      : {}),
    ...(schema.required ? { required: schema.required.filter((name) => !omitted.has(name)) } : {}),
  };
}

function eventSchemas(item, config) {
  if (!item.record?.shape) return {};
  const recordSchema = rosettaShapeToJsonSchema(item.record.shape);
  if (item.stream.file_format !== 'jsonl') return { payloadSchema: recordSchema };
  if (item.stream.id === config.primaryStream && config.primaryPayloadPath) {
    return { payloadSchema: recordSchema.properties?.[config.primaryPayloadPath] ?? {}, recordSchema };
  }
  const omitted =
    item.stream.id === config.primaryStream
      ? (config.primaryEnvelopeFields ?? [item.stream.discriminator]).filter(Boolean)
      : [item.stream.discriminator].filter(Boolean);
  return { payloadSchema: omitSchemaProperties(recordSchema, omitted), recordSchema };
}

function evidenceFor(item, capturedPrimary, claims) {
  const hasCarrier = item.stream.file_format === 'jsonl' && !!item.record?.shape;
  if (capturedPrimary) {
    return {
      eventEvidence: claimEvidence(claims.runtime, false, hasCarrier),
      eventConfidence: 'verified-headless',
      nodeEvidence: claimEvidence(claims.runtime),
      nodeConfidence: 'verified-headless',
    };
  }
  const sourceEvidence = item.record?.evidence ?? item.stream.evidence;
  const observed = item.record && Number.isFinite(item.record.observed) && item.record.observed > 0;
  if (observed) {
    const observedShape = sourceEvidence === 'fixture' || sourceEvidence === 'observed';
    return {
      eventEvidence: {
        existence: [claims.observed],
        shape: [observedShape ? claims.observed : claims.contract],
        ...(hasCarrier ? { carrier: [observedShape ? claims.observed : claims.contract] } : {}),
      },
      eventConfidence: observedShape ? 'verified-headless' : 'unverified',
      nodeEvidence: claimEvidence(claims.observed),
      nodeConfidence: 'verified-headless',
    };
  }
  return {
    eventEvidence: claimEvidence(claims.contract, false, hasCarrier),
    eventConfidence: 'unverified',
    nodeEvidence: claimEvidence(claims.contract),
    nodeConfidence: 'unverified',
  };
}

export function generateRosettaSurfaceModel(vendor) {
  const config = rosettaAgentConfig(vendor);
  const vendorRoot = join(packageRoot, 'vendors', vendor);
  const referencesRoot = join(vendorRoot, 'references', `${vendor}@${config.version}`);
  const capturesRoot = join(vendorRoot, 'captures', `${vendor}@${config.version}`);
  const modelRoot = join(vendorRoot, 'model', `${vendor}@${config.version}`);
  const eventsRoot = join(modelRoot, 'events');
  const canonical = JSON.parse(readFileSync(join(referencesRoot, 'rosetta-groundtruth.json'), 'utf8'));
  const imported = JSON.parse(readFileSync(join(referencesRoot, 'import.json'), 'utf8'));
  if (
    canonical.agent !== vendor ||
    canonical.agent_version !== config.version ||
    canonical.data_root !== config.dataRoot
  ) {
    throw new Error(`invalid Rosetta reference identity for ${vendor}@${config.version}`);
  }
  const inventory = rosettaEventInventory(canonical, config.primaryStream);
  if (inventory.length > 256)
    throw new Error(`${vendor} has ${inventory.length} events; behavior nodes support at most 256`);
  const captured = captureFacts(capturesRoot);
  const runtimeClaim = `${vendor}-rosetta-runtime`;
  const observedClaim = `${vendor}-rosetta-observed`;
  const contractClaim = `${vendor}-rosetta-contract`;
  const claims = { runtime: runtimeClaim, observed: observedClaim, contract: contractClaim };
  const corpus = imported.fixtureCorpus;

  rmSync(modelRoot, { recursive: true, force: true });
  mkdirSync(eventsRoot, { recursive: true });
  writeJson(join(modelRoot, 'manifest.json'), {
    asmVersion: 3,
    vendor,
    vendorVersion: config.version,
    generatedAt: '2026-08-28',
    source: `Complete Rosetta ${canonical.format} stream inventory plus type-preserving controlled native ${config.primaryStream} journals.`,
    evidence: 'evidence.json',
  });
  writeJson(join(modelRoot, 'detection.json'), {
    executables: config.executables,
    envVar: config.executableEnv,
    versionFlag: '--version',
    versionOutput: config.version,
    versionPattern: '^(?:[^0-9]*[vV]?)?(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?).*$',
    helpFlag: '--help',
    dataRoot: config.dataRoot,
    launchFlags: config.launchFlags,
  });
  writeJson(join(modelRoot, 'channels.json'), {
    channels: Object.fromEntries(
      canonical.streams.map((stream) => [
        stream.id,
        {
          kind: stream.id === config.primaryStream ? 'native-log' : `native-state-${stream.file_format}`,
          glob: stream.glob,
          discipline: stream.discipline,
          evidence: stream.evidence,
          ...(stream.notes ? { notes: stream.notes } : {}),
        },
      ]),
    ),
  });

  const nodeByEvent = new Map();
  for (const [index, item] of inventory.entries()) {
    const capturedPrimary = item.stream.id === config.primaryStream && captured.fixtures.has(item.nativeName);
    const { eventEvidence, eventConfidence } = evidenceFor(item, capturedPrimary, claims);
    const { payloadSchema, recordSchema } = eventSchemas(item, config);
    const document = {
      surface: vendor,
      surfaceVersion: config.version,
      event: item.event,
      ...(item.nativeName !== item.event ? { nativeName: item.nativeName } : {}),
      channel: item.stream.id,
      channels: [item.stream.id],
      transport: transportFor(item.stream),
      direction: 'agent-local',
      ...(payloadSchema
        ? {
            payloadSchema,
            ...(recordSchema ? { recordSchema } : {}),
            schemaFidelity: {
              payload: 'structural',
              ...(recordSchema ? { carrier: 'structural' } : {}),
              limitations: [
                'Rosetta retains observed/writer field types and requiredness, but its shape algebra intentionally omits some native validation constraints.',
              ],
            },
          }
        : {}),
      evidence: eventEvidence,
      confidence: eventConfidence,
      ...(capturedPrimary ? { fixture: captured.fixtures.get(item.nativeName) } : {}),
      notes: item.record
        ? `${item.stream.glob}; ${item.record.observed ?? 0} retained observation(s); source evidence: ${item.record.evidence ?? item.stream.evidence}.`
        : `${item.stream.glob}; non-record native artifact tracked by the complete Rosetta stream inventory.`,
    };
    writeJson(join(eventsRoot, eventDocumentPath(item.event)), document);
    nodeByEvent.set(item.event, `event-${String(index + 1).padStart(3, '0')}`);
  }

  const lanes = canonical.streams.map((stream) => ({
    id: stream.id,
    label: stream.id,
    description: `${stream.discipline} ${stream.file_format}: ${stream.glob}`,
  }));
  const laneOrders = new Map();
  const nodes = inventory.map((item) => {
    const order = laneOrders.get(item.stream.id) ?? 0;
    laneOrders.set(item.stream.id, order + 1);
    const capturedPrimary = item.stream.id === config.primaryStream && captured.fixtures.has(item.nativeName);
    const { nodeEvidence, nodeConfidence } = evidenceFor(item, capturedPrimary, claims);
    return {
      id: nodeByEvent.get(item.event),
      event: item.event,
      confidence: nodeConfidence,
      evidence: nodeEvidence,
      lane: item.stream.id,
      order,
      label: item.nativeName,
    };
  });
  const relationKeys = new Set();
  const relations = [];
  for (const sequence of captured.sequences) {
    for (let index = 1; index < sequence.length; index += 1) {
      const fromEvent = sequence[index - 1];
      const toEvent = sequence[index];
      const from = nodeByEvent.get(fromEvent);
      const to = nodeByEvent.get(toEvent);
      if (!from || !to) continue;
      const key = `${from}\0${to}`;
      if (relationKeys.has(key)) continue;
      relationKeys.add(key);
      relations.push({
        from,
        to,
        kind: from === to ? 'loop' : 'sequence',
        confidence: 'verified-headless',
        evidence: claimEvidence(runtimeClaim, true),
        source: 'sanitized Rosetta native journal order',
      });
    }
  }
  writeJson(join(modelRoot, 'behavior.json'), {
    behaviorVersion: 1,
    title: `${vendor} native persisted-state topology`,
    description: `Every Rosetta stream is retained as a lane. Arrows are only asserted where committed ${config.primaryStream} journals prove ordering.`,
    source: 'Rosetta canonical inventory and controlled fixtures',
    lanes,
    nodes,
    relations,
  });
  writeJson(join(modelRoot, 'evidence.json'), {
    evidenceVersion: 2,
    vendor,
    vendorVersion: config.version,
    artifacts: [
      {
        id: corpus.id,
        kind: 'controlled-fixture-corpus',
        versionOutput: corpus.versionOutput,
        platform: corpus.platform,
        capturedAt: corpus.capturedAt,
        integrity: { status: 'verified', sha256: `sha256:${corpus.sha256}` },
      },
    ],
    sourceReferences: [{ repository: config.repository, revision: config.revision, relation: config.relation }],
    records: [
      {
        id: `${vendor}-captures`,
        path: relative(repositoryRoot, capturesRoot).replaceAll('\\', '/'),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(capturesRoot),
      },
      {
        id: `${vendor}-references`,
        path: relative(repositoryRoot, referencesRoot).replaceAll('\\', '/'),
        digestAlgorithm: 'sha256-path-content-v1',
        sha256: digestTree(referencesRoot),
      },
    ],
    claims: [
      {
        id: runtimeClaim,
        kind: 'runtime-capture',
        confidence: 'verified-headless',
        record: `${vendor}-captures`,
        artifact: corpus.id,
        platform: corpus.platform,
        harness: 'rosetta controlled mock-provider farm',
        capturedAt: corpus.capturedAt,
        notes: `Type-preserving ${config.primaryStream} native journal captures.`,
      },
      {
        id: observedClaim,
        kind: 'generated-schema',
        confidence: 'verified-headless',
        record: `${vendor}-references`,
        artifact: corpus.id,
        sourceReference: 0,
        platform: corpus.platform,
        harness: 'rosetta controlled mock-provider farm',
        capturedAt: corpus.capturedAt,
        notes:
          'Digest-pinned Rosetta record inventory whose occurrence count is non-zero. It proves occurrence; it proves retained shape only for records classified as fixture or observed rather than writer evidence.',
      },
      {
        id: contractClaim,
        kind: 'generated-schema',
        confidence: 'unverified',
        record: `${vendor}-references`,
        artifact: corpus.id,
        sourceReference: 0,
        notes: `Digest-pinned complete Rosetta stream/shape inventory for ${vendor}@${config.version}; writer-only and zero-occurrence records establish a reviewable contract lead, not runtime occurrence.`,
      },
    ],
  });
  const written = writeGroundTruthArtifacts(modelRoot);
  return { vendor, version: config.version, events: inventory.length, ...written };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const result = generateRosettaSurfaceModel(process.argv[2]);
  console.log(`generated ${result.vendor}@${result.version}: ${result.events} events`);
}
