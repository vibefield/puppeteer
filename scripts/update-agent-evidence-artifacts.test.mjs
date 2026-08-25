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
        sha256: `sha256:${'a'.repeat(64)}`,
        acquiredAt: '2026-08-09T00:00:00.000Z',
        versionOutput: 'fake 2.0.0',
      },
    ],
  };
  mergeArtifactReport({ evidence, report, requiredPlatforms: ['linux-x64'] });
  assert.equal(evidence.artifacts[0].integrity.status, 'verified');
  assert.equal(evidence.claims[0].artifact, 'old');
});
