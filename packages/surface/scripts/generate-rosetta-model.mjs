#!/usr/bin/env node
/** Generate a complete Surface authoring model from committed Rosetta evidence. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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

const ROSETTA_DYNAMIC_KEY = '<dynamic>';

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
      const all = shape.fields && typeof shape.fields === 'object' ? shape.fields : {};
      // Rosetta folds arbitrary map keys (ids, paths, configured names) into one `<dynamic>` field; it describes the
      // map's values, not a property literally named `<dynamic>`.
      const dynamic = all[ROSETTA_DYNAMIC_KEY];
      const fields = Object.fromEntries(Object.entries(all).filter(([name]) => name !== ROSETTA_DYNAMIC_KEY));
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
        additionalProperties: dynamic ? rosettaShapeToJsonSchema(dynamic.shape) : true,
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
          ? {
              event: rosettaEventIdentity(stream, nativeName, primaryStream),
              nativeName,
              recordType: nativeName,
              stream,
              record,
            }
          : { event: `${stream.id}:document`, nativeName: stream.glob, recordType: nativeName, stream, record },
      );
    }
  }
  return inventory;
}

// A faithful port of Rosetta's `merge_shapes` / `merge_docs` record merge (tools/groundtruth/model.py), used to rebuild
// one release's inventory from that release's own source documents. Rosetta's canonical document sums every farmed
// release, so its occurrence counts and shapes would otherwise credit an older release's corpus to the pinned one.
const ROSETTA_EVIDENCE_STRENGTH = { research: 0, observed: 1, fixture: 2, writer: 3 };
const ROSETTA_ENUM_CARDINALITY_CAP = 128;
const ROSETTA_DYNAMIC_KEY_CAP = 40;
const ROSETTA_UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROSETTA_OPAQUE_VALUE =
  /^(?:msg|tool|toolu|call|session|req|request|task|thread|run|wf)_[A-Za-z0-9-]*[0-9][A-Za-z0-9-]+$/i;
const ROSETTA_LONG_HEX_VALUE = /^[0-9a-f]{12,}$/i;

function rosettaValueLikeKey(key) {
  if (Buffer.byteLength(key) > 48) return true;
  if (/[\s/\\]/u.test(key)) return true;
  if (ROSETTA_UUID_KEY.test(key) || ROSETTA_OPAQUE_VALUE.test(key) || ROSETTA_LONG_HEX_VALUE.test(key)) return true;
  return key.length > 2 && key.startsWith('<') && key.endsWith('>');
}

function rosettaSchemaFieldKey(key) {
  if (!key || rosettaValueLikeKey(key) || /^\p{N}/u.test(key)) return false;
  return /^[\p{L}\p{N}_]+$/u.test(key);
}

function rosettaField(shape, required, observed) {
  return { shape, required, ...(observed === undefined ? {} : { observed }) };
}

function sortedEntries(object) {
  return Object.entries(object).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function collapseRosettaDynamic(fields) {
  const sorted = Object.fromEntries(sortedEntries(fields));
  const keys = Object.keys(sorted);
  if (
    !keys.some(rosettaValueLikeKey) &&
    (keys.length <= ROSETTA_DYNAMIC_KEY_CAP || keys.every(rosettaSchemaFieldKey))
  ) {
    return sorted;
  }
  let merged;
  let total = 0;
  let hasCounts = true;
  for (const field of Object.values(sorted)) {
    merged = merged === undefined ? structuredClone(field.shape) : mergeRosettaShapes(merged, field.shape);
    if ('observed' in field) total += field.observed;
    else hasCounts = false;
  }
  return { [ROSETTA_DYNAMIC_KEY]: rosettaField(merged ?? { kind: 'unknown' }, true, hasCounts ? total : undefined) };
}

function mergeableRosettaShapes(left, right) {
  return (
    JSON.stringify(left) === JSON.stringify(right) ||
    (left.kind === right.kind && (left.kind === 'object' || left.kind === 'array'))
  );
}

export function mergeRosettaShapes(leftShape, rightShape) {
  const left = structuredClone(leftShape);
  const right = structuredClone(rightShape);
  if (left.kind === 'unknown') return right;
  if (right.kind === 'unknown') return left;
  if (left.kind === 'object' && right.kind === 'object') {
    const leftFields = left.fields ?? {};
    const rightFields = right.fields ?? {};
    const fields = {};
    for (const key of [...new Set([...Object.keys(leftFields), ...Object.keys(rightFields)])].sort()) {
      const first = leftFields[key];
      const second = rightFields[key];
      if (first === undefined || second === undefined) {
        fields[key] = { ...structuredClone(first ?? second), required: false };
        continue;
      }
      const observed = 'observed' in first && 'observed' in second ? first.observed + second.observed : undefined;
      fields[key] = rosettaField(
        mergeRosettaShapes(first.shape, second.shape),
        Boolean(first.required && second.required),
        observed,
      );
    }
    return { kind: 'object', fields: collapseRosettaDynamic(fields) };
  }
  if (left.kind === 'array' && right.kind === 'array') {
    const shape = { kind: 'array' };
    if (left.items !== undefined && right.items !== undefined)
      shape.items = mergeRosettaShapes(left.items, right.items);
    else if (left.items !== undefined || right.items !== undefined)
      shape.items = structuredClone(left.items ?? right.items);
    return shape;
  }
  if (left.kind === 'string' && right.kind === 'string') {
    const shape = { kind: 'string' };
    if (left.values !== undefined && right.values !== undefined) {
      const values = { ...left.values };
      for (const [key, count] of Object.entries(right.values)) values[key] = (values[key] ?? 0) + count;
      if (Object.keys(values).length <= ROSETTA_ENUM_CARDINALITY_CAP)
        shape.values = Object.fromEntries(sortedEntries(values));
    }
    return shape;
  }
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  const variants = [left, right].flatMap((shape) => (shape.kind === 'any_of' ? (shape.variants ?? []) : [shape]));
  const merged = [];
  for (const variant of variants) {
    const index = merged.findIndex((existing) => mergeableRosettaShapes(existing, variant));
    if (index >= 0) merged[index] = mergeRosettaShapes(merged[index], variant);
    else merged.push(variant);
  }
  return merged.length === 1 ? merged[0] : { kind: 'any_of', variants: merged };
}

/**
 * Rebuild each stream's record types from source documents of one release only, merged in Rosetta's evidence order.
 * Returns `Map<streamId, Map<recordType, record>>`.
 */
