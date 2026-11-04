#!/usr/bin/env node
/** Import immutable Rosetta evidence without making normal builds depend on Rosetta. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCaptureDirectory, sanitizeRecord } from '@vibefield/puppeteer-surface/sanitize';
import { writeCaptureFidelity } from './capture-fidelity.mjs';
import { rosettaAgentConfig, rosettaPrivacyRules } from './rosetta-agents.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(dirname(packageRoot));

function filesUnder(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    })
    .sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeJsonl(source, target, rules) {
  const records = [];
  for (const [index, line] of readFileSync(source, 'utf8').split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.stringify(sanitizeRecord(JSON.parse(line), rules)));
    } catch (error) {
      throw new Error(`${source}:${index + 1} is not valid JSON`, { cause: error });
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${records.join('\n')}\n`);
  return records.length;
}

/**
 * Sanitize one Rosetta fixture version's primary journals into `captures/<vendor>@<version>`, gated on the privacy
 * detector. A leaky import leaves nothing behind to commit.
 */
function importCaptureSet(vendor, config, sourceRoot, vendorRoot, version, limitations) {
  const captureRoot = join(vendorRoot, 'captures', `${vendor}@${version}`);
  rmSync(captureRoot, { recursive: true, force: true });
  mkdirSync(captureRoot, { recursive: true });
  const fixtureRoot = join(sourceRoot, 'fixtures', version);
  if (!existsSync(fixtureRoot)) throw new Error(`Rosetta has no ${vendor} fixtures for ${version}: ${fixtureRoot}`);
  const rules = rosettaPrivacyRules(vendor);
  const scenarios = [];
  const journals = [];
  let recordCount = 0;
  for (const scenarioEntry of readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const scenarioRoot = join(fixtureRoot, scenarioEntry.name);
    const sources = filesUnder(scenarioRoot).filter((path) =>
      config.primaryRecord(`/${relative(scenarioRoot, path).replaceAll('\\', '/')}`),
    );
    if (sources.length === 0) continue;
    scenarios.push(scenarioEntry.name);
    for (const [index, source] of sources.entries()) {
      const name = sources.length === 1 ? 'events.jsonl' : `events-${String(index + 1).padStart(2, '0')}.jsonl`;
      recordCount += sanitizeJsonl(source, join(captureRoot, scenarioEntry.name, name), rules);
      // The source path names native conversation ids, so only its digest is kept.
      journals.push({ capture: `${scenarioEntry.name}/${name}`, sourceSha256: sha256(source) });
    }
  }
  if (recordCount === 0) {
    rmSync(captureRoot, { recursive: true, force: true });
    throw new Error(`Rosetta fixture set has no ${config.primaryStream} records`);
  }
  // Gate the import on the detector, not only the redactor: a raw UUID left in an id-keyed map's KEY once shipped
  // while every value was aliased. A leaky import leaves nothing behind to commit.
  const leaks = checkCaptureDirectory(captureRoot, rules);
  if (leaks.length > 0) {
    rmSync(captureRoot, { recursive: true, force: true });
    throw new Error(
      `${leaks.length} privacy issue(s) in the imported ${vendor}@${version} captures:\n${leaks.slice(0, 20).join('\n')}`,
    );
  }

  writeJson(join(captureRoot, 'capture.json'), {
    schemaVersion: 2,
    representation: 'type-preserving-redaction',
    vendor,
    vendorVersion: version,
    mode: 'imported-rosetta-controlled-native-journals',
    scenarios,
    records: recordCount,
  });
  writeCaptureFidelity(captureRoot, {
    vendor,
    vendorVersion: version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['**/*.jsonl'],
    limitations: [
      ...limitations,
      'All native object keys, containers, primitive types, and record ordering are retained; sensitive scalar values are redacted in place.',
    ],
  });
  return { scenarios: scenarios.length, records: recordCount, journals };
}

/** The Rosetta commit, and whether the vendor's ground-truth tree matched it. Undefined outside a Git checkout. */
function rosettaRevision(rosettaRoot, sourceRoot) {
  try {
    const git = (...args) => execFileSync('git', ['-C', rosettaRoot, ...args], { encoding: 'utf8' }).trim();
    return {
      commit: git('rev-parse', 'HEAD'),
      sourceTreeClean: git('status', '--porcelain', '--', relative(rosettaRoot, sourceRoot)) === '',
    };
  } catch {
    return undefined;
  }
}

/**
 * Import only the sanitized primary journals of a Rosetta fixture version that is not (yet) the canonical one. The
 * committed `references/<vendor>@<version>` evidence, the active canonical, its model and its import record are left
 * untouched, so a newer writer's journals can back adapter compatibility while another version stays active.
 */
