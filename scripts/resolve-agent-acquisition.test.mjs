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
