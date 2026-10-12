import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packReleasePackages } from './release-packages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = mkdtempSync(join(tmpdir(), 'puppeteer-packs-'));
try {
  const packed = packReleasePackages(root, destination);
  console.log(`Validated ${packed.length} public package tarballs`);
} finally {
  rmSync(destination, { recursive: true, force: true });
}
