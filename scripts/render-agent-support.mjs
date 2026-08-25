#!/usr/bin/env node
/** Validate the promotion ledger and deterministically render README badges. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const START = '<!-- agent-support:start -->';
const END = '<!-- agent-support:end -->';

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
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

export function validateSupportLedger(repoRoot = root) {
  const ledgerPath = join(repoRoot, 'support', 'agents.json');
  const ledger = json(ledgerPath);
  const issues = [];
  const ids = new Set();
  const adapters = packageDirectories(repoRoot);
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.agents))
    issues.push('support ledger must use schemaVersion 1');

  for (const agent of ledger.agents ?? []) {
    if (ids.has(agent.id)) issues.push(`duplicate support id: ${agent.id}`);
    ids.add(agent.id);
    if (!adapters.has(agent.adapterPackage))
      issues.push(`${agent.id}: adapter package ${agent.adapterPackage} does not exist`);
    if (agent.status !== 'legacy-verified' && agent.legacyEvidence !== undefined) {
      issues.push(`${agent.id}: only legacy-verified support may carry a frozen legacy attestation`);
    }
    if (agent.status !== 'verified' && agent.verification !== undefined) {
      issues.push(`${agent.id}: only verified support may carry a promotion attestation`);
    }
    if (agent.candidateManifest) {
      const candidatePath = join(repoRoot, agent.candidateManifest);
      if (!existsSync(candidatePath)) {
        issues.push(`${agent.id}: candidate manifest does not exist: ${agent.candidateManifest}`);
      } else {
        const candidate = json(candidatePath);
        if (candidate.vendor !== agent.id)
          issues.push(`${agent.id}: candidate manifest declares vendor ${candidate.vendor}`);
        if (!candidate.vendorVersion) issues.push(`${agent.id}: candidate manifest has no vendorVersion`);
        if (!candidate.evidence || !existsSync(join(dirname(candidatePath), candidate.evidence))) {
          issues.push(`${agent.id}: candidate manifest has no evidence index`);
        }
        const personaPath = join(repoRoot, 'packages', 'imposter', 'personas', agent.persona ?? '', 'persona.json');
        if (!existsSync(personaPath)) {
          issues.push(`${agent.id}: candidate persona does not exist: ${agent.persona ?? '<missing>'}`);
        } else {
          const persona = json(personaPath);
          const surfaceRoot = join(repoRoot, 'packages', 'surface');
          const expectedModel = relative(surfaceRoot, dirname(candidatePath)).split(sep).join('/');
          if (persona.asm?.package !== '@vibecook/chopsticks-surface' || persona.asm?.path !== expectedModel) {
            issues.push(`${agent.id}: candidate persona ASM does not match candidate manifest (${expectedModel})`);
          }
        }
      }
    }
    if (!['verified', 'legacy-verified'].includes(agent.status)) continue;
    if (!agent.currentManifest) {
      issues.push(`${agent.id}: verified entry has no currentManifest`);
      continue;
    }
    const manifestPath = join(repoRoot, agent.currentManifest);
    if (!existsSync(manifestPath)) {
      issues.push(`${agent.id}: manifest does not exist: ${agent.currentManifest}`);
      continue;
    }
    const manifest = json(manifestPath);
    if (manifest.vendor !== agent.id) issues.push(`${agent.id}: manifest declares vendor ${manifest.vendor}`);
    if (!manifest.vendorVersion) issues.push(`${agent.id}: manifest has no vendorVersion`);
    const evidencePath = join(dirname(manifestPath), manifest.evidence ?? '');
    if (!manifest.evidence || !existsSync(evidencePath)) {
      issues.push(`${agent.id}: promoted manifest has no evidence index`);
    } else {
      const evidence = json(evidencePath);
      if (agent.status === 'verified') {
        if (manifest.asmVersion !== 2 || evidence.evidenceVersion !== 2 || !evidence.claims?.length) {
          issues.push(`${agent.id}: verified support requires claim-addressable ASM/evidence v2`);
        }
        const upstreamPath = join(repoRoot, 'packages', 'surface', 'vendors', agent.id, 'upstream.json');
        const requiredPlatforms = existsSync(upstreamPath) ? (json(upstreamPath).platforms ?? []) : [];
        const verifiedPlatforms = new Set(
          (evidence.artifacts ?? [])
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
          attestation.manifest !== agent.currentManifest ||
          !/^[0-9a-f]{40}$/.test(attestation.candidateCommit ?? '') ||
          !/^[0-9a-f]{64}$/.test(attestation.replayDigest ?? '') ||
          attestation.evidenceDigest !== evidence.records?.find((record) => record.kind === 'model-tree')?.sha256 ||
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
          const digest = (evidence.artifacts ?? []).find((artifact) => artifact.platform === platform)?.integrity
            ?.sha256;
          if (reportArtifacts.get(platform) !== digest) {
            issues.push(`${agent.id}: promotion attestation does not bind the ${platform} artifact`);
          }
        }
      } else {
        const frozen = agent.legacyEvidence;
        if (
          frozen?.kind !== 'pre-asm-v2-baseline' ||
          frozen.frozenManifest !== agent.currentManifest ||
          !/^\d{4}-\d{2}-\d{2}$/.test(frozen.frozenOn ?? '') ||
          typeof frozen.reason !== 'string' ||
          frozen.reason.length === 0
        ) {
          issues.push(`${agent.id}: legacy support must carry an explicit frozen baseline attestation`);
        }
        const modelRecord = (evidence.records ?? []).find((record) => record.kind === 'model-tree');
        if (!/^[0-9a-f]{64}$/.test(frozen?.modelSha256 ?? '') || modelRecord?.sha256 !== frozen?.modelSha256) {
          issues.push(`${agent.id}: legacy model tree differs from its frozen baseline digest`);
        }
      }
    }
    const personaPath = join(repoRoot, 'packages', 'imposter', 'personas', agent.persona ?? '', 'persona.json');
    if (!existsSync(personaPath)) {
      issues.push(`${agent.id}: persona does not exist: ${agent.persona ?? '<missing>'}`);
      continue;
    }
    const persona = json(personaPath);
    const surfaceRoot = join(repoRoot, 'packages', 'surface');
    const expectedModel = relative(surfaceRoot, dirname(manifestPath)).split(sep).join('/');
    if (
      !agent.candidateManifest &&
      (persona.asm?.package !== '@vibecook/chopsticks-surface' || persona.asm?.path !== expectedModel)
    ) {
      issues.push(`${agent.id}: persona ASM does not match promoted manifest (${expectedModel})`);
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
      const manifest = json(join(repoRoot, agent.currentManifest));
      message = `${agent.status.replace(/-/g, ' ')} ${manifest.vendorVersion}`;
      target = agent.currentManifest;
      color = agent.status === 'verified' ? 'blue' : 'orange';
    } else if (agent.candidateManifest) {
      const manifest = json(join(repoRoot, agent.candidateManifest));
      message = `${message} ${manifest.vendorVersion}`;
      target = agent.candidateManifest;
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
