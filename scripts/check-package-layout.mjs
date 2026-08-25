#!/usr/bin/env node
/** Structural invariants for the flat `packages/*` workspace. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPackages } from './public-packages.mjs';

const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function keys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

function hasPath(root, path) {
  return existsSync(join(root, path));
}

function packageDirectories(root) {
  const packagesRoot = join(root, 'packages');
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => `packages/${entry.name}`)
    .sort();
}

function internalProductionEdges(manifests) {
  const names = new Set([...manifests.values()].map((manifest) => manifest.name));
  return new Map(
    [...manifests].map(([directory, manifest]) => [
      directory,
      Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter((name) => names.has(name)),
    ]),
  );
}

function cycleIssues(edges, nameToDirectory) {
  const issues = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(directory, path) {
    if (visiting.has(directory)) {
      const start = path.indexOf(directory);
      issues.push(`production dependency cycle: ${[...path.slice(start), directory].join(' -> ')}`);
      return;
    }
    if (visited.has(directory)) return;
    visiting.add(directory);
    for (const name of edges.get(directory) ?? []) {
      const target = nameToDirectory.get(name);
      if (target) visit(target, [...path, directory]);
    }
    visiting.delete(directory);
    visited.add(directory);
  }

  for (const directory of edges.keys()) visit(directory, []);
  return issues;
}

const SPAGHETTI_SDK = '@vibecook/spaghetti-sdk';
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Adapters sharing semantic records must compile against one exact SDK contract. */
export function spaghettiAdapterPinIssues(manifests) {
  const issues = [];
  const pins = [];
  for (const [directory, manifest] of manifests) {
    if (!directory.startsWith('packages/adapter-')) continue;
    const declarations = ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies']
      .map((section) => ({ section, version: manifest[section]?.[SPAGHETTI_SDK] }))
      .filter(({ version }) => version !== undefined);
    const declaredVersions = [...new Set(declarations.map(({ version }) => version))];
    if (declaredVersions.length > 1) {
      issues.push(
        `${directory} declares conflicting ${SPAGHETTI_SDK} pins (${declarations
          .map(({ section, version }) => `${section}=${String(version)}`)
          .join(', ')})`,
      );
      continue;
    }
    const version = declaredVersions[0];
    if (version === undefined) continue;
    if (typeof version !== 'string' || !EXACT_SEMVER.test(version)) {
      issues.push(`${directory} must exactly pin ${SPAGHETTI_SDK}; found ${String(version)}`);
      continue;
    }
    pins.push({ directory, version });
  }
  const versions = [...new Set(pins.map(({ version }) => version))].sort();
  if (versions.length > 1) {
    issues.push(
      `${SPAGHETTI_SDK} adapter pins differ: ${pins
        .sort((left, right) => left.directory.localeCompare(right.directory))
        .map(({ directory, version }) => `${directory}=${version}`)
        .join(', ')}`,
    );
  }
  return issues;
}

