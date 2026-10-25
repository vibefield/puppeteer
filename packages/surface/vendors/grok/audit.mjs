#!/usr/bin/env node
/** Repo-local audit for the selected Grok candidate surface. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadModel, validateSanitizedPayload } from '@vibefield/puppeteer-surface';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { checkGrokCaptureDirectory } from './privacy.mjs';

const selected = resolveAgentModel({ vendor: 'grok' });
const capturesDir = selected.capturesRoot;
const probesDir = join(selected.vendorRoot, 'probes', `grok@${selected.version}`);
const referencePath = join(selected.vendorRoot, 'references', `grok@${selected.version}`, 'public-source-surface.json');
const model = loadModel(selected.groundTruthPath);
const events = new Map(model.events.map((event) => [event.nativeName ?? event.event, event]));
const problems = [];
let payloads = 0;
let results = 0;
let carriers = 0;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const metadata = readJson(join(capturesDir, 'capture.json'));
if (metadata.schemaVersion !== 2 || metadata.representation !== 'type-preserving-redaction') {
  problems.push('the selected capture set is not a schemaVersion 2 type-preserving redaction');
}

const valueAt = (value, dottedPath) =>
  dottedPath
    .split('.')
    .reduce((current, key) => (current !== null && typeof current === 'object' ? current[key] : undefined), value);
const matches = (payload, match) =>
  Object.entries(match ?? {}).every(([path, expected]) => Object.is(valueAt(payload, path), expected));

function validate(schema, value, location, label) {
  if (!schema) return;
  for (const violation of validateSanitizedPayload(schema, value)) problems.push(`${location} ${label}: ${violation}`);
}

/** Payload, matching refinements, and observed-variant confidence for one native payload. */
function auditPayload(event, params, location) {
  validate(event.payloadSchema, params, location, `${event.event} payload`);
  payloads += 1;
  for (const refinement of event.payloadRefinements ?? []) {
    if (!matches(params, refinement.match)) continue;
    const value = valueAt(params, refinement.path);
    if (value !== undefined) validate(refinement.schema, value, location, `${event.event} refinement`);
  }
  for (const variant of event.variants ?? []) {
    if (matches(params, variant.match) && variant.confidence === 'unverified') {
      problems.push(`${location} ${event.event}: captured variant ${JSON.stringify(variant.match)} is unverified`);
    }
  }
}

function jsonLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line, index) => [line, index + 1])
    .filter(([line]) => line.trim());
}

function auditAcpFrame(value, location, pending) {
  const { direction, message } = value;
  if (direction !== 'agent-to-client' && direction !== 'client-to-agent') {
    problems.push(`${location}: ACP frame without a direction`);
    return;
  }
  if (typeof message?.method !== 'string') {
    const requestDirection = direction === 'agent-to-client' ? 'client-to-agent' : 'agent-to-client';
    const method = pending.get(`${requestDirection}:${message?.id}`);
    if (!method) {
      problems.push(`${location}: result ${String(message?.id)} has no preceding request`);
      return;
    }
    if (message.result !== undefined)
      validate(events.get(method)?.resultSchema, message.result, location, `${method} result`);
    results += 1;
    return;
  }
  const event = events.get(message.method);
  if (!event) {
    problems.push(`${location}: method ${message.method} has no event document`);
    return;
  }
  if (event.direction !== direction) problems.push(`${location}: ${message.method} captured ${direction}`);
  if (!event.channels.includes('acp')) problems.push(`${location}: ${message.method} is not modeled on acp`);
  if (event.recordChannel === 'acp') {
    validate(event.recordSchema, message, location, `${message.method} carrier`);
    carriers += 1;
  }
  if (message.id !== undefined) pending.set(`${direction}:${message.id}`, message.method);
  auditPayload(event, message.params ?? {}, location);
}

function auditNativeRecord(value, file, location) {
  if (typeof value.method !== 'string') {
    problems.push(`${location}: native record without a method`);
    return;
  }
  const event = events.get(value.method);
  if (!event) {
    problems.push(`${location}: ${value.method} has no event document`);
    return;
  }
  if (file === 'state.jsonl') {
    if (!event.channels.includes('session-state')) problems.push(`${location}: ${value.method} is not session state`);
  } else if (event.recordChannel !== 'session-log') {
    problems.push(`${location}: ${value.method} is not modeled on the durable session log`);
  } else {
    validate(event.recordSchema, value, location, `${value.method} durable carrier`);
    carriers += 1;
  }
  auditPayload(event, value.params, location);
}

