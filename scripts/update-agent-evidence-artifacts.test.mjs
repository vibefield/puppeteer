import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeArtifactReport } from './update-agent-evidence-artifacts.mjs';

test('complete artifact reports replace legacy identities and preserve claim linkage by platform', () => {
  const evidence = {
    evidenceVersion: 2,
    vendor: 'fake',
    vendorVersion: '2.0.0',
    artifacts: [{ id: 'old', platform: 'linux-x64', integrity: { status: 'legacy-missing-digest' } }],
    claims: [{ id: 'runtime', artifact: 'old', platform: 'linux-x64' }],
  };
  const report = {
    vendor: 'fake',
    version: '2.0.0',
    status: 'complete',
    artifacts: [
      {
        key: `fake@2.0.0@linux-x64@sha256:${'a'.repeat(64)}`,
        platform: 'linux-x64',
        artifactKind: 'installed-console',
        sha256: `sha256:${'a'.repeat(64)}`,
        identity: { environmentSha256: `sha256:${'b'.repeat(64)}` },
        acquiredAt: '2026-08-09T00:00:00.000Z',
        versionOutput: 'fake 2.0.0',
      },
    ],
  };
  mergeArtifactReport({ evidence, report, requiredPlatforms: ['linux-x64'] });
  assert.equal(evidence.artifacts[0].integrity.status, 'verified');
  assert.equal(evidence.artifacts[0].artifactKind, 'installed-console');
  assert.equal(evidence.artifacts[0].identity.environmentSha256, `sha256:${'b'.repeat(64)}`);
  assert.equal(evidence.claims[0].artifact, 'old');
});

test('a report whose source URL carries a query, fragment or credentials never reaches evidence', () => {
  const evidence = () => ({
    evidenceVersion: 2,
    vendor: 'fake',
    vendorVersion: '2.0.0',
    artifacts: [],
    claims: [{ id: 'runtime', platform: 'linux-x64' }],
  });
  const report = (sourceUrl) => ({
    vendor: 'fake',
    version: '2.0.0',
    status: 'complete',
    artifacts: [
      {
        key: `fake@2.0.0@linux-x64@sha256:${'a'.repeat(64)}`,
        platform: 'linux-x64',
        sha256: `sha256:${'a'.repeat(64)}`,
        acquiredAt: '2026-08-09T00:00:00.000Z',
        versionOutput: 'fake 2.0.0',
        sourceUrl,
      },
    ],
  });
  const merged = mergeArtifactReport({
    evidence: evidence(),
    report: report('https://downloads.example.test/2.0.0/fake'),
    requiredPlatforms: ['linux-x64'],
  });
  assert.equal(merged.artifacts[0].sourceUrl, 'https://downloads.example.test/2.0.0/fake');
  // A report written before acquisition refused signed redirect targets.
  for (const sourceUrl of [
    'https://assets.example.test/asset/1?sp=r&sig=c2lnbmF0dXJl&jwt=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2ln',
    'https://downloads.example.test/2.0.0/fake#sig=abc',
    'https://user:secret@downloads.example.test/2.0.0/fake',
    'not a url',
  ]) {
    const target = evidence();
    assert.throws(
      () => mergeArtifactReport({ evidence: target, report: report(sourceUrl), requiredPlatforms: ['linux-x64'] }),
      /^Error: linux-x64 artifact source URL is not a plain https URL$/,
    );
    assert.deepEqual(target.artifacts, []);
  }
});

function reviewedEvidence() {
  return {
    evidenceVersion: 2,
    vendor: 'fake',
    vendorVersion: '2.0.0',
    artifacts: [
      {
        id: 'installed-fake-2.0.0-darwin-arm64',
        platform: 'darwin-arm64',
        channel: 'stable',
        acquiredAt: '2026-08-01T00:00:00.000Z',
        versionOutput: 'fake 2.0.0',
        sourceUrl: 'https://downloads.example.test/2.0.0/fake.tar.gz',
        package: { file: 'fake.tar.gz', sha256: `sha256:${'c'.repeat(64)}` },
        executable: 'bin/fake',
        companions: [{ path: 'bin/fake-helper', sha256: `sha256:${'d'.repeat(64)}` }],
        integrity: { status: 'verified', sha256: `sha256:${'a'.repeat(64)}` },
      },
    ],
    claims: [{ id: 'runtime', artifact: 'installed-fake-2.0.0-darwin-arm64', capturedAt: '2026-08-01T01:00:00.000Z' }],
  };
}

