#!/usr/bin/env node
/** Capture immutable, reviewable probes for the pinned Kimi candidate binary. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestTree } from '../../../scripts/check-evidence.mjs';
import { VERSION, cliOptions } from './source-contract.mjs';

const vendorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultOutput = join(vendorRoot, 'probes', `kimi@${VERSION}`);
const defaultRaw = join(vendorRoot, 'captures-raw', `kimi@${VERSION}`);

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(artifact, args) {
  const result = spawnSync(artifact, args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

function filesUnder(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const artifactFlag = flag('--artifact', process.env.CHOPSTICKS_KIMI_BIN ?? 'kimi');
const artifact = isAbsolute(artifactFlag) || artifactFlag.includes('/') ? resolve(artifactFlag) : artifactFlag;
const outputRoot = resolve(flag('--output', defaultOutput));
const rawRoot = resolve(flag('--raw', defaultRaw));
const rawFiles = filesUnder(rawRoot);
if (rawFiles.length === 0) throw new Error(`raw Kimi census is empty: ${rawRoot}`);

const versionProbe = run(artifact, ['--version']);
if (versionProbe.status !== 0 || versionProbe.stdout.trim() !== VERSION) {
  throw new Error(`expected Kimi ${VERSION}, got ${versionProbe.stdout.trim() || versionProbe.stderr.trim()}`);
}
const helpProbe = run(artifact, ['--help']);
if (helpProbe.status !== 0 || !helpProbe.stdout.includes('--prompt')) throw new Error('Kimi help probe failed');
const rejectedFlag = '--definitely-not-a-kimi-option';
const rejectionProbe = run(artifact, [rejectedFlag]);
if (rejectionProbe.status === 0 || !`${rejectionProbe.stdout}\n${rejectionProbe.stderr}`.includes(rejectedFlag)) {
  throw new Error('Kimi unknown-option probe did not fail closed');
}

const artifactBytes = readFileSync(artifact);
const artifactStat = statSync(artifact);
const fileProbe = spawnSync('file', ['-b', artifact], { encoding: 'utf8', timeout: 10_000 });
const probedAt = new Date().toISOString();
const captureTimes = rawFiles.map((path) => statSync(path).mtimeMs);
const captureStartedAt = new Date(Math.min(...captureTimes)).toISOString();
const captureEndedAt = new Date(Math.max(...captureTimes)).toISOString();

mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'version.txt'), `${versionProbe.stdout.trimEnd()}\n`);
writeFileSync(join(outputRoot, 'help.txt'), `${helpProbe.stdout.trimEnd()}\n`);
json(join(outputRoot, 'artifact.json'), {
  vendor: 'kimi',
  vendorVersion: VERSION,
  artifact: '$CHOPSTICKS_KIMI_BIN',
  platform: `${process.platform}-${process.arch}`,
  bytes: artifactStat.size,
  fileDescription: fileProbe.status === 0 ? fileProbe.stdout.trim() : undefined,
  versionArgs: ['--version'],
  versionOutput: versionProbe.stdout.trim(),
  sha256: createHash('sha256').update(artifactBytes).digest('hex'),
  probedAt,
});
json(join(outputRoot, 'flags.json'), {
  visibleHelpOptions: Object.fromEntries(
    Object.entries(cliOptions).map(([purpose, options]) => [
      purpose,
      options.filter((option) => helpProbe.stdout.includes(option)),
    ]),
  ),
  exactSourceOptions: cliOptions,
  rejectedOptionProbe: {
    args: [rejectedFlag],
    status: rejectionProbe.status,
    signal: rejectionProbe.signal,
    stdout: rejectionProbe.stdout.trim(),
    stderr: rejectionProbe.stderr.trim(),
  },
});
json(join(outputRoot, 'raw-capture-attestation.json'), {
  vendor: 'kimi',
  vendorVersion: VERSION,
  rawCaptureRoot: `captures-raw/kimi@${VERSION}`,
  digestAlgorithm: 'sha256-path-content-v1',
  sha256: digestTree(rawRoot),
  files: rawFiles.length,
  scenarios: readdirSync(rawRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(),
  captureStartedAt,
  captureEndedAt,
});

console.log(`wrote Kimi ${VERSION} binary probes and raw-capture attestation at ${outputRoot}`);
