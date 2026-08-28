#!/usr/bin/env node
/**
 * OpenCode census privacy gate: ignored verbatim captures -> committed,
 * shape-faithful fixtures. The output is staged and checked before replacing
 * the destination, so a partial or unsafe fixture set never lands there.
 *
 * JSONL carriers are promoted. OpenAPI documents and process logs remain raw:
 * the former is generated-schema evidence handled separately, and the latter
 * is diagnostic prose rather than a replay fixture.
 *
 * usage:
 *   node sanitize.mjs --version 1.18.16
 *   node sanitize.mjs --version 1.18.16 --check-only
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeCaptureDirectory } from '@vibecook/puppeteer-surface/sanitize';
import { writeCaptureFidelity } from '../../../scripts/capture-fidelity.mjs';
import { opencodeRules } from '../privacy.mjs';

const surfaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const version = flag('--version') ?? process.env.PUPPETEER_OPENCODE_VERSION;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('--version <semver> is required');
  }
  const input = resolve(flag('--in') ?? join(surfaceRoot, 'captures-raw', `opencode@${version}`));
  const output = resolve(flag('--out') ?? join(surfaceRoot, 'captures', `opencode@${version}`));

  if (argv.includes('--check-only')) {
    const issues = checkCaptureDirectory(output, opencodeRules);
    for (const issue of issues.slice(0, 20)) console.error(issue);
    console.log(issues.length === 0 ? `clean: ${output}` : `${issues.length} issue(s) in ${output}`);
    process.exit(issues.length === 0 ? 0 : 1);
  }

  const staging = `${output}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const result = sanitizeCaptureDirectory(input, staging, opencodeRules);
  writeCaptureFidelity(staging, {
    vendor: 'opencode',
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['*/*.jsonl'],
    limitations: [
      'Only JSONL protocol carriers are promoted; raw process logs and the generated OpenAPI document remain separate evidence.',
      'Sensitive scalar values are replaced in place while native keys, containers, primitive types, record order, and stable joins are retained.',
    ],
  });
  const issues = checkCaptureDirectory(staging, opencodeRules);
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 20)) console.error(issue);
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`${issues.length} privacy issue(s); nothing was promoted`);
  }

  writeFileSync(
    join(staging, 'SANITIZATION.md'),
    [
      '# OpenCode capture sanitization',
      '',
      `These fixtures were captured from OpenCode ${version} with the hermetic fake-provider census.`,
      'Native identifiers are stable pseudonyms; paths, clocks, prompts, model output, tool input/output,',
      'question text, answers, and permission patterns are redacted. Protocol enums, payload structure,',
      'ordering, and cross-record identity joins are preserved.',
      '',
      'Only JSONL protocol carriers are promoted. Raw logs and the generated OpenAPI document remain',
      'gitignored and are not part of this fixture set.',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  rmSync(output, { recursive: true, force: true });
  mkdirSync(dirname(output), { recursive: true });
  renameSync(staging, output);
  console.log(`sanitized ${result.files} file(s), ${result.lines} line(s) -> ${output}`);
  console.log('privacy check: clean');
}

export { opencodeRules };
