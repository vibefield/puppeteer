#!/usr/bin/env node
/** Digest lock between one canonical provider ground truth and adapter implementation references. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const adapters = ['claude', 'codex', 'grok', 'hermes', 'kimi', 'opencode'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'test-support') files.push(...filesUnder(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.live.ts') &&
      !entry.name.includes('.live.test.')
    ) {
      files.push(path);
    }
  }
  return files;
}

function quoted(source, value) {
  return source.includes(`'${value}'`) || source.includes(`"${value}"`) || source.includes(`\`${value}\``);
}

function eventDigest(events) {
  return sha256(`${events.join('\n')}\n`);
}

export function buildAdapterGroundTruthMap(root, provider) {
  const adapterDirectory = join(root, 'packages', `adapter-${provider}`);
  const groundTruth = `packages/surface/vendors/${provider}/groundtruth.json`;
  const groundTruthPath = join(root, groundTruth);
  const rawGroundTruth = readFileSync(groundTruthPath, 'utf8');
  const model = JSON.parse(rawGroundTruth);
  if (model.format !== 'puppeteer-groundtruth/1') throw new Error(`${groundTruth} is not canonical ground truth`);
  const events = model.events.map(({ event }) => event).sort();
  if (new Set(events).size !== events.length) throw new Error(`${groundTruth} contains duplicate event names`);

  const sources = filesUnder(join(adapterDirectory, 'src')).map((path) => ({
    path: relative(adapterDirectory, path),
    source: readFileSync(path, 'utf8'),
  }));
  const semanticSources = sources.filter(
    ({ path }) =>
      path.includes('normalization/') || path.endsWith('normalizer.ts') || path.endsWith('monitor-evidence.ts'),
  );
  const semanticEvents = events.filter((event) => semanticSources.some(({ source }) => quoted(source, event)));
  const observedOrControlledEvents = events.filter(
    (event) => !semanticEvents.includes(event) && sources.some(({ source }) => quoted(source, event)),
  );
  const mapped = new Set([...semanticEvents, ...observedOrControlledEvents]);
  const unmappedEvents = events.filter((event) => !mapped.has(event));

  return {
    format: 'puppeteer-adapter-groundtruth-map/1',
    provider,
    adapterPackage: `@vibecook/puppeteer-adapter-${provider}`,
    groundTruth,
    groundTruthSha256: sha256(rawGroundTruth),
    semanticEvents,
    observedOrControlledEvents,
    unmapped: {
      count: unmappedEvents.length,
      sha256: eventDigest(unmappedEvents),
      policy:
        'Not consumed by this adapter version. They remain provider-native ground truth and require explicit review when this lock changes.',
    },
    totals: {
      groundTruth: events.length,
      semantic: semanticEvents.length,
      observedOrControlled: observedOrControlledEvents.length,
    },
  };
}

export function auditAdapterGroundTruthMaps(root = repositoryRoot) {
  const issues = [];
  for (const provider of adapters) {
    const path = join(root, 'packages', `adapter-${provider}`, 'groundtruth-map.json');
    const expected = buildAdapterGroundTruthMap(root, provider);
    if (!existsSync(path)) {
      issues.push(`${relative(root, path)} is missing`);
      continue;
    }
    const actual = JSON.parse(readFileSync(path, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      issues.push(`${relative(root, path)} is stale; run pnpm groundtruth:mapping:write`);
    }
  }
  return issues;
}

function writeMaps(root = repositoryRoot) {
  for (const provider of adapters) {
    const path = join(root, 'packages', `adapter-${provider}`, 'groundtruth-map.json');
    const map = buildAdapterGroundTruthMap(root, provider);
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
    console.log(`wrote ${relative(root, path)}`);
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === join(repositoryRoot, relative(repositoryRoot, process.argv[1]));
if (invokedDirectly) {
  if (process.argv.includes('--write')) {
    writeMaps();
  } else {
    const issues = auditAdapterGroundTruthMaps();
    if (issues.length > 0) {
      console.error(`adapter ground-truth maps: ${issues.length} issue(s)`);
      for (const issue of issues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    console.log(`adapter ground-truth maps: current (${adapters.length} providers)`);
  }
}
