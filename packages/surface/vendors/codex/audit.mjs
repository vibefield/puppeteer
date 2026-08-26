#!/usr/bin/env node
/**
 * The codex surface audit (docs/archive/EMULATOR.md §7, ADAPTING-AN-AGENT step 6).
 *
 * Three checks, in increasing order of what they can catch:
 *
 *  1. **Model vs captures** — every schema marked `verified-*` must actually
 *     accept the capture it cites. This is the check that would have caught the
 *     adapter reading `item.output` when the wire says `aggregatedOutput`.
 *  2. **Privacy** — the committed fixtures must survive the sanitiser's
 *     detector. Runs on every invocation, because a leak is the one failure
 *     that cannot be undone after a push.
 *  3. **Model vs vendor schema** — drift. Needs the `codex` binary, so it is
 *     skipped (loudly, never silently) when the binary is absent; CI without
 *     codex still gets checks 1 and 2.
 *
 * Check 3 is the reconciliation lane: codex ships ~2 alpha tags a day and the
 * measured churn is additive (+6 methods, 0 removed over 9 days, C1b), so new
 * methods are expected and REMOVED ones are the alarm.
 *
 * usage: node audit.mjs [--schema <dir>]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModel, validatePayload } from '@vibecook/puppeteer-surface';
import { checkCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { resolveAgentModel } from '../../../../scripts/agent-model-selection.mjs';
import { codexRules } from './census/sanitize.mjs';

const selected = resolveAgentModel({ vendor: 'codex' });
const modelDir = selected.modelRoot;
const capturesDir = selected.capturesRoot;

const problems = [];
const notes = [];

// ---------------------------------------------------------------------------
// 1. Model vs captures
// ---------------------------------------------------------------------------

const model = loadModel(selected.groundTruthPath);
const schemas = new Map(model.events.map((event) => [event.event, event.payloadSchema]));
const resultSchemas = new Map(model.events.map((event) => [event.event, event.resultSchema]));
const recordSchemas = new Map(model.events.map((event) => [event.event, event.recordSchema]));
let checkedLines = 0;

for (const file of readdirSync(capturesDir).filter((name) => name.endsWith('.jsonl'))) {
  const lines = readFileSync(join(capturesDir, file), 'utf8').split('\n');
  const pending = new Map();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let message;
    try {
      const record = JSON.parse(line);
      message = record?.message && typeof record.message === 'object' ? record.message : record;
      message.captureDirection = record?.direction;
    } catch {
      problems.push(`${file}:${index + 1} is not valid JSON`);
      continue;
    }
    if (message.captureDirection && message.id !== undefined && message.result !== undefined) {
      const requestDirection =
        message.captureDirection === 'agent-to-client' ? 'client-to-agent' : 'agent-to-client';
      const method = pending.get(`${requestDirection}:${String(message.id)}`);
      const schema = method && resultSchemas.get(method);
      if (method && schema) {
        const violations = validatePayload(schema, message.result);
        if (violations.length > 0) {
          problems.push(`${file}:${index + 1} ${method} result: ${violations.join('; ')}`);
        }
        checkedLines += 1;
      }
      continue;
    }
    if (typeof message.method !== 'string') continue;
    if (!schemas.has(message.method)) {
      // A method on the wire that the model has never heard of is exactly the
      // drift the ASM exists to surface (C1b finding 3: the runtime surface is
      // wider than the documented one).
      problems.push(`${file}:${index + 1} method "${message.method}" has no event document`);
      continue;
    }
    const schema = schemas.get(message.method);
    if (!schema || message.params === undefined) continue;
    const violations = validatePayload(schema, message.params);
    if (violations.length > 0) {
      problems.push(`${file}:${index + 1} ${message.method}: ${violations.join('; ')}`);
    }
    const recordSchema = recordSchemas.get(message.method);
    if (recordSchema) {
      const recordViolations = validatePayload(recordSchema, message);
      if (recordViolations.length > 0) {
        problems.push(`${file}:${index + 1} ${message.method} carrier: ${recordViolations.join('; ')}`);
      }
    }
    checkedLines += 1;
    if (message.captureDirection && message.id !== undefined) {
      pending.set(`${message.captureDirection}:${String(message.id)}`, message.method);
    }
  }
}
notes.push(`model vs captures: ${checkedLines} payload(s) validated`);

// ---------------------------------------------------------------------------
// 2. Privacy
// ---------------------------------------------------------------------------

const leaks = checkCaptureDirectory(capturesDir, codexRules);
for (const leak of leaks) problems.push(`privacy: ${leak}`);
notes.push(`privacy: ${leaks.length === 0 ? 'clean' : `${leaks.length} issue(s)`}`);

// ---------------------------------------------------------------------------
// 3. Model vs vendor schema
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const schemaFlagIndex = argv.indexOf('--schema');
let schemaDir = schemaFlagIndex >= 0 ? argv[schemaFlagIndex + 1] : undefined;
let temporary;
if (!schemaDir) {
  try {
    temporary = mkdtempSync(join(tmpdir(), 'codex-audit-schema-'));
    execFileSync(process.env.PUPPETEER_CODEX_BIN ?? 'codex', ['app-server', 'generate-json-schema', '--experimental', '--out', temporary], {
      stdio: 'ignore',
    });
    schemaDir = temporary;
  } catch {
    rmSync(temporary ?? '', { recursive: true, force: true });
    schemaDir = undefined;
  }
}

if (!schemaDir) {
  notes.push('model vs vendor schema: SKIPPED (no codex binary — drift is unchecked in this run)');
} else {
  const methodsOf = (file) =>
    new Set(
      (JSON.parse(readFileSync(join(schemaDir, file), 'utf8')).oneOf ?? [])
        .map((variant) => variant.properties?.method?.enum?.[0])
        .filter((method) => typeof method === 'string'),
    );
  const vendor = new Set([
    ...methodsOf('ServerNotification.json'),
    ...methodsOf('ServerRequest.json'),
    ...methodsOf('ClientNotification.json'),
    ...methodsOf('ClientRequest.json'),
  ]);
  const modelled = new Set(schemas.keys());
  const added = [...vendor].filter((method) => !modelled.has(method)).sort();
  const removed = [...modelled].filter((method) => !vendor.has(method)).sort();
  // Additive churn is this vendor's normal; a method the model has and the
  // vendor no longer does means the model is describing something that is gone.
  for (const method of removed) problems.push(`drift: "${method}" is modelled but absent from the vendor schema`);
  if (added.length > 0) problems.push(`drift: ${added.length} new vendor method(s) not modelled: ${added.join(', ')}`);
  notes.push(`model vs vendor schema: ${vendor.size} vendor method(s), ${added.length} added, ${removed.length} removed`);
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

for (const note of notes) console.log(`  ${note}`);
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`\ncodex@${selected.version} surface audit: clean (${model.events.length} events)`);
