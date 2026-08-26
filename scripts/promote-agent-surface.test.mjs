import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validatePlatformEvidence,
  validateVerificationPlatforms,
  promoteLedgerAgent,
  supportVerificationFromReport,
  validatePromotion,
  validateVerificationAttestation,
} from './promote-agent-surface.mjs';

test('promotion atomically replaces a candidate pointer instead of leaving stale state', () => {
  const ledger = {
    agents: [
      {
        id: 'grok',
        status: 'baseline-pending',
        candidateManifest: 'old/candidate/groundtruth.json',
        legacyEvidence: { modelSha256: 'stale' },
      },
    ],
  };
  const verification = { candidateCommit: 'a'.repeat(40) };
  const agent = promoteLedgerAgent(ledger, 'grok', 'new/current/groundtruth.json', '0.2.0', verification);
  assert.equal(agent.status, 'verified');
  assert.equal(agent.currentManifest, 'new/current/groundtruth.json');
  assert.equal(agent.candidateManifest, undefined);
  assert.equal(agent.legacyEvidence, undefined);
  assert.equal(agent.verification, verification);
  assert.equal(agent.introducedInPuppeteer, '0.2.0');
});

test('promotion retains the verification identity after workflow artifacts expire', () => {
  const report = {
    commit: 'a'.repeat(40),
    manifest: 'packages/surface/vendors/fake/model/fake@1.0.0/groundtruth.json',
    replayDigest: 'b'.repeat(64),
    platformReports: [{ platform: 'linux-x64', artifactSha256: `sha256:${'c'.repeat(64)}` }],
    attestation: {
      provider: 'github-actions',
      repository: 'vibecook-dev/puppeteer',
      workflowRef: 'vibecook-dev/puppeteer/.github/workflows/promote.yml@refs/heads/main',
      runId: '123',
      runAttempt: '2',
      evidenceDigest: 'd'.repeat(64),
    },
  };
  assert.deepEqual(supportVerificationFromReport(report), {
    provider: 'github-actions',
    candidateCommit: report.commit,
    manifest: report.manifest,
    evidenceDigest: report.attestation.evidenceDigest,
    replayDigest: report.replayDigest,
    repository: report.attestation.repository,
    workflowRef: report.attestation.workflowRef,
    runId: '123',
    runAttempt: '2',
    platformArtifacts: report.platformReports,
  });
});

test('promotion requires a verification report', () => {
  assert.deepEqual(validatePromotion({ vendor: 'codex' }), ['--manifest is required']);
});

test('promotion binds the report, model digest, commit, workflow, and run attempt', () => {
  const commit = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const verification = {
    commit,
    attestation: {
      provider: 'github-actions',
      repository: 'vibecook-dev/puppeteer',
      workflow: 'Upstream adaptation',
      workflowRef: 'vibecook-dev/puppeteer/.github/workflows/adapt.yml@refs/heads/main',
      runId: '123',
      runAttempt: '2',
      evidenceDigest: digest,
    },
  };
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: commit,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_REPOSITORY: 'vibecook-dev/puppeteer',
    GITHUB_WORKFLOW: 'Upstream adaptation',
    GITHUB_WORKFLOW_REF: 'vibecook-dev/puppeteer/.github/workflows/adapt.yml@refs/heads/main',
  };
  assert.deepEqual(
    validateVerificationAttestation({
      verification,
      evidence: { records: [{ kind: 'model-tree', sha256: digest }] },
      currentCommit: commit,
      environment,
    }),
    [],
  );
  assert.deepEqual(
    validateVerificationAttestation({
      verification,
      evidence: { records: [{ kind: 'model-tree', sha256: 'c'.repeat(64) }] },
      currentCommit: 'd'.repeat(40),
      environment: {},
    }),
    [
      'verification commit does not match the checked-out commit',
      'promotion must run in the attested GitHub Actions workflow and attempt',
      'attestation evidenceDigest does not match the candidate model tree',
    ],
  );
});

test('promotion requires a verified digest for every declared platform', () => {
  const sha256 = `sha256:${'a'.repeat(64)}`;
  const evidence = {
    artifacts: [
      { platform: 'darwin-arm64', integrity: { status: 'verified', sha256 } },
      { platform: 'linux-x64', integrity: { status: 'legacy-missing-digest' } },
    ],
  };
  assert.deepEqual(validatePlatformEvidence(evidence, ['darwin-arm64', 'darwin-x64', 'linux-x64']), [
    'candidate has no verified artifact SHA-256 for required platform darwin-x64',
    'candidate has no verified artifact SHA-256 for required platform linux-x64',
  ]);
});

test('promotion rechecks the exact platform hash summary instead of trusting a passing gate string', () => {
  const darwin = `sha256:${'a'.repeat(64)}`;
  const linux = `sha256:${'b'.repeat(64)}`;
  const evidence = {
    artifacts: [
      { platform: 'darwin-arm64', integrity: { sha256: darwin } },
      { platform: 'linux-x64', integrity: { sha256: linux } },
    ],
  };
  assert.deepEqual(
    validateVerificationPlatforms(
      {
        platformReports: [
          { platform: 'darwin-arm64', artifactSha256: darwin },
          { platform: 'linux-x64', artifactSha256: `sha256:${'c'.repeat(64)}` },
          { platform: 'windows-x64', artifactSha256: `sha256:${'d'.repeat(64)}` },
        ],
      },
      evidence,
      ['darwin-arm64', 'linux-x64'],
    ),
    [
      'verification artifact digest does not match evidence for linux-x64',
      'verification contains unexpected platform artifact windows-x64',
    ],
  );
});
