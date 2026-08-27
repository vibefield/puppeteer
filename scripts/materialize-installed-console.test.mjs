import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createInstalledConsoleManifest,
  normalizeInstalledVersionOutput,
  validatePythonUvLockPolicy,
} from './lib/installed-console-contract.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const policy = {
  strategy: 'python-uv-lock',
  pythonVersion: '3.11.9',
  uvVersion: '0.9.28',
  projectFile: 'pyproject.toml',
  lockFile: 'uv.lock',
  distribution: 'hermes-agent',
  consoleScript: 'hermes',
  installMode: 'editable',
  generatedSourcePaths: ['hermes_agent.egg-info'],
  versionOutput: 'first-line',
  isolatedHomeEnvironment: ['HERMES_HOME'],
};

const distributions = [{ name: 'hermes-agent', version: '0.20.0', fileCount: 50, filesSha256: digest('4') }];
const binding = {
  distribution: 'hermes-agent',
  distributionVersion: '0.20.0',
  entryPoint: 'hermes_cli.main:main',
  launcher: 'bin/hermes',
  script: 'hermes',
};
const inventory = {
  schemaVersion: 1,
  runtime: {
    implementation: 'cpython',
    pythonVersion: '3.11.9',
    cacheTag: 'cpython-311',
    executableSha256: digest('1'),
    stdlibFileCount: 100,
    stdlibSha256: digest('2'),
  },
  environment: {
    digestAlgorithm: 'sha256-python-installed-files-v1',
    pathNormalization: ['python-environment', 'source-root'],
    excludedInstallMetadata: ['RECORD', 'direct_url.json', 'uv_cache.json'],
    excludedGeneratedLaunchers: true,
    distributionCount: 1,
    sha256: sha256(
      JSON.stringify(
        distributions.map(({ fileCount, filesSha256, name, version }) => ({ fileCount, filesSha256, name, version })),
      ),
    ),
    distributions,
  },
  console: {
    distribution: 'hermes-agent',
    distributionVersion: '0.20.0',
    installMode: 'editable',
    script: 'hermes',
    entryPoint: 'hermes_cli.main:main',
    sourceBinding: 'direct-url',
    launcher: 'bin/hermes',
    bindingDigestAlgorithm: 'sha256-console-binding-v1',
    bindingSha256: sha256(`sha256-console-binding-v1\0${JSON.stringify(binding)}`),
  },
};

test('installed-console manifests bind source, runtime, environment, console entry point, and observed version', () => {
  const manifest = createInstalledConsoleManifest({
    vendor: 'hermes',
    version: '0.20.0',
    platform: 'darwin-arm64',
    downloadMetadata: { sourceReference: 'v2026.8.3', archiveRoot: 'hermes-agent-2026.8.3' },
    archiveSha256: digest('a'),
    sourceTreeSha256: digest('d'),
    generatedSource: {
      roots: ['hermes_agent.egg-info'],
      fileCount: 7,
      digestAlgorithm: 'sha256-generated-source-trees-v1',
      sha256: digest('e'),
    },
    projectFileSha256: digest('b'),
    lockFileSha256: digest('c'),
    policy,
    inventory,
    versionOutput: 'Hermes Agent v0.20.0 (2026.8.3)\nInstall directory: /private/path\nPython: 3.11.9\n',
  });

  assert.equal(manifest.artifactKind, 'installed-console');
  assert.equal(manifest.source.archiveSha256, digest('a'));
  assert.equal(manifest.source.tree.sha256, digest('d'));
  assert.equal(manifest.source.generated.sha256, digest('e'));
  assert.equal(manifest.materialization.frozen, true);
  assert.equal(manifest.materialization.editable, true);
  assert.equal(manifest.runtime.stdlibSha256, digest('2'));
  assert.equal(manifest.environment.sha256, inventory.environment.sha256);
  assert.equal(manifest.console.bindingSha256, inventory.console.bindingSha256);
  assert.equal(manifest.console.versionOutput, 'Hermes Agent v0.20.0 (2026.8.3)');
  assert.doesNotMatch(JSON.stringify(manifest), /private\/path/);
});

test('installed-console version normalization is explicit and exact', () => {
  assert.equal(
    normalizeInstalledVersionOutput('Hermes Agent v0.20.0\nmore detail\n', '0.20.0', 'first-line'),
    'Hermes Agent v0.20.0',
  );
  assert.throws(
    () => normalizeInstalledVersionOutput('Hermes Agent v0.20.1\n', '0.20.0', 'first-line'),
    /does not identify 0\.20\.0/,
  );
  assert.throws(() => normalizeInstalledVersionOutput('first\nsecond\n', '0.20.0', 'single-line'), /one bounded line/);
});

test('installed-console manifests reject a mismatched Python or distribution version', () => {
  assert.throws(
    () =>
      createInstalledConsoleManifest({
        vendor: 'hermes',
        version: '0.20.0',
        platform: 'darwin-arm64',
        downloadMetadata: { sourceReference: 'v2026.8.3', archiveRoot: 'hermes-agent-2026.8.3' },
        archiveSha256: digest('a'),
        sourceTreeSha256: digest('d'),
        generatedSource: {
          roots: ['hermes_agent.egg-info'],
          fileCount: 7,
          digestAlgorithm: 'sha256-generated-source-trees-v1',
          sha256: digest('e'),
        },
        projectFileSha256: digest('b'),
        lockFileSha256: digest('c'),
        policy,
        inventory: { ...inventory, runtime: { ...inventory.runtime, pythonVersion: '3.12.0' } },
        versionOutput: 'Hermes Agent v0.20.0',
      }),
    /installed Python is 3\.12\.0/,
  );
});

test('installed-console manifests reject tampered environment and console-binding summaries', () => {
  const input = {
    vendor: 'hermes',
    version: '0.20.0',
    platform: 'darwin-arm64',
    downloadMetadata: { sourceReference: 'v2026.8.3', archiveRoot: 'hermes-agent-2026.8.3' },
    archiveSha256: digest('a'),
    sourceTreeSha256: digest('d'),
    generatedSource: {
      roots: ['hermes_agent.egg-info'],
      fileCount: 7,
      digestAlgorithm: 'sha256-generated-source-trees-v1',
      sha256: digest('e'),
    },
    projectFileSha256: digest('b'),
    lockFileSha256: digest('c'),
    policy,
    versionOutput: 'Hermes Agent v0.20.0',
  };
  assert.throws(
    () =>
      createInstalledConsoleManifest({
        ...input,
        inventory: {
          ...inventory,
          environment: {
            ...inventory.environment,
            distributions: [{ ...distributions[0], filesSha256: digest('9') }],
          },
        },
      }),
    /environment digest does not match/,
  );
  assert.throws(
    () =>
      createInstalledConsoleManifest({
        ...input,
        inventory: { ...inventory, console: { ...inventory.console, entryPoint: 'other:main' } },
      }),
    /console binding digest does not match/,
  );
});

test('installed-console policies reject traversal, overlapping output roots, and environment overrides', () => {
  assert.throws(() => validatePythonUvLockPolicy({ ...policy, projectFile: '../pyproject.toml' }), /safe project/);
  assert.throws(
    () =>
      validatePythonUvLockPolicy({
        ...policy,
        generatedSourcePaths: ['generated', 'generated/nested'],
      }),
    /unique, disjoint, safe/,
  );
  assert.throws(
    () => validatePythonUvLockPolicy({ ...policy, isolatedHomeEnvironment: ['HOME'] }),
    /unsafe or reserved/,
  );
});