export function mergeRosettaRecordTypes(documents) {
  const ordered = [...documents].sort(
    (left, right) => ROSETTA_EVIDENCE_STRENGTH[right.evidence] - ROSETTA_EVIDENCE_STRENGTH[left.evidence],
  );
  const streams = new Map();
  for (const document of ordered) {
    for (const stream of document.streams ?? []) {
      const target = streams.get(stream.id) ?? new Map();
      streams.set(stream.id, target);
      for (const [name, record] of Object.entries(stream.record_types ?? {})) {
        const evidence = record.evidence ?? document.evidence;
        const current = target.get(name);
        if (!current) {
          target.set(name, { ...structuredClone(record), evidence });
          continue;
        }
        current.observed += record.observed;
        current.shape = mergeRosettaShapes(current.shape, record.shape);
        if (ROSETTA_EVIDENCE_STRENGTH[evidence] > ROSETTA_EVIDENCE_STRENGTH[current.evidence])
          current.evidence = evidence;
      }
    }
  }
  return streams;
}

/**
 * Scope the cumulative inventory to the pinned release. Every canonical record stays in the inventory (the audit
 * compares it with the canonical one), but its shape, occurrence count and evidence come from the release's own
 * writer/fixture documents. A record no such document carries keeps the canonical shape with no occurrence, so it can
 * only support the contract claim.
 */
export function scopeRosettaInventory(inventory, versionRecords) {
  return inventory.map((item) => {
    if (!item.record) return item;
    const scoped = versionRecords.get(item.stream.id)?.get(item.recordType);
    return {
      ...item,
      record: scoped ?? { ...item.record, observed: 0 },
      versionScoped: true,
      inVersionSources: !!scoped,
    };
  });
}

function recordNotes(item, version) {
  if (!item.record)
    return `${item.stream.glob}; non-record native artifact tracked by the complete Rosetta stream inventory.`;
  if (item.versionScoped && !item.inVersionSources) {
    return `${item.stream.glob}; no ${version} writer or fixture source carries this record; its shape is the cumulative Rosetta inventory's (other releases) and is a contract lead only.`;
  }
  const scope = item.versionScoped ? ` in the ${version} sources` : '';
  return `${item.stream.glob}; ${item.record.observed ?? 0} retained observation(s)${scope}; source evidence: ${item.record.evidence ?? item.stream.evidence}.`;
}

function versionSourceDocuments(canonical, referencesRoot, version) {
  return canonical.sources
    .filter((source) => source.agent_version === version)
    .map((source) => {
      const path = join(referencesRoot, basename(source.path));
      if (!existsSync(path)) throw new Error(`version-scoped model needs the imported Rosetta source ${source.path}`);
      const document = JSON.parse(readFileSync(path, 'utf8'));
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (source.sha256 && digest !== source.sha256)
        throw new Error(`${source.path} does not match its canonical digest`);
      if (document.agent_version !== version || document.evidence !== source.evidence) {
        throw new Error(`${source.path} identity does not match its canonical source entry`);
      }
      return document;
    });
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(imported.importedAt ?? ''))
    throw new Error(`${vendor}@${config.version} import.json has no importedAt date`);
  if (
    canonical.agent !== vendor ||
    canonical.agent_version !== config.version ||
    canonical.data_root !== config.dataRoot
  ) {
    throw new Error(`invalid Rosetta reference identity for ${vendor}@${config.version}`);
  }
  const cumulative = rosettaEventInventory(canonical, config.primaryStream);
  const inventory = config.versionScopedSources
    ? scopeRosettaInventory(
        cumulative,
        mergeRosettaRecordTypes(versionSourceDocuments(canonical, referencesRoot, config.version)),
      )
    : cumulative;
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
    // The model is generated from the import, so it carries the import's date (2026-08-28 for the first imports).
    generatedAt: imported.importedAt,
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
      notes: recordNotes(item, config.version),
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
      {
        id: 'agent-surface-model',
        kind: 'model-tree',
        path: relative(repositoryRoot, modelRoot).replaceAll('\\', '/'),
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
        notes: `Digest-pinned Rosetta record inventory whose occurrence count is non-zero. It proves occurrence; it proves retained shape only for records classified as fixture or observed rather than writer evidence.${config.versionScopedSources ? ` Counts and shapes come from the ${config.version} writer and fixture sources only, not from the cumulative multi-release inventory.` : ''}`,
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
