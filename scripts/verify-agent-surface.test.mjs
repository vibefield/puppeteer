import assert from 'node:assert/strict';
import test from 'node:test';
import { platformVerification } from './write-platform-verification.mjs';
import { validatePlatformReports } from './verify-agent-surface.mjs';

test('platform verification binds the tested job to the acquired artifact digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const report = platformVerification({
    artifactReport: {
      vendor: 'fake',
      version: '1.2.3',
      artifacts: [{ platform: 'linux-x64', sha256: digest, versionOutput: 'fake 1.2.3' }],
    },
    platform: 'linux-x64',
    artifactSha256: digest,
    actualVersionOutput: 'fake 1.2.3',
    checks: { surfaceAudit: 'passed', adapterReal: 'passed' },
    environment: { GITHUB_RUN_ID: '123' },
  });
  assert.equal(report.status, 'passed');
  assert.deepEqual(
    validatePlatformReports({
      evidence: { artifacts: [{ platform: 'linux-x64', integrity: { status: 'verified', sha256: digest } }] },
      requiredPlatforms: ['linux-x64'],
      reports: [report],
      vendor: 'fake',
      vendorVersion: '1.2.3',
    }),
    [],
  );
});

test('platform verification refuses a different binary or self-asserted version gate', () => {
  const report = platformVerification({
    artifactReport: {
      vendor: 'fake',
      version: '1.2.3',
      artifacts: [{ platform: 'linux-x64', sha256: `sha256:${'a'.repeat(64)}`, versionOutput: 'fake 1.2.3' }],
    },
    platform: 'linux-x64',
    artifactSha256: `sha256:${'b'.repeat(64)}`,
    actualVersionOutput: 'fake 1.2.3',
    checks: { binaryVersion: 'passed', surfaceAudit: 'passed', adapterReal: 'passed' },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.binaryVersion, 'failed');
});

test('a passing string cannot substitute for a missing platform or mismatched digest', () => {
  assert.deepEqual(
    validatePlatformReports({
      evidence: { artifacts: [] },
      requiredPlatforms: ['darwin-arm64'],
      reports: [],
      vendor: 'fake',
      vendorVersion: '1.2.3',
    }),
    ['missing platform report for darwin-arm64'],
  );
});
