import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquisitionBundles, collectDownloadedBundles } from './assemble-agent-artifacts.mjs';

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

test('each platform bundle comes out of its own downloaded artifact, never a merged one', () => {
  const platforms = ['darwin-arm64', 'linux-x64'];
  const downloads = () => {
    const root = mkdtempSync(join(tmpdir(), 'puppeteer-assemble-downloads-'));
    for (const platform of platforms) {
      mkdirSync(join(root, 'downloads', `promotion-artifact-${platform}`, platform), { recursive: true });
      writeFileSync(join(root, 'downloads', `promotion-artifact-${platform}`, platform, 'agent'), platform);
    }
    return root;
  };
  const collected = downloads();
  collectDownloadedBundles({
    downloads: join(collected, 'downloads'),
    platforms,
    directory: join(collected, 'artifacts'),
  });
  for (const platform of platforms) {
    assert.equal(readFileSync(join(collected, 'artifacts', platform, 'agent'), 'utf8'), platform);
  }

  // An extra artifact uploaded by any job of the run is refused, not merged over a real platform's bundle.
  const extra = downloads();
  mkdirSync(join(extra, 'downloads', 'promotion-artifact-zz', 'linux-x64'), { recursive: true });
  assert.throws(
    () => collectDownloadedBundles({ downloads: join(extra, 'downloads'), platforms, directory: join(extra, 'a') }),
    /^Error: unexpected downloaded artifacts: promotion-artifact-zz$/,
  );
  assert.equal(existsSync(join(extra, 'a')), false);

  // A lane's artifact that also carries another platform's directory is refused.
  const smuggled = downloads();
  mkdirSync(join(smuggled, 'downloads', 'promotion-artifact-darwin-arm64', 'linux-x64'));
  assert.throws(
    () =>
      collectDownloadedBundles({ downloads: join(smuggled, 'downloads'), platforms, directory: join(smuggled, 'a') }),
    /^Error: promotion-artifact-darwin-arm64 must hold only the darwin-arm64 bundle$/,
  );

  const missing = downloads();
  mkdirSync(join(missing, 'empty'));
  assert.throws(
    () => collectDownloadedBundles({ downloads: join(missing, 'empty'), platforms, directory: join(missing, 'a') }),
    /^Error: missing downloaded artifact promotion-artifact-darwin-arm64$/,
  );
});
