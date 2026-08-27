import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createInstalledConsoleManifest } from './lib/installed-console-contract.mjs';
import { createNodeRuntimeBundleManifest, inventoryRuntimeBundle } from './lib/runtime-bundle-contract.mjs';
import { verifyInstalledConsoleReconstruction } from './verify-installed-console-reconstruction.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const runtimePolicy = {
  strategy: 'node-npm-lock-bundle',
  nodeVersion: '22.22.0',
  npmVersion: '10.9.4',
  packageFile: 'package.json',
  lockFile: 'package-lock.json',
  workspace: 'ui-tui',
  workspacePackageFile: 'ui-tui/package.json',
  buildFile: 'ui-tui/scripts/build.mjs',
  outputFile: 'ui-tui/dist/entry.js',
  environmentVariable: 'HERMES_TUI_DIR',
  maxBytes: 33_554_432,
};
const policy = {
  strategy: 'python-uv-lock',
  pythonVersion: '3.11.9',
  uvVersion: '0.9.28',
  projectFile: 'pyproject.toml',
  lockFile: 'uv.lock',
  distribution: 'fake-agent',
  consoleScript: 'fake',
  installMode: 'editable',
  generatedSourcePaths: ['fake_agent.egg-info'],
  versionOutput: 'first-line',
  isolatedHomeEnvironment: ['FAKE_HOME'],
  runtimeBundle: runtimePolicy,
};

function inventory() {
  const distributions = [{ name: 'fake-agent', version: '1.2.3', fileCount: 7, filesSha256: digest('4') }];
  const binding = {
    distribution: 'fake-agent',
    distributionVersion: '1.2.3',
    entryPoint: 'fake.main:main',
    launcher: 'bin/fake',
    script: 'fake',
  };
  return {
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
      distributionCount: distributions.length,
      sha256: sha256(
        JSON.stringify(
          distributions.map(({ fileCount, filesSha256, name, version }) => ({
            fileCount,
            filesSha256,
            name,
            version,
          })),
        ),
      ),
      distributions,
    },
    console: {
      ...binding,
      installMode: 'editable',
      sourceBinding: 'direct-url',
      bindingDigestAlgorithm: 'sha256-console-binding-v1',
      bindingSha256: sha256(`sha256-console-binding-v1\0${JSON.stringify(binding)}`),
    },
  };
}

function fixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-installed-console-reconstruction-'));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const vendorRoot = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  mkdirSync(vendorRoot, { recursive: true });
  writeFileSync(
    join(vendorRoot, 'upstream.json'),
    JSON.stringify({
      vendor: 'fake',
      platforms: ['linux-x64'],
      acquisition: { strategy: 'source-revision', installedConsole: policy },
    }),
  );

  const roots = ['expected', 'actual'].map((name) => join(repoRoot, 'artifacts', name));
  for (const artifactRoot of roots) {
    const runtimeRoot = join(artifactRoot, 'runtime');
    mkdirSync(join(runtimeRoot, 'dist'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'dist', 'entry.js'), 'export const exact = true;\n');
    const runtimeBundle = createNodeRuntimeBundleManifest({
      policy: runtimePolicy,
      nodeExecutableSha256: digest('9'),
      source: {
        packageFile: { path: runtimePolicy.packageFile, sha256: digest('a') },
        lockFile: { path: runtimePolicy.lockFile, sha256: digest('b') },
        workspacePackageFile: { path: runtimePolicy.workspacePackageFile, sha256: digest('c') },
        buildFile: { path: runtimePolicy.buildFile, sha256: digest('d') },
      },
      artifact: inventoryRuntimeBundle(runtimeRoot, 'dist/entry.js'),
    });
    const manifest = createInstalledConsoleManifest({
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      downloadMetadata: { sourceReference: 'v1.2.3', archiveRoot: 'fake-agent-1.2.3' },
      archiveSha256: digest('5'),
      sourceTreeSha256: digest('6'),
      generatedSource: {
        roots: policy.generatedSourcePaths,
        fileCount: 1,
        digestAlgorithm: 'sha256-generated-source-trees-v1',
        sha256: digest('7'),
      },
      projectFileSha256: digest('8'),
      lockFileSha256: digest('e'),
      policy,
      inventory: inventory(),
      runtimeBundle,
      versionOutput: 'Fake Agent 1.2.3\nPython 3.11.9\n',
    });
    writeFileSync(join(artifactRoot, 'installed-console.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return {
    repoRoot,
    expected: join(roots[0], 'installed-console.json'),
    actual: join(roots[1], 'installed-console.json'),
    actualRuntime: join(roots[1], 'runtime', 'dist', 'entry.js'),
  };
}

test('fresh installed-console reconstruction must match the acquired manifest and runtime bytes', (t) => {
  const files = fixture(t);
  const result = verifyInstalledConsoleReconstruction({
    ...files,
    vendor: 'fake',
    version: '1.2.3',
    platform: 'linux-x64',
  });
  assert.equal(result.check, 'installed-console-reconstruction');
  assert.match(result.manifestSha256, /^sha256:[0-9a-f]{64}$/);
});

test('reconstruction rejects a valid but non-identical manifest', (t) => {
  const files = fixture(t);
  const manifest = JSON.parse(readFileSync(files.actual, 'utf8'));
  manifest.runtime.executableSha256 = digest('f');
  writeFileSync(files.actual, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () =>
      verifyInstalledConsoleReconstruction({
        ...files,
        vendor: 'fake',
        version: '1.2.3',
        platform: 'linux-x64',
      }),
    /does not exactly reproduce/,
  );
});

test('reconstruction rejects runtime bytes that no longer match either manifest', (t) => {
  const files = fixture(t);
  writeFileSync(files.actualRuntime, 'tampered\n');
  assert.throws(
    () =>
      verifyInstalledConsoleReconstruction({
        ...files,
        vendor: 'fake',
        version: '1.2.3',
        platform: 'linux-x64',
      }),
    /runtime bundle bytes differ/,
  );
});
