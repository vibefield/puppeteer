#!/usr/bin/env node
/** Audit the selected Kimi baseline against every committed sanitized capture. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validatePayload } from '@vibefield/puppeteer-surface';
import { checkCaptureDirectory } from '@vibefield/puppeteer-surface/sanitize';
import { buildSourceReference } from './census/extract-source-reference.mjs';
import { hookEvents, hookSchemas, persistedSchemas, transientTypes } from './census/source-contract.mjs';
import { kimiRules } from './sanitize-captures.mjs';

const version = '0.34.0';
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const capturesRoot = join(vendorRoot, 'captures', `kimi@${version}`);
const model = loadModel(vendorRoot);
const sourceReference = JSON.parse(
  readFileSync(join(vendorRoot, 'references', `kimi@${version}`, 'source-contract.json'), 'utf8'),
);
const events = new Map(model.events.map((event) => [event.event, event]));
const capturedPayloads = new Map();
const problems = [];
let records = 0;

function lines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        problems.push(`${path}:${index + 1} is not valid JSON`);
        return undefined;
      }
    })
    .filter(Boolean);
}

function validate(name, payload, record) {
  const descriptor = events.get(name);
  if (!descriptor) return problems.push(`unmodelled native event ${name}`);
  if (descriptor.payloadSchema) {
    for (const failure of validatePayload(descriptor.payloadSchema, payload)) problems.push(`${name}: ${failure}`);
  }
  if (record && descriptor.recordSchema) {
    for (const failure of validatePayload(descriptor.recordSchema, record))
      problems.push(`${name} carrier: ${failure}`);
  }
  const observed = capturedPayloads.get(name) ?? [];
  observed.push(payload);
  capturedPayloads.set(name, observed);
  records += 1;
}

function valueAt(value, dottedPath) {
  return dottedPath
    .split('.')
    .reduce(
      (current, component) => (current !== null && typeof current === 'object' ? current[component] : undefined),
      value,
    );
}

function matches(payload, match) {
  return Object.entries(match).every(([path, expected]) => Object.is(valueAt(payload, path), expected));
}

function sameJson(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${label} differs from its source contract`);
}

function fixtureRecords(descriptor, path) {
  if (descriptor.transport === 'json-file') return [JSON.parse(readFileSync(path, 'utf8'))];
  return lines(path);
}

function fixtureContains(descriptor, recordsFromFixture) {
  if (descriptor.channel === 'wire') return recordsFromFixture.some((entry) => entry.type === descriptor.event);
  if (descriptor.channel === 'hook-command') {
    return recordsFromFixture.some((entry) => entry.hook_event_name === descriptor.event);
  }
  return recordsFromFixture.length > 0;
}

sameJson('persisted source schema projection', sourceReference.wire.payloadSchemas, persistedSchemas);
sameJson('hook source schema projection', sourceReference.hooks.payloadSchemas, hookSchemas);
sameJson('hook source inventory', sourceReference.hooks.events, hookEvents);
sameJson(
  'persisted source inventory',
  sourceReference.wire.persisted.map((entry) => entry.type),
  Object.keys(persistedSchemas),
);
sameJson(
  'transient source inventory',
  sourceReference.wire.transient.map((entry) => entry.type),
  transientTypes,
);
if (
  sourceReference.wire.totalOperationTypes !== 48 ||
  sourceReference.wire.persistedOperationTypes !== 40 ||
  sourceReference.wire.transientOperationTypes !== 8
) {
  problems.push('source operation counts must be 40 persisted + 8 transient = 48 total');
}
for (const [name, schema] of Object.entries(persistedSchemas)) {
  sameJson(`${name} payloadSchema`, events.get(name)?.payloadSchema, schema);
}
for (const [name, schema] of Object.entries(hookSchemas)) {
  sameJson(`${name} payloadSchema`, events.get(name)?.payloadSchema, schema);
}
for (const name of transientTypes) {
  if (events.has(name))
    problems.push(`transient source operation ${name} must not be modelled as a durable wire event`);
}

for (const descriptor of model.events) {
  if (descriptor.confidence.startsWith('verified') && !descriptor.fixture) {
    problems.push(`${descriptor.event}: verified event has no fixture`);
    continue;
  }
  if (!descriptor.fixture) continue;
  const fixture = resolve(vendorRoot, descriptor.fixture);
  if (!fixture.startsWith(`${resolve(vendorRoot)}${sep}`) || !existsSync(fixture)) {
    problems.push(`${descriptor.event}: fixture does not exist within the Kimi vendor root: ${descriptor.fixture}`);
    continue;
  }
  const fixturePayloads = fixtureRecords(descriptor, fixture);
  if (!fixtureContains(descriptor, fixturePayloads)) {
    problems.push(`${descriptor.event}: fixture contains no matching native event: ${descriptor.fixture}`);
  }
}

for (const scenario of readdirSync(capturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)) {
  const root = join(capturesRoot, scenario);
  for (const record of lines(join(root, 'wire.jsonl'))) {
    const { type, time: _time, ...payload } = record;
    validate(String(type), payload, record);
  }
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter((name) => name.endsWith('.jsonl'))) {
      for (const record of lines(join(agentsDir, file))) {
        const { type, time: _time, ...payload } = record;
        validate(String(type), payload, record);
      }
    }
  }
  for (const file of readdirSync(join(root, 'hooks'))) {
    for (const payload of lines(join(root, 'hooks', file))) validate(String(payload.hook_event_name), payload);
  }
  validate('state.json', JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')));
  for (const entry of lines(join(root, 'session-index.jsonl'))) validate('session_index.entry', entry);
}

for (const descriptor of model.events) {
  if ((capturedPayloads.get(descriptor.event)?.length ?? 0) > 0 && !descriptor.confidence.startsWith('verified')) {
    problems.push(`${descriptor.event}: captured event is still marked ${descriptor.confidence}`);
  }
  for (const variant of descriptor.variants ?? []) {
    const observed = (capturedPayloads.get(descriptor.event) ?? []).some((payload) => matches(payload, variant.match));
    if (variant.confidence.startsWith('verified') && !observed) {
      problems.push(`${descriptor.event}: verified variant has no matching capture: ${JSON.stringify(variant.match)}`);
    } else if (!variant.confidence.startsWith('verified') && observed) {
      problems.push(`${descriptor.event}: captured variant remains ${variant.confidence}: ${JSON.stringify(variant.match)}`);
    }
  }
}

for (const issue of checkCaptureDirectory(capturesRoot, kimiRules)) problems.push(`privacy: ${issue}`);

const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex >= 0) {
  const sourceRoot = process.argv[sourceIndex + 1];
  try {
    const rebuilt = buildSourceReference({ sourceRoot: resolve(sourceRoot), retrievedAt: sourceReference.retrievedAt });
    if (JSON.stringify(rebuilt) !== JSON.stringify(sourceReference)) {
      problems.push('tracked source reference differs from the exact checkout (regenerate it)');
    }
  } catch (error) {
    problems.push(`exact source checkout: ${error.message}`);
  }
}

if (problems.length) {
  console.error(`${problems.length} Kimi surface problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`kimi@${version} surface audit: clean (${model.events.length} events, ${records} captured records)`);
