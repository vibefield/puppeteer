import assert from 'node:assert/strict';
import test from 'node:test';
import { hostPlatform, platformVerification } from './write-platform-verification.mjs';
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
    adapterReceipt: {
      schemaVersion: 1,
      check: 'adapter-real',
      vendor: 'fake',
      platform: 'linux-x64',
      artifactSha256: digest,
      testId: 'fake:real',
    },
    checks: { surfaceAudit: 'passed' },
    host: 'linux-x64',
    environment: { GITHUB_RUN_ID: '123' },
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.hostPlatform, 'passed');
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
    adapterReceipt: {
      schemaVersion: 1,
      check: 'adapter-real',
      vendor: 'fake',
      platform: 'linux-x64',
      artifactSha256: `sha256:${'b'.repeat(64)}`,
      testId: 'fake:real',
    },
    checks: { binaryVersion: 'passed', surfaceAudit: 'passed', adapterReal: 'passed' },
    host: 'linux-x64',
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.binaryVersion, 'failed');
});

test('a passing adapter string cannot substitute for an artifact-bound live receipt', () => {
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
    host: 'linux-x64',
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.adapterReal, 'failed');
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

test('a lane attests only the platform it runs on, whatever its matrix label says', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const lane = (host, checks = { surfaceAudit: 'passed' }) =>
    platformVerification({
      artifactReport: {
        vendor: 'fake',
        version: '1.2.3',
        artifacts: [{ platform: 'darwin-x64', sha256: digest, versionOutput: 'fake 1.2.3' }],
      },
      platform: 'darwin-x64',
      artifactSha256: digest,
      actualVersionOutput: 'fake 1.2.3',
      adapterReceipt: {
        schemaVersion: 1,
        check: 'adapter-real',
        vendor: 'fake',
        platform: 'darwin-x64',
        artifactSha256: digest,
        testId: 'fake:real',
      },
      checks,
      host,
    });
  assert.equal(lane('darwin-x64').status, 'passed');
  for (const host of ['darwin-arm64', undefined]) {
    const report = lane(host, { surfaceAudit: 'passed', hostPlatform: 'passed' });
    assert.equal(report.status, 'failed');
    assert.equal(report.checks.hostPlatform, 'failed');
    assert.deepEqual(
      validatePlatformReports({
        evidence: { artifacts: [{ platform: 'darwin-x64', integrity: { status: 'verified', sha256: digest } }] },
        requiredPlatforms: ['darwin-x64'],
        reports: [report],
        vendor: 'fake',
        vendorVersion: '1.2.3',
      }),
      ['darwin-x64 platform report does not match verified candidate evidence'],
    );
  }
  assert.equal(hostPlatform({ platform: 'darwin', arch: 'x64', translated: false }), 'darwin-x64');
  // x64 Node under Rosetta on Apple silicon is not a darwin-x64 machine.
  assert.equal(hostPlatform({ platform: 'darwin', arch: 'x64', translated: true }), undefined);
  assert.equal(hostPlatform({ platform: 'win32', arch: 'x64', translated: false }), 'windows-x64');
  assert.equal(hostPlatform({ platform: 'linux', arch: 'x64', translated: false }), 'linux-x64');
  assert.equal(hostPlatform({ platform: 'linux', arch: 'ia32', translated: false }), undefined);
  assert.equal(hostPlatform({ platform: 'freebsd', arch: 'x64', translated: false }), undefined);
});
