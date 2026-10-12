#!/usr/bin/env node
/**
 * Hermes capture privacy gate: captures-raw -> committed captures.
 *
 * SchemaVersion 2 preserves every native key, container, and JSON type while
 * redacting sensitive values. The retained 0.20.0 schemaVersion 1 fixtures are
 * legacy projections and must never be treated as native payload schemas.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { VERSION } from './census/harness.mjs';
import { hermesRules } from './privacy.mjs';
import { writeCaptureFidelity } from '../../scripts/capture-fidelity.mjs';

const vendorRoot = dirname(fileURLToPath(import.meta.url));

function parseJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${path}:${index + 1} is not valid JSON`);
      }
    });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitizeRecord(value, hermesRules), null, 2)}\n`);
}

function writeJsonLines(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(sanitizeRecord(record, hermesRules))).join('\n')}\n`);
}

export function sanitizeHermesCaptureSet(input, output, version = VERSION) {
  const scenarios = readdirSync(input, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (scenarios.length === 0) throw new Error(`no Hermes scenarios in ${input}`);
  mkdirSync(output, { recursive: true });

  for (const scenario of scenarios) {
    const source = join(input, scenario.name);
    const destination = join(output, scenario.name);
    for (const name of [
      'rpc.jsonl',
      'provider-requests.jsonl',
      'webhooks.jsonl',
      'plugin-hooks.jsonl',
      'follow-ups.jsonl',
    ]) {
      const path = join(source, name);
      if (existsSync(path)) writeJsonLines(join(destination, name), parseJsonLines(path));
    }
    if (existsSync(join(source, 'session.json'))) {
      writeJson(join(destination, 'session.json'), JSON.parse(readFileSync(join(source, 'session.json'), 'utf8')));
    }
    writeJson(join(destination, 'capture.json'), {
      schemaVersion: 2,
      representation: 'type-preserving-redaction',
      vendor: 'hermes',
      version,
      scenario: scenario.name,
      mode: 'tui-gateway-stdio-hermetic',
    });
  }
  writeCaptureFidelity(output, {
    vendor: 'hermes',
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*/*.jsonl', '*/session.json', '*/capture.json'],
    limitations: [
      'Native gateway, hook, webhook, provider, and session JSON records retain all keys, containers, primitive types, and record order while sensitive scalar values are redacted in place.',
    ],
  });
  return { scenarios: scenarios.length };
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const version = flag('--version', VERSION);
  const input = resolve(flag('--input', join(vendorRoot, 'captures-raw', `hermes@${version}`)));
  const output = resolve(flag('--output', join(vendorRoot, 'captures', `hermes@${version}`)));

  if (process.argv.includes('--check')) {
    const issues = checkCaptureDirectory(output, hermesRules);
    for (const issue of issues.slice(0, 20)) console.error(issue);
    console.log(issues.length === 0 ? `clean: ${output}` : `${issues.length} issue(s) in ${output}`);
    process.exit(issues.length === 0 ? 0 : 1);
  }

  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`raw capture directory missing: ${input}`);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const result = sanitizeHermesCaptureSet(input, staging, version);
  const issues = checkCaptureDirectory(staging, hermesRules);
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 20)) console.error(issue);
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); committed captures were not replaced`);
  }
  const sanitizationNote = join(output, 'SANITIZATION.md');
  const sanitizationText = existsSync(sanitizationNote) ? readFileSync(sanitizationNote, 'utf8') : '';
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  if (sanitizationText) writeFileSync(join(output, 'SANITIZATION.md'), sanitizationText);
  console.log(`sanitized ${result.scenarios} Hermes scenario(s) -> ${output}`);
  console.log('privacy check: clean');
}
