import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquisitionBundles } from './assemble-agent-artifacts.mjs';

test('assembly carries an installed-console manifest as the platform artifact', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-assemble-console-'));
  const directory = join(repoRoot, '.agent-adaptation', 'artifacts');
  const bundle = join(directory, 'linux-x64');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'installed-console.json'), '{}\n');
  writeFileSync(join(bundle, 'version.txt'), 'fake 1.2.3\n');
  writeFileSync(
    join(bundle, 'download.json'),
    JSON.stringify({
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      artifactKind: 'installed-console',
      output: '.agent-adaptation/artifacts/linux-x64/installed-console.json',
      sourceUrl: 'https://downloads.example.test/v1.2.3.tar.gz',
    }),
  );

  const artifacts = acquisitionBundles({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    directory,
    platforms: ['linux-x64'],
  });
  assert.equal(artifacts[0].artifactKind, 'installed-console');
  assert.equal(artifacts[0].path, join(bundle, 'installed-console.json'));
});

test('assembly rejects a source archive masquerading as an executable bundle', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-assemble-source-'));
  const directory = join(repoRoot, '.agent-adaptation', 'artifacts');
  const bundle = join(directory, 'linux-x64');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'version.txt'), 'fake 1.2.3\n');
  writeFileSync(
    join(bundle, 'download.json'),
    JSON.stringify({
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      artifactKind: 'source-archive',
      output: '.agent-adaptation/artifacts/linux-x64/source.tar.gz',
    }),
  );

  assert.throws(
    () =>
      acquisitionBundles({
        repoRoot,
        vendor: 'fake',
        version: '1.2.3',
        directory,
        platforms: ['linux-x64'],
      }),
    /has no supported artifact/,
  );
});
