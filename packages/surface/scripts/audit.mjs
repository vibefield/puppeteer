#!/usr/bin/env node
/** Run every vendor-owned Surface audit from one stable package entrypoint. */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditEvidence } from './check-evidence.mjs';
import { checkGroundTruth, discoverGroundTruthRoots } from './groundtruth.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorsRoot = join(packageRoot, 'vendors');
const vendors = readdirSync(vendorsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(vendorsRoot, entry.name, 'audit.mjs')))
  .map((entry) => entry.name)
  .sort();

const evidenceIssues = auditEvidence();
if (evidenceIssues.length > 0) {
  console.error('surface evidence is stale or malformed:');
  for (const issue of evidenceIssues) console.error(`  - ${issue}`);
  process.exit(1);
}

const groundTruthIssues = checkGroundTruth();
if (groundTruthIssues.length > 0) {
  console.error('surface ground truth is stale or malformed:');
  for (const issue of groundTruthIssues) console.error(`  - ${issue}`);
  console.error('run `pnpm surface:groundtruth:write` to rebuild canonical JSON and HTML');
  process.exit(1);
}
console.log(`surface ground truth: ${discoverGroundTruthRoots().length} canonical agents clean`);

if (vendors.length === 0) {
  console.error('surface audit: no vendor audits found');
  process.exit(1);
}

for (const vendor of vendors) {
  console.log(`\n== ${vendor} ==`);
  const result = spawnSync(process.execPath, [join(vendorsRoot, vendor, 'audit.mjs'), ...process.argv.slice(2)], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`surface audit: ${vendor} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nsurface audit: ${vendors.length} vendor surfaces clean`);
