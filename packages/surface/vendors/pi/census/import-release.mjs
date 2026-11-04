#!/usr/bin/env node
/** Import native journals only after checking their recorded release identity against the complete bundle. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseBundle } from '../../../../../scripts/lib/release-bundle.mjs';
import { runRosettaCaptureSanitizer } from '../../../scripts/sanitize-rosetta-captures.mjs';
import { piRules } from '../privacy.mjs';
import { bindReleaseCapture } from './release-evidence.mjs';

const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--input') || !process.argv.includes('--bundle'))
  throw new Error('--input and --bundle are required');
const input = resolve(flag('--input'));
const bundle = resolve(flag('--bundle'));
const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const receipt = JSON.parse(readFileSync(join(input, 'release-capture.json'), 'utf8'));
bindReleaseCapture({ vendor: 'pi', vendorVersion: '1.5.0', artifacts: [], claims: [] }, receipt);
const upstream = JSON.parse(readFileSync(join(vendorRoot, 'upstream.json'), 'utf8'));
const spec = upstream.acquisition.artifacts[receipt.platform];
const { manifest } = verifyReleaseBundle(bundle, {
  vendor: 'pi',
  version: '1.5.0',
  platform: receipt.platform,
  policy: spec.bundle,
  format: spec.format,
});
if (
  `sha256:${createHash('sha256').update(readFileSync(bundle)).digest('hex')}` !== receipt.artifactSha256 ||
  manifest.tree.entrySha256 !== receipt.entrySha256
)
  throw new Error('capture receipt does not identify the verified release bundle');
const output = runRosettaCaptureSanitizer({ vendor: 'pi', vendorRoot, rules: piRules, argv: ['--input', input] });
writeFileSync(join(output, 'release-capture.json'), `${JSON.stringify(receipt, null, 2)}\n`);
writeFileSync(
  join(output, 'capture.json'),
  `${JSON.stringify({ schemaVersion: 2, representation: 'type-preserving-redaction', vendor: 'pi', vendorVersion: '1.5.0', mode: 'controlled-release-native-journals', scenarios: receipt.scenarios }, null, 2)}\n`,
);
