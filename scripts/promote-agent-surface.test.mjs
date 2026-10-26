import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  applyPromotion,
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

/** A minimal repository whose one staged candidate passes the support ledger once promoted. */
function promotionFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'puppeteer-promote-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(
      join(repoRoot, path),
      typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  };
  const sha256 = `sha256:${'a'.repeat(64)}`;
  const modelDigest = 'b'.repeat(64);
  write('package.json', { name: 'fixture', version: '0.2.1' });
  write('support/agents.json', {
    schemaVersion: 2,
    agents: [
      {
        id: 'fake',
        displayName: 'Fake',
        kind: 'vendor',
        adapterPackage: '@vibefield/puppeteer-adapter-fake',
        persona: 'fake',
        groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
        candidateVersion: '1.0.0',
        status: 'baseline-pending',
        blockers: ['The protected platform lanes have not completed.'],
      },
    ],
  });
  write(
    'README.md',
    '# Fixture\n\n## Agent support\n\n<!-- agent-support:start -->\nstale\n<!-- agent-support:end -->\n',
  );
  write('packages/adapter-fake/package.json', { name: '@vibefield/puppeteer-adapter-fake' });
  write(
    'packages/adapter-fake/docs/event-map.html',
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta name="viewport" content="width=device-width" />\n    <title>map</title>\n  </head>\n</html>\n',
  );
  write('packages/imposter/personas/fake/persona.json', {
    id: 'fake',
    asm: { package: '@vibefield/puppeteer-surface', path: 'vendors/fake' },
  });
  write('packages/surface/vendors/fake/upstream.json', { platforms: ['linux-x64'] });
  write('packages/surface/vendors/fake/groundtruth.json', {
    format: 'puppeteer-groundtruth/1',
    manifest: { vendor: 'fake', vendorVersion: '1.0.0', asmVersion: 3 },
    evidenceIndex: {
      evidenceVersion: 2,
      vendor: 'fake',
      vendorVersion: '1.0.0',
      artifacts: [{ id: 'fake-linux', platform: 'linux-x64', integrity: { status: 'verified', sha256 } }],
      claims: [{ id: 'runtime', artifact: 'fake-linux' }],
      records: [{ kind: 'model-tree', sha256: modelDigest }],
    },
  });
  const verification = {
    commit: 'c'.repeat(40),
    groundTruth: 'packages/surface/vendors/fake/groundtruth.json',
    vendorVersion: '1.0.0',
    replayDigest: 'd'.repeat(64),
    platformReports: [{ platform: 'linux-x64', artifactSha256: sha256 }],
    attestation: {
      provider: 'github-actions',
      repository: 'vibefield/puppeteer',
      workflowRef: 'vibefield/puppeteer/.github/workflows/agent-surface-promotion.yml@refs/heads/adapt/fake',
      runId: '123',
      runAttempt: '1',
      evidenceDigest: modelDigest,
    },
  };
  write('.agent-adaptation/verification.json', verification);
  const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
  return { repoRoot, write, read, verification };
}

test('the promotion transaction moves the ledger, the README badge, and the event map together', () => {
  const { repoRoot, read } = promotionFixture();
  const agent = applyPromotion({
    vendor: 'fake',
    groundTruthPath: 'packages/surface/vendors/fake/groundtruth.json',
    verificationPath: '.agent-adaptation/verification.json',
    repoRoot,
  });
  const ledger = JSON.parse(read('support/agents.json'));
  assert.deepEqual(ledger.agents[0], agent);
  assert.equal(agent.status, 'verified');
  assert.equal(agent.currentVersion, '1.0.0');
  assert.equal(agent.candidateVersion, undefined);
  assert.equal(agent.blockers, undefined);
  assert.equal(agent.introducedInPuppeteer, '0.2.1');
  assert.equal(agent.verification.runId, '123');
  assert.match(
    read('README.md'),
    /\[!\[Fake: verified 1\.0\.0\]\(https:\/\/img\.shields\.io\/badge\/Fake-verified_1\.0\.0-blue\)\]/,
  );
  assert.doesNotMatch(read('README.md'), /stale/);
  // The event-map path follows the ledger's adapter package, not the vendor id.
  const eventMap = read('packages/adapter-fake/docs/event-map.html');
  assert.match(
    eventMap,
    /<meta name="puppeteer-surface-groundtruth" content="packages\/surface\/vendors\/fake\/groundtruth\.json" \/>/,
  );
  assert.match(eventMap, /<meta name="puppeteer-last-verified" content="1\.0\.0" \/>/);
});

test('a promotion the support ledger refuses restores every file it wrote', () => {
  const { repoRoot, write, read, verification } = promotionFixture();
  // An attestation with no run attempt is not durable: the ledger refuses the promoted entry.
  write('.agent-adaptation/verification.json', {
    ...verification,
    attestation: { ...verification.attestation, runAttempt: undefined },
  });
  const paths = ['support/agents.json', 'README.md', 'packages/adapter-fake/docs/event-map.html'];
  const before = paths.map(read);
  assert.throws(
    () =>
      applyPromotion({
        vendor: 'fake',
        groundTruthPath: 'packages/surface/vendors/fake/groundtruth.json',
        verificationPath: '.agent-adaptation/verification.json',
        repoRoot,
      }),
    /fake: verified support has no durable promotion attestation/,
  );
  assert.deepEqual(paths.map(read), before);
});
