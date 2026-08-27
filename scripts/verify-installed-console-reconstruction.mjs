#!/usr/bin/env node
/** Prove that a fresh source build exactly reproduces an acquired installed-console artifact. */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInstalledConsoleManifest } from './lib/installed-console-contract.mjs';
import { verifyRuntimeBundleFiles } from './lib/runtime-bundle-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function safeFile(repoRoot, path, label) {
  if (typeof path !== 'string' || !path) throw new Error(`${label} is required`);
  const repository = resolve(repoRoot);
  const absolute = resolve(repository, path);
  if (!absolute.startsWith(`${repository}${sep}`)) throw new Error(`${label} is outside the repository`);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return absolute;
}

function parseManifest(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function verifyInstalledConsoleReconstruction({ repoRoot = root, vendor, version, platform, expected, actual }) {
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('invalid vendor');
  if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version ?? '')) throw new Error('invalid version');
  const upstream = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages', 'surface', 'vendors', vendor, 'upstream.json'), 'utf8'),
  );
  if (
    upstream.vendor !== vendor ||
    upstream.acquisition?.strategy !== 'source-revision' ||
    !(upstream.platforms ?? []).includes(platform)
  ) {
    throw new Error('installed-console reconstruction differs from the reviewed upstream policy');
  }

  const expectedPath = safeFile(repoRoot, expected, 'acquired installed-console manifest');
  const actualPath = safeFile(repoRoot, actual, 'reconstructed installed-console manifest');
  const expectedBytes = readFileSync(expectedPath);
  const actualBytes = readFileSync(actualPath);
  const expectedManifest = parseManifest(expectedBytes, 'acquired installed-console manifest');
  const actualManifest = parseManifest(actualBytes, 'reconstructed installed-console manifest');
  const policy = upstream.acquisition.installedConsole;

  for (const manifest of [expectedManifest, actualManifest]) {
    validateInstalledConsoleManifest(manifest, { vendor, version, platform, policy });
  }
  if (policy.runtimeBundle) {
    verifyRuntimeBundleFiles(expectedManifest.runtimeBundle, dirname(expectedPath), policy.runtimeBundle);
    verifyRuntimeBundleFiles(actualManifest.runtimeBundle, dirname(actualPath), policy.runtimeBundle);
  }
  if (!expectedBytes.equals(actualBytes)) {
    throw new Error('fresh materialization does not exactly reproduce the acquired installed-console manifest');
  }

  return {
    schemaVersion: 1,
    check: 'installed-console-reconstruction',
    vendor,
    version,
    platform,
    manifestSha256: `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`,
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  console.log(
    JSON.stringify(
      verifyInstalledConsoleReconstruction({
        vendor: flag('--vendor'),
        version: flag('--version'),
        platform: flag('--platform'),
        expected: flag('--expected'),
        actual: flag('--actual'),
      }),
    ),
  );
}
