/** Privacy-check and optional generic sanitization entry point for Rosetta-backed vendors. */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkCaptureDirectory, sanitizeCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { writeCaptureFidelity } from './capture-fidelity.mjs';
import { rosettaAgentConfig } from './rosetta-agents.mjs';

export function runRosettaCaptureSanitizer({ vendor, vendorRoot, rules, argv = process.argv.slice(2) }) {
  const config = rosettaAgentConfig(vendor);
  const output = join(vendorRoot, 'captures', `${vendor}@${config.version}`);
  if (argv.includes('--check')) {
    const issues = existsSync(output) ? checkCaptureDirectory(output, rules) : ['captures directory missing'];
    for (const issue of issues.slice(0, 20)) console.error(issue);
    if (issues.length) throw new Error(`${issues.length} privacy issue(s) in ${output}`);
    console.log(`${vendor}@${config.version} sanitized captures: clean`);
    return output;
  }
  const inputIndex = argv.indexOf('--input');
  if (inputIndex < 0 || !argv[inputIndex + 1]) {
    throw new Error('sanitizing new evidence requires --input <raw-capture-directory>');
  }
  const input = resolve(argv[inputIndex + 1]);
  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const result = sanitizeCaptureDirectory(input, staging, rules);
  writeFileSync(
    join(staging, 'capture.json'),
    `${JSON.stringify({ schemaVersion: 2, representation: 'type-preserving-redaction', vendor, vendorVersion: config.version, mode: 'maintainer-supplied-native-journals' }, null, 2)}\n`,
  );
  writeCaptureFidelity(staging, {
    vendor,
    vendorVersion: config.version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['**/*.jsonl'],
    limitations: [
      'Native JSONL keys, containers, primitive types, and ordering are retained while sensitive scalar values are redacted in place.',
    ],
  });
  const issues = checkCaptureDirectory(staging, rules);
  if (issues.length) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); captures were not replaced`);
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  console.log(`sanitized ${result.lines} records across ${result.files} files -> ${output}`);
  return output;
}
