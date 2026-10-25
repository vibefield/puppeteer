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
