#!/usr/bin/env node
/** Hash already-downloaded vendor artifacts without executing them or mutating support state. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInstalledConsoleManifest } from './lib/installed-console-contract.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function safePath(repoRoot, path) {
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(`${resolve(repoRoot)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function knownDigests(repoRoot, vendor, version) {
  const models = join(repoRoot, 'packages', 'surface', 'vendors', vendor, 'model');
  const known = new Map();
  if (!existsSync(models)) return known;
  for (const entry of readdirSync(models, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name !== `${vendor}@${version}`) continue;
    const evidencePath = join(models, entry.name, 'evidence.json');
    if (!existsSync(evidencePath)) continue;
    for (const artifact of json(evidencePath).artifacts ?? []) {
      const digest = artifact.integrity?.sha256;
      if (artifact.platform && /^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
        known.set(artifact.platform, {
          digest,
          artifactKind:
            artifact.artifactKind ??
            (artifact.identity === 'source-revision-and-lockfile' ? 'source-revision' : 'standalone-executable'),
        });
      }
    }
  }
  return known;
}

function installedConsoleIdentity(manifest) {
  return {
    sourceArchiveSha256: manifest.source.archiveSha256,
    sourceTreeSha256: manifest.source.tree.sha256,
    generatedSourceSha256: manifest.source.generated.sha256,
    sourceReference: manifest.source.reference,
    projectFileSha256: manifest.source.projectFile.sha256,
    lockFileSha256: manifest.source.lockFile.sha256,
    pythonVersion: manifest.runtime.pythonVersion,
    pythonExecutableSha256: manifest.runtime.executableSha256,
    pythonStandardLibrarySha256: manifest.runtime.stdlibSha256,
    environmentSha256: manifest.environment.sha256,
    consoleEntryPoint: manifest.console.entryPoint,
    consoleBindingSha256: manifest.console.bindingSha256,
  };
}

export function acquireAgentArtifacts({ repoRoot = root, vendor, version, artifacts, now = () => new Date() }) {
  if (!/^[a-z][a-z0-9-]*$/.test(vendor ?? '')) throw new Error('vendor is required and must be normalized');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('version is required and must be normalized');
  }
  const upstreamPath = join(repoRoot, 'packages', 'surface', 'vendors', vendor, 'upstream.json');
  if (!existsSync(upstreamPath)) throw new Error(`no upstream policy for ${vendor}`);
  const upstream = json(upstreamPath);
  const expectedArtifactKind =
    upstream.acquisition?.strategy === 'source-revision' ? 'installed-console' : 'standalone-executable';
  const requiredPlatforms = upstream.platforms ?? [];
  const supplied = new Map();
  const issues = [];
  for (const artifact of artifacts ?? []) {
    if (supplied.has(artifact.platform)) {
      issues.push(`duplicate artifact for ${artifact.platform}`);
      continue;
    }
    supplied.set(artifact.platform, artifact);
  }
  const known = knownDigests(repoRoot, vendor, version);
  const acquired = [];
  const republished = [];
  const versionPattern = new RegExp(`(?:^|[^0-9])${version.replace(/\./g, '\\.').replace(/-/g, '\\-')}(?:[^0-9]|$)`);
  for (const platform of requiredPlatforms) {
    const artifact = supplied.get(platform);
    if (!artifact) {
      issues.push(`missing artifact for required platform ${platform}`);
      continue;
    }
    const absolute = safePath(repoRoot, artifact.path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      issues.push(`artifact for ${platform} is not a file: ${artifact.path}`);
      continue;
    }
    const sha256 = `sha256:${digestFile(absolute)}`;
    const versionOutput = typeof artifact.versionOutput === 'string' ? artifact.versionOutput.trim() : '';
    if (!versionOutput || versionOutput.length > 256 || /[\r\n]/.test(versionOutput)) {
      issues.push(`${platform} has no bounded single-line version output`);
    } else if (!versionPattern.test(versionOutput)) {
      issues.push(`${platform} version output does not identify ${version}`);
    }
    const artifactKind = artifact.artifactKind ?? expectedArtifactKind;
    if (artifactKind !== expectedArtifactKind) {
      issues.push(`${platform} is ${artifactKind}, expected ${expectedArtifactKind}`);
    }
    let identity;
    if (artifactKind === 'installed-console') {
      try {
        const manifest = json(absolute);
        validateInstalledConsoleManifest(manifest, {
          vendor,
          version,
          platform,
          versionOutput,
          policy: upstream.acquisition.installedConsole,
        });
        identity = installedConsoleIdentity(manifest);
      } catch (error) {
        issues.push(`${platform} installed-console manifest is invalid: ${error.message}`);
      }
    }
    const prior = known.get(platform);
    if (prior?.artifactKind === artifactKind && prior.digest !== sha256) {
      republished.push({ platform, priorDigest: prior.digest, acquiredDigest: sha256 });
    }
    let sourceUrl;
    if (artifact.sourceUrl !== undefined) {
      try {
        const parsed = new URL(artifact.sourceUrl);
        if (
          parsed.protocol !== 'https:' ||
          !(upstream.acquisition?.allowedHosts ?? []).includes(parsed.hostname) ||
          artifact.sourceUrl.length > 2_048 ||
          /[\r\n]/.test(artifact.sourceUrl)
        ) {
          throw new Error('not allowlisted');
        }
        sourceUrl = parsed.href;
      } catch {
        issues.push(`${platform} has an invalid artifact source URL`);
      }
    }
    acquired.push({
      key: `${vendor}@${version}@${platform}@${sha256}`,
      platform,
      artifactKind,
      file: basename(absolute),
      bytes: statSync(absolute).size,
      sha256,
      versionOutput,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(identity ? { identity } : {}),
      acquiredAt: now().toISOString(),
    });
  }
  for (const platform of supplied.keys()) {
    if (!requiredPlatforms.includes(platform)) issues.push(`unexpected platform ${platform}`);
  }
  return {
    schemaVersion: 1,
    vendor,
    version,
    requiredPlatforms,
    status: republished.length > 0 ? 'republished-artifact' : issues.length > 0 ? 'incomplete' : 'complete',
    artifacts: acquired.sort((left, right) => left.platform.localeCompare(right.platform)),
    republished,
    issues: issues.sort(),
  };
}

function values(name) {
  const found = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) found.push(process.argv[index + 1]);
  }
  return found;
}

function flag(name) {
  return values(name).at(-1);
}

export function assignmentMap(name, entries) {
  const parsed = new Map();
  for (const value of entries) {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`${name} requires platform=value`);
    const platform = value.slice(0, separator);
    if (parsed.has(platform)) throw new Error(`${name} repeats platform ${platform}`);
    parsed.set(platform, value.slice(separator + 1));
  }
  return parsed;
}

function assignments(name) {
  return assignmentMap(name, values(name));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const paths = assignments('--artifact');
  const outputs = assignments('--version-output');
  const sources = assignments('--source-url');
  const report = acquireAgentArtifacts({
    vendor: flag('--vendor'),
    version: flag('--version'),
    artifacts: [...paths].map(([platform, path]) => ({
      platform,
      path,
      versionOutput: outputs.get(platform),
      sourceUrl: sources.get(platform),
    })),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const output = flag('--output');
  if (output) writeFileSync(safePath(root, output), serialized);
  else process.stdout.write(serialized);
  if (report.status !== 'complete') process.exitCode = 1;
}