function acquisition(darwinSha256) {
  const artifact = (platform, sha256) => ({
    key: `fake@2.0.0@${platform}@${sha256}`,
    platform,
    artifactKind: 'standalone-executable',
    sha256,
    acquiredAt: '2026-10-25T10:00:00.000Z',
    versionOutput: 'fake 2.0.0',
    sourceUrl: `https://downloads.example.test/2.0.0/fake-${platform}`,
  });
  return {
    vendor: 'fake',
    version: '2.0.0',
    status: 'complete',
    artifacts: [artifact('darwin-arm64', darwinSha256), artifact('linux-x64', `sha256:${'b'.repeat(64)}`)],
  };
}

test('re-acquiring reviewed bytes keeps their provenance and never dates them after the captures they ran', () => {
  const evidence = reviewedEvidence();
  const reviewed = structuredClone(evidence.artifacts[0]);
  mergeArtifactReport({
    evidence,
    report: acquisition(`sha256:${'a'.repeat(64)}`),
    requiredPlatforms: ['darwin-arm64', 'linux-x64'],
  });
  const [darwin, linux] = evidence.artifacts;
  assert.deepEqual(darwin, {
    ...reviewed,
    artifactKind: 'standalone-executable',
    sourceUrl: 'https://downloads.example.test/2.0.0/fake-darwin-arm64',
    acquisitionKey: `fake@2.0.0@darwin-arm64@sha256:${'a'.repeat(64)}`,
  });
  // The census claim stays later than the acquisition of the bytes it ran on.
  assert.ok(evidence.claims[0].capturedAt >= darwin.acquiredAt);
  assert.equal(evidence.claims[0].artifact, reviewed.id);
  // A platform the evidence never held is added from the acquisition.
  assert.equal(linux.id, 'fake-2.0.0-linux-x64');
  assert.equal(linux.acquiredAt, '2026-10-25T10:00:00.000Z');
  assert.deepEqual(linux.integrity, { status: 'verified', sha256: `sha256:${'b'.repeat(64)}` });
});

test('different bytes under a reviewed version are an incident, not an update to the evidence', () => {
  const evidence = reviewedEvidence();
  const before = structuredClone(evidence);
  assert.throws(
    () =>
      mergeArtifactReport({
        evidence,
        report: acquisition(`sha256:${'e'.repeat(64)}`),
        requiredPlatforms: ['darwin-arm64', 'linux-x64'],
      }),
    /^Error: same-version artifact change for darwin-arm64: evidence reviewed sha256:a{64}, but the acquisition holds sha256:e{64}; a republished artifact is an incident, not an update$/,
  );
  assert.deepEqual(evidence, before);
});

test('a fixture corpus or a digest-less legacy entry is replaced by the acquired executable', () => {
  for (const existing of [
    { kind: 'rosetta-fixture-corpus', integrity: { status: 'verified', sha256: `sha256:${'f'.repeat(64)}` } },
    { integrity: { status: 'legacy-missing-digest' } },
  ]) {
    const evidence = reviewedEvidence();
    evidence.artifacts = [{ id: 'installed-fake-2.0.0-darwin-arm64', platform: 'darwin-arm64', ...existing }];
    mergeArtifactReport({
      evidence,
      report: acquisition(`sha256:${'a'.repeat(64)}`),
      requiredPlatforms: ['darwin-arm64', 'linux-x64'],
    });
    assert.equal(evidence.artifacts[0].id, 'installed-fake-2.0.0-darwin-arm64');
    assert.equal(evidence.artifacts[0].kind, undefined);
    assert.equal(evidence.artifacts[0].acquiredAt, '2026-10-25T10:00:00.000Z');
    assert.deepEqual(evidence.artifacts[0].integrity, { status: 'verified', sha256: `sha256:${'a'.repeat(64)}` });
  }
});
