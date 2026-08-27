import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireAgentArtifacts, assignmentMap } from './acquire-agent-artifacts.mjs';

function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-acquire-'));
  const vendorRoot = join(repoRoot, 'packages/surface/vendors/fake');
  mkdirSync(join(vendorRoot, 'model/fake@1.2.3'), { recursive: true });
  writeFileSync(join(vendorRoot, 'upstream.json'), JSON.stringify({ platforms: ['darwin-arm64', 'linux-x64'] }));
  const first = join(repoRoot, 'darwin.bin');
  const second = join(repoRoot, 'linux.bin');
  writeFileSync(first, 'darwin');
  writeFileSync(second, 'linux');
  return { repoRoot, vendorRoot, first, second };
}

test('acquisition binds every required platform to bytes and version output without executing it', () => {
  const { repoRoot, first, second } = fixture();
  const report = acquireAgentArtifacts({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    artifacts: [
      { platform: 'darwin-arm64', path: first, versionOutput: 'fake 1.2.3' },
      { platform: 'linux-x64', path: second, versionOutput: 'fake-cli 1.2.3' },
    ],
    now: () => new Date('2026-08-09T00:00:00Z'),
  });
  assert.equal(report.status, 'complete');
  assert.equal(report.artifacts.length, 2);
  assert.ok(report.artifacts.every((artifact) => /^sha256:[0-9a-f]{64}$/.test(artifact.sha256)));
  assert.ok(report.artifacts.every((artifact) => !artifact.file.includes(repoRoot)));
});

test('same-version changed bytes are quarantined as a republished artifact', () => {
  const { repoRoot, vendorRoot, first, second } = fixture();
  writeFileSync(
    join(vendorRoot, 'model/fake@1.2.3/evidence.json'),
    JSON.stringify({
      artifacts: [{ platform: 'darwin-arm64', integrity: { sha256: `sha256:${'a'.repeat(64)}` } }],
    }),
  );
  const report = acquireAgentArtifacts({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    artifacts: [
      { platform: 'darwin-arm64', path: first, versionOutput: 'fake 1.2.3' },
      { platform: 'linux-x64', path: second, versionOutput: 'fake 1.2.3' },
    ],
  });
  assert.equal(report.status, 'republished-artifact');
  assert.equal(report.republished[0].platform, 'darwin-arm64');
});

test('CLI assignments reject repeated platform keys instead of silently replacing them', () => {
  assert.throws(
    () => assignmentMap('--artifact', ['darwin-arm64=first', 'darwin-arm64=second']),
    /repeats platform darwin-arm64/,
  );
});

test('source-only acquisition refuses archive bytes without an installed-console manifest', () => {
  const { repoRoot, vendorRoot, first } = fixture();
  writeFileSync(
    join(vendorRoot, 'upstream.json'),
    JSON.stringify({
      platforms: ['darwin-arm64'],
      acquisition: { strategy: 'source-revision', installedConsole: {} },
    }),
  );
  const report = acquireAgentArtifacts({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    artifacts: [{ platform: 'darwin-arm64', path: first, versionOutput: 'fake 1.2.3' }],
  });
  assert.equal(report.status, 'incomplete');
  assert.ok(report.issues.some((issue) => issue.includes('installed-console manifest')));
});

test('source-only acquisition binds a composite installed-console manifest instead of wrapper bytes', () => {
  const { repoRoot, vendorRoot, first } = fixture();
  writeFileSync(
    join(vendorRoot, 'upstream.json'),
    JSON.stringify({
      platforms: ['darwin-arm64'],
      acquisition: {
        strategy: 'source-revision',
        installedConsole: {
          strategy: 'python-uv-lock',
          uvVersion: '0.9.28',
          pythonVersion: '3.11.9',
          projectFile: 'pyproject.toml',
          lockFile: 'uv.lock',
          distribution: 'fake',
          consoleScript: 'fake',
          installMode: 'editable',
          generatedSourcePaths: ['fake.egg-info'],
          versionOutput: 'first-line',
          isolatedHomeEnvironment: ['FAKE_HOME'],
        },
      },
    }),
  );
  const digest = (character) => `sha256:${character.repeat(64)}`;
  const distributionInventory = [{ fileCount: 10, filesSha256: digest('4'), name: 'fake', version: '1.2.3' }];
  const environmentSha256 = `sha256:${createHash('sha256')
    .update(JSON.stringify(distributionInventory))
    .digest('hex')}`;
  const consoleBinding = {
    distribution: 'fake',
    distributionVersion: '1.2.3',
    entryPoint: 'fake:main',
    launcher: 'bin/fake',
    script: 'fake',
  };
  const bindingSha256 = `sha256:${createHash('sha256')
    .update('sha256-console-binding-v1\0')
    .update(JSON.stringify(consoleBinding))
    .digest('hex')}`;
  writeFileSync(
    first,
    JSON.stringify({
      schemaVersion: 1,
      artifactKind: 'installed-console',
      identityAlgorithm: 'sha256-installed-console-manifest-v1',
      vendor: 'fake',
      version: '1.2.3',
      platform: 'darwin-arm64',
      source: {
        archiveSha256: digest('a'),
        reference: 'v1.2.3',
        archiveRoot: 'fake-v1.2.3',
        tree: { digestAlgorithm: 'sha256-path-content-v1', sha256: digest('2') },
        generated: {
          roots: ['fake.egg-info'],
          fileCount: 4,
          digestAlgorithm: 'sha256-generated-source-trees-v1',
          sha256: digest('3'),
        },
        projectFile: { path: 'pyproject.toml', sha256: digest('b') },
        lockFile: { path: 'uv.lock', sha256: digest('c') },
      },
      materialization: {
        strategy: 'python-uv-lock',
        uvVersion: '0.9.28',
        pythonVersion: '3.11.9',
        frozen: true,
        exact: true,
        editable: true,
        defaultGroups: false,
      },
      runtime: {
        implementation: 'cpython',
        pythonVersion: '3.11.9',
        cacheTag: 'cpython-311',
        executableSha256: digest('d'),
        stdlibFileCount: 100,
        stdlibSha256: digest('e'),
      },
      environment: {
        digestAlgorithm: 'sha256-python-installed-files-v1',
        pathNormalization: ['python-environment', 'source-root'],
        excludedInstallMetadata: ['RECORD', 'direct_url.json', 'uv_cache.json'],
        excludedGeneratedLaunchers: true,
        distributionCount: 1,
        sha256: environmentSha256,
        distributions: distributionInventory,
      },
      console: {
        distribution: 'fake',
        distributionVersion: '1.2.3',
        script: 'fake',
        installMode: 'editable',
        entryPoint: 'fake:main',
        sourceBinding: 'direct-url',
        launcher: 'bin/fake',
        bindingDigestAlgorithm: 'sha256-console-binding-v1',
        bindingSha256,
        versionOutput: 'fake 1.2.3',
      },
    }),
  );
  const report = acquireAgentArtifacts({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    artifacts: [{ platform: 'darwin-arm64', path: first, versionOutput: 'fake 1.2.3' }],
    now: () => new Date('2026-08-09T00:00:00Z'),
  });
  assert.equal(report.status, 'complete');
  assert.equal(report.artifacts[0].artifactKind, 'installed-console');
  assert.equal(report.artifacts[0].identity.pythonExecutableSha256, digest('d'));
  assert.equal(report.artifacts[0].identity.pythonStandardLibrarySha256, digest('e'));
  assert.equal(report.artifacts[0].identity.environmentSha256, environmentSha256);
  assert.equal(report.artifacts[0].identity.consoleBindingSha256, bindingSha256);
});
