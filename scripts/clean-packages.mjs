#!/usr/bin/env node
/** Remove only known generated package output; never touch dependencies or unknown paths. */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesRoot = join(root, 'packages');
const dryRun = process.argv.includes('--dry-run');
const targets = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, 'package.json')))
  .map((entry) => join(packagesRoot, entry.name, 'dist'))
  .filter((path) => existsSync(path));

for (const target of targets) {
  if (lstatSync(target).isSymbolicLink()) throw new Error(`refusing to clean symlink: ${target}`);
  console.log(`${dryRun ? 'would remove' : 'removed'} ${target}`);
  if (!dryRun) rmSync(target, { recursive: true, force: true });
}
if (targets.length === 0) console.log('package clean: no generated dist directories');
