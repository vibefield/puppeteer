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

function applicationDirectories(root) {
  const appsRoot = join(root, 'apps');
  if (!existsSync(appsRoot)) return [];
  return readdirSync(appsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => `apps/${entry.name}`)
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

const architectureDependencies = new Map([
  ['packages/core', []],
  ['packages/surface', []],
  ['packages/imposter', ['@vibecook/puppeteer-surface']],
  ['packages/adapter-acp', ['@vibecook/puppeteer-core']],
  ['packages/adapter-claude', ['@vibecook/puppeteer-core']],
  ['packages/adapter-codex', ['@vibecook/puppeteer-core']],
  ['packages/adapter-grok', ['@vibecook/puppeteer-adapter-acp', '@vibecook/puppeteer-core']],
  ['packages/adapter-hermes', ['@vibecook/puppeteer-core']],
  ['packages/adapter-kimi', ['@vibecook/puppeteer-core']],
  ['packages/adapter-opencode', ['@vibecook/puppeteer-core']],
  ['packages/record', ['@vibecook/puppeteer-core']],
  ['packages/testing', ['@vibecook/puppeteer-core']],
  ['packages/workspaces', []],
  ['packages/runtime', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-record', '@vibecook/puppeteer-workspaces']],
  [
    'packages/builtin-providers',
    [
      '@vibecook/puppeteer-adapter-acp',
      '@vibecook/puppeteer-adapter-claude',
      '@vibecook/puppeteer-adapter-codex',
      '@vibecook/puppeteer-adapter-grok',
      '@vibecook/puppeteer-adapter-hermes',
      '@vibecook/puppeteer-adapter-kimi',
      '@vibecook/puppeteer-adapter-opencode',
      '@vibecook/puppeteer-core',
      '@vibecook/puppeteer-runtime',
    ],
  ],
  ['packages/monitor', ['@vibecook/puppeteer-core']],
  ['packages/react', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-monitor']],
  [
    'apps/godview',
    [
      '@vibecook/puppeteer-builtin-providers',
      '@vibecook/puppeteer-core',
      '@vibecook/puppeteer-monitor',
      '@vibecook/puppeteer-react',
      '@vibecook/puppeteer-record',
      '@vibecook/puppeteer-runtime',
      '@vibecook/puppeteer-workspaces',
    ],
  ],
  [
    'apps/imposter-control',
    [
      '@vibecook/puppeteer-adapter-claude',
      '@vibecook/puppeteer-adapter-codex',
      '@vibecook/puppeteer-adapter-hermes',
      '@vibecook/puppeteer-adapter-kimi',
      '@vibecook/puppeteer-adapter-opencode',
      '@vibecook/puppeteer-core',
      '@vibecook/puppeteer-imposter',
    ],
  ],
]);

const retiredRepositoryPaths = [
  'apps/godview/src/main/latest-value-queue.ts',
  'apps/godview/src/renderer/legacy-agent-state.ts',
  'apps/emulator',
  'docs/monitor-v2-canary.md',
  'draft/DESIGN.md',
  'draft/IMPLEMENTATION-PLAN.md',
  'draft/ADAPTING-AN-AGENT.md',
  'draft/NORMALIZATION-DEVKIT.md',
  'draft/SURFACE-ADAPTATION-REFACTOR.md',
  'packages/adapter-acp/src/connection.ts',
  'packages/adapter-acp/src/monitor-evidence.ts',
  'packages/adapter-acp/src/normalizer.ts',
  'packages/adapter-acp/src/scripted-connector.ts',
  'packages/adapter-claude/src/normalizer.ts',
  'packages/adapter-claude/src/observation/account-usage.ts',
  'packages/adapter-claude/src/observation/monitor-evidence.ts',
  'packages/adapter-claude/src/observation/spaghetti',
  'packages/adapter-claude/src/provider-modes.ts',
  'packages/adapter-codex/src/control',
  'packages/adapter-codex/src/control/approvals.ts',
  'packages/adapter-codex/src/normalizer.ts',
  'packages/adapter-codex/src/observation/account-usage.ts',
  'packages/adapter-codex/src/observation/monitor-evidence.ts',
  'packages/adapter-grok/src/account-usage.ts',
  'packages/adapter-grok/src/backend.ts',
  'packages/adapter-grok/src/monitor-evidence.ts',
  'packages/adapter-grok/src/session-observer.ts',
  'packages/adapter-grok/src/services/tui-launch.ts',
  'packages/adapter-grok/src/services/session-discovery.ts',
  'packages/adapter-grok/src/services/session-observer.ts',
  'packages/adapter-hermes/src/monitor-evidence.ts',
  'packages/adapter-hermes/src/normalizer.ts',
  'packages/adapter-hermes/src/questions.ts',
  'packages/adapter-kimi/src/monitor-evidence.ts',
  'packages/adapter-kimi/src/normalizer.ts',
  'packages/adapter-kimi/src/session-observer.ts',
  'packages/adapter-kimi/src/session-store.ts',
  'packages/adapter-kimi/src/services/session-observer.ts',
  'packages/adapter-kimi/src/services/session-store.ts',
  'packages/adapter-kimi/src/tui-session.ts',
  'packages/adapter-opencode/src/backend.ts',
  'packages/adapter-opencode/src/client.ts',
  'packages/adapter-opencode/src/event-stream.ts',
  'packages/adapter-opencode/src/history.ts',
  'packages/adapter-opencode/src/monitor-evidence.ts',
  'packages/adapter-opencode/src/normalizer.ts',
  'packages/core/src/events.ts',
  'packages/core/src/events/state',
  'packages/core/src/account-usage.ts',
  'packages/core/src/session.ts',
  'packages/runtime/src/conversation.ts',
  'packages/runtime/src/creation-registry.ts',
  'packages/runtime/src/environment.ts',
  'packages/runtime/src/event-bus.ts',
  'packages/runtime/src/git-observer.ts',
  'packages/runtime/src/identity.ts',
  'packages/runtime/src/legacy-state-bridge.ts',
  'packages/runtime/src/monitor-clock.ts',
  'packages/runtime/src/monitor-handle.ts',
  'packages/runtime/src/monitor-hub.ts',
  'packages/runtime/src/monitor-ipc.ts',
  'packages/runtime/src/monitor-shadow.ts',
  'packages/testing/src/session-projection.ts',
];

const requiredArchitectureDocuments = [
  'docs/README.md',
  'docs/guides/adapting-an-agent.md',
  'docs/guides/normalization-devkit.md',
  'docs/guides/surface-adaptation.md',
  'docs/rfcs/001-evidence-backed-runtime-observation.md',
  'docs/rfcs/002-modular-agent-events-and-services.md',
  'docs/rfcs/003-native-observation-sources.md',
  'docs/rfcs/004-layered-agent-runtime.md',
];

const requiredLayerPaths = [
  'packages/core/src/adapter/binding.ts',
  'packages/core/src/adapter/index.ts',
  'packages/core/src/events/index.ts',
  'packages/core/src/services/index.ts',
  'packages/runtime/src/agent.ts',
  'packages/runtime/src/events/event-bus.ts',
  'packages/runtime/src/host/environment.ts',
  'packages/runtime/src/identity/creation-registry.ts',
  'packages/runtime/src/identity/runtime-identity.ts',
  'packages/runtime/src/monitor/clock.ts',
  'packages/runtime/src/monitor/handle.ts',
  'packages/runtime/src/observation/git.ts',
  'packages/runtime/src/runtime.ts',
];

/** Exact internal production edges are the executable form of the layered architecture. */
export function architectureDependencyIssues(edges) {
  const issues = [];
  for (const [directory, dependencies] of edges) {
    const declared = architectureDependencies.get(directory);
    if (!declared) {
      issues.push(`${directory} has no layered-architecture dependency rule`);
      continue;
    }
    const allowed = new Set(declared);
    for (const dependency of dependencies) {
      if (!allowed.has(dependency)) {
        issues.push(`${directory} production dependency ${dependency} violates the layered architecture`);
      }
    }
  }
  return issues;
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

export function auditPackageLayout(root = scriptRoot) {
  const issues = [];
  const rootManifest = json(join(root, 'package.json'));
  const directories = packageDirectories(root);
  const applications = applicationDirectories(root);
  const manifests = new Map();
  const applicationManifests = new Map();

  for (const path of retiredRepositoryPaths) {
    if (hasPath(root, path)) issues.push(`${path} is a retired compatibility or rollout path`);
  }
  for (const path of requiredArchitectureDocuments) {
    if (!hasPath(root, path)) issues.push(`${path} is required architecture documentation`);
  }
  for (const path of requiredLayerPaths) {
    if (!hasPath(root, path)) issues.push(`${path} is required by the layered repository structure`);
  }
  for (const script of ['emulator', 'emulator:smoke', 'imposter-control', 'imposter-control:smoke', 'surface:detect']) {
    if (rootManifest.scripts?.[script]) issues.push(`root script ${script} is a retired alias`);
  }

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
    const expectedName = `@vibecook/puppeteer-${leaf}`;
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

  for (const directory of applications) {
    const absolute = join(root, directory);
    if (lstatSync(absolute).isSymbolicLink()) {
      issues.push(`${directory} must be a real directory, not a symlink`);
      continue;
    }
    const manifestPath = join(absolute, 'package.json');
    if (!existsSync(manifestPath)) {
      issues.push(`${directory} has no package.json (orphan application directories are forbidden)`);
      continue;
    }
    const manifest = json(manifestPath);
    applicationManifests.set(directory, manifest);
    if (!architectureDependencies.has(directory)) {
      issues.push(`${directory} has no layered-architecture dependency rule`);
    }
    if (manifest.private !== true) issues.push(`${directory} must remain private`);
    for (const script of ['build', 'typecheck', 'test']) {
      if (typeof manifest.scripts?.[script] !== 'string') issues.push(`${directory} has no ${script} script`);
    }
  }
  for (const directory of [...architectureDependencies.keys()].filter((path) => path.startsWith('apps/'))) {
    if (!applicationManifests.has(directory)) issues.push(`${directory} is a required application`);
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
  } else if (!readFileSync(versionSourcePath, 'utf8').includes(`PUPPETEER_VERSION = '${rootManifest.version}'`)) {
    issues.push(`PUPPETEER_VERSION does not match root version ${rootManifest.version}`);
  }
  const readmePath = join(root, 'README.md');
  if (!existsSync(readmePath)) {
    issues.push('README.md is missing');
  } else if (
    !readFileSync(readmePath, 'utf8').includes(`pnpm add @vibecook/puppeteer-runtime@${rootManifest.version}`)
  ) {
    issues.push(`README install command does not match root version ${rootManifest.version}`);
  }

  const allManifests = new Map([...manifests, ...applicationManifests]);
  const edges = internalProductionEdges(allManifests);
  const nameToDirectory = new Map([...allManifests].map(([directory, manifest]) => [manifest.name, directory]));
  issues.push(...cycleIssues(edges, nameToDirectory));
  issues.push(...architectureDependencyIssues(edges));
  for (const [directory, dependencies] of edges) {
    if (directory.startsWith('packages/adapter-') && dependencies.includes('@vibecook/puppeteer-surface')) {
      issues.push(`${directory} must consume generated projections, not Surface at runtime`);
    }
    if (directory === 'packages/imposter') {
      for (const dependency of dependencies.filter((name) => name.includes('puppeteer-adapter-'))) {
        issues.push(`${directory} must not depend on adapter package ${dependency}`);
      }
    }
  }

  for (const directory of directories.filter((path) => path.startsWith('packages/adapter-'))) {
    for (const child of [
      'src/driver.ts',
      'src/normalization/adapter.ts',
      'src/normalization/index.ts',
      'src/normalization/monitor.ts',
      'src/normalization/pipeline.ts',
      'src/services/event-source.ts',
    ]) {
      if (!hasPath(join(root, directory), child)) issues.push(`${directory}/${child} is required by adapter layout`);
    }
    for (const child of ['surface/model', 'surface/captures', 'surface/captures-raw']) {
      if (hasPath(join(root, directory), child)) issues.push(`${directory}/${child} violates Surface ownership`);
    }
    const files = manifests.get(directory)?.files ?? [];
    if (JSON.stringify(files) !== JSON.stringify(['dist'])) {
      issues.push(`${directory} must publish only dist`);
    }
    if (files.some((entry) => entry === 'surface' || entry.startsWith('surface/'))) {
      issues.push(`${directory} publishes a forbidden Surface path`);
    }
    if (files.some((entry) => entry === 'scripts' || entry.startsWith('scripts/'))) {
      issues.push(`${directory} publishes repository-only generator scripts`);
    }
    if (hasPath(join(root, directory), 'src/test-support')) {
      const buildConfig = json(join(root, directory, 'tsconfig.build.json'));
      if (!buildConfig.exclude?.includes('src/test-support/**')) {
        issues.push(`${directory} must exclude src/test-support/** from published builds`);
      }
    }
  }
  if (hasPath(root, 'packages/imposter/surface') || hasPath(root, 'packages/imposter/vendors')) {
    issues.push('packages/imposter must not own real-vendor Surface evidence');
  }
  const surfaceFiles = manifests.get('packages/surface')?.files ?? [];
  if (JSON.stringify(surfaceFiles) !== JSON.stringify(['dist', 'vendors/*/groundtruth.json'])) {
    issues.push('packages/surface must publish only dist and canonical vendor ground truth');
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
      const vendorVersion = agent.currentVersion;
      if (!html.includes(`name="puppeteer-surface-groundtruth" content="${agent.groundTruth}"`)) {
        issues.push(`${directory}/docs/event-map.html does not name the promoted Surface ground truth`);
      }
      if (!html.includes(`name="puppeteer-last-verified" content="${vendorVersion}"`)) {
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
  console.log(
    `package layout: clean (${packageDirectories(scriptRoot).length} packages, ${applicationDirectories(scriptRoot).length} apps)`,
  );
}
