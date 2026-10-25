import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  downloadAgentArtifact,
  resolveArtifactDownload,
  resolveSourceArchiveRoot,
} from './download-agent-artifact.mjs';

const config = {
  vendor: 'fake',
  platforms: ['linux-x64'],
  acquisition: {
    allowedHosts: ['downloads.example.test'],
    maxBytes: 100,
    artifacts: {
      'linux-x64': {
        urls: ['https://downloads.example.test/${version}/fake'],
        format: 'binary',
        executableBasenames: ['fake'],
      },
    },
  },
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entry, content) {
  const name = Buffer.from(entry);
  const bytes = Buffer.from(content);
  const checksum = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + bytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

test('artifact URLs expand only the reviewed version field and host', () => {
  const resolved = resolveArtifactDownload(config, 'linux-x64', '1.2.3');
  assert.equal(resolved.artifactKind, 'standalone-executable');
  assert.deepEqual(resolved.urls, ['https://downloads.example.test/1.2.3/fake']);
});

test('downloader writes bounded bytes but never runs them', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(config));
  let calls = 0;
  const metadata = await downloadAgentArtifact({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    platform: 'linux-x64',
    output: 'artifacts/fake',
    fetchImpl: async (url) => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-length': '5' }),
        arrayBuffer: async () => Buffer.from('bytes'),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(repoRoot, 'artifacts', 'fake'), 'utf8'), 'bytes');
  assert.equal(metadata.artifactKind, 'standalone-executable');
});

test('source downloads require an exact tag and retain the reviewed archive bytes', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-source-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  const sourceConfig = {
    vendor: 'fake',
    platforms: ['linux-x64'],
    acquisition: {
      strategy: 'source-revision',
      allowedHosts: ['downloads.example.test'],
      maxBytes: 1_000,
      sourceArchive: {
        urls: ['https://downloads.example.test/refs/${tag}.zip'],
        format: 'zip',
        rootFiles: ['pyproject.toml'],
      },
    },
  };
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(sourceConfig));
  const archive = storedZip('fake-v1.2.3/pyproject.toml', '[project]');

  await assert.rejects(
    downloadAgentArtifact({
      repoRoot,
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      output: 'artifacts/source.zip',
      fetchImpl: async () => assert.fail('a tag-less source URL must fail before download'),
    }),
    /normalized release tag is required/,
  );

  const metadata = await downloadAgentArtifact({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    platform: 'linux-x64',
    tag: 'v1.2.3',
    output: 'artifacts/source.zip',
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-length': String(archive.length) }),
      arrayBuffer: async () => archive,
    }),
  });

  assert.deepEqual(readFileSync(join(repoRoot, 'artifacts', 'source.zip')), archive);
  assert.equal(metadata.artifactKind, 'source-archive');
  assert.equal(metadata.sourceReference, 'v1.2.3');
  assert.equal(metadata.archiveRoot, 'fake-v1.2.3');
});

test('source downloads reject archives without the reviewed project-root files', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-source-root-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  const sourceConfig = {
    vendor: 'fake',
    platforms: ['linux-x64'],
    acquisition: {
      strategy: 'source-revision',
      allowedHosts: ['downloads.example.test'],
      maxBytes: 1_000,
      sourceArchive: {
        urls: ['https://downloads.example.test/refs/${tag}.zip'],
        format: 'zip',
        rootFiles: ['pyproject.toml'],
      },
    },
  };
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(sourceConfig));
  const archive = storedZip('fake-v1.2.3/README.md', 'missing project metadata');

  await assert.rejects(
    downloadAgentArtifact({
      repoRoot,
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      tag: 'v1.2.3',
      output: 'artifacts/source.zip',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-length': String(archive.length) }),
        arrayBuffer: async () => archive,
      }),
    }),
    /exactly one reviewed project root/,
  );
  assert.equal(existsSync(join(repoRoot, 'artifacts', 'source.zip')), false);
});

test('source root resolution distinguishes root package metadata from nested workspaces', () => {
  assert.equal(
    resolveSourceArchiveRoot(
      [
        'release/pyproject.toml',
        'release/package.json',
        'release/ui-tui/package.json',
        'release/other/package.json',
        'release/ui-tui/scripts/build.mjs',
      ],
      ['pyproject.toml', 'package.json', 'ui-tui/package.json', 'ui-tui/scripts/build.mjs'],
    ),
    'release',
  );
});