for (const scenario of metadata.scenarios ?? []) {
  const directory = join(capturesDir, scenario);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    problems.push(`${scenario}: declared scenario directory is missing`);
    continue;
  }
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()) {
    const pending = new Map();
    for (const [line, number] of jsonLines(join(directory, file))) {
      const location = `${scenario}/${file}:${number}`;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        problems.push(`${location} is not valid JSON`);
        continue;
      }
      if (file.startsWith('acp-')) auditAcpFrame(value, location, pending);
      else auditNativeRecord(value, file, location);
    }
  }
}

for (const leak of checkGrokCaptureDirectory(capturesDir)) problems.push(`privacy: ${leak}`);

// Artifact identity binds the evidence index, the census, the probes, and the binary-probe reference.
const evidence = model.evidenceIndex;
if (!evidence) throw new Error('canonical ground truth has no evidence index');
const artifact = readJson(join(probesDir, 'artifact.json'));
const reference = readJson(referencePath);
for (const entry of evidence.artifacts ?? []) {
  const label = entry.id ?? entry.platform ?? 'unnamed artifact';
  if (typeof entry.versionOutput !== 'string' || !entry.versionOutput.includes(selected.version)) {
    problems.push(`${label} version/revision identity drifted`);
  }
  if (entry.integrity?.sha256 !== `sha256:${artifact.sha256}`) problems.push(`${label} digest differs from the probe`);
}
if ((evidence.artifacts ?? []).length === 0) problems.push('artifact evidence is missing');
if (metadata.artifactSha256 !== artifact.sha256) problems.push('census was captured from different artifact bytes');
if (reference.binaryProbe?.artifactSha256 !== artifact.sha256)
  problems.push('binary-probe reference used different bytes');
if (readFileSync(join(probesDir, 'version.txt'), 'utf8').trim() !== model.detection.versionOutput) {
  problems.push('detection versionOutput differs from the probed --version');
}
if (!new RegExp(model.detection.versionPattern).test(model.detection.versionOutput)) {
  problems.push('detection versionPattern rejects the probed version');
}
const help = ['help-long.txt', 'agent-leader-help.txt']
  .map((file) => readFileSync(join(probesDir, file), 'utf8'))
  .join('\n');
for (const value of Object.values(model.detection.launchFlags ?? {})) {
  if (!help.includes(value)) problems.push(`launch flag ${value} is absent from the probed help`);
}

const unpublishedRevision = evidence.sourceReferences?.some(
  (entry) => entry.relation === 'binary-reported-revision-not-present-in-public-mirror',
);
const unpublishedLimitation = evidence.limitations?.some((entry) =>
  entry.includes('absent from the public source mirror'),
);
if (unpublishedRevision && !unpublishedLimitation) problems.push('unpublished source-revision limitation is missing');
if (!unpublishedRevision && unpublishedLimitation) problems.push('unpublished source-revision limitation is stale');
if (unpublishedRevision && evidence.evidencePolicy?.kind !== 'binary-only') {
  problems.push('an unpublished binary revision requires the explicit binary-only evidence policy');
}

// The complete supplemental inventories must be retained, and leads never promoted.
const standard = model.events.find((event) => event.event === 'session/update');
const extension = model.events.find((event) => event.event === '_x.ai/session_notification');
const variantValues = (event) =>
  new Set((event?.variants ?? []).map((variant) => variant.match['update.sessionUpdate']));
for (const value of reference.acpDependencyOfPublicMirror.sessionUpdateValues) {
  if (!variantValues(standard).has(value)) problems.push(`ACP session/update ${value} has no variant`);
}
const leads = reference.binaryProbe.binaryOnlyVariantLeads;
for (const value of [...reference.publicMirror.xaiSessionUpdate.variants.map((entry) => entry.wireName), ...leads]) {
  if (!variantValues(extension).has(value)) problems.push(`xAI ${value} has no _x.ai/session_notification variant`);
}
for (const value of leads) {
  const variant = extension?.variants?.find((entry) => entry.match['update.sessionUpdate'] === value);
  if (variant?.confidence !== 'unverified') problems.push(`binary-only lead ${value} must stay unverified`);
}

if (problems.length > 0) {
  console.error(`${problems.length} Grok surface problem(s):`);
  for (const problem of problems.slice(0, 200)) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `grok@${selected.version} surface audit: clean (${model.events.length} events, ${payloads} payloads, ${results} results, ${carriers} carriers; ${metadata.representation})`,
);
