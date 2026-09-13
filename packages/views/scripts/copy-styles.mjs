#!/usr/bin/env node
// tsc emits no stylesheets. The package ships its CSS beside the compiled
// modules at the same relative paths, so the `publishConfig` exports resolve
// in dist exactly as the source exports resolve in src.
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, 'src');
const target = join(packageRoot, 'dist');

function visit(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      visit(path);
      continue;
    }
    if (!entry.endsWith('.css')) continue;
    const destination = join(target, relative(source, path));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(path, destination);
  }
}

visit(source);
