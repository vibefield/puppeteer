#!/usr/bin/env node
/** Manually promote a fully verified candidate. Detection never calls this. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel } from '@vibecook/puppeteer-surface';
import { auditEvidence } from '../packages/surface/scripts/check-evidence.mjs';
import { renderSupportBlock, updateReadme, validateSupportLedger } from './render-agent-support.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUIRED_GATES = [
  'identity',
  'privacy',
  'model',
  'adapterFixtures',
  'imposter',
  'replayDiff',
  'hermetic',
  'pinnedArtifact',
  'platforms',
  'packaging',
  'documentation',
];

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function insideRepo(path) {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${path} is outside the repository`);
  return absolute;
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateVerificationAttestation({ verification, evidence, currentCommit, environment }) {
  const issues = [];
  const attestation = verification?.attestation;
  if (!/^[0-9a-f]{40}$/.test(verification?.commit ?? '') || verification.commit !== currentCommit) {
    issues.push('verification commit does not match the checked-out commit');
  }
  if (
    attestation?.provider !== 'github-actions' ||
    typeof attestation.repository !== 'string' ||
    !attestation.repository ||
    typeof attestation.workflow !== 'string' ||
    !attestation.workflow ||
    typeof attestation.workflowRef !== 'string' ||
    !attestation.workflowRef ||
    !/^\d+$/.test(attestation.runId ?? '') ||
    !/^\d+$/.test(attestation.runAttempt ?? '')
  ) {
    issues.push('verification has no valid GitHub Actions attestation');
  }
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_SHA !== currentCommit ||
    environment.GITHUB_RUN_ID !== attestation?.runId ||
    environment.GITHUB_RUN_ATTEMPT !== attestation?.runAttempt ||
    environment.GITHUB_REPOSITORY !== attestation?.repository ||
    environment.GITHUB_WORKFLOW !== attestation?.workflow ||
    environment.GITHUB_WORKFLOW_REF !== attestation?.workflowRef
  ) {
    issues.push('promotion must run in the attested GitHub Actions workflow and attempt');
  }
  const modelDigest = evidence?.records?.find((record) => record.kind === 'model-tree')?.sha256;
  if (!/^[0-9a-f]{64}$/.test(attestation?.evidenceDigest ?? '') || attestation.evidenceDigest !== modelDigest) {
    issues.push('attestation evidenceDigest does not match the candidate model tree');
  }
  return issues;
}

/** Promotion requires evidence for the whole declared platform matrix, not a self-asserted gate string. */
export function validatePlatformEvidence(evidence, requiredPlatforms) {
  const verified = new Set(
    (evidence?.artifacts ?? [])
      .filter(
        (artifact) =>
          artifact?.integrity?.status === 'verified' && /^sha256:[0-9a-f]{64}$/.test(artifact.integrity.sha256 ?? ''),
      )
      .map((artifact) => artifact.platform),
  );
  return requiredPlatforms
    .filter((platform) => !verified.has(platform))
    .map((platform) => `candidate has no verified artifact SHA-256 for required platform ${platform}`);
}

export function validateVerificationPlatforms(verification, evidence, requiredPlatforms) {
  const reports = verification?.platformReports;
  if (!Array.isArray(reports)) return ['verification has no platform artifact summary'];
  const issues = [];
  const expected = new Map(
    (evidence?.artifacts ?? []).map((artifact) => [artifact.platform, artifact.integrity?.sha256]),
  );
  const actual = new Map();
  for (const report of reports) {
    if (!report || typeof report.platform !== 'string' || typeof report.artifactSha256 !== 'string') {
      issues.push('verification contains an invalid platform artifact summary');
      continue;
    }
    if (actual.has(report.platform)) issues.push(`verification repeats platform artifact ${report.platform}`);
    actual.set(report.platform, report.artifactSha256);
    if (!requiredPlatforms.includes(report.platform)) {
      issues.push(`verification contains unexpected platform artifact ${report.platform}`);
    }
  }
  for (const platform of requiredPlatforms) {
    if (actual.get(platform) !== expected.get(platform)) {
      issues.push(`verification artifact digest does not match evidence for ${platform}`);
    }
  }
  return issues.sort();
}