export function auditPackageLayout(root = scriptRoot) {
  const issues = [];
  const rootManifest = json(join(root, 'package.json'));
  const directories = packageDirectories(root);
  const manifests = new Map();

  for (const directory of directories) {
    const absolute = join(root, directory);
    if (lstatSync(absolute).isSymbolicLink()) {
      issues.push(`${directory} must be a real directory, not a symlink`);
      continue;
    }
    const manifestPath = join(absolute, 'package.json');
    if (!existsSync(manifestPath)) {
      issues.push(`${directory} has no package.json (orphan/category directories are forbidden)`);
      continue;
    }
    const manifest = json(manifestPath);
    manifests.set(directory, manifest);
    const leaf = directory.slice('packages/'.length);
    const expectedName = `@vibecook/chopsticks-${leaf}`;
    if (manifest.name !== expectedName) issues.push(`${directory} name is ${manifest.name}; expected ${expectedName}`);
    if (manifest.version !== rootManifest.version) {
      issues.push(`${directory} version ${manifest.version} differs from root ${rootManifest.version}`);
    }
    if (manifest.repository?.directory !== directory) {
      issues.push(`${directory} repository.directory is ${manifest.repository?.directory ?? '<missing>'}`);
    }
    if (manifest.engines?.node !== '>=22.18.0') {
      issues.push(`${directory} engines.node is ${manifest.engines?.node ?? '<missing>'}; expected >=22.18.0`);
    }
    const sourceExports = keys(manifest.exports);
    const publishedExports = keys(manifest.publishConfig?.exports);
    if (JSON.stringify(sourceExports) !== JSON.stringify(publishedExports)) {
      issues.push(
        `${directory} source/publish export keys differ (${sourceExports.join(', ')} vs ${publishedExports.join(', ')})`,
      );
    }
    if (typeof manifest.main !== 'string' || !hasPath(absolute, manifest.main)) {
      issues.push(`${directory} source main does not exist: ${manifest.main ?? '<missing>'}`);
    }
    for (const script of ['clean', 'build', 'prepack', 'typecheck', 'test']) {
      if (typeof manifest.scripts?.[script] !== 'string') issues.push(`${directory} has no ${script} script`);
    }
  }

  const declaredPublic = new Map(publicPackages);
  for (const directory of directories) {
    if (manifests.has(directory) && !declaredPublic.has(directory)) {
      issues.push(`${directory} is missing from scripts/public-packages.mjs`);
    }
  }
  for (const [directory, expectedName] of declaredPublic) {
    const manifest = manifests.get(directory);
    if (!manifest) issues.push(`${directory} is listed as public but is not a package`);
    else if (manifest.name !== expectedName)
      issues.push(`${directory} public package name does not match its manifest`);
  }

  const release = json(join(root, 'release-please-config.json'));
  const extraFiles = release.packages?.['.']?.['extra-files'] ?? [];
  const releasedManifests = new Set(
    extraFiles.filter((entry) => entry.type === 'json' && entry.jsonpath === '$.version').map((entry) => entry.path),
  );
  for (const directory of manifests.keys()) {
    const path = `${directory}/package.json`;
    if (!releasedManifests.has(path)) issues.push(`${path} is missing from release-please extra-files`);
  }
  for (const path of releasedManifests) {
    if (!manifests.has(dirname(path))) issues.push(`${path} is stale in release-please extra-files`);
  }
  if (!extraFiles.some((entry) => entry.type === 'generic' && entry.path === 'packages/core/src/version.ts')) {
    issues.push('release-please must update packages/core/src/version.ts');
  }
  const versionSourcePath = join(root, 'packages', 'core', 'src', 'version.ts');
  if (!existsSync(versionSourcePath)) {
    issues.push('packages/core/src/version.ts is missing');
  } else if (!readFileSync(versionSourcePath, 'utf8').includes(`CHOPSTICKS_VERSION = '${rootManifest.version}'`)) {
    issues.push(`CHOPSTICKS_VERSION does not match root version ${rootManifest.version}`);
  }
  const readmePath = join(root, 'README.md');
  if (!existsSync(readmePath)) {
    issues.push('README.md is missing');
  } else if (
    !readFileSync(readmePath, 'utf8').includes(`pnpm add @vibecook/chopsticks-runtime@${rootManifest.version}`)
  ) {
    issues.push(`README install command does not match root version ${rootManifest.version}`);
  }

  const edges = internalProductionEdges(manifests);
  const nameToDirectory = new Map([...manifests].map(([directory, manifest]) => [manifest.name, directory]));
  issues.push(...cycleIssues(edges, nameToDirectory));
  issues.push(...spaghettiAdapterPinIssues(manifests));
  for (const [directory, dependencies] of edges) {
    if (directory.startsWith('packages/adapter-') && dependencies.includes('@vibecook/chopsticks-surface')) {
      issues.push(`${directory} must consume generated projections, not Surface at runtime`);
    }
    if (directory === 'packages/imposter') {
      for (const dependency of dependencies.filter((name) => name.includes('chopsticks-adapter-'))) {
        issues.push(`${directory} must not depend on adapter package ${dependency}`);
      }
    }
  }

  for (const directory of directories.filter((path) => path.startsWith('packages/adapter-'))) {
    for (const child of ['surface/model', 'surface/captures', 'surface/captures-raw']) {
      if (hasPath(join(root, directory), child)) issues.push(`${directory}/${child} violates Surface ownership`);
    }
    const files = manifests.get(directory)?.files ?? [];
    if (files.some((entry) => entry === 'surface' || entry.startsWith('surface/'))) {
      issues.push(`${directory} publishes a forbidden Surface path`);
    }
  }
  if (hasPath(root, 'packages/imposter/surface') || hasPath(root, 'packages/imposter/vendors')) {
    issues.push('packages/imposter must not own real-vendor Surface evidence');
  }
  const surfaceFiles = manifests.get('packages/surface')?.files ?? [];
  if (!surfaceFiles.includes('vendors/*/model/**/*')) {
    issues.push('packages/surface must publish vendors/*/model/**/*');
  }
  const testingFiles = manifests.get('packages/testing')?.files ?? [];
  if (testingFiles.some((entry) => entry.includes('fixture')))
    issues.push('packages/testing must not publish vendor fixtures');
  if (!manifests.get('packages/testing')?.peerDependencies?.vitest) {
    issues.push('packages/testing must declare Vitest as a peer because its conformance export imports it');
  }
  if (!hasPath(root, 'packages/testing/MIGRATION.md')) {
    issues.push('packages/testing must document the 0.2.0 vendor-fixture migration');
  }

  const supportPath = join(root, 'support', 'agents.json');
  if (!existsSync(supportPath)) {
    issues.push('support/agents.json is missing');
  } else {
    const support = json(supportPath);
    for (const agent of support.agents.filter((entry) => ['verified', 'legacy-verified'].includes(entry.status))) {
      const directory = nameToDirectory.get(agent.adapterPackage);
      if (!directory) continue;
      const mapPath = join(root, directory, 'docs', 'event-map.html');
      if (!existsSync(mapPath)) continue;
      const html = readFileSync(mapPath, 'utf8');
      const vendorVersion = json(join(root, agent.currentManifest)).vendorVersion;
      if (!html.includes(`name="chopsticks-surface-manifest" content="${agent.currentManifest}"`)) {
        issues.push(`${directory}/docs/event-map.html does not name the promoted Surface manifest`);
      }
      if (!html.includes(`name="chopsticks-last-verified" content="${vendorVersion}"`)) {
        issues.push(`${directory}/docs/event-map.html lastVerified does not match ${vendorVersion}`);
      }
    }
  }

  return issues.sort();
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === join(scriptRoot, relative(scriptRoot, process.argv[1]));
if (invokedDirectly) {
  const issues = auditPackageLayout();
  if (issues.length > 0) {
    console.error(`package layout: ${issues.length} issue(s)`);
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(`package layout: clean (${packageDirectories(scriptRoot).length} packages)`);
}
