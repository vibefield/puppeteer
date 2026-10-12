import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { spawnPackageManager } from './package-manager.mjs';
import { publicPackages } from './public-packages.mjs';

export const npmRegistry = 'https://registry.npmjs.org/';
export const releaseRepository = 'vibefield/puppeteer';
export const releaseWorkflow = 'release.yml';
export const repositoryUrl = `git+https://github.com/${releaseRepository}.git`;

export function releaseMetadataIssues(manifest, directory) {
  const issues = [];
  if (manifest.repository?.type !== 'git' || manifest.repository?.url !== repositoryUrl) {
    issues.push(`${directory} repository must be ${repositoryUrl}`);
  }
  if (manifest.repository?.directory !== directory)
    issues.push(`${directory} repository.directory must match its path`);
  if (manifest.private === true || manifest.publishConfig?.access !== 'public') {
    issues.push(`${directory} must publish with public access`);
  }
  if (Object.hasOwn(manifest.publishConfig ?? {}, 'provenance')) {
    issues.push(`${directory} must leave provenance to the release workflow`);
  }
  if (manifest.publishConfig?.registry && manifest.publishConfig.registry !== npmRegistry) {
    issues.push(`${directory} publishConfig.registry must be ${npmRegistry}`);
  }
  if (manifest.publishConfig?.tag && manifest.publishConfig.tag !== 'latest') {
    issues.push(`${directory} must publish stable releases to latest`);
  }
  return issues;
}

export function readReleasePackages(root, packages = publicPackages) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable release version; found ${version}`);
  }
  const names = new Set(packages.map(([, name]) => name));
  const seen = new Set();
  const issues = [];
  const descriptors = packages.map(([directory, name]) => {
    const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    if (manifest.name !== name || manifest.version !== version) issues.push(`${directory} must be ${name}@${version}`);
    issues.push(...releaseMetadataIssues(manifest, directory));
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (names.has(dependency) && !seen.has(dependency)) issues.push(`${name} must publish after ${dependency}`);
    }
    if (seen.has(name)) issues.push(`${name} appears twice in the release train`);
    seen.add(name);
    return { directory, name, version };
  });
  if (issues.length) throw new Error(`Release metadata is invalid:\n${issues.join('\n')}`);
  return descriptors;
}

function targets(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
}

export function validatePackedPackage(manifest, entries, descriptor, names, groundTruthFiles = []) {
  const { directory, name, version } = descriptor;
  const issues = releaseMetadataIssues(manifest, directory);
  if (manifest.name !== name || manifest.version !== version) issues.push(`Tarball must be ${name}@${version}`);
  if (!entries.some((entry) => entry.startsWith('package/dist/')))
    issues.push(`${name} tarball contains no dist output`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|link|file):/.test(range))
        issues.push(`${name} tarball contains local dependency ${dependency}: ${range}`);
      if (names.has(dependency) && range !== version) issues.push(`${name} must depend on ${dependency}@${version}`);
    }
  }
  for (const target of targets([manifest.main, manifest.types, manifest.exports, manifest.bin])) {
    const path = target.replace(/^\.\//, '');
    const pattern = new RegExp(
      `^package/${path
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    if (path.split('/').includes('..') || !entries.some((entry) => pattern.test(entry))) {
      issues.push(`${name} tarball is missing entry point ${target}`);
    }
  }
  if (directory === 'packages/surface') {
    for (const path of groundTruthFiles) {
      if (!entries.includes(`package/${path}`)) issues.push(`${name} tarball is missing ${path}`);
    }
    const forbidden = entries.find(
      (entry) =>
        /\/(captures|captures-raw|model|probes|references)\//.test(entry) ||
        /\/(findings\.md|groundtruth\.html|upstream\.json)$/.test(entry),
    );
    if (forbidden) issues.push(`${name} tarball leaks repository-only evidence: ${forbidden}`);
  }
  if (directory.startsWith('packages/adapter-')) {
    const forbidden = entries.find(
      (entry) =>
        entry.startsWith('package/surface/') ||
        entry.startsWith('package/scripts/') ||
        entry.includes('/test-support/') ||
        /\.(?:live\.)?test\.(?:js|d\.ts|js\.map|d\.ts\.map)$/.test(entry),
    );
    if (forbidden) issues.push(`${name} tarball leaks repository-only adapter content: ${forbidden}`);
  }
  if (directory === 'packages/testing' && entries.some((entry) => entry.startsWith('package/fixtures/'))) {
    issues.push(`${name} tarball contains vendor fixtures`);
  }
  if (issues.length) throw new Error(issues.join('\n'));
}

// CI and publishing inspect the same bytes. Prepare every tarball before the
// first upload, so a later package's build failure cannot split a release.
export function packReleasePackages(
  root,
  destination,
  descriptors = readReleasePackages(root),
  run = spawnPackageManager,
) {
  const names = new Set(descriptors.map(({ name }) => name));
  const support = descriptors.some(({ directory }) => directory === 'packages/surface')
    ? JSON.parse(readFileSync(join(root, 'support/agents.json'), 'utf8'))
    : { agents: [] };
  const groundTruthFiles = support.agents
    .filter((agent) => agent.groundTruth)
    .map((agent) => agent.groundTruth.replace(/^packages\/surface\//, ''));
  return descriptors.map((descriptor) => {
    const before = new Set(readdirSync(destination));
    const result = run('pnpm', ['--dir', descriptor.directory, 'pack', '--pack-destination', destination], {
      cwd: root,
      stdio: 'inherit',
    });
    if (result.status !== 0)
      throw new Error(`Failed to pack ${descriptor.name}: ${result.error?.message ?? result.status}`);
    const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz') && !before.has(file));
    if (tarballs.length !== 1) throw new Error(`Expected one tarball for ${descriptor.name}; found ${tarballs.length}`);
    const tarballPath = join(destination, tarballs[0]);
    const entries = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', tarballPath, 'package/package.json'], { encoding: 'utf8' }),
    );
    validatePackedPackage(manifest, entries, descriptor, names, groundTruthFiles);
    return { ...descriptor, tarballPath };
  });
}
