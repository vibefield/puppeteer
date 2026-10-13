import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packReleasePackages } from './release-packages.mjs';
import { assertConsumerNpmVersion, verifyPublishedPackages } from './verify-published-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== '--consumer')) {
  throw new Error('Usage: node scripts/pack-check.mjs [--consumer]');
}
const consumer = args.includes('--consumer');
if (consumer) assertConsumerNpmVersion();
const destination = mkdtempSync(join(tmpdir(), 'puppeteer-packs-'));
try {
  const packed = packReleasePackages(root, destination);
  console.log(`Validated ${packed.length} public package tarballs`);
  if (consumer) verifyPublishedPackages({ root, tarballs: packed });
} finally {
  rmSync(destination, { recursive: true, force: true });
}