export function validatePromotion({
  vendor,
  groundTruthPath,
  verificationPath,
  currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  environment = process.env,
}) {
  const issues = [];
  if (!vendor) return ['--vendor is required'];
  if (!groundTruthPath) return ['--ground-truth is required'];
  if (!verificationPath) return ['--verification is required'];
  const groundTruthAbsolute = insideRepo(groundTruthPath);
  const verificationAbsolute = insideRepo(verificationPath);
  if (!existsSync(groundTruthAbsolute)) return [`ground truth does not exist: ${groundTruthPath}`];
  if (!existsSync(verificationAbsolute)) return [`verification does not exist: ${verificationPath}`];
  const normalizedGroundTruth = relative(root, groundTruthAbsolute).split(sep).join('/');
  if (normalizedGroundTruth !== `packages/surface/vendors/${vendor}/groundtruth.json`) {
    issues.push('ground truth must be the canonical document at the matching Surface vendor root');
  }
  const groundTruth = json(groundTruthAbsolute);
  const manifest = groundTruth.manifest ?? {};
  if (groundTruth.format !== 'puppeteer-groundtruth/1') issues.push('file is not a canonical ground-truth document');
  if (manifest.vendor !== vendor) issues.push(`ground-truth vendor is ${manifest.vendor}`);
  let model;
  try {
    model = loadModel(groundTruthAbsolute);
  } catch (error) {
    issues.push(error.message);
  }
  if (model && model.manifest.asmVersion !== 2) {
    issues.push('promotion requires a fully traced ASM v2 candidate');
  }
  let evidence = groundTruth.evidenceIndex;
  let requiredPlatforms = [];
  if (!evidence) {
    issues.push('candidate ground truth has no evidence index');
  } else {
    if (evidence.vendor !== vendor || evidence.vendorVersion !== manifest.vendorVersion)
      issues.push('evidence identity differs from manifest');
    if (evidence.evidenceVersion !== 2 || !Array.isArray(evidence.claims) || evidence.claims.length === 0) {
      issues.push('promotion requires claim-addressable evidenceVersion 2');
    }
    if (!evidence.artifacts?.some((artifact) => artifact.integrity?.status === 'verified')) {
      issues.push('candidate has no exact artifact SHA-256; legacy-missing-digest cannot be promoted');
    }
    const upstreamPath = resolve(root, 'packages', 'surface', 'vendors', vendor, 'upstream.json');
    if (!existsSync(upstreamPath)) {
      issues.push('candidate vendor has no upstream platform policy');
    } else {
      requiredPlatforms = json(upstreamPath).platforms ?? [];
      issues.push(...validatePlatformEvidence(evidence, requiredPlatforms));
    }
  }
  issues.push(...auditEvidence().map((issue) => `evidence: ${issue}`));
  const verification = json(verificationAbsolute);
  if (
    verification.schemaVersion !== 1 ||
    verification.vendor !== vendor ||
    verification.vendorVersion !== manifest.vendorVersion ||
    verification.groundTruth !== normalizedGroundTruth ||
    verification.status !== 'passed'
  ) {
    issues.push('verification identity/status does not match the candidate ground truth');
  }
  if (!/^[0-9a-f]{64}$/.test(verification.replayDigest ?? '')) {
    issues.push('verification has no exact replay digest');
  }
  issues.push(...validateVerificationPlatforms(verification, evidence, requiredPlatforms));
  for (const gate of REQUIRED_GATES) {
    if (verification.gates?.[gate] !== 'passed') issues.push(`verification gate ${gate} has not passed`);
  }
  issues.push(...validateVerificationAttestation({ verification, evidence, currentCommit, environment }));
  const ledger = json(resolve(root, 'support/agents.json'));
  const agent = ledger.agents.find((entry) => entry.id === vendor);
  if (!agent) issues.push(`support ledger has no ${vendor} entry`);
  if (agent?.groundTruth !== normalizedGroundTruth || agent?.candidateVersion !== manifest.vendorVersion) {
    issues.push('support ledger does not stage this canonical candidate version');
  }
  if (agent?.persona) {
    const personaPath = resolve(root, 'packages', 'imposter', 'personas', agent.persona, 'persona.json');
    const persona = existsSync(personaPath) ? json(personaPath) : undefined;
    const expectedModel = `vendors/${vendor}`;
    if (persona?.asm?.package !== '@vibecook/puppeteer-surface' || persona?.asm?.path !== expectedModel) {
      issues.push('Imposter persona must target the candidate before promotion');
    }
  }
  return issues.sort();
}

export function supportVerificationFromReport(verification) {
  return {
    provider: verification.attestation.provider,
    candidateCommit: verification.commit,
    groundTruth: verification.groundTruth,
    vendorVersion: verification.vendorVersion,
    evidenceDigest: verification.attestation.evidenceDigest,
    replayDigest: verification.replayDigest,
    repository: verification.attestation.repository,
    workflowRef: verification.attestation.workflowRef,
    runId: verification.attestation.runId,
    runAttempt: verification.attestation.runAttempt,
    platformArtifacts: verification.platformReports,
  };
}

export function promoteLedgerAgent(ledger, vendor, groundTruth, vendorVersion, puppeteerVersion, verification) {
  const agent = ledger.agents.find((entry) => entry.id === vendor);
  if (!agent) throw new Error(`support ledger has no ${vendor} entry`);
  if (!verification) throw new Error('promotion requires a durable verification attestation');
  agent.groundTruth = groundTruth;
  agent.currentVersion = vendorVersion;
  delete agent.candidateVersion;
  delete agent.legacyEvidence;
  agent.status = 'verified';
  agent.verification = verification;
  agent.introducedInPuppeteer ??= puppeteerVersion;
  return agent;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const vendor = flag('--vendor');
  const groundTruth = flag('--ground-truth');
  const verification = flag('--verification');
  const issues = validatePromotion({ vendor, groundTruthPath: groundTruth, verificationPath: verification });
  if (issues.length > 0) {
    console.error(`promotion refused (${issues.length} issue(s)):`);
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }

  const ledgerPath = resolve(root, 'support/agents.json');
  const readmePath = resolve(root, 'README.md');
  const oldLedger = readFileSync(ledgerPath, 'utf8');
  const oldReadme = readFileSync(readmePath, 'utf8');
  const ledger = JSON.parse(oldLedger);
  const agent = promoteLedgerAgent(
    ledger,
    vendor,
    relative(root, insideRepo(groundTruth)).split(sep).join('/'),
    json(insideRepo(groundTruth)).manifest.vendorVersion,
    json(resolve(root, 'package.json')).version,
    supportVerificationFromReport(json(insideRepo(verification))),
  );

  try {
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    writeFileSync(readmePath, updateReadme(oldReadme, renderSupportBlock()));
    const after = validateSupportLedger().issues;
    if (after.length > 0) throw new Error(after.join('\n'));
  } catch (error) {
    writeFileSync(ledgerPath, oldLedger);
    writeFileSync(readmePath, oldReadme);
    throw error;
  }
  console.log(`promoted ${vendor}: ${agent.groundTruth} at ${agent.currentVersion}`);
}
