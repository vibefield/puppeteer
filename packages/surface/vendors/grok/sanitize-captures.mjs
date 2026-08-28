#!/usr/bin/env node
/** Grok capture privacy gate: preserve complete native JSON shape. */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeRecord } from '@vibecook/puppeteer-surface/sanitize';
import { grokRules } from './privacy.mjs';
import { writeCaptureFidelity } from '../../scripts/capture-fidelity.mjs';

const VERSION = '1.0.0';
const vendorRoot = dirname(fileURLToPath(import.meta.url));

function parseJsonLines(path) {
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

export function sanitizeGrokCaptureSet(input, output, version = VERSION) {
  mkdirSync(output, { recursive: true });
  let records = 0;
  for (const name of readdirSync(input)
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort()) {
    const values = parseJsonLines(join(input, name));
    writeFileSync(
      join(output, name),
      `${values.map((value) => JSON.stringify(sanitizeRecord(value, grokRules))).join('\n')}\n`,
    );
    records += values.length;
  }
  writeFileSync(
    join(output, 'capture.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        representation: 'type-preserving-redaction',
        vendor: 'grok',
        vendorVersion: version,
        mode: 'controlled-acp-state-census',
      },
      null,
      2,
    )}\n`,
  );
  writeCaptureFidelity(output, {
    vendor: 'grok',
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*.jsonl', 'capture.json'],
    limitations: [
      'ACP and xAI JSON records retain all native keys, containers, primitive types, and record ordering while sensitive scalar values are redacted in place.',
    ],
  });
  return { files: readdirSync(output).filter((name) => name.endsWith('.jsonl')).length, records };
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const version = flag('--version', VERSION);
  const input = resolve(flag('--input', join(vendorRoot, 'captures-raw', `grok@${version}`)));
  const output = resolve(flag('--output', join(vendorRoot, 'captures', `grok@${version}`)));
  if (process.argv.includes('--check')) {
    const issues = existsSync(output) ? checkCaptureDirectory(output, grokRules) : ['captures directory missing'];
    for (const issue of issues.slice(0, 20)) console.error(issue);
    console.log(issues.length === 0 ? `clean: ${output}` : `${issues.length} issue(s) in ${output}`);
    process.exit(issues.length === 0 ? 0 : 1);
  }
  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`raw capture directory missing: ${input}`);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const result = sanitizeGrokCaptureSet(input, staging, version);
  const issues = checkCaptureDirectory(staging, grokRules);
  if (issues.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); committed captures were not replaced`);
  }
  const note = existsSync(join(output, 'SANITIZATION.md')) ? readFileSync(join(output, 'SANITIZATION.md'), 'utf8') : '';
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  if (note) writeFileSync(join(output, 'SANITIZATION.md'), note);
  console.log(`sanitized ${result.records} Grok records across ${result.files} files -> ${output}`);
}