export function importRosettaCaptures(vendor, version, options = {}) {
  const config = rosettaAgentConfig(vendor);
  if (version === config.version) {
    throw new Error(`${vendor}@${version} is the configured canonical version; run the full import instead`);
  }
  const rosettaRoot = resolve(options.rosettaRoot ?? join(repositoryRoot, '..', 'rosetta'));
  const sourceRoot = join(rosettaRoot, 'groundtruth', config.rosettaDirectory);
  const canonicalPath = join(sourceRoot, 'groundtruth.json');
  if (!existsSync(canonicalPath)) throw new Error(`Rosetta ground truth is missing: ${canonicalPath}`);
  const canonical = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  if (canonical.agent !== vendor) throw new Error(`Rosetta identity is ${canonical.agent}, expected ${vendor}`);
  const vendorRoot = join(packageRoot, 'vendors', vendor);
  const { journals, ...result } = importCaptureSet(vendor, config, sourceRoot, vendorRoot, version, [
    `Captures-only import: only the ${config.primaryStream} append-only journal is copied from each Rosetta ${version} scenario. The active canonical stays ${vendor}@${config.version}; this set backs adapter compatibility and is not folded into the model.`,
  ]);
  // No reference directory is written for a captures-only set, so its provenance lives beside the captures.
  const fixtureSource = canonical.sources?.find(
    (source) => source.agent_version === version && source.evidence === 'fixture',
  );
  writeJson(join(vendorRoot, 'captures', `${vendor}@${version}`, 'import.json'), {
    format: 'puppeteer-rosetta-captures-import/1',
    vendor,
    vendorVersion: version,
    importer: relative(repositoryRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/'),
    source: {
      project: 'rosetta',
      ...rosettaRevision(rosettaRoot, sourceRoot),
      canonicalSha256: sha256(canonicalPath),
      ...(fixtureSource?.sha256 ? { fixtureSourceSha256: fixtureSource.sha256 } : {}),
      journals,
    },
  });
  return { vendor, version, ...result };
}

export function importRosettaSurface(vendor, options = {}) {
  const config = rosettaAgentConfig(vendor);
  const rosettaRoot = resolve(options.rosettaRoot ?? join(repositoryRoot, '..', 'rosetta'));
  const sourceRoot = join(rosettaRoot, 'groundtruth', config.rosettaDirectory);
  const canonicalPath = join(sourceRoot, 'groundtruth.json');
  if (!existsSync(canonicalPath)) throw new Error(`Rosetta ground truth is missing: ${canonicalPath}`);
  const canonical = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  if (canonical.agent !== vendor || canonical.agent_version !== config.version) {
    throw new Error(
      `Rosetta identity is ${canonical.agent}@${canonical.agent_version}, expected ${vendor}@${config.version}`,
    );
  }

  const vendorRoot = join(packageRoot, 'vendors', vendor);
  const referencesRoot = join(vendorRoot, 'references', `${vendor}@${config.version}`);
  rmSync(referencesRoot, { recursive: true, force: true });
  mkdirSync(referencesRoot, { recursive: true });
  writeJson(join(referencesRoot, 'rosetta-groundtruth.json'), canonical);

  const importedReferences = [];
  for (const sourceRelative of config.referenceFiles) {
    const source = join(sourceRoot, sourceRelative);
    if (!existsSync(source)) continue;
    const targetName = basename(source);
    const target = join(referencesRoot, targetName);
    writeFileSync(target, readFileSync(source));
    importedReferences.push({ path: targetName, sha256: sha256(target) });
  }

  const captured = importCaptureSet(vendor, config, sourceRoot, vendorRoot, config.version, [
    `Only the ${config.primaryStream} append-only journal is copied from each Rosetta scenario; the committed Rosetta reference preserves the complete ${canonical.streams.length}-stream inventory.`,
  ]);

  const fixtureSource = canonical.sources.find(
    (source) => source.agent_version === config.version && source.evidence === 'fixture',
  );
  writeJson(join(referencesRoot, 'import.json'), {
    format: 'puppeteer-rosetta-import/1',
    vendor,
    vendorVersion: config.version,
    importedAt: config.importedAt ?? '2026-08-28',
    importer: relative(repositoryRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/'),
    source: { project: 'rosetta', canonicalSha256: sha256(canonicalPath), files: importedReferences },
    fixtureCorpus: {
      id: `${vendor}-${config.version}-rosetta-fixture-corpus`,
      versionOutput: config.version,
      platform: config.platform ?? 'darwin-arm64',
      capturedAt: config.capturedAt,
      sha256: fixtureSource?.sha256 ?? sha256(canonicalPath),
    },
  });
  return { vendor, version: config.version, ...captured };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendor = process.argv[2];
  const rootIndex = process.argv.indexOf('--rosetta');
  const capturesOnlyIndex = process.argv.indexOf('--captures-only');
  const options = rootIndex >= 0 ? { rosettaRoot: process.argv[rootIndex + 1] } : {};
  const result =
    capturesOnlyIndex >= 0
      ? importRosettaCaptures(vendor, process.argv[capturesOnlyIndex + 1], options)
      : importRosettaSurface(vendor, options);
  console.log(
    `imported ${result.vendor}@${result.version}${capturesOnlyIndex >= 0 ? ' (captures only)' : ''}: ${result.records} records across ${result.scenarios} scenarios`,
  );
}
