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
  ['packages/native-observation', []],
  ['packages/imposter', ['@vibecook/puppeteer-surface']],
  ['packages/adapter-acp', ['@vibecook/puppeteer-core']],
  ['packages/adapter-antigravity', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-native-observation']],
  ['packages/adapter-claude', ['@vibecook/puppeteer-core']],
  ['packages/adapter-codex', ['@vibecook/puppeteer-core']],
  ['packages/adapter-copilot', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-native-observation']],
  ['packages/adapter-grok', ['@vibecook/puppeteer-adapter-acp', '@vibecook/puppeteer-core']],
  ['packages/adapter-hermes', ['@vibecook/puppeteer-core']],
  ['packages/adapter-kimi', ['@vibecook/puppeteer-core']],
  ['packages/adapter-opencode', ['@vibecook/puppeteer-core']],
  ['packages/adapter-pi', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-native-observation']],
  ['packages/record', ['@vibecook/puppeteer-core']],
  ['packages/testing', ['@vibecook/puppeteer-core']],
  ['packages/workspaces', []],
  ['packages/runtime', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-record', '@vibecook/puppeteer-workspaces']],
  [
    'packages/builtin-providers',
    [
      '@vibecook/puppeteer-adapter-acp',
      '@vibecook/puppeteer-adapter-antigravity',
      '@vibecook/puppeteer-adapter-claude',
      '@vibecook/puppeteer-adapter-codex',
      '@vibecook/puppeteer-adapter-copilot',
      '@vibecook/puppeteer-adapter-grok',
      '@vibecook/puppeteer-adapter-hermes',
      '@vibecook/puppeteer-adapter-kimi',
      '@vibecook/puppeteer-adapter-opencode',
      '@vibecook/puppeteer-adapter-pi',
      '@vibecook/puppeteer-core',
      '@vibecook/puppeteer-runtime',
    ],
  ],
  ['packages/view-sdk', []],
  ['packages/monitor', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-view-sdk']],
  ['packages/react', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-monitor']],
  ['packages/views', ['@vibecook/puppeteer-core', '@vibecook/puppeteer-react', '@vibecook/puppeteer-view-sdk']],
  [
    'apps/godview',
    [
      '@vibecook/puppeteer-builtin-providers',
      '@vibecook/puppeteer-core',
      '@vibecook/puppeteer-monitor',
      '@vibecook/puppeteer-react',
      '@vibecook/puppeteer-record',
      '@vibecook/puppeteer-runtime',
      '@vibecook/puppeteer-view-sdk',
      '@vibecook/puppeteer-views',
      '@vibecook/puppeteer-workspaces',
    ],
  ],
  [
    'apps/imposter-control',
    [
      '@vibecook/puppeteer-adapter-antigravity',
      '@vibecook/puppeteer-adapter-claude',
      '@vibecook/puppeteer-adapter-codex',
      '@vibecook/puppeteer-adapter-copilot',
      '@vibecook/puppeteer-adapter-hermes',
      '@vibecook/puppeteer-adapter-kimi',
      '@vibecook/puppeteer-adapter-opencode',
      '@vibecook/puppeteer-adapter-pi',
      '@vibecook/puppeteer-core',
      '@vibecook/puppeteer-imposter',
    ],
  ],
]);

const retiredRepositoryPaths = [
  'apps/godview/src/main/latest-value-queue.ts',
  'apps/godview/src/main/restore-launch.ts',
  'apps/godview/src/main/scenario-recorder.test.ts',
  'apps/godview/src/main/scenario-recorder.ts',
  // Godview's own spawn-through gateway and shim: the kit (`packages/runtime/src/host/spawn-through`) replaced them.
  'apps/godview/src/main/spawn-through.test.ts',
  'apps/godview/src/main/spawn-through.ts',
  'apps/godview/src/renderer/legacy-agent-state.ts',
  // The monitor-view migration's scaffolding (MV-8, L9): the legacy shim and its frozen views, the view host's bridge,
  // Godview's legacy rows and the MV-2 differential that compared the pre-MV seam through the shim.
  'apps/godview/src/renderer/monitor/differential',
  'apps/godview/src/renderer/monitor/legacy-rows.ts',
  'apps/godview/src/renderer/ScenarioRecordingControl.tsx',
  'apps/godview/src/shim',
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
  'packages/view-sdk/src/host/legacy.ts',
  'packages/views/src/legacy',
  // The window's own ledgers and a view's host-DOM helper (MV-8b, M176 item 5): the backend computes unread and cost
  // once (L5, L11), and a view reads its stage from its input (MV-D19).
  'packages/views/src/monitor/chrome.ts',
  'packages/views/src/monitor/unread.ts',
  'packages/views/src/monitor/usage-history.ts',
  'packages/views/src/monitor/usage-ledger.ts',
  'packages/views/src/views/swarm/physics/context.tsx',
];

const requiredArchitectureDocuments = [
  'docs/README.md',
  'docs/architecture.html',
  'docs/agent-api.html',
  'docs/guides/adapting-an-agent.md',
  'docs/guides/normalization-devkit.md',
  'docs/guides/surface-adaptation.md',
  'docs/rfcs/001-evidence-backed-runtime-observation.md',
  'docs/rfcs/002-modular-agent-events-and-services.md',
  'docs/rfcs/003-native-observation-sources.md',
  'docs/rfcs/004-layered-agent-runtime.md',
];

const requiredLayerPaths = [
  'packages/adapter-claude/src/launch/native-invocation.ts',
  'packages/adapter-antigravity/src/launch/native-invocation.ts',
  'packages/adapter-codex/src/launch/native-invocation.ts',
  'packages/adapter-copilot/src/launch/native-invocation.ts',
  'packages/adapter-grok/src/launch/native-invocation.ts',
  'packages/adapter-hermes/src/launch/native-invocation.ts',
  'packages/adapter-kimi/src/launch/native-invocation.ts',
  'packages/adapter-opencode/src/launch/native-invocation.ts',
  'packages/adapter-pi/src/launch/native-invocation.ts',
  'packages/core/src/adapter/binding.ts',
  'packages/core/src/adapter/index.ts',
  'packages/core/src/events/index.ts',
  'packages/core/src/services/index.ts',
  'packages/core/src/services/launch.ts',
  'packages/core/src/services/provider.ts',
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

const providerNeutralAccountUsagePaths = [
  'packages/runtime/src/services/account-usage-monitor.ts',
  'packages/views/src/usage/account-usage.ts',
  'packages/views/src/usage/UsageColumn.tsx',
];

const forbiddenConsumerUsageTokens = [
  'claude',
  'codex',
  'grok',
  'hermes',
  'kimi',
  'opencode',
  'acp',
  'antigravity',
  'copilot',
  'pi',
  'five_hour',
  'seven_day',
  'cinder_cove',
  'spark',
];

const providerNeutralLaunchPaths = ['apps/godview/src/restore-snapshot.ts'];

const providerNeutralLaunchHostPaths = ['apps/godview/src/main/main.ts'];

const forbiddenConsumerLaunchTokens = [
  'claude',
  'codex',
  'grok',
  'hermes',
  'kimi',
  'opencode',
  'antigravity',
  'copilot',
  'pi',
  'resumeInvocation',
  'resumeLatest',
  'appServerEnv',
  'kimiHome',
  'hermesHome',
  'AI_PERSONA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GROK_HOME',
  'KIMI_CODE_HOME',
  'HERMES_HOME',
  'PUPPETEER_ANTIGRAVITY_HOME',
  'PUPPETEER_ANTIGRAVITY_DATA_ROOT',
  'COPILOT_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'agentOptions',
];

const forbiddenPrivateLaunchTokens = [
  'resumeInvocation',
  'resumeLatest',
  'appServerEnv',
  'kimiHome',
  'hermesHome',
  'AI_PERSONA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GROK_HOME',
  'KIMI_CODE_HOME',
  'HERMES_HOME',
  'PUPPETEER_ANTIGRAVITY_HOME',
  'PUPPETEER_ANTIGRAVITY_DATA_ROOT',
  'COPILOT_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'agentOptions',
];

// The views' visual-branding maps: the services' — the company marks, and the
// names their plans are sold under (RFC 006, "Plans"). The agents' own marks are
// the SDK toolkit's (`marks.ts`) since MV-4 moved AgentIcon into `/react` (M6).
const godviewBrandingPaths = new Set([
  'packages/views/src/icons/ServiceMark.tsx',
  'packages/views/src/icons/service-marks.ts',
]);
const godviewCompositionRootPaths = new Set(['apps/godview/src/main/main.ts']);
const forbiddenGodviewWireTokens = [
  'claudeHookRailFaultInjection',
  'hook_event_name',
  'nativeEvent',
  'ScenarioRecording',
  'transcript_path',
];

function forbiddenTokenPattern(token) {
  // `Pi` is both a provider name and JavaScript's ubiquitous `Math.PI`.
  // Exclude property access without weakening checks for literals, switches,
  // identifiers, or prose that actually names the provider.
  return new RegExp(`${token === 'pi' ? '(?<!\\.)' : ''}\\b${token}\\b`, 'iu');
}

function productionTypeScriptSources(root, directory) {
  const sources = new Map();
  const absoluteRoot = join(root, directory);
  if (!existsSync(absoluteRoot)) return sources;

  function visit(absoluteDirectory) {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:ts|tsx)$/u.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry.name)) {
        continue;
      }
      const path = relative(root, absolutePath).replaceAll('\\', '/');
      sources.set(path, readFileSync(absolutePath, 'utf8'));
    }
  }

  visit(absoluteRoot);
  return sources;
}

export function accountUsageConsumerBoundaryIssues(sources) {
  const issues = [];
  for (const [path, source] of sources) {
    if (/puppeteer-adapter-/i.test(source)) {
      issues.push(`${path} must not import an agent adapter`);
    }
    for (const token of forbiddenConsumerUsageTokens) {
      if (forbiddenTokenPattern(token).test(source)) {
        issues.push(`${path} contains provider-specific account-usage token ${token}`);
      }
    }
  }
  return issues;
}

export function launchConsumerBoundaryIssues(sources) {
  const issues = [];
  for (const [path, source] of sources) {
    if (/puppeteer-adapter-/i.test(source)) issues.push(`${path} must not import an agent adapter`);
    for (const token of forbiddenConsumerLaunchTokens) {
      if (forbiddenTokenPattern(token).test(source)) {
        issues.push(`${path} contains provider-specific launch token ${token}`);
      }
    }
  }
  return issues;
}

/** Main may brand providers, but it still must not reconstruct any provider's private launch recipe. */
export function launchHostBoundaryIssues(sources) {
  const issues = [];
  for (const [path, source] of sources) {
    if (/puppeteer-adapter-/i.test(source)) issues.push(`${path} must not import an agent adapter`);
    for (const token of forbiddenPrivateLaunchTokens) {
      if (forbiddenTokenPattern(token).test(source)) {
        issues.push(`${path} contains private launch token ${token}`);
      }
    }
  }
  return issues;
}

/**
 * Godview is a consumer of normalized providers. Concrete provider names are
 * allowed only in its optional visual-branding maps; provider package assembly
 * is allowed only in the main-process composition root.
 */
export function godviewConsumerBoundaryIssues(sources) {
  const issues = [];
  const providerTokens = new Set([...forbiddenConsumerUsageTokens, ...forbiddenConsumerLaunchTokens]);
  for (const [path, source] of sources) {
    if (/puppeteer-adapter-/iu.test(source)) issues.push(`${path} must not import an agent adapter`);
    if (/puppeteer-builtin-providers/iu.test(source) && !godviewCompositionRootPaths.has(path)) {
      issues.push(`${path} may not compose built-in providers outside Godview's main composition root`);
    }
    if (!godviewBrandingPaths.has(path)) {
      for (const token of providerTokens) {
        if (forbiddenTokenPattern(token).test(source)) {
          issues.push(`${path} contains provider-specific Godview token ${token}`);
        }
      }
    }
    for (const token of forbiddenGodviewWireTokens) {
      if (source.includes(token)) issues.push(`${path} contains provider-native wire token ${token}`);
    }
    for (const command of ['/clear', '/compact', '/exit']) {
      if (source.includes(command)) issues.push(`${path} contains provider-native terminal command ${command}`);
    }
  }
  return issues;
}

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
  issues.push(
    ...accountUsageConsumerBoundaryIssues(
      new Map(
        providerNeutralAccountUsagePaths
          .filter((path) => hasPath(root, path))
          .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
      ),
    ),
  );
  issues.push(
    ...launchConsumerBoundaryIssues(
      new Map(
        providerNeutralLaunchPaths
          .filter((path) => hasPath(root, path))
          .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
      ),
    ),
  );
  // The spawn-through host kit is what every host's shim and gateway run: the same boundary, every file of it.
  issues.push(
    ...launchConsumerBoundaryIssues(productionTypeScriptSources(root, 'packages/runtime/src/host/spawn-through')),
  );
  issues.push(
    ...launchHostBoundaryIssues(
      new Map(
        providerNeutralLaunchHostPaths
          .filter((path) => hasPath(root, path))
          .map((path) => [path, readFileSync(join(root, path), 'utf8')]),
      ),
    ),
  );
  issues.push(...godviewConsumerBoundaryIssues(productionTypeScriptSources(root, 'apps/godview/src')));
  // The views package is Godview's consumer surface moved out of the app: the same boundary holds there.
  issues.push(...godviewConsumerBoundaryIssues(productionTypeScriptSources(root, 'packages/views/src')));
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
      'src/normalization/monitor-capabilities.ts',
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
