import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAgentAcquisition } from './resolve-agent-acquisition.mjs';

test('standalone acquisition resolves one platform executable without source policy', () => {
  assert.deepEqual(
    resolveAgentAcquisition(
      {
        vendor: 'fake',
        platforms: ['windows-x64'],
        acquisition: { strategy: 'https-template' },
      },
      { vendor: 'fake', platform: 'windows-x64' },
    ),
    { artifactKind: 'standalone-executable', outputName: 'agent.exe' },
  );
});

test('source acquisition exposes only its declarative installed-console toolchain', () => {
  assert.deepEqual(
    resolveAgentAcquisition(
      {
        vendor: 'fake',
        platforms: ['linux-x64'],
        acquisition: {
          strategy: 'source-revision',
          sourceArchive: { format: 'tar.gz' },
          installedConsole: {
            strategy: 'python-uv-lock',
            pythonVersion: '3.11.9',
            uvVersion: '0.9.28',
            projectFile: 'pyproject.toml',
            lockFile: 'uv.lock',
            distribution: 'fake',
            consoleScript: 'fake',
            installMode: 'non-editable',
            generatedSourcePaths: [],
            versionOutput: 'single-line',
            isolatedHomeEnvironment: ['FAKE_HOME'],
          },
        },
      },
      { vendor: 'fake', platform: 'linux-x64', sourceReference: 'v1.2.3' },
    ),
    {
      artifactKind: 'installed-console',
      outputName: 'installed-console.json',
      sourceFile: 'source.tar.gz',
      sourceReference: 'v1.2.3',
      pythonVersion: '3.11.9',
      uvVersion: '0.9.28',
      consolePath: 'bin/fake',
      pythonPath: 'bin/python',
    },
  );
});

test('source acquisition fails closed without its exact release reference', () => {
  assert.throws(
    () =>
      resolveAgentAcquisition(
        {
          vendor: 'fake',
          platforms: ['linux-x64'],
          acquisition: { strategy: 'source-revision', installedConsole: { strategy: 'python-uv-lock' } },
        },
        { vendor: 'fake', platform: 'linux-x64' },
      ),
    /requires --source-reference/,
  );
});

test('source acquisition exposes a separately pinned runtime-bundle toolchain when required', () => {
  const installedConsole = {
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
    runtimeBundle: {
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
    },
  };
  const resolved = resolveAgentAcquisition(
    {
      vendor: 'hermes',
      platforms: ['darwin-arm64'],
      acquisition: { strategy: 'source-revision', sourceArchive: { format: 'tar.gz' }, installedConsole },
    },
    { vendor: 'hermes', platform: 'darwin-arm64', sourceReference: 'v2026.8.3' },
  );

  assert.equal(resolved.nodeVersion, '22.22.0');
  assert.equal(resolved.npmVersion, '10.9.4');
  assert.equal(resolved.consolePath, 'bin/hermes');
  assert.equal(resolved.pythonPath, 'bin/python');
  assert.equal(resolved.runtimeRoot, 'runtime');
});

test('source acquisition exposes platform-correct Windows launcher paths', () => {
  const installedConsole = {
    strategy: 'python-uv-lock',
    pythonVersion: '3.11.9',
    uvVersion: '0.9.28',
    projectFile: 'pyproject.toml',
    lockFile: 'uv.lock',
    distribution: 'fake',
    consoleScript: 'fake',
    installMode: 'non-editable',
    generatedSourcePaths: [],
    versionOutput: 'single-line',
    isolatedHomeEnvironment: ['FAKE_HOME'],
  };
  const resolved = resolveAgentAcquisition(
    {
      vendor: 'fake',
      platforms: ['windows-x64'],
      acquisition: { strategy: 'source-revision', sourceArchive: { format: 'zip' }, installedConsole },
    },
    { vendor: 'fake', platform: 'windows-x64', sourceReference: 'v1.2.3' },
  );

  assert.equal(resolved.consolePath, 'Scripts/fake.exe');
  assert.equal(resolved.pythonPath, 'Scripts/python.exe');
});
