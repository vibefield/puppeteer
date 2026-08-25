#!/usr/bin/env node
/** Resolve versioned Surface inputs from the one support ledger pointer. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function insideRepo(repoRoot, path) {
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(`${resolve(repoRoot)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

/**
 * `active` intentionally prefers a candidate: vendor-local audits, checked
 * adapter projections, and Imposter personas must exercise the version under
 * review. This may broaden compatibility code before promotion, but public
 * support continues to mean `currentManifest` and changes only through the
 * protected promotion transaction.
 */
export function resolveAgentModel({ repoRoot = root, vendor, selection = 'active' } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('vendor is required and must be normalized');
  if (!['active', 'current', 'candidate'].includes(selection)) {
    throw new Error(`unsupported Surface selection ${selection}`);
  }
  const ledgerPath = join(repoRoot, 'support', 'agents.json');
  const ledger = json(ledgerPath);
  const agent = ledger.agents?.find((entry) => entry.id === vendor);
  if (!agent) throw new Error(`support ledger has no ${vendor} entry`);
  const manifestRelative =
    selection === 'candidate'
      ? agent.candidateManifest
      : selection === 'current'
        ? agent.currentManifest
        : (agent.candidateManifest ?? agent.currentManifest);
  if (!manifestRelative) throw new Error(`${vendor} has no ${selection} Surface manifest`);
  const manifestPath = insideRepo(repoRoot, manifestRelative);
  if (!existsSync(manifestPath)) throw new Error(`${vendor} Surface manifest does not exist: ${manifestRelative}`);
  const manifest = json(manifestPath);
  if (manifest.vendor !== vendor || typeof manifest.vendorVersion !== 'string') {
    throw new Error(`${manifestRelative} does not identify ${vendor}`);
  }
  const modelRoot = dirname(manifestPath);
  if (modelRoot.split(sep).at(-1) !== `${vendor}@${manifest.vendorVersion}`) {
    throw new Error(`${manifestRelative} directory does not match its vendor/version identity`);
  }
  const canonicalManifest = join(
    repoRoot,
    'packages',
    'surface',
    'vendors',
    vendor,
    'model',
    `${vendor}@${manifest.vendorVersion}`,
    'manifest.json',
  );
  if (manifestPath !== canonicalManifest) {
    throw new Error(`${manifestRelative} is not the canonical ${vendor} Surface manifest path`);
  }
  const surfaceRoot = join(repoRoot, 'packages', 'surface');
  const capturesRoot = join(surfaceRoot, 'vendors', vendor, 'captures', `${vendor}@${manifest.vendorVersion}`);
  return {
    agent,
    manifest,
    version: manifest.vendorVersion,
    manifestPath,
    manifestRelative: relative(repoRoot, manifestPath).split(sep).join('/'),
    modelRoot,
    capturesRoot,
    surfaceRoot,
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const selected = resolveAgentModel({
    vendor: flag('--vendor'),
    selection: flag('--selection') ?? 'active',
  });
  const field = flag('--field') ?? 'manifestRelative';
  if (!(field in selected) || typeof selected[field] === 'object') throw new Error(`unsupported output field ${field}`);
  process.stdout.write(`${selected[field]}\n`);
}
