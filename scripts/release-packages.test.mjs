import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { readReleasePackages, releaseMetadataIssues, validatePackedPackage } from './release-packages.mjs';
import { releaseFixture, updateManifest } from './test-support/release-fixture.mjs';

test('release metadata rejects stale repository identity, fixed provenance, and other registries', (t) => {
  const root = releaseFixture(t);
  const manifest = updateManifest(root, 'packages/core', (pkg) => {
    pkg.repository.url = 'git+https://github.com/vibecook-dev/puppeteer.git';
    pkg.publishConfig.provenance = true;
    pkg.publishConfig.registry = 'https://example.invalid/';
  });
  const issues = releaseMetadataIssues(manifest, 'packages/core');
  assert.equal(issues.length, 3);
  assert.throws(() => readReleasePackages(root), /Release metadata is invalid/);
});

test('release preflight rejects version drift and packages ordered before their dependencies', (t) => {
  const root = releaseFixture(t);
  updateManifest(root, 'packages/core', (pkg) => {
    pkg.version = '9.0.0';
    pkg.dependencies = { '@vibefield/puppeteer-runtime': 'workspace:*' };
  });
  assert.throws(
    () => readReleasePackages(root),
    (error) => error.message.includes('core@1.2.3') && error.message.includes('must publish after'),
  );
});

test('tarball validation checks remapped entry points, executable paths and lockstep dependencies', (t) => {
  const root = releaseFixture(t);
  const descriptor = readReleasePackages(root)[0];
  const manifest = JSON.parse(readFileSync(join(root, descriptor.directory, 'package.json'), 'utf8'));
  const entries = ['package/dist/index.js', 'package/dist/index.d.ts', 'package/package.json'];
  const names = new Set(['@vibefield/puppeteer-runtime']);
  assert.doesNotThrow(() => validatePackedPackage(manifest, entries, descriptor, names));
  manifest.exports['./missing'] = './src/missing.ts';
  manifest.bin = { cli: './bin/missing.mjs' };
  manifest.dependencies = { '@vibefield/puppeteer-runtime': 'workspace:*', local: 'link:../local' };
  assert.throws(
    () => validatePackedPackage(manifest, entries, descriptor, names),
    (error) =>
      error.message.includes('missing entry point ./src/missing.ts') &&
      error.message.includes('missing entry point ./bin/missing.mjs') &&
      error.message.includes('local dependency local') &&
      error.message.includes('runtime@1.2.3'),
  );
});

test('tarball validation preserves the Surface evidence and adapter test exclusions', (t) => {
  const root = releaseFixture(t);
  for (const directory of ['packages/surface', 'packages/adapter-codex', 'packages/testing']) {
    const descriptor = readReleasePackages(root).find((pkg) => pkg.directory === directory);
    const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'));
    const leaked =
      directory === 'packages/surface'
        ? 'package/vendors/codex/model/private.json'
        : directory === 'packages/testing'
          ? 'package/fixtures/vendor.json'
          : 'package/dist/driver.live.test.js';
    assert.throws(
      () =>
        validatePackedPackage(
          manifest,
          ['package/dist/index.js', 'package/dist/index.d.ts', leaked],
          descriptor,
          new Set(),
          ['vendors/codex/groundtruth.json'],
        ),
      /leaks repository-only|contains vendor fixtures/,
    );
  }
});
