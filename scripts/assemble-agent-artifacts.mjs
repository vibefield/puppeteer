#!/usr/bin/env node
/** Assemble platform acquisition bundles into one immutable artifact report. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireAgentArtifacts } from './acquire-agent-artifacts.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function safePath(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

/**
 * Each acquisition lane uploads one workflow artifact, `<prefix><platform>`, holding only its own platform's
 * bundle. Downloaded by pattern without merging, every artifact lands in its own directory under `downloads`;
 * this moves each platform's bundle out of its own artifact alone. Merging instead would let any job that can
 * upload an artifact (a vendor binary running in a lane can) shadow another platform's bytes, so an
 * unexpected artifact name, or an artifact holding anything but its platform's directory, is refused.
 */
export function collectDownloadedBundles({ downloads, platforms, directory, prefix = 'promotion-artifact-' }) {
  const expected = new Set(platforms.map((platform) => `${prefix}${platform}`));
  const unexpected = readdirSync(downloads)
    .filter((name) => !expected.has(name))
    .sort();
  if (unexpected.length > 0) throw new Error(`unexpected downloaded artifacts: ${unexpected.join(', ')}`);
  for (const platform of platforms) {
    const artifact = join(downloads, `${prefix}${platform}`);
    if (!existsSync(artifact)) throw new Error(`missing downloaded artifact ${prefix}${platform}`);
    const entries = readdirSync(artifact);
    if (entries.length !== 1 || entries[0] !== platform || !lstatSync(join(artifact, platform)).isDirectory()) {
      throw new Error(`${prefix}${platform} must hold only the ${platform} bundle`);
    }
    const target = join(directory, platform);
    if (existsSync(target)) throw new Error(`${platform} bundle is already present before collection`);
    mkdirSync(directory, { recursive: true });
    renameSync(join(artifact, platform), target);
  }
}

export function acquisitionBundles({ repoRoot = root, vendor, version, directory, platforms }) {
  return platforms.map((platform) => {
    const bundle = join(directory, platform);
    const metadataPath = join(bundle, 'download.json');
    const versionPath = join(bundle, 'version.txt');
    if (!existsSync(metadataPath) || !existsSync(versionPath)) {
      throw new Error(`incomplete acquisition bundle for ${platform}`);
    }
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (metadata.vendor !== vendor || metadata.version !== version || metadata.platform !== platform) {
      throw new Error(`acquisition bundle identity differs for ${platform}`);
    }
    const artifact =
      metadata.artifactKind === 'installed-console'
        ? join(bundle, 'installed-console.json')
        : ['agent', 'agent.exe'].map((name) => join(bundle, name)).find(existsSync);
    if (
      !artifact ||
      !existsSync(artifact) ||
      !['standalone-executable', 'installed-console'].includes(metadata.artifactKind)
    ) {
      throw new Error(`acquisition bundle for ${platform} has no supported artifact`);
    }
    if (resolve(repoRoot, metadata.output) !== resolve(artifact)) {
      throw new Error(`acquisition bundle output differs for ${platform}`);
    }
    return {
      platform,
      artifactKind: metadata.artifactKind,
      path: artifact,
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
  const downloads = flag('--downloads');
  if (downloads) collectDownloadedBundles({ downloads: safePath(downloads), platforms: upstream.platforms, directory });
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
