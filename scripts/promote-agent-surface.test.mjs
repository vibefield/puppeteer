import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validatePlatformEvidence,
  validateVerificationPlatforms,
  promoteLedgerAgent,
  stampEventMap,
  supportVerificationFromReport,
  validatePromotion,
  validateVerificationAttestation,
} from './promote-agent-surface.mjs';

test('promotion atomically advances the supported version without moving canonical truth', () => {
  const ledger = {
    agents: [
      {
        id: 'grok',
        status: 'baseline-pending',
        groundTruth: 'packages/surface/vendors/grok/groundtruth.json',
        candidateVersion: '1.0.0',
        legacyEvidence: { modelSha256: 'stale' },
        blockers: ['The protected four-platform lane has not completed.'],
      },
    ],
  };
  const verification = { candidateCommit: 'a'.repeat(40) };
  const agent = promoteLedgerAgent(
    ledger,
    'grok',
    'packages/surface/vendors/grok/groundtruth.json',
    '1.0.0',
    '0.2.0',
    verification,
  );
  assert.equal(agent.status, 'verified');
  assert.equal(agent.groundTruth, 'packages/surface/vendors/grok/groundtruth.json');
  assert.equal(agent.currentVersion, '1.0.0');
  assert.equal(agent.candidateVersion, undefined);
  assert.equal(agent.legacyEvidence, undefined);
  // The ledger forbids blockers outside baseline-pending, so a promotion that kept them would roll back.
  assert.equal(agent.blockers, undefined);
  assert.equal(agent.verification, verification);
  assert.equal(agent.introducedInPuppeteer, '0.2.0');
});

test('promotion stamps the adapter event map with the promoted ground truth and version', () => {
  const head = (metas) =>
    `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n${metas}    <title>map</title>\n  </head>\n</html>\n`;
  const gt = 'packages/surface/vendors/grok/groundtruth.json';
  const stamped =
    '    <meta name="puppeteer-surface-groundtruth" content="packages/surface/vendors/grok/groundtruth.json" />\n' +
    '    <meta name="puppeteer-last-verified" content="1.0.70" />\n';
  // A map that never carried the metas (Grok's) gains both, in the head, after the viewport.
  assert.equal(stampEventMap(head(''), gt, '1.0.70'), head(stamped));
  // A map that carries stale metas (Claude's legacy 2.1.207) is updated in place.
  const stale =
    '    <meta name="puppeteer-surface-groundtruth" content="packages/surface/vendors/grok/groundtruth.json" />\n' +
    '    <meta name="puppeteer-last-verified" content="1.0.0" />\n';
  assert.equal(stampEventMap(head(stale), gt, '1.0.70'), head(stamped));
  assert.equal(stampEventMap(stampEventMap(head(''), gt, '1.0.70'), gt, '1.0.70'), head(stamped));
  assert.throws(() => stampEventMap('<html></html>', gt, '1.0.70'), /no viewport meta/);
});

test('promotion retains the verification identity after workflow artifacts expire', () => {
  const report = {
    commit: 'a'.repeat(40),
    groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
    vendorVersion: '1.0.0',
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
    groundTruth: report.groundTruth,
    vendorVersion: report.vendorVersion,
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
  assert.deepEqual(validatePromotion({ vendor: 'codex' }), ['--ground-truth is required']);
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
