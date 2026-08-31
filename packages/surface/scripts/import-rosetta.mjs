#!/usr/bin/env node
/** Import immutable Rosetta evidence without making normal builds depend on Rosetta. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeRecord } from '@vibecook/puppeteer-surface/sanitize';
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

  const captureRoot = join(vendorRoot, 'captures', `${vendor}@${config.version}`);
  rmSync(captureRoot, { recursive: true, force: true });
  mkdirSync(captureRoot, { recursive: true });
  const fixtureRoot = join(sourceRoot, 'fixtures', config.version);
  const scenarios = [];
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
      recordCount += sanitizeJsonl(source, join(captureRoot, scenarioEntry.name, name), rosettaPrivacyRules(vendor));
    }
  }
  if (recordCount === 0) throw new Error(`Rosetta fixture set has no ${config.primaryStream} records`);

  writeJson(join(captureRoot, 'capture.json'), {
    schemaVersion: 2,
    representation: 'type-preserving-redaction',
    vendor,
    vendorVersion: config.version,
    mode: 'imported-rosetta-controlled-native-journals',
    scenarios,
    records: recordCount,
  });
  writeCaptureFidelity(captureRoot, {
    vendor,
    vendorVersion: config.version,
    defaultRepresentation: 'type-preserving-redaction',
    nativeArtifacts: ['**/*.jsonl'],
    limitations: [
      `Only the ${config.primaryStream} append-only journal is copied from each Rosetta scenario; the committed Rosetta reference preserves the complete ${canonical.streams.length}-stream inventory.`,
      'All native object keys, containers, primitive types, and record ordering are retained; sensitive scalar values are redacted in place.',
    ],
  });

  const fixtureSource = canonical.sources.find(
    (source) => source.agent_version === config.version && source.evidence === 'fixture',
  );
  writeJson(join(referencesRoot, 'import.json'), {
    format: 'puppeteer-rosetta-import/1',
    vendor,
    vendorVersion: config.version,
    importedAt: '2026-08-28',
    importer: relative(repositoryRoot, fileURLToPath(import.meta.url)).replaceAll('\\', '/'),
    source: { project: 'rosetta', canonicalSha256: sha256(canonicalPath), files: importedReferences },
    fixtureCorpus: {
      id: `${vendor}-${config.version}-rosetta-fixture-corpus`,
      versionOutput: config.version,
      platform: 'darwin-arm64',
      capturedAt: config.capturedAt,
      sha256: fixtureSource?.sha256 ?? sha256(canonicalPath),
    },
  });
  return { vendor, version: config.version, scenarios: scenarios.length, records: recordCount };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendor = process.argv[2];
  const rootIndex = process.argv.indexOf('--rosetta');
  const result = importRosettaSurface(vendor, {
    ...(rootIndex >= 0 ? { rosettaRoot: process.argv[rootIndex + 1] } : {}),
  });
  console.log(
    `imported ${result.vendor}@${result.version}: ${result.records} records across ${result.scenarios} scenarios`,
  );
}
