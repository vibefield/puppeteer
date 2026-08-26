#!/usr/bin/env node
/** Validate the promotion ledger and deterministically render README badges. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGroundTruth } from '@vibecook/puppeteer-surface';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const START = '<!-- agent-support:start -->';
const END = '<!-- agent-support:end -->';

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function groundTruth(path) {
  const document = json(path);
  if (document.format !== 'puppeteer-groundtruth/1' || !document.manifest) {
    throw new Error(`${path} is not a canonical Surface ground-truth document`);
  }
  return { document, manifest: document.manifest, evidence: document.evidenceIndex ?? document.legacyEvidenceIndex };
}

function groundTruthForVersion(repoRoot, agent, version) {
  const canonical = groundTruth(join(repoRoot, agent.groundTruth));
  if (canonical.manifest.vendorVersion === version) return canonical;
  const modelRoot = join(repoRoot, 'packages', 'surface', 'vendors', agent.id, 'model', `${agent.id}@${version}`);
  if (!existsSync(join(modelRoot, 'manifest.json'))) {
    throw new Error(`${agent.id}: authoring model does not exist for supported version ${version}`);
  }
  const document = buildGroundTruth(modelRoot);
  return { document, manifest: document.manifest, evidence: document.evidenceIndex ?? document.legacyEvidenceIndex };
}

function shield(value) {
  return value.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_');
}

function packageDirectories(repoRoot) {
  const packages = new Map();
  const packagesRoot = join(repoRoot, 'packages');
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    const directory = join(packagesRoot, entry.name);
    if (!entry.isDirectory() || !entry.name.startsWith('adapter-') || !existsSync(join(directory, 'package.json')))
      continue;
    const manifest = json(join(directory, 'package.json'));
    packages.set(manifest.name, directory);
  }
  return packages;
}

function expectedGroundTruth(agent) {
  return `packages/surface/vendors/${agent.id}/groundtruth.json`;
}

function validatePersona(repoRoot, agent, issues) {
  const personaPath = join(repoRoot, 'packages', 'imposter', 'personas', agent.persona ?? '', 'persona.json');
  if (!existsSync(personaPath)) {
    issues.push(`${agent.id}: persona does not exist: ${agent.persona ?? '<missing>'}`);
    return;
  }
  const persona = json(personaPath);
  const expectedPath = `vendors/${agent.id}`;
  if (persona.asm?.package !== '@vibecook/puppeteer-surface' || persona.asm?.path !== expectedPath) {
    issues.push(`${agent.id}: persona ASM must target the stable canonical root (${expectedPath})`);
  }
}

export function validateSupportLedger(repoRoot = root) {
  const ledgerPath = join(repoRoot, 'support', 'agents.json');
  const ledger = json(ledgerPath);
  const issues = [];
  const ids = new Set();
  const adapters = packageDirectories(repoRoot);
  if (ledger.schemaVersion !== 2 || !Array.isArray(ledger.agents)) {
    issues.push('support ledger must use schemaVersion 2');
  }

  for (const agent of ledger.agents ?? []) {
    if (ids.has(agent.id)) issues.push(`duplicate support id: ${agent.id}`);
    ids.add(agent.id);
    if (!adapters.has(agent.adapterPackage)) {
      issues.push(`${agent.id}: adapter package ${agent.adapterPackage} does not exist`);
    }
    if (agent.status !== 'legacy-verified' && agent.legacyEvidence !== undefined) {
      issues.push(`${agent.id}: only legacy-verified support may carry a frozen legacy attestation`);
    }
    if (agent.status !== 'verified' && agent.verification !== undefined) {
      issues.push(`${agent.id}: only verified support may carry a promotion attestation`);
    }

    const requiresGroundTruth =
      agent.currentVersion !== undefined ||
      agent.candidateVersion !== undefined ||
      ['verified', 'legacy-verified'].includes(agent.status);
    if (!agent.groundTruth) {
      if (requiresGroundTruth) issues.push(`${agent.id}: support state has no canonical groundTruth path`);
      continue;
    }
    if (agent.groundTruth !== expectedGroundTruth(agent)) {
      issues.push(`${agent.id}: groundTruth must be ${expectedGroundTruth(agent)}`);
      continue;
    }
    const groundTruthPath = join(repoRoot, agent.groundTruth);
    if (!existsSync(groundTruthPath)) {
      issues.push(`${agent.id}: canonical ground truth does not exist: ${agent.groundTruth}`);
      continue;
    }

    let active;
    try {
      active = groundTruth(groundTruthPath);
    } catch (error) {
      issues.push(`${agent.id}: ${(error instanceof Error ? error : new Error(String(error))).message}`);
      continue;
    }
    if (active.manifest.vendor !== agent.id) {
      issues.push(`${agent.id}: canonical ground truth declares vendor ${active.manifest.vendor}`);
    }
    const activeVersion = agent.candidateVersion ?? agent.currentVersion;
    if (!activeVersion) {
      issues.push(`${agent.id}: canonical ground truth has no currentVersion or candidateVersion`);
    } else if (active.manifest.vendorVersion !== activeVersion) {
      issues.push(
        `${agent.id}: canonical ground truth is ${active.manifest.vendorVersion}, support selects ${activeVersion}`,
      );
    }
    if (!active.evidence) issues.push(`${agent.id}: canonical ground truth has no evidence index`);
    if (agent.persona) validatePersona(repoRoot, agent, issues);

    if (agent.candidateVersion) {
      if (
        active.manifest.asmVersion !== 2 ||
        active.evidence?.evidenceVersion !== 2 ||
        !active.evidence?.claims?.length
      ) {
        issues.push(`${agent.id}: candidate ground truth requires claim-addressable ASM/evidence v2`);
      }
    }

    if (!['verified', 'legacy-verified'].includes(agent.status)) continue;
    if (!agent.currentVersion) {
      issues.push(`${agent.id}: verified entry has no currentVersion`);
      continue;
    }

    let promoted;
    try {
      promoted = groundTruthForVersion(repoRoot, agent, agent.currentVersion);
    } catch (error) {
      issues.push((error instanceof Error ? error : new Error(String(error))).message);
      continue;
    }
    if (promoted.manifest.vendor !== agent.id || promoted.manifest.vendorVersion !== agent.currentVersion) {
      issues.push(`${agent.id}: promoted authoring model identity does not match ${agent.currentVersion}`);
    }
    if (!promoted.evidence) {
      issues.push(`${agent.id}: promoted authoring model has no evidence index`);
      continue;
    }

    if (agent.status === 'verified') {
      if (
        promoted.manifest.asmVersion !== 2 ||
        promoted.evidence.evidenceVersion !== 2 ||
        !promoted.evidence.claims?.length
      ) {
        issues.push(`${agent.id}: verified support requires claim-addressable ASM/evidence v2`);
      }
      const upstreamPath = join(repoRoot, 'packages', 'surface', 'vendors', agent.id, 'upstream.json');
      const requiredPlatforms = existsSync(upstreamPath) ? (json(upstreamPath).platforms ?? []) : [];
      const verifiedPlatforms = new Set(
        (promoted.evidence.artifacts ?? [])
          .filter(
            (artifact) =>
              artifact.integrity?.status === 'verified' &&
              /^sha256:[0-9a-f]{64}$/.test(artifact.integrity?.sha256 ?? ''),
          )
          .map((artifact) => artifact.platform),
      );
      for (const platform of requiredPlatforms) {
        if (!verifiedPlatforms.has(platform)) {
          issues.push(`${agent.id}: verified support has no immutable artifact for ${platform}`);
        }
      }
      const attestation = agent.verification;
      if (
        attestation?.provider !== 'github-actions' ||
        attestation.groundTruth !== agent.groundTruth ||
        attestation.vendorVersion !== agent.currentVersion ||
        !/^[0-9a-f]{40}$/.test(attestation.candidateCommit ?? '') ||
        !/^[0-9a-f]{64}$/.test(attestation.replayDigest ?? '') ||
        attestation.evidenceDigest !==
          promoted.evidence.records?.find((record) => record.kind === 'model-tree')?.sha256 ||
        typeof attestation.repository !== 'string' ||
        !attestation.repository ||
        typeof attestation.workflowRef !== 'string' ||
        !attestation.workflowRef ||
        !Array.isArray(attestation.platformArtifacts) ||
        !/^\d+$/.test(attestation.runId ?? '') ||
        !/^\d+$/.test(attestation.runAttempt ?? '')
      ) {
        issues.push(`${agent.id}: verified support has no durable promotion attestation`);
      }
      const reportArtifacts = new Map(
        (attestation?.platformArtifacts ?? []).map((artifact) => [artifact.platform, artifact.artifactSha256]),
      );
      if (reportArtifacts.size !== (attestation?.platformArtifacts ?? []).length) {
        issues.push(`${agent.id}: promotion attestation repeats a platform artifact`);
      }
      if (reportArtifacts.size !== requiredPlatforms.length) {
        issues.push(`${agent.id}: promotion attestation platform set differs from policy`);
      }
      for (const platform of requiredPlatforms) {
        const digest = (promoted.evidence.artifacts ?? []).find((artifact) => artifact.platform === platform)?.integrity
          ?.sha256;
        if (reportArtifacts.get(platform) !== digest) {
          issues.push(`${agent.id}: promotion attestation does not bind the ${platform} artifact`);
        }
      }
    } else {
      const frozen = agent.legacyEvidence;
      if (
        frozen?.kind !== 'pre-asm-v2-baseline' ||
        frozen.version !== agent.currentVersion ||
        !/^\d{4}-\d{2}-\d{2}$/.test(frozen.frozenOn ?? '') ||
        typeof frozen.reason !== 'string' ||
        frozen.reason.length === 0
      ) {
        issues.push(`${agent.id}: legacy support must carry an explicit frozen baseline attestation`);
      }
      const modelRecord = (promoted.evidence.records ?? []).find((record) => record.kind === 'model-tree');
      if (!/^[0-9a-f]{64}$/.test(frozen?.modelSha256 ?? '') || modelRecord?.sha256 !== frozen?.modelSha256) {
        issues.push(`${agent.id}: legacy model tree differs from its frozen baseline digest`);
      }
    }
  }
  return { ledger, issues: issues.sort() };
}

export function renderSupportBlock(repoRoot = root) {
  const { ledger, issues } = validateSupportLedger(repoRoot);
  if (issues.length > 0) throw new Error(issues.join('\n'));
  const badges = ledger.agents.map((agent) => {
    let message = agent.status.replace(/-/g, ' ');
    let target = 'support/agents.json';
    let color = 'lightgrey';
    if (['verified', 'legacy-verified'].includes(agent.status)) {
      message = `${message} ${agent.currentVersion}`;
      target = agent.groundTruth;
      color = agent.status === 'verified' ? 'blue' : 'orange';
    } else if (agent.candidateVersion) {
      message = `${message} ${agent.candidateVersion}`;
      target = agent.groundTruth;
    }
    const alt = `${agent.displayName}: ${message}`;
    return `[![${alt}](https://img.shields.io/badge/${shield(agent.displayName)}-${shield(message)}-${color})](${target})`;
  });
  return [START, ...badges, END].join('\n');
}

export function updateReadme(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start >= 0 && end > start) return `${readme.slice(0, start)}${block}${readme.slice(end + END.length)}`;
  const packagesHeading = readme.indexOf('\n## Packages');
  if (packagesHeading < 0) throw new Error('README has no Packages heading for the generated support block');
  return `${readme.slice(0, packagesHeading)}\n\n## Agent support\n\n${block}\n${readme.slice(packagesHeading)}`;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const readmePath = join(root, 'README.md');
  const current = readFileSync(readmePath, 'utf8');
  const expected = updateReadme(current, renderSupportBlock());
  if (mode === 'write') {
    writeFileSync(readmePath, expected);
    console.log('updated README agent support block');
  } else if (current !== expected) {
    console.error('README agent support block is stale; run `pnpm support:write`');
    process.exit(1);
  } else {
    console.log('agent support ledger and README: clean');
  }
}
