#!/usr/bin/env node
/** Assemble platform acquisition bundles into one immutable artifact report. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAgentArtifacts } from './acquire-agent-artifacts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function safePath(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

export function acquisitionBundles({ repoRoot = root, vendor, version, directory, platforms }) {
  return platforms.map((platform) => {
    const bundle = join(directory, platform);
    const metadataPath = join(bundle, 'download.json');
    const versionPath = join(bundle, 'version.txt');
    const binary = ['agent', 'agent.exe'].map((name) => join(bundle, name)).find(existsSync);
    if (!binary || !existsSync(metadataPath) || !existsSync(versionPath)) {
      throw new Error(`incomplete acquisition bundle for ${platform}`);
    }
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (metadata.vendor !== vendor || metadata.version !== version || metadata.platform !== platform) {
      throw new Error(`acquisition bundle identity differs for ${platform}`);
    }
    return {
      platform,
      path: binary,
      versionOutput: readFileSync(versionPath, 'utf8').trim(),
      sourceUrl: metadata.sourceUrl,
    };
  });
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendor = flag('--vendor');
  const version = flag('--version');
  const directory = safePath(flag('--directory'));
  const upstream = JSON.parse(
    readFileSync(resolve(root, 'packages', 'surface', 'vendors', vendor, 'upstream.json'), 'utf8'),
  );
  const report = acquireAgentArtifacts({
    vendor,
    version,
    artifacts: acquisitionBundles({
      vendor,
      version,
      directory,
      platforms: upstream.platforms,
    }),
  });
  const output = safePath(flag('--output'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'complete') process.exitCode = 1;
}
