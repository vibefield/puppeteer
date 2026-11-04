import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadAgentArtifact } from './download-agent-artifact.mjs';
import { acquireAgentArtifacts } from './acquire-agent-artifacts.mjs';
import { acquisitionBundles } from './assemble-agent-artifacts.mjs';
import { resolveAgentAcquisition } from './resolve-agent-acquisition.mjs';
import { materializeReleaseBundle, validateReleaseBundlePolicy, verifyReleaseBundle } from './lib/release-bundle.mjs';

const policy = { entry: 'fake.exe', rootFiles: ['fake.exe', 'package.json'], maxExtractedBytes: 4096 };
const identity = { vendor: 'fake', version: '1.2.3', platform: 'windows-x64', policy, format: 'zip' };

function archive(root, members) {
  const path = join(root, 'input.zip');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', [
    '-c',
    'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for name,data in json.loads(sys.argv[2]).items(): z.writestr(name,data)',
    path,
    JSON.stringify(members),
  ]);
  return readFileSync(path);
}

test('release acquisition retains companion bytes and binds the complete bundle identity', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'release-bundle-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, 'packages/surface/vendors/fake');
  mkdirSync(upstream, { recursive: true });
  const config = {
    vendor: 'fake',
    platforms: ['windows-x64'],
    acquisition: {
      strategy: 'https-template',
      allowedHosts: ['example.test'],
      maxBytes: 4096,
      artifacts: {
        'windows-x64': {
          urls: ['https://example.test/${version}/fake.zip'],
          format: 'zip',
          executableBasenames: ['fake.exe'],
          bundle: policy,
        },
      },
    },
  };
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(config));
  assert.deepEqual(resolveAgentAcquisition(config, identity), {
    artifactKind: 'release-bundle',
    outputName: 'release-bundle.json',
  });
  const bytes = archive(root, {
    'fake/fake.exe': 'not executed',
    'fake/package.json': '{"version":"1.2.3"}',
    'fake/themes/light.json': '{"color":"blue"}',
  });
  const output = 'artifacts/windows-x64/release-bundle.json';
  const metadata = await downloadAgentArtifact({
    repoRoot: root,
    ...identity,
    output,
    fetchImpl: async () => new Response(bytes),
  });
  assert.equal(metadata.artifactKind, 'release-bundle');
  assert.equal(readFileSync(join(root, 'artifacts/windows-x64/release/package.json'), 'utf8'), '{"version":"1.2.3"}');
  const verified = verifyReleaseBundle(join(root, output), identity);
  assert.equal(verified.manifest.tree.fileCount, 3);
  writeFileSync(join(root, 'artifacts/windows-x64/download.json'), JSON.stringify(metadata));
  writeFileSync(join(root, 'artifacts/windows-x64/version.txt'), '1.2.3\n');
  const artifacts = acquisitionBundles({
    repoRoot: root,
    vendor: 'fake',
    version: '1.2.3',
    directory: join(root, 'artifacts'),
    platforms: ['windows-x64'],
  });
  const acquire = () => acquireAgentArtifacts({ repoRoot: root, vendor: 'fake', version: '1.2.3', artifacts });
  const report = acquire();
  assert.equal(report.status, 'complete');
  assert.equal(report.artifacts[0].identity.archiveSha256, verified.manifest.archive.sha256);
  writeFileSync(join(root, 'artifacts/windows-x64/release/themes/light.json'), '{"color":"red"}');
  assert.throws(() => verifyReleaseBundle(join(root, output), identity), /differs/);
  assert.notEqual(acquire().status, 'complete');
});

test('release extraction refuses escaping paths and excessive decompressed bytes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'release-bundle-unsafe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const members of [
    { 'fake/fake.exe': 'x', 'fake/package.json': '{}', 'fake/../../escaped': 'bad' },
    { 'fake/fake.exe': 'x'.repeat(5000), 'fake/package.json': '{}' },
  ]) {
    assert.throws(() =>
      materializeReleaseBundle({
        ...identity,
        bytes: archive(root, members),
        output: join(root, 'release-bundle.json'),
        archiveRoot: 'fake',
      }),
    );
    assert.equal(existsSync(join(root, 'release')), false);
    assert.equal(existsSync(join(root, 'release-bundle.json')), false);
  }
  assert.throws(() => validateReleaseBundlePolicy({ ...policy, entry: '../fake' }, 'zip'), /unsafe/);
  assert.throws(() => validateReleaseBundlePolicy(policy, 'binary'), /requires an archive/);
});
