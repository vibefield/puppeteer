#!/usr/bin/env node
/** Resolve versioned authoring inputs from one stable per-agent ground-truth document. */
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

/** Resolve and validate the only legal canonical path for one Surface vendor. */
export function resolveCanonicalGroundTruth({ repoRoot = root, vendor, groundTruthPath } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('vendor is required and must be normalized');
  const expectedRelative = `packages/surface/vendors/${vendor}/groundtruth.json`;
  const groundTruthRelative = groundTruthPath ?? expectedRelative;
  const absolute = insideRepo(repoRoot, groundTruthRelative);
  const expected = resolve(repoRoot, expectedRelative);
  if (absolute !== expected) {
    throw new Error(`${groundTruthRelative} is not the canonical ${vendor} Surface ground-truth path`);
  }
  if (!existsSync(absolute)) throw new Error(`${vendor} Surface ground truth does not exist: ${groundTruthRelative}`);
  const document = json(absolute);
  const manifest = document.manifest;
  if (!manifest || document.format !== 'puppeteer-groundtruth/1') {
    throw new Error(`${groundTruthRelative} is not a canonical Surface ground-truth document`);
  }
  if (manifest.vendor !== vendor || typeof manifest.vendorVersion !== 'string') {
    throw new Error(`${groundTruthRelative} does not identify ${vendor}`);
  }
  return {
    document,
    manifest,
    groundTruthPath: absolute,
    groundTruthRelative: relative(resolve(repoRoot), absolute).split(sep).join('/'),
    vendorRoot: dirname(absolute),
  };
}

/**
 * The canonical path is stable across releases. Its manifest identifies the
 * active authoring model/capture version, while the support ledger separately
 * records whether that version is promoted or still a candidate.
 */
export function resolveAgentModel({ repoRoot = root, vendor } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('vendor is required and must be normalized');
  const ledgerPath = join(repoRoot, 'support', 'agents.json');
  const ledger = json(ledgerPath);
  const agent = ledger.agents?.find((entry) => entry.id === vendor);
  if (!agent) throw new Error(`support ledger has no ${vendor} entry`);
  if (typeof agent.groundTruth !== 'string') throw new Error(`${vendor} has no canonical Surface ground truth`);
  const canonical = resolveCanonicalGroundTruth({ repoRoot, vendor, groundTruthPath: agent.groundTruth });
  const { groundTruthPath, groundTruthRelative, manifest, vendorRoot } = canonical;
  const activeVersion = agent.candidateVersion ?? agent.currentVersion;
  if (manifest.vendorVersion !== activeVersion) {
    throw new Error(
      `${vendor} ground truth is ${manifest.vendorVersion}, but the support ledger selects ${String(activeVersion)}`,
    );
  }

  const surfaceRoot = join(repoRoot, 'packages', 'surface');
  const modelRoot = join(vendorRoot, 'model', `${vendor}@${manifest.vendorVersion}`);
  if (!existsSync(join(modelRoot, 'manifest.json'))) {
    throw new Error(`${vendor} authoring model does not exist for ${manifest.vendorVersion}`);
  }
  const capturesRoot = join(vendorRoot, 'captures', `${vendor}@${manifest.vendorVersion}`);
  return {
    agent,
    manifest,
    version: manifest.vendorVersion,
    groundTruthPath,
    groundTruthRelative,
    vendorRoot,
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
  const selected = resolveAgentModel({ vendor: flag('--vendor') });
  const field = flag('--field') ?? 'groundTruthRelative';
  if (!(field in selected) || typeof selected[field] === 'object') throw new Error(`unsupported output field ${field}`);
  process.stdout.write(`${selected[field]}\n`);
}