test('downloader extracts one reviewed executable from a ZIP release', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-zip-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  const zipConfig = structuredClone(config);
  zipConfig.acquisition.maxBytes = 1_000;
  zipConfig.acquisition.artifacts['linux-x64'].format = 'zip';
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(zipConfig));
  const archive = storedZip('release/fake', 'bytes');

  await downloadAgentArtifact({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    platform: 'linux-x64',
    output: 'artifacts/fake',
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: new Headers({ 'content-length': String(archive.length) }),
      arrayBuffer: async () => archive,
    }),
  });

  assert.equal(readFileSync(join(repoRoot, 'artifacts', 'fake'), 'utf8'), 'bytes');
});

test('ZIP extraction rejects unsafe archive paths', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-zip-unsafe-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  const zipConfig = structuredClone(config);
  zipConfig.acquisition.maxBytes = 1_000;
  zipConfig.acquisition.artifacts['linux-x64'].format = 'zip';
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(zipConfig));
  const archive = storedZip('../fake', 'bytes');

  await assert.rejects(
    downloadAgentArtifact({
      repoRoot,
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      output: 'artifacts/fake',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-length': String(archive.length) }),
        arrayBuffer: async () => archive,
      }),
    }),
    /archive contains an unsafe path/,
  );
});

test('ZIP extraction rejects option-like archive entries', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-zip-option-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  const zipConfig = structuredClone(config);
  zipConfig.acquisition.maxBytes = 1_000;
  zipConfig.acquisition.artifacts['linux-x64'].format = 'zip';
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(zipConfig));
  const archive = storedZip('-x/fake', 'bytes');

  await assert.rejects(
    downloadAgentArtifact({
      repoRoot,
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      output: 'artifacts/fake',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-length': String(archive.length) }),
        arrayBuffer: async () => archive,
      }),
    }),
    /archive contains an unsafe path/,
  );
});

test('downloader cancels an oversized response stream before buffering the artifact', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-limit-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(config));
  let chunk = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(60));
      chunk += 1;
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    downloadAgentArtifact({
      repoRoot,
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      output: 'artifacts/fake',
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        url,
        headers: new Headers(),
        body,
        arrayBuffer: async () => {
          throw new Error('streaming responses must not be buffered wholesale');
        },
      }),
    }),
    /artifact download failed:[\s\S]*exceeds 100 bytes/,
  );
  assert.equal(cancelled, true);
  assert.equal(existsSync(join(repoRoot, 'artifacts', 'fake')), false);
});

test('downloader records the reviewed URL, not the signed URL it was redirected to', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-signed-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  mkdirSync(upstream, { recursive: true });
  const signedConfig = {
    ...config,
    acquisition: { ...config.acquisition, allowedHosts: ['downloads.example.test', 'assets.example.test'] },
  };
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(signedConfig));
  const signed = 'https://assets.example.test/asset/1?sig=c2lnbmF0dXJl&jwt=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2ln';
  const requested = [];
  const metadata = await downloadAgentArtifact({
    repoRoot,
    vendor: 'fake',
    version: '1.2.3',
    platform: 'linux-x64',
    output: 'artifacts/fake',
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === 'https://downloads.example.test/1.2.3/fake') {
        return { ok: false, status: 302, url, headers: new Headers({ location: signed }) };
      }
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ 'content-length': '5' }),
        arrayBuffer: async () => Buffer.from('bytes'),
      };
    },
  });
  assert.deepEqual(requested, ['https://downloads.example.test/1.2.3/fake', signed]);
  assert.equal(readFileSync(join(repoRoot, 'artifacts', 'fake'), 'utf8'), 'bytes');
  assert.equal(metadata.sourceUrl, 'https://downloads.example.test/1.2.3/fake');
  assert.doesNotMatch(JSON.stringify(metadata), /sig=|jwt=|eyJ/);
});

test('downloader validates every redirect before contacting the next origin', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-download-redirect-'));
  const upstream = join(repoRoot, 'packages', 'surface', 'vendors', 'fake');
  mkdirSync(upstream, { recursive: true });
  writeFileSync(join(upstream, 'upstream.json'), JSON.stringify(config));
  let calls = 0;

  await assert.rejects(
    downloadAgentArtifact({
      repoRoot,
      vendor: 'fake',
      version: '1.2.3',
      platform: 'linux-x64',
      output: 'artifacts/fake',
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 302,
          url: '',
          headers: new Headers({ location: 'https://unreviewed.example.test/fake' }),
        };
      },
    }),
    /redirected to non-allowlisted origin/,
  );
  assert.equal(calls, 1);
});
