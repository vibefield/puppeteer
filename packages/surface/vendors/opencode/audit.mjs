#!/usr/bin/env node
/** Audit the pinned OpenCode ASM against sanitized carriers and `/doc`. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory, defaultRules } from '@vibecook/puppeteer-surface/sanitize';
import { digestTree } from '../../scripts/check-evidence.mjs';
import { opencodeRules } from './privacy.mjs';

const VERSION = '1.18.16';
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(vendorRoot, '../../../..');
const modelDir = join(vendorRoot, 'model', `opencode@${VERSION}`);
const capturesDir = join(vendorRoot, 'captures', `opencode@${VERSION}`);
const probesDir = join(vendorRoot, 'probes', `opencode@${VERSION}`);
const generator = join(vendorRoot, 'census', 'generate-model.mjs');
const behavior = join(vendorRoot, 'census', 'behavior.seed.json');
const rawSchema = join(vendorRoot, 'captures-raw', `opencode@${VERSION}`, 'turn', 'openapi.json');
const argv = process.argv.slice(2);
const schemaIndex = argv.indexOf('--schema');
const schemaPath = schemaIndex >= 0 ? resolve(argv[schemaIndex + 1]) : existsSync(rawSchema) ? rawSchema : undefined;
const problems = [];
const notes = [];

function records(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => ({ line: index + 1, value: JSON.parse(line) }));
}

function validate(label, schema, payload) {
  if (!schema) {
    problems.push(`${label}: model has no schema`);
    return;
  }
  for (const violation of validatePayload(schema, payload)) problems.push(`${label}: ${violation}`);
}

function routeKey(value) {
  return `${value?.method} ${value?.route}`;
}

function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(current, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [{ path, name: relative(root, path).split(sep).join('/') }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function compareTrees(expected, actual, label) {
  const expectedFiles = filesUnder(expected);
  const actualFiles = filesUnder(actual);
  const expectedNames = expectedFiles.map((file) => file.name);
  const actualNames = actualFiles.map((file) => file.name);
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    problems.push(`${label}: file set differs from regenerated schema projection`);
    return;
  }
  for (let index = 0; index < expectedFiles.length; index += 1) {
    if (!readFileSync(expectedFiles[index].path).equals(readFileSync(actualFiles[index].path))) {
      problems.push(`${label}: ${expectedFiles[index].name} differs from regenerated schema projection`);
    }
  }
}

const model = loadModel(modelDir);
if (model.manifest.vendor !== 'opencode' || model.manifest.vendorVersion !== VERSION) {
  problems.push('model identity does not match opencode@1.18.16');
}
const sse = new Map(model.events.filter((event) => event.channel === 'sse').map((event) => [event.event, event]));
const http = new Map();
for (const event of model.events.filter((entry) => entry.channel === 'http')) {
  const request = event.recordSchema?.properties?.request;
  const method = request?.properties?.method?.enum?.[0];
  const route = request?.properties?.route?.enum?.[0];
  if (typeof method !== 'string' || typeof route !== 'string') {
    problems.push(`${event.event}: HTTP record schema has no exact method/route`);
    continue;
  }
  const key = `${method} ${route}`;
  if (http.has(key)) problems.push(`${event.event}: duplicate HTTP carrier ${key}`);
  http.set(key, event);
}

let sseLines = 0;
let requestLines = 0;
let responseLines = 0;
for (const scenario of readdirSync(capturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()) {
  for (const { line, value } of records(join(capturesDir, scenario, 'events.jsonl'))) {
    const event = sse.get(value.type);
    if (!event) {
      problems.push(`${scenario}/events.jsonl:${line}: unknown SSE event ${String(value.type)}`);
      continue;
    }
    validate(`${scenario}/events.jsonl:${line} ${value.type} payload`, event.payloadSchema, value.properties);
    validate(`${scenario}/events.jsonl:${line} ${value.type} carrier`, event.recordSchema, value);
    sseLines += 1;
  }

  const pending = new Map();
  for (const { line, value } of records(join(capturesDir, scenario, 'http-roundtrip.jsonl'))) {
    if (value.request) {
      const key = routeKey(value.request);
      const event = http.get(key);
      if (!event) {
        problems.push(`${scenario}/http-roundtrip.jsonl:${line}: unknown HTTP request ${key}`);
        continue;
      }
      validate(`${scenario}/http-roundtrip.jsonl:${line} ${event.event} payload`, event.payloadSchema, value.request);
      validate(`${scenario}/http-roundtrip.jsonl:${line} ${event.event} carrier`, event.recordSchema, value);
      const correlation = `${key} ${JSON.stringify(value.request.params ?? {})}`;
      pending.set(correlation, (pending.get(correlation) ?? 0) + 1);
      requestLines += 1;
    } else if (value.response) {
      const key = routeKey(value.response);
      const event = http.get(key);
      if (!event) {
        problems.push(`${scenario}/http-roundtrip.jsonl:${line}: unknown HTTP response ${key}`);
        continue;
      }
      const correlation = `${key} ${JSON.stringify(value.response.params ?? {})}`;
      const count = pending.get(correlation) ?? 0;
      if (count === 0) problems.push(`${scenario}/http-roundtrip.jsonl:${line}: orphan HTTP response ${key}`);
      else pending.set(correlation, count - 1);
      validate(`${scenario}/http-roundtrip.jsonl:${line} ${event.event} result`, event.resultSchema, value.response);
      responseLines += 1;
    }
  }
  for (const [correlation, count] of pending) {
    if (count > 0) problems.push(`${scenario}/http-roundtrip.jsonl: ${count} request(s) lack a result: ${correlation}`);
  }
}
notes.push(`model vs captures: ${sseLines} SSE, ${requestLines} HTTP request, ${responseLines} HTTP result carrier(s)`);

for (const [name, rules] of [
  ['vendor', opencodeRules],
  ['shared', defaultRules],
]) {
  const leaks = checkCaptureDirectory(capturesDir, rules);
  for (const leak of leaks) problems.push(`privacy (${name}): ${leak}`);
  notes.push(`privacy (${name}): ${leaks.length === 0 ? 'clean' : `${leaks.length} issue(s)`}`);
}

const evidence = model.evidenceIndex;
if (!evidence) throw new Error('canonical ground truth has no evidence index');
for (const record of evidence.records ?? []) {
  const path = resolve(repoRoot, record.path ?? '');
  if (!existsSync(path)) {
    problems.push(`evidence ${record.id}: missing ${record.path}`);
    continue;
  }
  const digest = digestTree(path, record.exclude ?? []);
  if (digest !== record.sha256) problems.push(`evidence ${record.id}: digest mismatch`);
}
const artifact = JSON.parse(readFileSync(join(probesDir, 'artifact.json'), 'utf8'));
const evidenceArtifact = evidence.artifacts?.[0];
if (evidenceArtifact?.integrity?.sha256 !== `sha256:${artifact.sha256}`) {
  problems.push('evidence artifact SHA-256 does not match the binary probe');
}
if (evidenceArtifact?.sourceRevision !== artifact.sourceRevision) {
  problems.push('evidence source revision does not match the binary probe');
}
notes.push(`evidence: ${evidence.records?.length ?? 0} digest-pinned record(s)`);

if (!schemaPath) {
  notes.push('model vs /doc: SKIPPED (pass --schema or retain a raw pinned census OpenAPI document)');
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'opencode-model-audit-'));
  const regenerated = join(temporary, `opencode@${VERSION}`);
  try {
    execFileSync(
      process.execPath,
      [
        generator,
        '--version',
        VERSION,
        '--schema',
        schemaPath,
        '--captures',
        capturesDir,
        '--probes',
        probesDir,
        '--behavior',
        behavior,
        '--out',
        regenerated,
        '--no-evidence',
      ],
      { stdio: 'ignore' },
    );
    compareTrees(join(modelDir, 'events'), join(regenerated, 'events'), 'model vs /doc');
    notes.push(`model vs /doc: regenerated ${model.events.length} event document(s)`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

for (const note of notes) console.log(`  ${note}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 60)) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`\nopencode@${VERSION} surface audit: clean (${model.events.length} events)`);
